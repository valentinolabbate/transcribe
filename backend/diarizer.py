"""pyannote.audio 3.1 speaker diarization wrapper (MPS backend).

Requires a HuggingFace token whose account has accepted the model terms at
huggingface.co/pyannote/speaker-diarization-3.1. Construction downloads the
pipeline on first use and may block.
"""

import numpy as np


class Diarizer:
    def __init__(self, hf_token: str, sample_rate: int = 16000) -> None:
        if not hf_token:
            raise ValueError("diarization requires a HuggingFace token")
        self.sample_rate = sample_rate

        import torch
        from pyannote.audio import Pipeline

        self._torch = torch
        self.pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )
        if self.pipeline is None:
            raise RuntimeError(
                "pyannote pipeline failed to load — check token and model terms "
                "acceptance at huggingface.co/pyannote/speaker-diarization-3.1"
            )
        # Apple Silicon GPU when available; harmless fallback to CPU otherwise.
        if torch.backends.mps.is_available():
            self.pipeline.to(torch.device("mps"))

    def diarize(self, pcm: np.ndarray):
        """Return a list of (start_s, end_s, speaker_label) tuples."""
        waveform = self._torch.from_numpy(
            pcm.astype(np.float32, copy=False)
        ).unsqueeze(0)
        diarization = self.pipeline(
            {"waveform": waveform, "sample_rate": self.sample_rate}
        )
        return [
            (turn.start, turn.end, speaker)
            for turn, _, speaker in diarization.itertracks(yield_label=True)
        ]
