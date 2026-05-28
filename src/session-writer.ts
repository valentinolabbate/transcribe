import { App, normalizePath, TFolder } from 'obsidian';
import type { SegmentMessage } from './stdio-protocol';
import type { AudioSource } from './audio-recorder';

export interface SessionWriterOptions {
	app: App;
	/** Vault-relative folder for transcripts, e.g. "Transcripts". */
	outputFolder: string;
	audioSource: AudioSource;
	/** Whisper model id (display is shortened to the last path segment). */
	model: string;
}

/**
 * Owns one transcript file for a recording session: creates a dated Markdown
 * file with frontmatter on start, then appends each segment as a two-line
 * block as it arrives.
 */
export class SessionWriter {
	private readonly app: App;
	private readonly outputFolder: string;
	private readonly audioSource: AudioSource;
	private readonly model: string;

	private filePath: string | null = null;
	// Serialize appends so concurrent segments can't interleave/clobber.
	private writeChain: Promise<void> = Promise.resolve();

	constructor(opts: SessionWriterOptions) {
		this.app = opts.app;
		this.outputFolder = opts.outputFolder;
		this.audioSource = opts.audioSource;
		this.model = opts.model;
	}

	getFilePath(): string | null {
		return this.filePath;
	}

	/** Create the transcript file with frontmatter; returns its vault path. */
	async start(date = new Date()): Promise<string> {
		await this.ensureFolder();

		const filePath = normalizePath(
			`${this.outputFolder}/Transkript ${fileStamp(date)}.md`,
		);
		const frontmatter = this.buildHeader(date);

		await this.app.vault.create(filePath, frontmatter);
		this.filePath = filePath;
		return filePath;
	}

	/** Append one speaker-labeled segment. No-op if the session isn't started. */
	async appendSegment(seg: SegmentMessage): Promise<void> {
		const filePath = this.filePath;
		if (!filePath) return;
		const block = `\n**${seg.speaker}** · \`${formatClock(seg.start)}\`\n${seg.text}\n`;
		this.writeChain = this.writeChain.then(() =>
			this.app.vault.adapter.append(filePath, block),
		);
		return this.writeChain;
	}

	/** Wait for all queued appends to finish (call before discarding). */
	async flush(): Promise<void> {
		await this.writeChain;
	}

	private buildHeader(date: Date): string {
		const shortModel = this.model.split('/').pop() ?? this.model;
		return (
			`---\n` +
			`created: ${isoLocal(date)}\n` +
			`audio_source: ${this.audioSource}\n` +
			`model: ${shortModel}\n` +
			`---\n\n` +
			`# Transkript – ${titleStamp(date)}\n`
		);
	}

	private async ensureFolder(): Promise<void> {
		const folder = normalizePath(this.outputFolder);
		const existing = this.app.vault.getAbstractFileByPath(folder);
		if (existing instanceof TFolder) return;
		if (existing) {
			throw new Error(`output path "${folder}" exists but is not a folder`);
		}
		await this.app.vault.createFolder(folder);
	}
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Seconds -> HH:MM:SS. */
export function formatClock(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

/** Filename-safe local timestamp: "2026-05-28 14-30". */
function fileStamp(d: Date): string {
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}-${pad(d.getMinutes())}`
	);
}

/** Human title timestamp: "28.05.2026 14:30". */
function titleStamp(d: Date): string {
	return (
		`${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}`
	);
}

/** Local ISO-like timestamp without timezone: "2026-05-28T14:30:00". */
function isoLocal(d: Date): string {
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
	);
}
