"""Live Transcriber backend — stdio JSON Lines loop.

Pipeline (see CLAUDE.md): VAD chunking -> mlx-whisper -> pyannote diarization
-> timestamp alignment. Models load lazily on the `config` message. Incoming
audio chunks are re-cut by the VAD and handed to a single worker thread, which
transcribes, diarizes, aligns, and emits speaker-labeled segments — keeping the
stdin loop responsive and segment output ordered.

Protocol:
  Plugin -> Python:  {"type":"config"|"chunk"|"stop", ...}
  Python -> Plugin:  {"type":"ready"|"status"|"segment"|"error", ...}

stdout is reserved for the protocol — always print(..., flush=True) via send().
Diagnostics and tracebacks go to stderr only.
"""

import sys
import json
import base64
import threading
import queue
import traceback

import numpy as np

CONFIG = {"sample_rate": 16000}

_send_lock = threading.Lock()
_work_q: "queue.Queue" = queue.Queue()
_worker: "threading.Thread | None" = None

vad = None
transcriber = None
diarizer = None
aligner = None


def send(msg: dict) -> None:
    """Thread-safe single-line JSON protocol write to stdout."""
    with _send_lock:
        print(json.dumps(msg), flush=True)


def log(*args) -> None:
    print("[backend]", *args, file=sys.stderr, flush=True)


def handle_config(msg: dict) -> None:
    global vad, transcriber, diarizer, aligner, _worker

    sample_rate = int(msg.get("sample_rate", 16000))
    model = msg.get("model") or "mlx-community/whisper-large-v3-turbo"
    language = msg.get("language") or None
    hf_token = msg.get("hf_token") or ""
    CONFIG["sample_rate"] = sample_rate

    send({"type": "status", "message": "Loading voice-activity detector..."})
    from vad_chunker import VadChunker
    vad = VadChunker(sample_rate=sample_rate)

    send({"type": "status", "message": f"Loading Whisper model ({model})..."})
    from transcriber import Transcriber
    transcriber = Transcriber(model, language)

    from aligner import Aligner
    aligner = Aligner()

    if hf_token:
        send({"type": "status", "message": "Loading speaker diarization..."})
        try:
            from diarizer import Diarizer
            diarizer = Diarizer(hf_token, sample_rate)
        except Exception as e:
            diarizer = None
            log("diarization load failed:", traceback.format_exc())
            send({"type": "status", "message": f"Diarization disabled: {e}"})
    else:
        diarizer = None
        send({"type": "status", "message": "No HF token — diarization disabled."})

    _worker = threading.Thread(target=_worker_loop, daemon=True)
    _worker.start()

    send({"type": "ready"})


def _worker_loop() -> None:
    while True:
        item = _work_q.get()
        if item is None:
            break
        pcm, start_s = item
        try:
            segments = transcriber.transcribe(pcm)
            diarization = diarizer.diarize(pcm) if diarizer else []
            for out in aligner.align(segments, diarization, offset_s=start_s):
                send({"type": "segment", **out})
        except Exception as e:
            log("processing failed:", traceback.format_exc())
            send({"type": "error", "message": f"processing failed: {e}"})


def handle_chunk(msg: dict) -> None:
    if vad is None:
        send({"type": "error", "message": "received chunk before config"})
        return
    pcm = np.frombuffer(base64.b64decode(msg.get("pcm_b64", "")), dtype=np.float32).copy()
    offset = float(msg.get("offset_s", 0.0))
    for chunk, start_s in vad.push(pcm, offset):
        _work_q.put((chunk, start_s))


def handle_flush() -> None:
    """Emit trailing speech but keep the backend (and models) resident."""
    if vad is not None:
        for chunk, start_s in vad.flush():
            _work_q.put((chunk, start_s))


def handle_stop() -> None:
    handle_flush()
    _work_q.put(None)
    if _worker is not None:
        _worker.join(timeout=120)


def main() -> None:
    log("backend started")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            msg_type = msg.get("type")
            if msg_type == "config":
                handle_config(msg)
            elif msg_type == "chunk":
                handle_chunk(msg)
            elif msg_type == "flush":
                handle_flush()
            elif msg_type == "stop":
                handle_stop()
                break
            else:
                send({"type": "error", "message": f"unknown message type: {msg_type!r}"})
        except json.JSONDecodeError as e:
            send({"type": "error", "message": f"invalid JSON: {e}"})
        except Exception as e:  # noqa: BLE001 — protocol must surface all errors
            log("fatal in main loop:", traceback.format_exc())
            send({"type": "error", "message": str(e)})


if __name__ == "__main__":
    main()
