"""Silero VAD chunker.

Accumulates incoming PCM (the plugin sends fixed-length chunks) and re-cuts it
into speech-bounded chunks for transcription. A speech region is only emitted
once it's followed by enough trailing silence (so we don't cut mid-utterance),
or once the buffer grows past `max_buffer_s` (so a long monologue still flows).
"""

import numpy as np


class VadChunker:
    def __init__(
        self,
        sample_rate: int = 16000,
        min_silence_s: float = 0.7,
        min_speech_s: float = 0.4,
        max_buffer_s: float = 30.0,
    ) -> None:
        # Imported lazily so the module can be inspected without torch present.
        import torch
        from silero_vad import load_silero_vad, get_speech_timestamps

        self._torch = torch
        self._get_speech_timestamps = get_speech_timestamps
        self._model = load_silero_vad()

        self.sample_rate = sample_rate
        self.min_silence_samples = int(min_silence_s * sample_rate)
        self.min_speech_samples = int(min_speech_s * sample_rate)
        self.max_buffer_samples = int(max_buffer_s * sample_rate)

        self._buf = np.zeros(0, dtype=np.float32)
        self._buf_start = 0.0  # absolute seconds of self._buf[0]

    def push(self, pcm: np.ndarray, offset_s: float):
        """Append audio; return a list of (chunk_pcm, chunk_start_s) ready now."""
        if self._buf.size == 0:
            self._buf_start = offset_s
        self._buf = np.concatenate([self._buf, pcm.astype(np.float32, copy=False)])
        return self._extract(final=False)

    def flush(self):
        """Emit any remaining speech (call on stop)."""
        out = self._extract(final=True)
        self._buf = np.zeros(0, dtype=np.float32)
        return out

    def _speech_timestamps(self):
        return self._get_speech_timestamps(
            self._torch.from_numpy(self._buf),
            self._model,
            sampling_rate=self.sample_rate,
            min_silence_duration_ms=int(self.min_silence_samples / self.sample_rate * 1000),
            min_speech_duration_ms=int(self.min_speech_samples / self.sample_rate * 1000),
        )

    def _extract(self, final: bool):
        emitted = []
        if self._buf.size < self.min_speech_samples and not final:
            return emitted

        speeches = self._speech_timestamps()
        if not speeches:
            # No speech detected. Drop leading audio to bound memory.
            if self._buf.size > self.max_buffer_samples:
                drop = self._buf.size - self.max_buffer_samples
                self._buf = self._buf[drop:]
                self._buf_start += drop / self.sample_rate
            return emitted

        consumed_until = 0
        over_budget = self._buf.size >= self.max_buffer_samples
        for i, s in enumerate(speeches):
            start_i, end_i = s["start"], s["end"]
            is_last = i == len(speeches) - 1
            trailing = self._buf.size - end_i
            # The last region may still be growing — wait for trailing silence,
            # unless we're flushing or the buffer is over budget.
            if is_last and not final and not over_budget and trailing < self.min_silence_samples:
                break
            chunk = self._buf[start_i:end_i].copy()
            chunk_start = self._buf_start + start_i / self.sample_rate
            emitted.append((chunk, chunk_start))
            consumed_until = end_i

        if consumed_until > 0:
            self._buf = self._buf[consumed_until:]
            self._buf_start += consumed_until / self.sample_rate
        return emitted
