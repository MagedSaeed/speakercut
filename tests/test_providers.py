import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "server"))
import httpx, pytest
import providers

def patch_client(monkeypatch, handler):
    real = httpx.Client
    monkeypatch.setattr(providers.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(providers.time, "sleep", lambda s: None)

def test_pyannoteai_flow(monkeypatch):
    monkeypatch.setenv("PYANNOTEAI_API_KEY", "k")
    calls, polls = [], {"n": 0}
    def h(req):
        calls.append((req.method, str(req.url)))
        if req.url.path == "/v1/media/input":
            assert req.headers["authorization"] == "Bearer k"
            assert json.loads(req.content)["url"].startswith("media://")
            return httpx.Response(201, json={"url": "https://upload.example/put"})
        if req.url.host == "upload.example":
            assert req.method == "PUT" and req.content == b"WAV"
            return httpx.Response(200)
        if req.url.path == "/v1/diarize":
            b = json.loads(req.content)
            assert b["model"] == "precision-2" and b["minSpeakers"] == 2 and b["maxSpeakers"] == 4 and "numSpeakers" not in b
            return httpx.Response(200, json={"jobId": "j1", "status": "created"})
        if req.url.path == "/v1/jobs/j1":
            polls["n"] += 1
            if polls["n"] < 3:
                return httpx.Response(200, json={"jobId": "j1", "status": "running"})
            return httpx.Response(200, json={"jobId": "j1", "status": "succeeded", "output": {
                "diarization": [{"speaker": "SPEAKER_00", "start": 0.5, "end": 3.0}, {"speaker": "SPEAKER_01", "start": 3.2, "end": 6.0}]}})
        raise AssertionError(req.url)
    patch_client(monkeypatch, h)
    turns = providers.pyannoteai(b"WAV", 0, 2, 4)
    assert [(t.speaker, t.start, t.end) for t in turns] == [("SPEAKER_00", 0.5, 3.0), ("SPEAKER_01", 3.2, 6.0)]
    assert polls["n"] == 3

def test_pyannoteai_failure(monkeypatch):
    monkeypatch.setenv("PYANNOTEAI_API_KEY", "k")
    def h(req):
        if req.url.path == "/v1/media/input": return httpx.Response(401, text="bad key")
    patch_client(monkeypatch, h)
    with pytest.raises(providers.ProviderError, match="401"):
        providers.pyannoteai(b"WAV", 0, 0, 0)

def test_elevenlabs_words_to_turns(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "e")
    def h(req):
        assert req.headers["xi-api-key"] == "e"
        body = req.content.decode("latin1")
        for f in ['name="model_id"', "scribe_v2", 'name="diarize"', 'name="language_code"', "ara", 'name="num_speakers"']:
            assert f in body, f
        w = lambda t, s, e, sp: {"text": t, "type": "word", "start": s, "end": e, "speaker_id": sp, "logprob": 0}
        return httpx.Response(200, json={"words": [
            w("a", 0.0, 0.4, "speaker_0"), {"text": " ", "type": "spacing", "start": 0.4, "end": 0.5},
            w("b", 0.5, 1.0, "speaker_0"), w("c", 1.2, 2.0, "speaker_1"), w("d", 2.1, 2.5, "speaker_1"),
            w("e", 4.0, 4.5, "speaker_1")]})
    patch_client(monkeypatch, h)
    turns = providers.elevenlabs(b"WAV", 0, 0, 3)
    assert [(t.speaker, t.start, t.end) for t in turns] == [("speaker_0", 0.0, 1.0), ("speaker_1", 1.2, 2.5), ("speaker_1", 4.0, 4.5)]

def test_missing_keys(monkeypatch):
    monkeypatch.delenv("PYANNOTEAI_API_KEY", raising=False); monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    with pytest.raises(providers.ProviderError): providers.pyannoteai(b"", 0, 0, 0)
    with pytest.raises(providers.ProviderError): providers.elevenlabs(b"", 0, 0, 0)
