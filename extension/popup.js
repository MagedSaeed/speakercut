const keys = Object.keys(LSP_DEFAULTS);
const el = (k) => document.getElementById(k);
const msg = (t) => (el("msg").textContent = t);

chrome.storage.sync.get(LSP_DEFAULTS, (s) => {
  keys.forEach((k) => {
    if (typeof LSP_DEFAULTS[k] === "boolean") el(k).checked = !!s[k];
    else el(k).value = s[k];
  });
  if (!el("provider").value) el("provider").value = LSP_DEFAULTS.provider; // e.g. a removed provider was saved
});

function read() {
  const o = {};
  keys.forEach((k) => {
    const d = LSP_DEFAULTS[k];
    if (typeof d === "boolean") o[k] = el(k).checked;
    else if (typeof d === "number") o[k] = Number(el(k).value);
    else o[k] = el(k).value.trim();
  });
  return o;
}

el("save").onclick = () => chrome.storage.sync.set(read(), () => msg("Saved."));
el("test").onclick = () => {
  msg("Checking…");
  chrome.runtime.sendMessage({ type: "LSP_HEALTH", serverUrl: read().serverUrl }, (r) => {
    if (!r?.ok) return msg("Unreachable: " + (r?.error || chrome.runtime.lastError?.message));
    const d = r.data;
    const p = d.providers || {};
    const prov = read().provider;
    const warn = [];
    if (prov === "local" && d.hf_token_set === false) warn.push("HF_TOKEN missing");
    if (prov === "pyannoteai" && !p.pyannoteai) warn.push("PYANNOTEAI_API_KEY missing");
    if (read().removeMusic && d.separation === false) warn.push("music removal not installed (uv sync --extra separation)");
    msg(`OK · ${d.cuda ? "GPU" : "CPU"} · keys: ${["local","pyannoteai"].filter(k=>p[k]).join(", ") || "none"}` +
        (warn.length ? " · ⚠ " + warn.join("; ") : ""));
  });
};
