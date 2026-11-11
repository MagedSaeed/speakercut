// Service worker: talks to the diarization server (avoids page CORS / local-network restrictions).
// It only ever calls the configured diarization server. It never calls Label Studio.

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "LSP_HEALTH") {
    fetch(msg.serverUrl.replace(/\/$/, "") + "/health")
      .then((r) => r.json())
      .then((j) => sendResponse({ ok: true, data: j }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "LSP_DIARIZE") {
    (async () => {
      try {
        const s = msg.settings;
        const fd = new FormData();
        fd.append("file", new Blob([b64ToBytes(msg.wavB64)], { type: "audio/wav" }), "audio.wav");
        fd.append("max_gap", String(s.maxGap));
        fd.append("max_dur", String(s.maxDur));
        fd.append("pad", String(s.pad));
        fd.append("min_seg", String(s.minSeg));
        fd.append("num_speakers", String(s.numSpeakers || 0));
        fd.append("min_speakers", String(s.minSpeakers || 0));
        fd.append("max_speakers", String(s.maxSpeakers || 0));
        fd.append("provider", s.provider || "local");
        fd.append("remove_music", String(!!s.removeMusic));
        fd.append("drop_overlap", String(!!s.dropOverlap));
        const r = await fetch(s.serverUrl.replace(/\/$/, "") + "/diarize", { method: "POST", body: fd });
        const text = await r.text();
        if (!r.ok) throw new Error(`Server ${r.status}: ${text.slice(0, 300)}`);
        sendResponse({ ok: true, data: JSON.parse(text) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});
