# SpeakerCut — Speaker Presegmenter for Label Studio

Speaker-diarization pre-segmentation for the Cinnamon Label Studio projects.
One click adds **draft** `Speaker segment` regions (one speaker, no overlap, ~30 s max) to the open task.
You then check the boundaries and fill in the transcript and labels yourself.

**It never submits.** It never clicks Submit, Update or Skip, and never calls the Label Studio annotation API.
Note: Label Studio's own autosave may store your in-progress work as a *draft*, just as it does when you add segments by hand.

## 1. Start the diarization server (GPU machine or laptop)

You need a Hugging Face token (read access) and to accept the terms of
[`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1) first.

```bash
cd server
cp .env.example .env     # then put your HF_TOKEN in .env
```

`.env` is git-ignored; a real `HF_TOKEN` environment variable overrides it. The status in the extension popup warns if the token is missing.
Write values without quotes and keep comments on their own lines (Docker's `--env-file` reads the rest of the line literally).

### Option A: Docker (easiest)

Requires [Docker](https://docs.docker.com/get-docker/).

```bash
cd server
docker build -t speakercut-server .     # first build downloads torch etc. and takes a while
docker run -d --name speakercut-server --restart unless-stopped \
  --env-file .env -p 127.0.0.1:8000:8000 -v speakercut-cache:/root/.cache \
  speakercut-server
```

- The server listens on `http://127.0.0.1:8000` (only reachable from this machine). Downloaded models are kept in the `speakercut-cache` volume, so restarts are fast.
- NVIDIA GPU: install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) and add `--gpus all` to `docker run`. Without it the server runs on CPU.
- Logs: `docker logs -f speakercut-server`. Stop: `docker stop speakercut-server` (start again with `docker start speakercut-server`).
- After changing `.env` or pulling new code, rebuild and restart in one line:
  ```bash
  docker build -t speakercut-server . && docker rm -f speakercut-server 2>/dev/null; docker run -d --name speakercut-server --restart unless-stopped --env-file .env -p 127.0.0.1:8000:8000 -v speakercut-cache:/root/.cache speakercut-server
  ```
- `speakercut-cache` is a Docker volume holding the downloaded pyannote and Demucs models; it survives `docker rm`, so models download only once. See its size with `docker system df -v`; delete it with `docker volume rm speakercut-cache` (models download again on the next run).

### Option B: uv

Requires [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`).

```bash
cd server
uv sync                  # creates .venv from pyproject.toml + uv.lock (pyannote.audio 4.x, torch, demucs)
uv run uvicorn app:app --host 127.0.0.1 --port 8000
```

`uv run` also works without `uv sync` first (it syncs automatically). Tests: `uv run pytest ../tests`.

### Running on the cluster

Start it on a GPU node (e.g. inside `srun --gres=gpu:1 --pty bash`), then from your laptop
tunnel straight to that node through the login node:
`ssh -J <login-node> -L 8000:127.0.0.1:8000 <gpu-node>`. The extension only talks to `localhost` / `127.0.0.1`.

To use pyannote 3.1 instead, set `DIARIZATION_MODEL=pyannote/speaker-diarization-3.1` in `.env`.

### Improving accuracy (optional)

Pick these in the extension popup:

| Provider | Key in `server/.env` | Notes |
|---|---|---|
| Local pyannote (default) | `HF_TOKEN` | Free, runs on your GPU/CPU. |
| pyannoteAI Precision | `PYANNOTEAI_API_KEY` | Hosted premium models from the pyannote authors (`PYANNOTEAI_MODEL=precision-2` or `precision-3`). Best choice when speakers get mixed. Paid per audio second; uploads are auto-deleted within 48 h. |

**Remove music first** runs Demucs vocal separation before diarization. Cut points are computed on the vocals but line up with the original audio. Helps with loud background music in series; leave it off for clean speech. Roughly real-time on CPU, seconds on GPU.

**Speaker-count hints** (exact, or min/max) are often the cheapest fix when two speakers get merged: if you know a clip has 3 people, say so.

Note: with a paid provider, the clip's audio is sent to that company.

## 2. Install the extension (Chrome, Edge or Brave)

The extension isn't on the Chrome Web Store; you load it from this repository.

1. Get the code: `git clone https://github.com/MagedSaeed/speakercut.git`
   (or on GitHub click **Code → Download ZIP** and unzip it). Keep the folder somewhere permanent; the browser loads the extension from it.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder inside the repository (the one containing `manifest.json`).
5. Pin it: click the puzzle-piece icon in the toolbar → pin **SpeakerCut**.
6. Click the SpeakerCut icon. Leave **Server** as `http://127.0.0.1:8000` (or set your own). The status in the top-right corner should turn green and say **Online**; changes save automatically.

Chrome may show a "developer mode extensions" notice on startup; that's expected for extensions loaded this way.

**Updating:** run `git pull` in the repository (or download the ZIP again into the same folder), then open `chrome://extensions` and click the reload ↻ icon on the SpeakerCut card. Reload any open Label Studio tabs afterwards. Your settings are kept.

## 3. Use it

Open a task. A row with **Presegment** / **Remove auto** appears right under the Video Tutorial / Guidelines links (floating bar as fallback on other layouts). Presegment stays disabled until the audio has finished loading.

- Presegment reuses the audio Label Studio has already decoded for the waveform (no second download), resamples it to 16 kHz mono, sends it to your server, and adds the segments. (Downloading the media itself is only a last-resort fallback.)
- If the task already has segments, it warns first. Click again within 6 s to add anyway.
- Remove auto deletes only the segments the extension added on this task (Ctrl+Z also works).

## Segmentation rules (server/segmenter.py)

1. Overlapping speech (2+ speakers at once) is cut out.
2. Consecutive turns of the same speaker are merged, however long the pause, as long as nobody else speaks in between and the result stays ≤ `max_dur` (30 s; 0 = unlimited, i.e. one segment per speaker turn).
3. Edges are padded by `pad` (0.2 s) so words aren't clipped, but never into another speaker's speech.
4. Segments shorter than `min_seg` (1 s) are dropped.

All of these can be changed in the extension popup.

## Tests

`pytest tests/` (segmentation logic). `tests/e2e.js` runs the extension in Chromium against a mock Label Studio page and a mock server.
