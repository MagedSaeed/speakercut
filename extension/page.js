// Runs in the page's MAIN world so it can reach Label Studio's editor store (window.Htx).
// It only reads the current task and adds/removes regions in the open editor.
// It NEVER submits, updates or skips an annotation.
(() => {
  if (window.__LSP_PAGE__) return;
  window.__LSP_PAGE__ = true;

  const CH = "LSP_BRIDGE_v1";
  const created = new WeakMap(); // annotation -> Set(region ids created by us)

  const store = () => window.Htx || null;
  const annotation = () => store()?.annotationStore?.selected || null;

  function reply(id, ok, data) {
    window.postMessage({ ch: CH, dir: "toContent", id, ok, data }, window.location.origin);
  }

  function taskInfo() {
    const s = store();
    const a = annotation();
    if (!s || !a || !s.task) throw new Error("No open Label Studio task found. Open a task first.");
    let data = s.task.data;
    if (typeof data === "string") data = JSON.parse(data);
    const url = data.video || data.audio;
    if (!url) throw new Error("Task has no $video/$audio field.");
    return { taskId: s.task.id, annotationId: a.id, mediaUrl: url, readOnly: !!(a.readonly || a.isReadOnly?.()) };
  }

  function existingCount(fromName) {
    const a = annotation();
    if (!a) return 0;
    const res = a.serializeAnnotation ? a.serializeAnnotation() : [];
    return res.filter((r) => r.from_name === fromName).length;
  }

  function apply({ segments, fromName, toName, label, expectedTaskId }) {
    const s = store();
    const a = annotation();
    if (!a) throw new Error("No annotation open.");
    if (expectedTaskId != null && s.task.id !== expectedTaskId)
      throw new Error("Task changed while diarizing; not applying. Run again on this task.");
    const results = segments.map((seg, i) => ({
      id: "lsp" + Math.random().toString(36).slice(2, 10) + i,
      from_name: fromName,
      to_name: toName,
      type: "labels",
      origin: "manual",
      value: { start: seg.start, end: seg.end, channel: 0, labels: [label] }
    }));
    const before = new Set(a.regions.map((r) => r.id));
    if (typeof a.appendResults === "function") {
      a.appendResults(results);
    } else {
      a.deserializeResults(results);
      a.updateObjects?.();
    }
    const mine = created.get(a) || new Set();
    a.regions.forEach((r) => { if (!before.has(r.id)) mine.add(r.id); });
    created.set(a, mine);
    return { added: a.regions.length - before.size };
  }

  // Is the editor's audio fully loaded and decoded?
  function readiness({ toName }) {
    const s = store();
    const a = annotation();
    if (!s || !a || !s.task) return { ready: false, reason: "Open a task to presegment." };
    if (a.readonly) return { ready: false, reason: "This annotation is read-only." };
    const ws = a.names?.get(toName)?._ws;
    if (!ws) return { ready: false, reason: "Waiting for the audio player…" };
    const dec = ws.media?.audio?.decoder;
    const parts = dec?.chunks?.[0];
    const ok = ws.loaded === true && Array.isArray(parts) && parts.some((p) => p?.length) && dec?._sampleRate > 0;
    if (!ok) {
      const pct = dec?._dataLength > 0 && dec?._dataSize > 0 ? ` ${Math.round((100 * dec._dataSize) / dec._dataLength)}%` : "";
      return { ready: false, reason: `Waiting for audio to load…${pct}` };
    }
    return { ready: true, taskId: s.task.id };
  }

  // Reuse the audio Label Studio already downloaded+decoded for its waveform (avoids a 2nd download).
  async function pcm16k({ toName, sr: target = 16000 }) {
    const a = annotation();
    const dec = a?.names?.get(toName)?._ws?.media?.audio?.decoder;
    const parts = dec?.chunks?.[0];
    const sr = dec?._sampleRate;
    if (!Array.isArray(parts) || !parts.length || !sr) return null;
    const n = parts.reduce((t, p) => t + p.length, 0);
    if (!n) return null;
    const all = new Float32Array(n);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    const ctx = new OfflineAudioContext(1, Math.ceil((n / sr) * target), target);
    const b = ctx.createBuffer(1, n, sr);
    b.copyToChannel(all, 0);
    const src = ctx.createBufferSource();
    src.buffer = b; src.connect(ctx.destination); src.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    return { samples: out, sampleRate: target, duration: n / sr };
  }

  function clearMine() {
    const a = annotation();
    if (!a) return { removed: 0 };
    const mine = created.get(a);
    if (!mine?.size) return { removed: 0 };
    let n = 0;
    [...a.regions].forEach((r) => {
      if (mine.has(r.id)) { a.deleteRegion(r); n++; }
    });
    mine.clear();
    return { removed: n };
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const m = ev.data;
    if (!m || m.ch !== CH || m.dir !== "toPage") return;
    try {
      if (m.op === "pcm") {
        let r = null;
        try { r = await pcm16k(m.args); } catch (_) { r = null; }
        return reply(m.id, true, r);
      }
      let out;
      if (m.op === "ready") out = readiness(m.args);
      else if (m.op === "task") out = { ...taskInfo(), existing: existingCount(m.args.fromName) };
      else if (m.op === "apply") out = apply(m.args);
      else if (m.op === "clear") out = clearMine();
      else throw new Error("unknown op " + m.op);
      reply(m.id, true, out);
    } catch (e) {
      reply(m.id, false, String(e?.message || e));
    }
  });
})();
