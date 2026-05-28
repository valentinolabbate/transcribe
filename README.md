# Live Transcriber

An Obsidian plugin for **live audio transcription with speaker diarization**,
optimized for Apple Silicon (MLX + MPS). It captures microphone or system audio,
transcribes it with [mlx-whisper](https://github.com/ml-explore/mlx-examples),
labels speakers with [pyannote.audio](https://github.com/pyannote/pyannote-audio),
and writes a live Markdown transcript into your vault.

> **Platform:** macOS on Apple Silicon (M-series). Desktop only.

## How it works

A small Python backend runs as a subprocess and communicates with the plugin
over stdio (JSON Lines):

```
audio (Web Audio API) → VAD chunking → mlx-whisper → pyannote diarization
→ timestamp alignment → speaker-labeled Markdown
```

The backend is embedded in the plugin and extracted to
`<vault>/.obsidian/plugins/live-transcriber/backend/` on first activation; its
virtual environment lives next to it in `venv/`.

## Requirements

- macOS, Apple Silicon
- **Python 3.10+** installed and on your PATH (or set the path in settings)
- A **HuggingFace token** with accepted terms for
  [pyannote/embedding](https://huggingface.co/pyannote/embedding) — required only
  for speaker labels
- For **system audio** capture: a virtual audio device such as
  [BlackHole](https://github.com/ExistentialAudio/BlackHole)

### Capturing system audio (e.g. a Teams call)

macOS apps can't record the system output directly. Route it through a virtual
input device:

1. Install [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)
   (`brew install blackhole-2ch`).
2. In **Audio MIDI Setup**, create a **Multi-Output Device** combining your
   speakers/headphones **and** BlackHole — so you still hear the call while it's
   also sent to BlackHole. Set it as the system output (or the app's output).
3. In the plugin settings, set **Audio input device** to **BlackHole 2ch**.
4. Start transcription — it now captures whatever is playing.

To capture the call **and** your own mic, create an **Aggregate Device** of
BlackHole + your microphone and select that instead.

## Installation (BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. In BRAT: *Add Beta Plugin* → enter this repository's URL.
3. Enable **Live Transcriber** in *Community Plugins*.
4. Open the plugin settings and click **Install dependencies** (creates the venv
   and installs the Python packages — this can take several minutes).
5. Optionally paste your HuggingFace token to enable speaker diarization.

## Usage

- Click the microphone ribbon icon (or run *Toggle transcription*) to start.
- A dated transcript file is created in your configured output folder
  (default: `Transcripts/`).
- Click again (or run *Stop transcription*) to stop.

## Settings

| Setting | Description |
| --- | --- |
| Whisper model | mlx-whisper model id (default `mlx-community/whisper-large-v3-turbo`) |
| Language | ISO code (e.g. `de`, `en`); empty = auto-detect |
| Chunk length | Seconds of audio buffered per chunk |
| HuggingFace token | Enables speaker labels (voice-embedding identification) |
| Audio input device | Microphone, or a virtual device like BlackHole for system audio |
| Output folder | Vault-relative folder for transcripts |
| Python path | Explicit interpreter, or empty to auto-detect |

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # production build + typecheck
```

The Python backend sources live in `backend/`. A prebuild step
(`scripts/embed-backend.mjs`) bundles them into `src/backend-embed.ts` so they
ship inside `main.js` (BRAT only distributes `manifest.json`, `main.js`,
`styles.css`).

## License

MIT
