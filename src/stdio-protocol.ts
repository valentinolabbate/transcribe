import { EventEmitter } from 'events';
import * as readline from 'readline';
import type { ChildProcessWithoutNullStreams } from 'child_process';

// ---- Protocol message shapes (see CLAUDE.md "stdio Protocol") -------------

/** Plugin -> Python */
export interface ConfigMessage {
	type: 'config';
	model: string;
	hf_token: string;
	sample_rate: number;
	language: string;
	/** Cosine-similarity threshold for matching speakers (higher = stricter). */
	speaker_threshold: number;
}

export interface ChunkMessage {
	type: 'chunk';
	pcm_b64: string;
	offset_s: number;
}

export interface StopMessage {
	type: 'stop';
}

export type OutgoingMessage = ConfigMessage | ChunkMessage | StopMessage;

/** Python -> Plugin */
export interface ReadyMessage {
	type: 'ready';
}

export interface StatusMessage {
	type: 'status';
	message: string;
}

export interface SegmentMessage {
	type: 'segment';
	speaker: string;
	text: string;
	start: number;
	end: number;
}

export interface ErrorMessage {
	type: 'error';
	message: string;
}

export type IncomingMessage =
	| ReadyMessage
	| StatusMessage
	| SegmentMessage
	| ErrorMessage;

// ---- Typed event map -------------------------------------------------------

interface ProtocolEvents {
	ready: () => void;
	status: (msg: StatusMessage) => void;
	segment: (msg: SegmentMessage) => void;
	error: (msg: ErrorMessage) => void;
	/** Fires for every parsed incoming message, regardless of type. */
	message: (msg: IncomingMessage) => void;
	/** A stdout line that failed to parse as JSON. */
	malformed: (line: string) => void;
	/** The subprocess closed; payload is the exit code (null if killed). */
	close: (code: number | null) => void;
}

/**
 * Wraps the backend subprocess streams in the JSON-Lines protocol.
 *
 * - Writes single-line JSON to stdin (always newline-terminated).
 * - Reads stdout line-by-line via readline, parses JSON, emits typed events.
 * - Forwards stderr to the console (stdout is protocol-only).
 */
export class StdioProtocol extends EventEmitter {
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly rl: readline.Interface;
	private stderrBuffer = '';

	constructor(proc: ChildProcessWithoutNullStreams) {
		super();
		this.proc = proc;

		this.rl = readline.createInterface({ input: proc.stdout });
		this.rl.on('line', (line) => this.handleLine(line));

		proc.stderr.on('data', (buf: Buffer) => this.handleStderr(buf));

		proc.on('close', (code) => {
			this.flushStderr();
			this.rl.close();
			this.emit('close', code);
		});
	}

	// ---- Typed emitter overrides ------------------------------------------

	on<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}

	once<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
		return super.once(event, listener as (...args: unknown[]) => void);
	}

	emit<K extends keyof ProtocolEvents>(
		event: K,
		...args: Parameters<ProtocolEvents[K]>
	): boolean {
		return super.emit(event, ...args);
	}

	// ---- Writing -----------------------------------------------------------

	/** Send a protocol message to the backend. */
	send(msg: OutgoingMessage): void {
		if (!this.proc.stdin.writable) {
			throw new Error('backend stdin is not writable');
		}
		this.proc.stdin.write(JSON.stringify(msg) + '\n');
	}

	sendConfig(cfg: Omit<ConfigMessage, 'type'>): void {
		this.send({ type: 'config', ...cfg });
	}

	sendChunk(pcmB64: string, offsetS: number): void {
		this.send({ type: 'chunk', pcm_b64: pcmB64, offset_s: offsetS });
	}

	sendStop(): void {
		this.send({ type: 'stop' });
	}

	// ---- Reading -----------------------------------------------------------

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let msg: IncomingMessage;
		try {
			msg = JSON.parse(trimmed) as IncomingMessage;
		} catch {
			console.warn('Live Transcriber: malformed stdout line:', trimmed);
			this.emit('malformed', trimmed);
			return;
		}

		this.emit('message', msg);
		switch (msg.type) {
			case 'ready':
				this.emit('ready');
				break;
			case 'status':
				this.emit('status', msg);
				break;
			case 'segment':
				this.emit('segment', msg);
				break;
			case 'error':
				// Node's EventEmitter throws on an unheard 'error' event, so
				// fall back to logging when nobody is listening.
				if (this.listenerCount('error') > 0) {
					this.emit('error', msg);
				} else {
					console.error('Live Transcriber [py error]:', msg.message);
				}
				break;
			default:
				console.warn('Live Transcriber: unknown message type:', msg);
		}
	}

	private handleStderr(buf: Buffer): void {
		this.stderrBuffer += buf.toString();
		const lines = this.stderrBuffer.split(/\r?\n/);
		this.stderrBuffer = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim()) console.log('Live Transcriber [py]:', line);
		}
	}

	private flushStderr(): void {
		if (this.stderrBuffer.trim()) {
			console.log('Live Transcriber [py]:', this.stderrBuffer.trim());
		}
		this.stderrBuffer = '';
	}

	/** Stop reading. Does not kill the process (PythonManager owns that). */
	dispose(): void {
		this.rl.close();
	}
}
