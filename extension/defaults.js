// Shared defaults (loaded by popup.html; duplicated inline in content.js/background.js)
const LSP_DEFAULTS = {
  serverUrl: "http://127.0.0.1:8000",
  fromName: "speaker_segments",
  toName: "audio",
  label: "Speaker segment",
  maxDur: 30,
  maxGap: 1.5,
  pad: 0.2,
  minSeg: 1.0,
  numSpeakers: 0,
  minSpeakers: 0,
  maxSpeakers: 0,
  dropOverlap: true,
  provider: "local",
  removeMusic: false
};
