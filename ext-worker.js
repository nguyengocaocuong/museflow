/* ext-worker.js — MuseFlow Extension Worker (Generation Worker cho rup-video Brain).
 *
 * Vòng tròn giả lập/test:
 *   mock server (Brain) --poll--> extension (Worker) --generate--> upload kết quả về server
 *
 * Hai chế độ generate:
 *   - simulate=true  (mặc định): KHÔNG chạm bridge thật. Vẽ ảnh placeholder bằng
 *                      canvas, đợi vài giây, upload binary thật về server.
 *                      Dùng để test toàn bộ vòng tròn API.
 *   - simulate=false: build flow thật từ job.scene qua JSON→Flow (cần tab Muse.ai
 *                      login), nhưng phần "bắt kết quả generate để upload" CHƯA CODE
 *                      (P1) → job fail với mã RESULT_CAPTURE_TODO.
 *
 * API khớp docs/28-kien-truc-brain-worker.md (rup-video).
 */
(() => {
  'use strict';

  const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8765',
    token: '',
    workerId: 'ext-' + Math.random().toString(36).slice(2, 10),
    simulate: true,
    pollMs: 10000,
  };
  const STORE_KEY = 'extWorkerConfig';

  const store = {
    async get() {
      try {
        if (window.chrome && chrome.storage && chrome.storage.local) {
          const r = await chrome.storage.local.get(STORE_KEY);
          return Object.assign({}, DEFAULTS, r[STORE_KEY] || {});
        }
      } catch (e) { /* fallthrough */ }
      try {
        return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
      } catch (e) { return Object.assign({}, DEFAULTS); }
    },
    async set(cfg) {
      try {
        if (window.chrome && chrome.storage && chrome.storage.local) {
          await chrome.storage.local.set({ [STORE_KEY]: cfg });
          return;
        }
      } catch (e) { /* fallthrough */ }
      try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);

  const state = {
    running: false,
    cfg: Object.assign({}, DEFAULTS),
    timer: 0,
    logLines: [],
    onLog: null,       // UI hook: (line) => void
    busy: false,       // đang xử lý 1 job
  };

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.logLines.push(line);
    if (state.logLines.length > 200) state.logLines.shift();
    if (state.onLog) { try { state.onLog(line); } catch (e) {} }
    console.log('[ExtWorker]', msg);
  }

  function api(path, opts = {}) {
    const url = state.cfg.serverUrl.replace(/\/+$/, '') + path;
    const headers = Object.assign(
      { 'Authorization': 'Bearer ' + state.cfg.token },
      opts.headers || {}
    );
    return fetch(url, Object.assign({}, opts, { headers }));
  }

  // ---- simulate: vẽ ảnh placeholder thật bằng canvas ----
  function simulateImage(job) {
    return new Promise((resolve) => {
      const scene = (job.payload && job.payload.scene) || {};
      const kind = (job.payload && job.payload.kind) || 'image';
      const size = scene.size || '9:16';
      const dims = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [720, 720], '4:3': [800, 600], '3:4': [600, 800] }[size] || [540, 960];
      const [w, h] = dims;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, w, h);
      if (kind === 'video') { grad.addColorStop(0, '#1a2a6c'); grad.addColorStop(1, '#b21f1f'); }
      else { grad.addColorStop(0, '#134e5e'); grad.addColorStop(1, '#71b280'); }
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.textAlign = 'center';
      g.font = `bold ${Math.round(w / 14)}px sans-serif`;
      g.fillText('SIMULATED ' + kind.toUpperCase(), w / 2, h / 2 - 30);
      g.font = `${Math.round(w / 22)}px sans-serif`;
      const name = String(scene.name || job.id).slice(0, 40);
      g.fillText(name, w / 2, h / 2 + 20);
      g.font = `${Math.round(w / 28)}px monospace`;
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText('job ' + String(job.id).slice(0, 8), w / 2, h / 2 + 60);
      c.toBlob((blob) => resolve({ blob, width: w, height: h }), 'image/png');
    });
  }

  async function heartbeatLoop(jobId, stopFlag) {
    while (!stopFlag.stopped) {
      await sleep(30000);
      if (stopFlag.stopped) break;
      try {
        const r = await api(`/api/ext/v1/jobs/${jobId}/heartbeat`, { method: 'POST' });
        if (r.status === 410) { stopFlag.gone = true; break; }
      } catch (e) { /* mạng lỗi: thử lại kỳ sau */ }
    }
  }

  async function failJob(job, code, message, retryable) {
    try {
      await api(`/api/ext/v1/jobs/${job.id}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, message, retryable }),
      });
    } catch (e) { log('failJob network error: ' + e.message); }
  }

  async function uploadResult(job, blob, meta) {
    const fd = new FormData();
    const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'png';
    fd.append('file', blob, `result-${String(job.id).slice(0, 8)}.${ext}`);
    for (const [k, v] of Object.entries(meta || {})) fd.append(k, String(v));
    const r = await api(`/api/ext/v1/jobs/${job.id}/result`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('upload HTTP ' + r.status);
    return r.json();
  }

  // ---- real mode: build flow thật (kết quả capture = TODO P1) ----
  async function realGenerate(job) {
    const scene = (job.payload && job.payload.scene) || {};
    const wf = {
      name: 'Worker job ' + String(job.id).slice(0, 8),
      autoRun: false, // build thôi, user bấm run tay (tránh chạy ồ ạt)
      negativePrompt: scene.negativePrompt || '',
      scenes: [Object.assign({ name: scene.name || 'Scene' }, scene)],
    };
    if (window.__museflowHooks && window.__museflowHooks.buildJsonFlow) {
      window.__museflowHooks.buildJsonFlow(JSON.stringify(wf));
      log('Đã build flow từ job (real mode). Bấm Run tay trên canvas.');
    } else {
      log('Không tìm thấy hook buildJsonFlow — mở app page mới nhất.');
    }
    const err = new Error('RESULT_CAPTURE_TODO');
    err.code = 'RESULT_CAPTURE_TODO';
    throw err;
  }

  async function handleJob(job) {
    const kind = (job.payload && job.payload.kind) || '?';
    const sname = ((job.payload && job.payload.scene) || {}).name || '';
    log(`Claimed job ${String(job.id).slice(0, 8)} [${kind}] "${sname}" (simulate=${state.cfg.simulate})`);
    const stopFlag = { stopped: false, gone: false };
    const hb = heartbeatLoop(job.id, stopFlag);
    try {
      let blob, meta;
      if (state.cfg.simulate) {
        await sleep(4000); // giả lập thời gian generate
        const sim = await simulateImage(job);
        blob = sim.blob;
        meta = { width: sim.width, height: sim.height, kind, simulated: 'true',
                 durationSec: ((job.payload && job.payload.scene) || {}).duration || '' };
      } else {
        await realGenerate(job); // throw RESULT_CAPTURE_TODO
      }
      if (stopFlag.gone) { log('Job bị server thu hồi giữa chừng — bỏ kết quả.'); return; }
      await uploadResult(job, blob, meta);
      log(`✅ Upload xong job ${String(job.id).slice(0, 8)} (${(blob.size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      if (e.code === 'RESULT_CAPTURE_TODO') {
        log('Real mode: flow đã build, chờ P1 nối bridge result capture.');
        await failJob(job, 'RESULT_CAPTURE_TODO', 'Real bridge result capture chưa code (P1). Flow đã build trên canvas.', false);
      } else {
        log('❌ Lỗi job: ' + e.message);
        await failJob(job, 'UNKNOWN', e.message || 'worker error', true);
      }
    } finally {
      stopFlag.stopped = true;
      await hb.catch(() => {});
    }
  }

  async function pollOnce() {
    let r;
    try {
      r = await api('/api/ext/v1/jobs/next', {
        headers: { 'X-Worker-Id': state.cfg.workerId },
      });
    } catch (e) {
      log('Không nối được server: ' + e.message);
      return;
    }
    if (r.status === 204) return; // không có job
    if (r.status === 401) { log('Sai token (401). Kiểm tra API token.'); return; }
    if (!r.ok) { log('jobs/next HTTP ' + r.status); return; }
    const data = await r.json();
    if (data && data.job) await handleJob(data.job);
  }

  async function loop() {
    if (!state.running) return;
    if (!state.busy) {
      state.busy = true;
      try { await pollOnce(); } finally { state.busy = false; }
    }
    if (state.running) state.timer = setTimeout(loop, state.cfg.pollMs);
  }

  const Worker = {
    async init() { state.cfg = await store.get(); return state.cfg; },
    get config() { return state.cfg; },
    async saveConfig(cfg) {
      state.cfg = Object.assign({}, state.cfg, cfg);
      await store.set(state.cfg);
    },
    isRunning() { return state.running; },
    async testConnection() {
      try {
        const r = await api('/api/ext/v1/status');
        if (r.status === 401) return { ok: false, msg: 'Sai token (401)' };
        if (!r.ok) return { ok: false, msg: 'HTTP ' + r.status };
        const j = await r.json();
        return { ok: true, msg: `OK — ${j.pendingJobs} job đang chờ` };
      } catch (e) { return { ok: false, msg: 'Không nối được: ' + e.message }; }
    },
    start() {
      if (state.running) return;
      if (!state.cfg.token) { log('Chưa nhập API token.'); return false; }
      state.running = true;
      log(`Worker START (id=${state.cfg.workerId}, simulate=${state.cfg.simulate}, poll=${state.cfg.pollMs}ms)`);
      loop();
      return true;
    },
    stop() {
      state.running = false;
      clearTimeout(state.timer);
      log('Worker STOP.');
    },
    onLog(fn) { state.onLog = fn; },
    getLog() { return state.logLines.slice(); },
  };

  window.ExtWorker = Worker;
})();
