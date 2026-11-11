// Isolated-world content script: floating panel, audio extraction, bridge to page.js and background.js.
// Safety: this extension only ADDS DRAFT REGIONS to the open editor. It never clicks Submit/Update/Skip
// and never calls the Label Studio annotation API.
(() => {
  if (window.__LSP_CONTENT__) return;
  window.__LSP_CONTENT__ = true;

  const CH = "LSP_BRIDGE_v1";
  const DEFAULTS = {
    serverUrl: "http://127.0.0.1:8000",
    fromName: "speaker_segments",
    toName: "audio",
    label: "Speaker segment",
    maxDur: 30, maxGap: 1.5, pad: 0.2, minSeg: 1.0, numSpeakers: 0, minSpeakers: 0, maxSpeakers: 0, dropOverlap: true, provider: "local", removeMusic: false
  };
  const TARGET_SR = 16000;

  // ---------- bridge to page.js ----------
  let seq = 0;
  const pending = new Map();
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.ch !== CH || m.dir !== "toContent" || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.ok ? resolve(m.data) : reject(new Error(m.data));
  });
  function page(op, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      window.postMessage({ ch: CH, dir: "toPage", id, op, args }, window.location.origin);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error("Editor did not respond. Is a task open?")); }
      }, 5000);
    });
  }

  const settings = () => new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));
  const bg = (msg) => new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resp?.ok ? resolve(resp.data) : reject(new Error(resp?.error || "No response"));
    }));

  // ---------- audio: media URL -> 16 kHz mono WAV (base64) ----------
  async function mediaToWavB64(url, onStatus) {
    onStatus("Downloading media…");
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`Media fetch failed (${r.status})`);
    const buf = await r.arrayBuffer();
    onStatus(`Decoding audio (${(buf.byteLength / 1e6).toFixed(1)} MB)…`);
    const ctx = new AudioContext();
    let decoded;
    try { decoded = await ctx.decodeAudioData(buf); }
    catch (e) { throw new Error("Browser could not decode the audio track: " + e.message); }
    finally { ctx.close(); }
    const len = Math.ceil(decoded.duration * TARGET_SR);
    const off = new OfflineAudioContext(1, len, TARGET_SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const mono = (await off.startRendering()).getChannelData(0);
    return { b64: wavB64(mono, TARGET_SR), duration: decoded.duration };
  }

  function wavB64(samples, sr) {
    const n = samples.length;
    const ab = new ArrayBuffer(44 + n * 2);
    const v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const bytes = new Uint8Array(ab);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "lsp-root";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{all:initial}
      .box{font:13px system-ui,sans-serif;display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap}
      .box.floating{position:fixed;left:50%;bottom:52px;transform:translateX(-50%);z-index:2147483646;
        background:#fff;border:1px solid #c9d3e0;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.15);padding:6px 8px;max-width:620px}
      .box.inline{width:100%;margin:0 0 8px}
      button{font:inherit;border:1px solid #4A90E2;background:#4A90E2;color:#fff;border-radius:7px;padding:5px 12px;cursor:pointer;font-weight:600}
      .inline button{font-size:14px}
      button img{vertical-align:-3px;margin-right:6px;border-radius:4px}
      button.sec{background:#fafafa;color:#4A90E2;border-color:#ccc}
      button:disabled{opacity:.5;cursor:default}
      .st{color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
      .err{color:#b00020}
      .x{border:none;background:none;color:#888;padding:0 4px;font-weight:400}
      .inline .x{display:none}
    </style>
    <div class="box floating" id="box">
      <button id="run" title="Diarize this task and add draft speaker segments (does not submit)"><img id="logo" alt="" width="16" height="16">Presegment</button>
      <button id="undo" class="sec" title="Remove segments added by this extension on this task">Remove auto</button>
      <span id="st" class="st">Ready</span>
      <button id="hide" class="x" title="Hide">✕</button>
    </div>`;
  const $ = (id) => shadow.getElementById(id);
  $("logo").src = chrome.runtime.getURL("icons/icon32.png");
  const status = (t, err = false) => { $("st").textContent = t; $("st").className = "st" + (err ? " err" : ""); $("st").title = t; };
  let busy = false;
  let confirmArmed = 0;
  let ready = false;
  let lastReason = "";
  let lastTaskId = null;

  // Keep the button disabled until the editor's audio is loaded and decoded.
  async function refreshReady() {
    if (!host.isConnected || busy) return;
    const s = await settings();
    const r = await page("ready", { toName: s.toName }).catch(() => ({ ready: false, reason: "Open a task to presegment." }));
    ready = !!r.ready;
    $("run").disabled = !ready;
    $("run").title = ready ? "Diarize this task and add draft speaker segments (does not submit)" : r.reason;
    if (!ready) { if (r.reason !== lastReason) status(r.reason); lastReason = r.reason; }
    else if (lastReason || r.taskId !== lastTaskId) { status("Ready"); lastReason = ""; }
    if (r.taskId != null) lastTaskId = r.taskId;
  }

  async function run() {
    if (busy || !ready) return;
    busy = true; $("run").disabled = true;
    try {
      const s = await settings();
      const info = await page("task", { fromName: s.fromName });
      if (info.readOnly) throw new Error("This annotation is read-only.");
      if (info.existing > 0 && Date.now() - confirmArmed > 6000) {
        confirmArmed = Date.now();
        status(`Task already has ${info.existing} segment(s). Click again within 6 s to add anyway.`, true);
        return;
      }
      confirmArmed = 0;
      status("Reading audio from the editor…");
      const sendSr = s.removeMusic ? 44100 : TARGET_SR; // Demucs works at 44.1 kHz
      const pcm = await page("pcm", { toName: s.toName, sr: sendSr }).catch(() => null);
      const { b64, duration } = pcm?.samples?.length
        ? { b64: wavB64(pcm.samples, pcm.sampleRate), duration: pcm.duration }
        : await mediaToWavB64(info.mediaUrl, status); // fallback: waveform not loaded yet
      const secs = Math.round(duration);
      const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      const via = { local: "local pyannote", pyannoteai: "pyannoteAI", elevenlabs: "ElevenLabs" }[s.provider] || s.provider;
      status(`Diarizing ${mmss} of audio via ${via}${s.removeMusic ? " (music removed)" : ""}…`);
      const res = await bg({ type: "LSP_DIARIZE", wavB64: b64, settings: s });
      if (!res.segments?.length) { status(`No clean single-speaker segments found (${res.num_speakers} speakers).`, true); return; }
      const out = await page("apply", {
        segments: res.segments, fromName: s.fromName, toName: s.toName, label: s.label, expectedTaskId: info.taskId
      });
      status(`Added ${out.added} draft segment(s), ${res.num_speakers} speaker(s). Review, then annotate. Not submitted.`);
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      busy = false;
      refreshReady();
    }
  }

  $("run").addEventListener("click", run);
  $("undo").addEventListener("click", async () => {
    try { const r = await page("clear"); status(`Removed ${r.removed} auto segment(s).`); }
    catch (e) { status(e.message, true); }
  });
  let hidden = false;
  $("hide").addEventListener("click", () => { hidden = true; host.remove(); });

  // Placement: a row directly under the "Video Tutorial / Guidelines" row of the labeling config.
  // Label Studio re-renders that area on every task switch, so we re-attach when it disappears.
  function findLinksRow() {
    const link = [...document.querySelectorAll(".lsf-main-view__annotation a, a")]
      .find((a) => /guidelines/i.test(a.textContent || ""));
    let el = link;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === "flex" && el.children.length >= 2 && /tutorial/i.test(el.textContent || "")) return el;
    }
    return null;
  }

  const onTaskPage = () => /\/projects\/\d+\/data/.test(location.pathname) || /[?&]task=/.test(location.search);
  let lastFloatingCheck = 0;

  const mount = () => {
    if (!onTaskPage()) { if (host.isConnected) host.remove(); return; }
    const row = findLinksRow();
    if (row) {
      lastFloatingCheck = 0;
      if (host.previousElementSibling !== row || !host.isConnected) {
        row.insertAdjacentElement("afterend", host);
        $("box").className = "box inline";
      }
      return;
    }
    // No links row (other layout / editor not open yet): wait a bit, then fall back to the floating bar.
    if (!host.isConnected || $("box").className.includes("inline")) {
      if (!lastFloatingCheck) lastFloatingCheck = Date.now();
      if (Date.now() - lastFloatingCheck < 4000) { if (host.isConnected) host.remove(); return; }
      if (!hidden) { document.documentElement.appendChild(host); $("box").className = "box floating"; }
    }
  };
  mount();
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; mount(); });
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(mount, 1500); // SPA navigation safety net
  $("run").disabled = true;
  refreshReady();
  setInterval(refreshReady, 1000);
})();
