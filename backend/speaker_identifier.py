"""Online speaker identification via voice embeddings.

The previous design diarized each VAD chunk independently, so pyannote's local
labels (SPEAKER_00, ...) never lined up across chunks — every single-speaker
utterance became "Speaker 1". Instead we compute one speaker embedding per
speech chunk and match it against a growing set of global speaker centroids
(cosine similarity). New voices spawn a new speaker; known voices keep their id.
This yields speaker identities that stay consistent for the whole session.

Uses the WeSpeaker ResNet34 embedding (the same one pyannote's
speaker-diarization-3.1 pipeline relies on) for strong discrimination, including
between same-gender voices. Requires a HuggingFace token whose account has
accepted the terms for huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM.
"""

import numpy as np

EMBEDDING_MODEL = "pyannote/wespeaker-voxceleb-resnet34-LM"


class SpeakerIdentifier:
    def __init__(
        self,
        hf_token: str,
        sample_rate: int = 16000,
        similarity_threshold: float = 0.5,
        min_embed_s: float = 0.8,
    ) -> None:
        if not hf_token:
            raise ValueError("speaker identification requires a HuggingFace token")
        self.sample_rate = sample_rate
        self.similarity_threshold = similarity_threshold
        self.min_embed_samples = int(min_embed_s * sample_rate)

        import torch
        from pyannote.audio import Model, Inference

        self._torch = torch
        model = Model.from_pretrained(EMBEDDING_MODEL, use_auth_token=hf_token)
        if model is None:
            raise RuntimeError(
                f"{EMBEDDING_MODEL} failed to load — accept its terms at "
                f"huggingface.co/{EMBEDDING_MODEL} and check the token"
            )
        if torch.backends.mps.is_available():
            try:
                model.to(torch.device("mps"))
            except Exception:
                pass
        # window="whole" -> a single embedding vector for the whole input.
        self._inference = Inference(model, window="whole")

        self._centroids: list[np.ndarray] = []  # unit-norm speaker centroids
        self._counts: list[int] = []
        self._last_id: int = 0

    def identify(self, pcm: np.ndarray) -> int:
        """Return a stable global speaker index (0-based) for this chunk."""
        # Too short for a reliable embedding — treat as a continuation of the
        # previous speaker rather than risk a spurious new identity.
        if pcm.size < self.min_embed_samples and self._centroids:
            return self._last_id

        emb = self._embed(pcm)
        norm = np.linalg.norm(emb)
        if norm < 1e-9:
            return self._last_id
        emb = emb / norm

        best_i, best_sim = -1, -1.0
        for i, c in enumerate(self._centroids):
            sim = float(np.dot(emb, c))
            if sim > best_sim:
                best_sim, best_i = sim, i

        if best_i >= 0 and best_sim >= self.similarity_threshold:
            n = self._counts[best_i]
            merged = (self._centroids[best_i] * n + emb) / (n + 1)
            self._centroids[best_i] = merged / (np.linalg.norm(merged) + 1e-9)
            self._counts[best_i] += 1
            self._last_id = best_i
            return best_i

        self._centroids.append(emb)
        self._counts.append(1)
        self._last_id = len(self._centroids) - 1
        return self._last_id

    def _embed(self, pcm: np.ndarray) -> np.ndarray:
        waveform = self._torch.from_numpy(
            pcm.astype(np.float32, copy=False)
        ).unsqueeze(0)
        out = self._inference({"waveform": waveform, "sample_rate": self.sample_rate})
        return np.asarray(out, dtype=np.float32).reshape(-1)
