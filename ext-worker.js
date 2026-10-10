/* ext-worker.js — MuseFlow Extension Worker (Generation Worker cho rup-video Brain).
 *
 * Vòng tròn giả lập/test:
 *   mock server (Brain) --poll--> extension (Worker) --generate--> upload kết quả về server
 *
 * Hai chế độ generate:
 *   - simulate=true  (mặc định): KHÔNG chạm bridge thật. Vẽ ảnh placeholder bằng
 *                      canvas, đợi vài giây, upload binary thật về server.
 *                      Dùng để test toàn bộ vòng tròn API.
 *   - simulate=false: build flow thật từ job, chạy qua tab Muse.ai đã login
 *                      (runAndCapture hook), gom từng asset (node.data.asset.url)
 *                      và upload về server. Campaign dài có thể mất hàng chục phút.
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
    onJobs: null,      // UI hook: () => void (job history thay đổi)
    busy: false,       // đang xử lý 1 job
    history: [],       // [{id,kind,sceneName,status,startedAt,finishedAt,error,resultUrl}]
    currentJobId: null,
  };
  const HIST_KEY = 'extWorkerHistory';

  async function loadHistory() {
    try {
      if (window.chrome && chrome.storage && chrome.storage.local) {
        const r = await chrome.storage.local.get(HIST_KEY);
        state.history = (r[HIST_KEY] || []).slice(-50);
        return;
      }
    } catch (e) {}
    try { state.history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]').slice(-50); } catch (e) {}
  }
  async function saveHistory() {
    const h = state.history.slice(-50);
    try {
      if (window.chrome && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [HIST_KEY]: h });
        return;
      }
    } catch (e) {}
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) {}
  }
  function recordJob(id, patch) {
    let rec = state.history.find((x) => x.id === id);
    if (!rec) { rec = { id }; state.history.push(rec); }
    Object.assign(rec, patch);
    state.history = state.history.slice(-50);
    saveHistory();
    if (state.onJobs) { try { state.onJobs(); } catch (e) {} }
  }

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

  // Mô tả lỗi từng node để debug (log vào worker + fail message)
  function describeFailures(items) {
    return items.filter((i) => !(i.status === 'success' && i.url))
      .map((i) => `${i.sceneName}[${i.kind}](${i.status}): ${i.error || 'no asset'}`)
      .join(' | ');
  }

  // ---- real mode: chạy thật qua bridge, gom kết quả từng node ----
  function needHooks() {
    if (!(window.__museflowHooks && window.__museflowHooks.buildJsonFlow && window.__museflowHooks.runAndCapture))
      throw Object.assign(new Error('App page chưa sẵn sàng — mở extension bản mới nhất.'), { code: 'HOOK_MISSING' });
  }

  async function fetchAssetBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch asset HTTP ' + r.status);
    return r.blob();
  }

  // Upload từng asset thật lên server, rồi báo complete. Trả về {succeeded, failed}.
  async function uploadCapturedItems(job, items) {
    const okItems = items.filter((i) => i.status === 'success' && i.url);
    const badItems = items.filter((i) => !(i.status === 'success' && i.url));
    let n = 0;
    for (const it of okItems) {
      const blob = await fetchAssetBlob(it.url);
      const ext = it.kind === 'video' ? 'mp4' : 'png';
      const safeName = String(it.sceneName || it.nodeId).replace(/[^\w\-]+/g, '_').slice(0, 30);
      const fd = new FormData();
      fd.append('file', blob, `${String(job.id).slice(0, 8)}-${safeName}.${ext}`);
      fd.append('kind', it.kind);
      fd.append('sceneName', it.sceneName);
      fd.append('nodeId', it.nodeId);
      fd.append('width', it.width || '');
      fd.append('height', it.height || '');
      const r = await api(`/api/ext/v1/jobs/${job.id}/result`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error('upload HTTP ' + r.status);
      n++;
      log(`  ↑ ${n}/${okItems.length}: ${it.sceneName} [${it.kind}] (${(blob.size / 1024).toFixed(0)} KB)`);
    }
    await api(`/api/ext/v1/jobs/${job.id}/result/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: items.length, succeeded: n,
        failed: badItems.map((i) => ({ sceneName: i.sceneName, kind: i.kind, error: i.error })) }),
    });
    return { succeeded: n, failed: badItems.length };
  }

  // ---- real mode cho job đơn lẻ: dựng flow 1 scene → chạy thật → upload ----
  async function realGenerate(job) {
    const scene = (job.payload && job.payload.scene) || {};
    needHooks();
    const wf = {
      name: 'Worker job ' + String(job.id).slice(0, 8),
      autoRun: false,
      negativePrompt: scene.negativePrompt || '',
      scenes: [Object.assign({ name: scene.name || 'Scene' }, scene)],
    };
    window.__museflowHooks.buildJsonFlow(JSON.stringify(wf), { autoRun: false });
    log('Đã dựng sơ đồ. Đang chạy thật qua tab Muse.ai — có thể mất vài phút, giữ tab mở.');
    return window.__museflowHooks.runAndCapture();
  }

  // ---- simulate thumb nhỏ cho từng scene (dùng cho campaign) ----
  function simulateThumb(label, kind) {
    return new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 270; c.height = 480;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 270, 480);
      if (kind === 'video') { grad.addColorStop(0, '#1a2a6c'); grad.addColorStop(1, '#b21f1f'); }
      else { grad.addColorStop(0, '#134e5e'); grad.addColorStop(1, '#71b280'); }
      g.fillStyle = grad; g.fillRect(0, 0, 270, 480);
      g.fillStyle = 'rgba(255,255,255,0.92)'; g.textAlign = 'center';
      g.font = 'bold 22px sans-serif';
      g.fillText(kind.toUpperCase(), 135, 220);
      g.font = '15px sans-serif';
      g.fillText(String(label || '').slice(0, 26), 135, 250);
      c.toBlob((b) => resolve(c), 'image/png');
    });
  }

  // Ghép các thumb thành 1 ảnh tổng kết quả campaign
  function compositeGrid(canvases, title) {
    return new Promise((resolve) => {
      const cols = 3, tw = 270, th = 480, pad = 10, headH = 50;
      const rows = Math.ceil(canvases.length / cols) || 1;
      const c = document.createElement('canvas');
      c.width = cols * (tw + pad) + pad;
      c.height = headH + rows * (th + pad) + pad;
      const g = c.getContext('2d');
      g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 24px sans-serif';
      g.fillText('SIMULATED CAMPAIGN — ' + String(title || '').slice(0, 40), c.width / 2, 34);
      canvases.forEach((t, i) => {
        const x = pad + (i % cols) * (tw + pad), y = headH + pad + Math.floor(i / cols) * (th + pad);
        g.drawImage(t, x, y, tw, th);
      });
      c.toBlob((b) => resolve(b), 'image/png');
    });
  }

  // ---- job campaign: nhận NGUYÊN workflow JSON, dựng sơ đồ như import ----
  async function handleCampaignJob(job) {
    const wf = (job.payload && job.payload.workflow) || {};
    const scenes = Array.isArray(wf.scenes) ? wf.scenes : [];
    const shortId = String(job.id).slice(0, 8);
    state.currentJobId = job.id;
    recordJob(job.id, { kind: 'campaign', sceneName: `${wf.name || 'Campaign'} (${scenes.length} scenes)`,
      status: 'claimed', startedAt: Date.now(), finishedAt: null, error: null, resultUrl: null });
    log(`Nhận campaign "${wf.name || ''}" — ${scenes.length} scenes.`);
    const stopFlag = { stopped: false, gone: false };
    const hb = heartbeatLoop(job.id, stopFlag);
    try {
      // 1. Dựng sơ đồ flow trên canvas — y hệt lúc bấm JSON → Flow
      recordJob(job.id, { status: 'building' });
      const autoRun = (job.payload && job.payload.autoRun) !== false; // mặc định true
      if (window.__museflowHooks && window.__museflowHooks.buildJsonFlow) {
        window.__museflowHooks.buildJsonFlow(JSON.stringify(wf), { autoRun });
        log(`Đã dựng sơ đồ flow trên canvas${autoRun ? ' và auto-run' : ''}.`);
      } else {
        log('⚠ Không tìm thấy hook buildJsonFlow — mở app page mới nhất.');
      }
      if (stopFlag.gone) { recordJob(job.id, { status: 'revoked', finishedAt: Date.now() }); return; }
      if (state.cfg.simulate) {
        // 2. Giả lập generate từng scene
        recordJob(job.id, { status: 'generating' });
        const thumbs = [];
        for (const s of scenes) {
          if (s.imagePrompt) thumbs.push(await simulateThumb(s.name, 'image'));
          if (s.videoPrompt) thumbs.push(await simulateThumb(s.name, 'video'));
          await sleep(400);
        }
        if (stopFlag.gone) { recordJob(job.id, { status: 'revoked', finishedAt: Date.now() }); return; }
        // 3. Upload 1 ảnh tổng
        recordJob(job.id, { status: 'uploading' });
        const blob = await compositeGrid(thumbs, wf.name);
        const up = await uploadResult(job, blob, { kind: 'campaign', simulated: 'true', scenes: String(scenes.length) });
        recordJob(job.id, { status: 'done', finishedAt: Date.now(),
          resultUrl: state.cfg.serverUrl.replace(/\/+$/, '') + (up.fileUrl || '') });
        log(`✅ Campaign xong — ${thumbs.length} placeholders, đã upload ảnh tổng.`);
      } else {
        // REAL MODE: chạy thật qua bridge, gom từng asset, upload về server
        needHooks();
        recordJob(job.id, { status: 'generating' });
        log('Đã dựng sơ đồ. Đang chạy thật qua tab Muse.ai — campaign dài có thể mất hàng chục phút, giữ tab mở.');
        const items = await window.__museflowHooks.runAndCapture();
        if (stopFlag.gone) { recordJob(job.id, { status: 'revoked', finishedAt: Date.now() }); return; }
        recordJob(job.id, { status: 'uploading' });
        const res = await uploadCapturedItems(job, items);
        if (res.succeeded === 0) {
          const detail = describeFailures(items);
          log('Chi tiết node lỗi: ' + detail);
          throw Object.assign(new Error('Không có node nào generate thành công. ' + detail), { code: 'ALL_FAILED' });
        }
        recordJob(job.id, { status: 'done', finishedAt: Date.now(), resultUrl: null });
        log(`✅ Campaign thật xong — ${res.succeeded} files đã upload${res.failed ? `, ${res.failed} node lỗi` : ''} (xem trên web UI server).`);
      }
    } catch (e) {
      if (e.code === 'HOOK_MISSING') {
        log('❌ ' + e.message);
        await failJob(job, 'HOOK_MISSING', e.message, false);
      } else {
        log('❌ Lỗi campaign: ' + e.message);
        await failJob(job, e.code || 'UNKNOWN', e.message || 'worker error', true);
      }
      recordJob(job.id, { status: 'failed', finishedAt: Date.now(), error: e.message });
    } finally {
      state.currentJobId = null;
      stopFlag.stopped = true;
      await hb.catch(() => {});
    }
  }

  async function handleJob(job) {
    const kind = (job.payload && job.payload.kind) || '?';
    if (kind === 'campaign') return handleCampaignJob(job);
    const sname = ((job.payload && job.payload.scene) || {}).name || '';
    const shortId = String(job.id).slice(0, 8);
    state.currentJobId = job.id;
    recordJob(job.id, { kind, sceneName: sname, status: 'claimed', startedAt: Date.now(), finishedAt: null, error: null, resultUrl: null });
    log(`Claimed job ${shortId} [${kind}] "${sname}" (simulate=${state.cfg.simulate})`);
    const stopFlag = { stopped: false, gone: false };
    const hb = heartbeatLoop(job.id, stopFlag);
    try {
      let uploaded = 0, failedNodes = 0, singleResultUrl = null;
      if (state.cfg.simulate) {
        recordJob(job.id, { status: 'generating' });
        await sleep(4000); // giả lập thời gian generate
        const sim = await simulateImage(job);
        const blob = sim.blob;
        const meta = { width: sim.width, height: sim.height, kind, simulated: 'true',
                 durationSec: ((job.payload && job.payload.scene) || {}).duration || '' };
        if (stopFlag.gone) { recordJob(job.id, { status: 'revoked', finishedAt: Date.now() }); return; }
        recordJob(job.id, { status: 'uploading' });
        const up = await uploadResult(job, blob, meta); // single-file (giữ tương thích mock)
        await api(`/api/ext/v1/jobs/${job.id}/result/complete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ total: 1, succeeded: 1, failed: [] }),
        });
        uploaded = 1;
        singleResultUrl = state.cfg.serverUrl.replace(/\/+$/, '') + (up.fileUrl || '');
      } else {
        recordJob(job.id, { status: 'generating' });
        const items = await realGenerate(job); // chạy thật + gom asset
        if (stopFlag.gone) { recordJob(job.id, { status: 'revoked', finishedAt: Date.now() }); return; }
        recordJob(job.id, { status: 'uploading' });
        const res = await uploadCapturedItems(job, items);
        uploaded = res.succeeded; failedNodes = res.failed;
        if (uploaded === 0) {
          const detail = describeFailures(items);
          log('Chi tiết node lỗi: ' + detail);
          throw Object.assign(new Error('Không có node nào generate thành công. ' + detail), { code: 'ALL_FAILED' });
        }
      }
      recordJob(job.id, { status: 'done', finishedAt: Date.now(), resultUrl: singleResultUrl });
      log(`✅ Upload xong job ${shortId} — ${uploaded} file${failedNodes ? `, ${failedNodes} node lỗi` : ''} (xem trên web UI server)`);
    } catch (e) {
      if (e.code === 'HOOK_MISSING') {
        log('❌ ' + e.message);
        await failJob(job, 'HOOK_MISSING', e.message, false);
        recordJob(job.id, { status: 'failed', finishedAt: Date.now(), error: e.message });
      } else {
        log('❌ Lỗi job: ' + e.message);
        await failJob(job, e.code || 'UNKNOWN', e.message || 'worker error', true);
        recordJob(job.id, { status: 'failed', finishedAt: Date.now(), error: e.message });
      }
    } finally {
      state.currentJobId = null;
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
    async init() { state.cfg = await store.get(); await loadHistory(); return state.cfg; },
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
    onJobs(fn) { state.onJobs = fn; },
    getLog() { return state.logLines.slice(); },
    getHistory() { return state.history.slice().reverse(); },
    getCurrentJobId() { return state.currentJobId; },
    async fetchServerJobs() {
      const r = await api('/api/ext/v1/jobs');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
    serverBase() { return state.cfg.serverUrl.replace(/\/+$/, ''); },
  };

  window.ExtWorker = Worker;
})();
