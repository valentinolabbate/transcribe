# Obsidian Live Transcriber — CLAUDE.md

## Goal

Obsidian community plugin (installable via BRAT) for live audio transcription with speaker
diarization. Optimized for Apple Silicon (MLX + MPS). Outputs live Markdown to the Obsidian vault.

---

## Architecture

Two components communicate via **stdio (JSON Lines)**:

**Obsidian Plugin (TypeScript/Electron)**
- Audio capture via Web Audio API (mic via `getUserMedia`, system audio via `getDisplayMedia`)
- Spawns Python backend as child process
- Writes transcription segments live to vault via `app.vault.adapter.append()`

**Python Backend (subprocess)**
- Receives raw PCM audio as Base64 Float32 chunks via stdin
- Pipeline: VAD chunking → mlx-whisper → pyannote 3.1 diarization → timestamp alignment
- Returns speaker-labeled segments as JSON Lines via stdout

---

## Critical Constraints

### BRAT Compatibility (most important constraint)

BRAT downloads **only** `manifest.json`, `main.js`, and `styles.css` from GitHub Releases.
Python backend files cannot be distributed as separate files.

**Solution:** Pre-build script `scripts/embed-backend.mjs` reads all `backend/*.py` and
`backend/requirements.txt`, and generates `src/backend-embed.ts` containing their content as
exported string constants. On first plugin activation, `main.ts` extracts these files to disk.

Backend files land at:
```
<vault>/.obsidian/plugins/live-transcriber/backend/
```

Virtual environment at:
```
<vault>/.obsidian/plugins/live-transcriber/venv/
```

### Python Requirement

Python 3.10+ must be installed by the user (it is a stated prerequisite).
The plugin auto-detects via `which python3` (macOS/Linux) / `where python3` (Windows).

### System Audio on macOS

`getDisplayMedia({ audio: true })` in Electron requires the user to have BlackHole (or similar
virtual audio device) installed for true system audio capture. The plugin detects available audio
devices and shows a notice in Settings if system audio is selected.

---

## File Structure

```
obsidian-live-transcriber/
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── styles.css
├── src/
│   ├── main.ts              # Plugin entry point: onload, onunload, ribbon icon
│   ├── settings.ts          # SettingTab: HF-Token, Modell, Gerät, Vault-Pfad, pip install
│   ├── audio-recorder.ts    # Web Audio API: getUserMedia / getDisplayMedia, PCM → Base64
│   ├── python-manager.ts    # detect Python, create venv, pip install, spawn/kill subprocess
│   ├── session-writer.ts    # create session .md file, append segments live
│   ├── stdio-protocol.ts    # JSON Lines reader/writer over subprocess stdin/stdout
│   └── backend-embed.ts     # AUTO-GENERATED — do not edit manually
├── backend/
│   ├── requirements.txt
│   ├── main.py              # stdio JSON loop, lazy model loading, threading
│   ├── vad_chunker.py       # Silero VAD: accumulate PCM, emit chunks
│   ├── transcriber.py       # mlx-whisper wrapper
│   ├── diarizer.py          # pyannote.audio 3.1 wrapper (MPS backend)
│   └── aligner.py           # align whisper timestamps with pyannote speaker segments
├── scripts/
│   └── embed-backend.mjs    # prebuild: backend/*.py + requirements.txt → backend-embed.ts
└── .github/
    └── workflows/
        └── release.yml      # on tag push: build → GitHub Release with main.js + manifest.json
```

---

## stdio Protocol (JSON Lines)

Every message is a single-line JSON object terminated by `\n`.
**Python must always use `print(..., flush=True)`.** TypeScript reads line by line via readline.
Python errors go to stderr only — stdout is reserved for the protocol.

### Plugin → Python

```json
{"type":"config","model":"mlx-community/whisper-large-v3-turbo","hf_token":"hf_...","sample_rate":16000,"language":"de"}
{"type":"chunk","pcm_b64":"<base64 float32 little-endian>","offset_s":0.0}
{"type":"stop"}
```

### Python → Plugin

```json
{"type":"ready"}
{"type":"status","message":"Models loaded"}
{"type":"segment","speaker":"Speaker 1","text":"Hier der Text.","start":5.2,"end":8.1}
{"type":"error","message":"pyannote model not found"}
```

---

## TypeScript Implementation Notes

**Get plugin directory:**
```typescript
import { FileSystemAdapter } from 'obsidian';
const adapter = this.app.vault.adapter as FileSystemAdapter;
const pluginDir = path.join(adapter.getBasePath(), '.obsidian', 'plugins', 'live-transcriber');
```

**Spawn subprocess:**
```typescript
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
const venvPython = path.join(pluginDir, 'venv', 'bin', 'python3'); // macOS/Linux
const proc = spawn(venvPython, [path.join(pluginDir, 'backend', 'main.py')], {
  stdio: ['pipe', 'pipe', 'pipe']
});
// proc.stdin  → write JSON lines
// proc.stdout → readline, parse JSON
// proc.stderr → log warnings/errors to console
```

**Audio capture (16 kHz, mono):**
```typescript
const ctx = new AudioContext({ sampleRate: 16000 });
const source = ctx.createMediaStreamSource(stream);
// Use ScriptProcessorNode (bufferSize: 4096) or AudioWorklet
// Collect buffers until chunkSeconds reached, then encode and send
// Float32Array → Base64: Buffer.from(f32arr.buffer).toString('base64')
```

**Vault writing:**
```typescript
// On session start:
await this.app.vault.create(filePath, frontmatter);
// On each segment:
await this.app.vault.adapter.append(filePath, segmentMarkdown);
```

**Settings (saved via `this.loadData()` / `this.saveData()`):**
```typescript
interface TranscriberSettings {
  pythonPath: string;       // '' = auto-detect
  hfToken: string;
  whisperModel: string;     // default: 'mlx-community/whisper-large-v3-turbo'
  outputFolder: string;     // default: 'Transcripts'
  audioSource: 'microphone' | 'system';
  chunkSeconds: number;     // default: 8
}
```

---

## Python Implementation Notes

**requirements.txt:**
```
mlx-whisper
pyannote.audio
torch
silero-vad
numpy
soundfile
```

**main.py structure:**
```python
import sys, json, threading, base64, numpy as np
from concurrent.futures import ThreadPoolExecutor

executor = ThreadPoolExecutor(max_workers=2)
whisper_model = None
diarizer_pipeline = None

def send(msg: dict):
    print(json.dumps(msg), flush=True)

def handle_config(msg):
    # Load mlx-whisper and pyannote models here (blocking, send status updates)
    send({"type": "ready"})

def handle_chunk(msg):
    pcm = np.frombuffer(base64.b64decode(msg['pcm_b64']), dtype=np.float32)
    offset = msg['offset_s']
    # Submit transcription + diarization to executor, align, send segments

for line in sys.stdin:
    try:
        msg = json.loads(line.strip())
        if msg['type'] == 'config': handle_config(msg)
        elif msg['type'] == 'chunk': handle_chunk(msg)
        elif msg['type'] == 'stop': break
    except Exception as e:
        send({"type": "error", "message": str(e)})
```

**mlx-whisper call:**
```python
import mlx_whisper
result = mlx_whisper.transcribe(pcm, path_or_hf_repo=model, language=language, word_timestamps=True)
```

**pyannote call:**
```python
import torch, soundfile as sf, io
# pyannote expects a file path or dict with waveform + sample_rate
audio_dict = {"waveform": torch.from_numpy(pcm).unsqueeze(0), "sample_rate": 16000}
diarization = pipeline(audio_dict)
# diarization yields (turn, _, speaker) tuples with .start and .end
```

**Aligner:** For each whisper segment, find the pyannote speaker whose time range has the maximum
overlap with the segment's `[start, end]`. Assign that speaker label. Maintain a global speaker
name mapping (SPEAKER_00 → "Speaker 1") consistent across chunks by comparing speaker embeddings
or simply tracking first-seen order.

---

## Markdown Output Format

**Filename:** `Transcripts/Transkript 2026-05-28 14-30.md`

**Content** (frontmatter written once at session start, segments appended):
```markdown
---
created: 2026-05-28T14:30:00
audio_source: microphone
model: whisper-large-v3-turbo
---

# Transkript – 28.05.2026 14:30

**Speaker 1** · `00:00:05`
Hier der transkribierte Text...

**Speaker 2** · `00:00:18`
Und die Antwort...
```

Each appended segment is a two-line block: `\n**Speaker N** · \`HH:MM:SS\`\nText\n`

---

## Build Pipeline

**package.json scripts:**
```json
{
  "scripts": {
    "dev":   "node scripts/embed-backend.mjs && node esbuild.config.mjs",
    "build": "node scripts/embed-backend.mjs && node esbuild.config.mjs production"
  }
}
```

**embed-backend.mjs** reads every file in `backend/`, produces:
```typescript
// src/backend-embed.ts  —  AUTO-GENERATED, do not edit
export const BACKEND_FILES: Record<string, string> = {
  "main.py": `...raw source...`,
  "vad_chunker.py": `...`,
  "requirements.txt": `...`,
  // etc.
};
```

`main.ts` writes these files on first activation:
```typescript
import { BACKEND_FILES } from './backend-embed';
for (const [filename, content] of Object.entries(BACKEND_FILES)) {
  const dest = path.join(pluginDir, 'backend', filename);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, content, 'utf8');
}
```

**release.yml** (GitHub Actions, triggers on tag `v*.*.*`):
1. `npm ci && npm run build`
2. Create GitHub Release
3. Upload `manifest.json`, `main.js`, `styles.css` as release assets

---

## Implementation Order

Work through these steps sequentially. Complete and test each before moving to the next.

1. **Plugin scaffold** — `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.mjs`,
   bare-bones `main.ts` with `onload()`/`onunload()`. Verify it loads in Obsidian without errors.

2. **embed-backend.mjs + stub backend** — create stub `backend/main.py` (just prints `{"type":"ready"}`),
   stub other `.py` files, `requirements.txt`. Run `npm run build`, verify `backend-embed.ts` is generated
   and `main.js` embeds the Python source.

3. **python-manager.ts** — detect Python executable, create venv, run pip install, spawn subprocess,
   write backend files to plugin folder on first run, kill process on `onunload()`.

4. **stdio-protocol.ts** — JSON Lines writer on `proc.stdin`, readline reader on `proc.stdout`,
   EventEmitter that fires on each parsed segment. Log stderr to console.

5. **End-to-end stub test** — wire `python-manager` + `stdio-protocol` in `main.ts`, send a
   `{"type":"config"}` message on load, verify `{"type":"ready"}` is received and logged.

6. **audio-recorder.ts** — Web Audio API capture at 16 kHz, Float32 buffer accumulation,
   Base64 encoding, send `chunk` messages via `stdio-protocol`. Test with stub Python echoing
   input back as segments.

7. **Python backend (real)** — implement `vad_chunker.py`, `transcriber.py`, `diarizer.py`,
   `aligner.py`. Test standalone with a WAV file before wiring to the plugin.

8. **session-writer.ts** — create dated `.md` file in configured output folder, append segments
   as they arrive.

9. **settings.ts** — SettingTab with all config fields, "Install Dependencies" button that runs
   pip install and shows progress via `new Notice()`.

10. **UI polish** — ribbon icon (microphone), status bar item showing recording state, stop button.

11. **release.yml** — GitHub Actions workflow for automated BRAT-compatible releases.

---

## Notes

- Target platform: macOS Apple Silicon (M-series). Do not add Windows-specific code unless
  explicitly asked.
- The `venv/bin/python3` path is macOS/Linux. Add a platform check for Windows (`venv/Scripts/python.exe`)
  as a fallback but don't prioritize it.
- pyannote requires the user to accept model terms on HuggingFace before the token works.
  Show a link to `huggingface.co/pyannote/speaker-diarization-3.1` in Settings.
- mlx-whisper models are downloaded to `~/.cache/huggingface/` on first use.
- If `getDisplayMedia` fails for system audio, fall back gracefully and show a Notice with
  BlackHole installation instructions.
- Keep `backend-embed.ts` in `.gitignore` — it is generated at build time.
