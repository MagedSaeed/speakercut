# SpeakerCut diarization server
#   docker build -t speakercut-server .   (see README for the docker run command)
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# ffmpeg: audio decoding backend used by pyannote/torchaudio
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Dependencies first so code changes don't reinstall torch
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY *.py ./

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
