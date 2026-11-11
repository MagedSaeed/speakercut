"""Diarization providers. Each returns a list of raw speaker turns (Seg), possibly overlapping.

  local       pyannote open-source model on this machine (free; needs HF_TOKEN)
  pyannoteai  pyannoteAI hosted Precision models (paid; needs PYANNOTEAI_API_KEY)
  elevenlabs  ElevenLabs Scribe speech-to-text with diarization (paid; needs ELEVENLABS_API_KEY)
"""
from __future__ import annotations

import os
import time
import uuid

import httpx

from segmenter import Seg


class ProviderError(RuntimeError):
    pass


def _speaker_kwargs(num: int, lo: int, hi: int) -> dict:
    if num > 0:
        return {"num_speakers": num}
    out = {}
    if lo > 0:
        out["min_speakers"] = lo
    if hi > 0:
        out["max_speakers"] = hi
    return out


def available() -> dict:
    return {
        "local": bool(os.environ.get("HF_TOKEN")),
        "pyannoteai": bool(os.environ.get("PYANNOTEAI_API_KEY")),
        "elevenlabs": bool(os.environ.get("ELEVENLABS_API_KEY")),
    }


# ---------------------------------------------------------------- pyannoteAI
PYA_BASE = "https://api.pyannote.ai/v1"


def pyannoteai(wav_bytes: bytes, num: int, lo: int, hi: int, timeout_s: float = 600) -> list[Seg]:
    key = os.environ.get("PYANNOTEAI_API_KEY")
    if not key:
        raise ProviderError("PYANNOTEAI_API_KEY is not set in server/.env")
    model = os.environ.get("PYANNOTEAI_MODEL", "precision-2")
    h = {"Authorization": f"Bearer {key}"}
    with httpx.Client(timeout=120) as c:
        # 1) temporary storage (auto-deleted by pyannoteAI within 48 h), 2) upload, 3) job, 4) poll
        media = f"media://speakercut/{uuid.uuid4().hex}.wav"
        r = c.post(f"{PYA_BASE}/media/input", headers=h, json={"url": media})
        if r.status_code >= 300:
            raise ProviderError(f"pyannoteAI media/input {r.status_code}: {r.text[:300]}")
        put = c.put(r.json()["url"], content=wav_bytes, headers={"Content-Type": "audio/wav"})
        if put.status_code >= 300:
            raise ProviderError(f"pyannoteAI upload {put.status_code}: {put.text[:300]}")

        body = {"url": media, "model": model}
        sk = _speaker_kwargs(num, lo, hi)
        if "num_speakers" in sk:
            body["numSpeakers"] = sk["num_speakers"]
        if "min_speakers" in sk:
            body["minSpeakers"] = sk["min_speakers"]
        if "max_speakers" in sk:
            body["maxSpeakers"] = sk["max_speakers"]
        r = c.post(f"{PYA_BASE}/diarize", headers=h, json=body)
        if r.status_code >= 300:
            raise ProviderError(f"pyannoteAI diarize {r.status_code}: {r.text[:300]}")
        job = r.json()["jobId"]

        t0 = time.time()
        while True:
            r = c.get(f"{PYA_BASE}/jobs/{job}", headers=h)
            if r.status_code == 429:
                time.sleep(float(r.headers.get("Retry-After", 3)))
                continue
            if r.status_code >= 300:
                raise ProviderError(f"pyannoteAI job {r.status_code}: {r.text[:300]}")
            j = r.json()
            st = j.get("status")
            if st == "succeeded":
                turns = (j.get("output") or {}).get("diarization") or []
                return [Seg(t["start"], t["end"], str(t["speaker"])) for t in turns]
            if st in ("failed", "canceled"):
                raise ProviderError(f"pyannoteAI job {st}: {str(j)[:300]}")
            if time.time() - t0 > timeout_s:
                raise ProviderError("pyannoteAI job timed out")
            time.sleep(2)


# ---------------------------------------------------------------- ElevenLabs
def elevenlabs(wav_bytes: bytes, num: int, lo: int, hi: int, word_gap: float = 0.6) -> list[Seg]:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise ProviderError("ELEVENLABS_API_KEY is not set in server/.env")
    data = {
        "model_id": os.environ.get("ELEVENLABS_MODEL", "scribe_v2"),
        "diarize": "true",
        "timestamps_granularity": "word",
        "tag_audio_events": "false",
    }
    lang = os.environ.get("ELEVENLABS_LANGUAGE", "ara")
    if lang:
        data["language_code"] = lang
    max_spk = num if num > 0 else hi  # ElevenLabs only takes a maximum
    if max_spk > 0:
        data["num_speakers"] = str(max_spk)
    with httpx.Client(timeout=600) as c:
        r = c.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers={"xi-api-key": key},
            data=data,
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
        )
    if r.status_code >= 300:
        raise ProviderError(f"ElevenLabs {r.status_code}: {r.text[:300]}")
    words = [w for w in r.json().get("words", [])
             if w.get("type") == "word" and w.get("start") is not None and w.get("end") is not None]
    # words -> speaker turns (contiguous words of one speaker)
    turns: list[Seg] = []
    for w in words:
        spk = str(w.get("speaker_id") or "speaker_0")
        if turns and turns[-1].speaker == spk and w["start"] - turns[-1].end <= word_gap:
            turns[-1].end = max(turns[-1].end, float(w["end"]))
        else:
            turns.append(Seg(float(w["start"]), float(w["end"]), spk))
    return turns
