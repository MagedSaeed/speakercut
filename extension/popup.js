const keys = Object.keys(LSP_DEFAULTS);
const el = (id) => document.getElementById(id);
// Numeric settings where 0 means "auto" / "no limit": shown as an empty field with a placeholder.
const ZERO_IS_EMPTY = new Set(["maxDur", "numSpeakers", "minSpeakers", "maxSpeakers"]);

function write(s) {
  keys.forEach((k) => {
    const d = LSP_DEFAULTS[k];
    if (k === "provider") {
      const r = document.querySelector(`input[name=provider][value="${s.provider}"]`)
        || document.querySelector(`input[name=provider][value="${LSP_DEFAULTS.provider}"]`); // e.g. a removed provider was saved
      r.checked = true;
    } else if (typeof d === "boolean") el(k).checked = !!s[k];
    else if (ZERO_IS_EMPTY.has(k) && Number(s[k]) === 0) el(k).value = "";
    else el(k).value = s[k];
  });
}

function read() {
  const o = {};
  keys.forEach((k) => {
    const d = LSP_DEFAULTS[k];
    if (k === "provider") o[k] = document.querySelector("input[name=provider]:checked")?.value || d;
    else if (typeof d === "boolean") o[k] = el(k).checked;
    else if (typeof d === "number") { const n = Number(el(k).value); o[k] = Number.isFinite(n) && n > 0 ? n : 0; }
    else o[k] = el(k).value.trim() || d;
  });
  return o;
}

// ---- autosave
let saveTimer, flashTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set(read(), () => {
    const s = el("saved");
    s.textContent = "Saved";
    s.classList.add("flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { s.textContent = "Changes save automatically"; s.classList.remove("flash"); }, 1500);
  }), 250);
}

// ---- server status
let checkSeq = 0;
function setStatus(state, text) {
  el("status").dataset.state = state;
  el("statusText").textContent = text;
  if (state !== "checking") lock(state === "down"); // keep the previous lock state while re-checking
}
// Settings only make sense once the server answers: lock everything but the server URL until then.
function lock(on) {
  document.body.classList.toggle("offline", on);
  document.querySelectorAll(".lockable input").forEach((i) => (i.disabled = on));
  const d = document.querySelector("details.lockable");
  if (on && d.open) d.open = false;
}
function info(parts) {
  const box = el("serverInfo");
  box.replaceChildren(...parts.map(([cls, t], i) => {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = (i ? ". " : "") + t;
    return span;
  }));
}
function check() {
  const seq = ++checkSeq;
  const s = read();
  setStatus("checking", "Checking");
  info([]);
  chrome.runtime.sendMessage({ type: "LSP_HEALTH", serverUrl: s.serverUrl }, (r) => {
    if (seq !== checkSeq) return; // a newer check started
    if (!r?.ok) {
      setStatus("down", "Offline");
      info([["err", `Can't reach ${s.serverUrl}. Start the server, or fix the address, to change the other settings`]]);
      return;
    }
    const d = r.data, p = d.providers || {};
    const warn = [];
    if (s.provider === "local" && d.hf_token_set === false) warn.push("HF_TOKEN is missing on the server");
    if (s.provider === "pyannoteai" && !p.pyannoteai) warn.push("PYANNOTEAI_API_KEY is missing on the server");
    if (s.removeMusic && d.separation === false) warn.push("music removal isn't installed (run uv sync on the server)");
    setStatus(warn.length ? "warn" : "ok", d.cuda ? "Online, GPU" : "Online, CPU");
    info(warn.length ? warn.map((w) => ["warn", w]) : [["", d.cuda ? "Connected. Running on GPU" : "Connected. Running on CPU"]]);
  });
}

// ---- wiring
chrome.storage.sync.get(LSP_DEFAULTS, (s) => {
  write(s);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("ready")));
  check();
});

let urlTimer;
document.addEventListener("input", (e) => {
  save();
  if (e.target.id === "serverUrl") { clearTimeout(urlTimer); urlTimer = setTimeout(check, 600); }
});
document.addEventListener("change", (e) => {
  save();
  if (e.target.name === "provider" || e.target.id === "removeMusic") check(); // warnings depend on these
});
el("status").onclick = check;
document.querySelector("details.lockable summary").addEventListener("click", (e) => {
  if (document.body.classList.contains("offline")) e.preventDefault();
});
el("reset").onclick = () => {
  write(LSP_DEFAULTS);
  chrome.storage.sync.set(read(), check);
  el("saved").textContent = "Defaults restored";
};

// ---- field help tooltips (hover, keyboard focus, or click on the "i")
const tipBox = el("tooltip");
let tipFor = null, tipTimer;
function showTip(btn) {
  clearTimeout(tipTimer);
  if (tipFor && tipFor !== btn) tipFor.removeAttribute("aria-expanded");
  tipFor = btn;
  btn.setAttribute("aria-expanded", "true");
  btn.setAttribute("aria-describedby", "tooltip");
  tipBox.textContent = btn.dataset.tip;
  tipBox.hidden = false;
  const b = btn.getBoundingClientRect(), t = tipBox.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, m = 8;
  const left = Math.min(Math.max(b.left + b.width / 2 - t.width / 2, m), vw - t.width - m);
  const above = b.top - t.height - 8 >= m; // prefer above; flip below near the top
  tipBox.dataset.side = above ? "above" : "below";
  tipBox.style.left = left + "px";
  tipBox.style.top = (above ? b.top - t.height - 8 : b.bottom + 8) + "px";
  tipBox.style.setProperty("--ax", (b.left + b.width / 2 - left) + "px");
  requestAnimationFrame(() => tipBox.classList.add("show"));
}
function hideTip() {
  if (!tipFor) return;
  tipFor.removeAttribute("aria-expanded");
  tipFor.removeAttribute("aria-describedby");
  tipFor = null;
  tipBox.classList.remove("show");
  tipTimer = setTimeout(() => (tipBox.hidden = true), 150);
}
document.querySelectorAll(".tip").forEach((btn) => {
  btn.addEventListener("mouseenter", () => showTip(btn));
  btn.addEventListener("mouseleave", hideTip);
  btn.addEventListener("focus", () => showTip(btn));
  btn.addEventListener("blur", hideTip);
  btn.addEventListener("click", (e) => { e.preventDefault(); tipFor === btn ? hideTip() : showTip(btn); });
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
