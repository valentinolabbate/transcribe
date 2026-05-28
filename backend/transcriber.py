"""mlx-whisper wrapper.

Transcribes a mono float32 PCM array (16 kHz) and returns whisper segments with
word-level timestamps. Models are downloaded to ~/.cache/huggingface on first
use; the first call therefore blocks while the model loads.
"""

import numpy as np


class Transcriber:
    def __init__(self, model: str, language: str | None = None) -> None:
        self.model = model
        self.language = language or None
        import mlx_whisper  # lazy import

        self._mlx_whisper = mlx_whisper

    def transcribe(self, pcm: np.ndarray):
        """Return a list of segment dicts: {start, end, text, ...}."""
        result = self._mlx_whisper.transcribe(
            pcm.astype(np.float32, copy=False),
            path_or_hf_repo=self.model,
            language=self.language,
            word_timestamps=True,
        )
        return result.get("segments", [])
