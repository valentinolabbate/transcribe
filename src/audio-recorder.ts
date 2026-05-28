export interface AudioRecorderOptions {
	/**
	 * Input device id from enumerateDevices(); '' / undefined = system default.
	 * Pick a virtual device (e.g. BlackHole) here to capture system audio.
	 */
	deviceId?: string;
	/** Target capture rate; backend is told the same value. Default 16000. */
	sampleRate?: number;
	/** Seconds of audio per emitted chunk. Default 8. */
	chunkSeconds?: number;
	/** Called with Base64 Float32 (LE) PCM and the chunk's start offset (s). */
	onChunk: (pcmB64: string, offsetS: number) => void;
	onError?: (err: Error) => void;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHUNK_SECONDS = 8;
const SCRIPT_BUFFER_SIZE = 4096;

/**
 * Captures mono audio from a chosen input device via getUserMedia, accumulates
 * Float32 PCM, and emits fixed-length Base64 chunks. System audio is captured
 * by selecting a virtual input device (e.g. BlackHole) — getDisplayMedia audio
 * is unreliable in Electron, so it isn't used. ScriptProcessorNode keeps this
 * dependency-free; it's deprecated but reliable in Electron.
 */
export class AudioRecorder {
	private readonly deviceId: string;
	private readonly sampleRate: number;
	private readonly chunkSeconds: number;
	private readonly onChunk: (pcmB64: string, offsetS: number) => void;
	private readonly onError?: (err: Error) => void;

	private ctx: AudioContext | null = null;
	private stream: MediaStream | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private processor: ScriptProcessorNode | null = null;

	private pending: Float32Array[] = [];
	private pendingSamples = 0;
	private chunkSamples = 0;
	private nextOffsetS = 0;
	private running = false;

	constructor(opts: AudioRecorderOptions) {
		this.deviceId = (opts.deviceId ?? '').trim();
		this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
		this.chunkSeconds = opts.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
		this.onChunk = opts.onChunk;
		this.onError = opts.onError;
	}

	isRecording(): boolean {
		return this.running;
	}

	/** The sample rate actually used (may differ from requested). */
	get actualSampleRate(): number {
		return this.ctx?.sampleRate ?? this.sampleRate;
	}

	async start(): Promise<void> {
		if (this.running) return;

		this.stream = await this.acquireStream();
		this.ctx = new AudioContext({ sampleRate: this.sampleRate });
		if (this.ctx.sampleRate !== this.sampleRate) {
			console.warn(
				`Live Transcriber: requested ${this.sampleRate} Hz but AudioContext ` +
					`runs at ${this.ctx.sampleRate} Hz — chunks use the actual rate.`,
			);
		}

		this.chunkSamples = Math.round(this.ctx.sampleRate * this.chunkSeconds);
		this.pending = [];
		this.pendingSamples = 0;
		this.nextOffsetS = 0;

		this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
		this.processor = this.ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
		this.processor.onaudioprocess = (e) => this.onAudio(e);

		this.sourceNode.connect(this.processor);
		// ScriptProcessorNode only fires while connected to a destination.
		this.processor.connect(this.ctx.destination);

		this.running = true;
	}

	/** Stop capture, flushing any buffered audio as a final chunk. */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;

		this.flush();

		if (this.processor) {
			this.processor.onaudioprocess = null;
			this.processor.disconnect();
			this.processor = null;
		}
		this.sourceNode?.disconnect();
		this.sourceNode = null;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
		if (this.ctx) {
			await this.ctx.close();
			this.ctx = null;
		}
	}

	private async acquireStream(): Promise<MediaStream> {
		const audio: MediaTrackConstraints = {
			channelCount: 1,
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		};
		if (this.deviceId) {
			audio.deviceId = { exact: this.deviceId };
		}
		return navigator.mediaDevices.getUserMedia({ audio, video: false });
	}

	private onAudio(e: AudioProcessingEvent): void {
		if (!this.running) return;
		// getChannelData returns a reused view — copy before buffering.
		const input = e.inputBuffer.getChannelData(0);
		this.pending.push(new Float32Array(input));
		this.pendingSamples += input.length;

		while (this.pendingSamples >= this.chunkSamples) {
			this.emitChunk(this.chunkSamples);
		}
	}

	/** Flush whatever is buffered (used on stop). */
	private flush(): void {
		if (this.pendingSamples > 0) {
			this.emitChunk(this.pendingSamples);
		}
	}

	/** Drain `count` samples from the pending buffers and emit one chunk. */
	private emitChunk(count: number): void {
		const merged = new Float32Array(count);
		let filled = 0;
		while (filled < count && this.pending.length > 0) {
			const head = this.pending[0];
			const need = count - filled;
			if (head.length <= need) {
				merged.set(head, filled);
				filled += head.length;
				this.pending.shift();
			} else {
				merged.set(head.subarray(0, need), filled);
				this.pending[0] = head.subarray(need);
				filled += need;
			}
		}
		this.pendingSamples -= filled;

		const b64 = Buffer.from(
			merged.buffer,
			merged.byteOffset,
			merged.byteLength,
		).toString('base64');

		try {
			this.onChunk(b64, this.nextOffsetS);
		} catch (err) {
			this.onError?.(err instanceof Error ? err : new Error(String(err)));
		}
		this.nextOffsetS += count / this.actualSampleRate;
	}
}
