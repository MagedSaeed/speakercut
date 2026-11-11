"""Music/background removal before diarization (Demucs vocal separation).

Only the *diarization input* is cleaned. Timing is preserved, so segment boundaries
still line up with the original audio that annotators listen to.
"""
from __future__ import annotations

import threading

import torch

_model = None
_lock = threading.Lock()


def available() -> bool:
    try:
        import demucs  # noqa: F401
        return True
    except Exception:
        return False


def _get_model():
    global _model
    if _model is None:
        from demucs.pretrained import get_model

        m = get_model("htdemucs")
        m.eval()
        if torch.cuda.is_available():
            m.to("cuda")
        _model = m
    return _model


def _resample(x: torch.Tensor, src: int, dst: int) -> torch.Tensor:
    if src == dst:
        return x
    import julius  # demucs dependency

    return julius.resample_frac(x, src, dst)


@torch.no_grad()
def vocals_only(wav: torch.Tensor, sr: int, out_sr: int = 16000) -> torch.Tensor:
    """wav: (1, T) mono float tensor at `sr`. Returns (1, T') mono vocals at `out_sr`."""
    with _lock:
        model = _get_model()
        dev = next(model.parameters()).device
        x = _resample(wav, sr, model.samplerate).repeat(model.audio_channels, 1)  # mono -> stereo
        ref = x.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        x = (x - mean) / std
        from demucs.apply import apply_model

        src = apply_model(model, x[None].to(dev), split=True, overlap=0.25, progress=False, device=dev)[0]
        voc = src[model.sources.index("vocals")].cpu() * std + mean
        return _resample(voc.mean(0, keepdim=True), model.samplerate, out_sr)
