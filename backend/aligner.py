"""Align whisper timestamps with pyannote speaker segments.

For each whisper segment, pick the pyannote speaker whose time range overlaps
the segment most. A global, first-seen-order mapping turns raw pyannote labels
(SPEAKER_00, ...) into stable display names ("Speaker 1", ...) that stay
consistent across chunks for the lifetime of the session.
"""


class Aligner:
    def __init__(self) -> None:
        self._speaker_names: dict[str, str] = {}

    def _display_name(self, raw_label: str) -> str:
        if raw_label not in self._speaker_names:
            self._speaker_names[raw_label] = f"Speaker {len(self._speaker_names) + 1}"
        return self._speaker_names[raw_label]

    def align(self, whisper_segments, diarization, offset_s: float = 0.0):
        """Return labeled segments: {speaker, text, start, end} (absolute time)."""
        out = []
        for seg in whisper_segments:
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            start = float(seg["start"])
            end = float(seg["end"])
            raw = self._best_speaker(start, end, diarization)
            speaker = self._display_name(raw) if raw is not None else "Speaker 1"
            out.append(
                {
                    "speaker": speaker,
                    "text": text,
                    "start": start + offset_s,
                    "end": end + offset_s,
                }
            )
        return out

    @staticmethod
    def _best_speaker(start: float, end: float, diarization):
        """Raw label with the most overlap on [start, end], or None."""
        best_label = None
        best_overlap = 0.0
        for d_start, d_end, label in diarization:
            overlap = min(end, d_end) - max(start, d_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_label = label
        return best_label
