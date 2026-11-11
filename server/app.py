"""Local diarization service for the SpeakerCut extension (Label Studio presegmentation).

Run:
    cp .env.example .env          # put your HF_TOKEN in .env (must have accepted the model's terms)
    uv run uvicorn app:app --host 127.0.0.1 --port 8000

POST /diarize  (multipart: file=<mono WAV>, provider=local|pyannoteai, remove_music, ...)
GET  /health
"""
from __future__ import annotations

import io
import os
import threading

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from dotenv import load_dotenv

from fastapi.concurrency import run_in_threadpool

import providers
import separation
from segmenter import Seg, build_segments, to_dicts

# Load server/.env (next to this file) regardless of the working directory.
# Real environment variables take precedence over values in .env.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"), override=False)

MODEL = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1")
HF_TOKEN = os.environ.get("HF_TOKEN")

app = FastAPI(title="SpeakerCut")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_pipeline = None
_lock = threading.Lock()


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from pyannote.audio import Pipeline

        if not HF_TOKEN:
            raise RuntimeError("HF_TOKEN is not set. Put it in server/.env (see .env.example).")

        try:
            p = Pipeline.from_pretrained(MODEL, token=HF_TOKEN)          # pyannote >= 4
        except TypeError:
            p = Pipeline.from_pretrained(MODEL, use_auth_token=HF_TOKEN)  # pyannote 3.x
        if p is None:
            raise RuntimeError(f"Could not load {MODEL}. Check HF_TOKEN and that you accepted the model terms.")
        if torch.cuda.is_available():
            p.to(torch.device("cuda"))
        _pipeline = p
    return _pipeline


def _annotation(output):
    # pyannote 4 returns DiarizeOutput; 3.x returns an Annotation
    return getattr(output, "speaker_diarization", output)


def _to_wav_bytes(wav: torch.Tensor, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, wav.squeeze(0).numpy(), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "loaded": _pipeline is not None, "cuda": torch.cuda.is_available(),
            "hf_token_set": bool(HF_TOKEN), "providers": providers.available(),
            "separation": separation.available()}


@app.post("/diarize")
async def diarize(
    file: UploadFile = File(...),
    provider: str = Form("local"),
    remove_music: bool = Form(False),
    max_gap: float = Form(1.5),
    max_dur: float = Form(30.0),
    pad: float = Form(0.2),
    min_seg: float = Form(1.0),
    num_speakers: int = Form(0),
    min_speakers: int = Form(0),
    max_speakers: int = Form(0),
    drop_overlap: bool = Form(True),
):
    raw = await file.read()
    try:
        audio, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(400, f"Could not read audio: {e}")
    wav = torch.from_numpy(np.ascontiguousarray(audio.T))  # (channels, time)
    if wav.shape[0] > 1:
        wav = wav.mean(0, keepdim=True)
    duration = wav.shape[1] / sr

    # Optional: diarize on the vocals stem only (music/background removed). Timing is unchanged.
    if remove_music:
        if not separation.available():
            raise HTTPException(400, "Music removal is not installed. Run: uv sync --extra separation")
        wav = await run_in_threadpool(separation.vocals_only, wav, sr, 16000)
        sr = 16000

    try:
        if provider == "local":
            kwargs = providers._speaker_kwargs(num_speakers, min_speakers, max_speakers)

            def _run():
                with _lock:  # one job at a time on the GPU
                    return _annotation(get_pipeline()({"waveform": wav, "sample_rate": sr}, **kwargs))

            ann = await run_in_threadpool(_run)
            turns = [Seg(t.start, t.end, spk) for t, _, spk in ann.itertracks(yield_label=True)]
        elif provider == "pyannoteai":
            turns = await run_in_threadpool(providers.pyannoteai, _to_wav_bytes(wav, sr),
                                            num_speakers, min_speakers, max_speakers)
        else:
            raise HTTPException(400, f"Unknown provider {provider!r}")
    except providers.ProviderError as e:
        raise HTTPException(502, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    segs = build_segments(turns, duration, max_gap=max_gap, max_dur=max_dur, pad=pad,
                          min_seg=min_seg, drop_overlap=drop_overlap)
    return {
        "provider": provider,
        "remove_music": remove_music,
        "duration": round(duration, 3),
        "num_speakers": len({t.speaker for t in turns}),
        "segments": to_dicts(segs),
    }

