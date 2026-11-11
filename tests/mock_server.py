import io, sys, pathlib, soundfile as sf
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "server"))
from fastapi import FastAPI, File, Form, UploadFile
from segmenter import Seg, build_segments, to_dicts
app = FastAPI()
LAST = {}
@app.get("/health")
def health(): return {"ok": True, "model": "mock", "loaded": True, "cuda": False}
@app.get("/last")
def last(): return LAST
@app.post("/diarize")
async def diarize(file: UploadFile = File(...), max_dur: float = Form(30),
                  pad: float = Form(0.2), min_seg: float = Form(1.0), num_speakers: int = Form(0), drop_overlap: bool = Form(True)):
    a, sr = sf.read(io.BytesIO(await file.read()), always_2d=True)
    dur = len(a) / sr
    LAST.update(sr=sr, channels=a.shape[1], duration=dur, max_dur=max_dur)
    turns = [Seg(0.5, 4, "A"), Seg(4.5, 8, "A"), Seg(8.2, 12, "B"), Seg(11.5, 12.5, "A"), Seg(13, 19, "A")]
    segs = build_segments(turns, dur, max_dur=max_dur, pad=pad, min_seg=min_seg, drop_overlap=drop_overlap)
    return {"duration": dur, "num_speakers": 2, "segments": to_dicts(segs)}
