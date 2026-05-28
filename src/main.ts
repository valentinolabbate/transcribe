import { FileSystemAdapter, Notice, Plugin, setIcon, setTooltip } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { BACKEND_FILES } from './backend-embed';
import { PythonManager } from './python-manager';
import { StdioProtocol } from './stdio-protocol';
import { AudioRecorder } from './audio-recorder';
import { SessionWriter } from './session-writer';
import {
	DEFAULT_SETTINGS,
	LiveTranscriberSettingTab,
	type TranscriberSettings,
} from './settings';

const SAMPLE_RATE = 16000;

export default class LiveTranscriberPlugin extends Plugin {
	settings: TranscriberSettings = { ...DEFAULT_SETTINGS };

	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private python: PythonManager | null = null;
	private protocol: StdioProtocol | null = null;
	private recorder: AudioRecorder | null = null;
	private session: SessionWriter | null = null;

	private backendReady = false;
	private readyWaiters: Array<{
		resolve: () => void;
		reject: (e: Error) => void;
	}> = [];

	async onload(): Promise<void> {
		console.log('Live Transcriber: loading plugin');

		await this.loadSettings();

		// Extract the embedded Python backend to disk (overwrites stale copies).
		try {
			this.extractBackendFiles();
		} catch (e) {
			console.error('Live Transcriber: failed to extract backend files', e);
			new Notice('Live Transcriber: could not write backend files (see console)');
		}

		// Manages the Python interpreter / venv / backend subprocess.
		this.python = new PythonManager({
			pluginDir: this.getPluginDir(),
			pythonPath: this.settings.pythonPath,
		});

		this.addSettingTab(new LiveTranscriberSettingTab(this.app, this));

		// Ribbon icon — toggles recording; icon/label track state.
		this.ribbonIconEl = this.addRibbonIcon('mic', 'Start transcription', () => {
			void this.toggleRecording();
		});

		// Status bar item showing recording state; click to toggle.
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('mod-clickable');
		this.statusBarItem.addEventListener('click', () => {
			void this.toggleRecording();
		});

		this.setStatus('idle');

		this.addCommand({
			id: 'live-transcriber-toggle',
			name: 'Toggle transcription',
			callback: () => {
				void this.toggleRecording();
			},
		});

		this.addCommand({
			id: 'live-transcriber-stop',
			name: 'Stop transcription',
			checkCallback: (checking) => {
				const recording = this.recorder?.isRecording() ?? false;
				if (checking) return recording;
				void this.stopRecording();
				return true;
			},
		});

		// Convenience command mirroring the settings "Install dependencies" button.
		this.addCommand({
			id: 'live-transcriber-install-deps',
			name: 'Install Python dependencies',
			callback: () => {
				void this.installDependencies();
			},
		});

		// The (heavy) backend is started lazily on the first recording so we
		// don't load the Whisper model on every Obsidian launch.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<TranscriberSettings> | null,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Keep the Python manager's interpreter choice in sync. Safe while idle;
		// a running backend keeps its already-resolved interpreter.
		this.python?.setPythonPath(this.settings.pythonPath);
	}

	onunload(): void {
		console.log('Live Transcriber: unloading plugin');
		void this.recorder?.stop();
		this.recorder = null;
		this.rejectReadyWaiters(new Error('plugin unloaded'));
		this.protocol?.dispose();
		this.protocol = null;
		this.backendReady = false;
		this.python?.kill();
		this.python = null;
		this.statusBarItem = null;
	}

	/** Start capture if idle, stop it if recording. */
	private async toggleRecording(): Promise<void> {
		if (this.recorder?.isRecording()) {
			await this.stopRecording();
		} else {
			await this.startRecording();
		}
	}

	private async startRecording(): Promise<void> {
		try {
			await this.ensureBackendReady();
		} catch (e) {
			console.error('Live Transcriber: backend not ready', e);
			new Notice(`Live Transcriber: backend not ready (${String(e)})`);
			return;
		}

		// Create the transcript file before audio starts so early segments land.
		const session = new SessionWriter({
			app: this.app,
			outputFolder: this.settings.outputFolder,
			audioSource: this.settings.inputDeviceLabel || 'default input',
			model: this.settings.whisperModel,
		});
		try {
			const filePath = await session.start();
			this.session = session;
			console.log('Live Transcriber: writing to', filePath);
		} catch (e) {
			console.error('Live Transcriber: could not create transcript file', e);
			new Notice(`Live Transcriber: cannot write transcript (${String(e)})`);
			return;
		}

		const recorder = new AudioRecorder({
			deviceId: this.settings.inputDeviceId,
			sampleRate: SAMPLE_RATE,
			chunkSeconds: this.settings.chunkSeconds,
			onChunk: (b64, offsetS) => this.protocol?.sendChunk(b64, offsetS),
			onError: (err) =>
				console.error('Live Transcriber: chunk send failed —', err),
		});
		try {
			await recorder.start();
			this.recorder = recorder;
			this.setStatus('recording');
			new Notice('Live Transcriber: recording started');
		} catch (e) {
			console.error('Live Transcriber: failed to start recording', e);
			new Notice(`Live Transcriber: microphone error (${String(e)})`);
			this.session = null;
		}
	}

	private async stopRecording(): Promise<void> {
		await this.recorder?.stop();
		this.recorder = null;
		this.setStatus('idle');
		// Flush the VAD's trailing speech but keep the backend resident so the
		// next recording doesn't reload the Whisper model.
		this.protocol?.sendFlush();
		// Let any in-flight appends settle, then close the session. Late
		// segments from the flush still land via the segment handler.
		await this.session?.flush();
		new Notice('Live Transcriber: recording stopped');
	}

	/** Run `pip install -r requirements.txt` into the venv. */
	async installDependencies(): Promise<void> {
		if (!this.python) return;
		const notice = new Notice(
			'Live Transcriber: installing dependencies… (several minutes)',
			0,
		);
		try {
			await this.python.installDependencies((line) => {
				console.log('Live Transcriber [pip]:', line);
				notice.setMessage(`Live Transcriber [pip]: ${line.slice(0, 80)}`);
			});
			notice.hide();
			new Notice('Live Transcriber: dependencies installed ✅');
		} catch (e) {
			notice.hide();
			console.error('Live Transcriber: dependency install failed', e);
			new Notice(`Live Transcriber: install failed (${String(e)})`);
		}
	}

	/**
	 * Spawn the backend (creating the venv if needed), send config, and resolve
	 * once it reports ready. Subsequent calls return immediately while the
	 * backend stays up (Whisper model stays resident). Surfaces a Notice and
	 * rejects on failure.
	 */
	private async ensureBackendReady(): Promise<void> {
		if (this.protocol && this.backendReady) return;
		if (!this.python) throw new Error('plugin not initialized');

		if (!this.protocol) {
			this.spawnBackend();
		}
		if (this.backendReady) return;

		await new Promise<void>((resolve, reject) => {
			this.readyWaiters.push({ resolve, reject });
		});
	}

	/** Create the venv if needed, spawn the backend, wire events, send config. */
	private spawnBackend(): void {
		if (!this.python) return;

		const prep = new Notice('Live Transcriber: starting backend…', 0);
		void (async () => {
			try {
				if (!this.python!.venvExists()) {
					prep.setMessage('Live Transcriber: creating venv…');
					await this.python!.createVenv((l) =>
						console.log('Live Transcriber [venv]:', l),
					);
				}

				const proc = this.python!.spawnBackend();
				const protocol = new StdioProtocol(proc);
				this.protocol = protocol;
				this.backendReady = false;

				protocol.on('ready', () => {
					console.log('Live Transcriber: backend ready ✅');
					this.backendReady = true;
					prep.hide();
					new Notice('Live Transcriber: backend ready');
					this.resolveReadyWaiters();
				});
				protocol.on('status', (m) => {
					console.log('Live Transcriber: status —', m.message);
					if (!this.backendReady) prep.setMessage(`Live Transcriber: ${m.message}`);
				});
				protocol.on('segment', (m) => {
					console.log('Live Transcriber: segment —', m);
					void this.session?.appendSegment(m);
				});
				protocol.on('error', (m) => {
					console.error('Live Transcriber: backend error —', m.message);
					if (!this.backendReady) {
						prep.hide();
						this.rejectReadyWaiters(new Error(m.message));
					}
				});
				protocol.on('close', (code) => {
					console.log('Live Transcriber: backend closed, code', code);
					if (this.protocol === protocol) {
						this.protocol = null;
						this.backendReady = false;
					}
					if (!this.backendReady) {
						prep.hide();
						this.rejectReadyWaiters(
							new Error(`backend exited before ready (code ${code})`),
						);
					}
				});

				protocol.sendConfig({
					model: this.settings.whisperModel,
					hf_token: this.settings.hfToken,
					sample_rate: SAMPLE_RATE,
					language: this.settings.language,
				});
			} catch (e) {
				prep.hide();
				console.error('Live Transcriber: failed to start backend', e);
				this.rejectReadyWaiters(
					e instanceof Error ? e : new Error(String(e)),
				);
			}
		})();
	}

	private resolveReadyWaiters(): void {
		const waiters = this.readyWaiters;
		this.readyWaiters = [];
		waiters.forEach((w) => w.resolve());
	}

	private rejectReadyWaiters(err: Error): void {
		const waiters = this.readyWaiters;
		this.readyWaiters = [];
		waiters.forEach((w) => w.reject(err));
	}

	/** Absolute path to this plugin's folder inside the vault. */
	private getPluginDir(): string {
		const adapter = this.app.vault.adapter as FileSystemAdapter;
		return path.join(
			adapter.getBasePath(),
			'.obsidian',
			'plugins',
			'live-transcriber',
		);
	}

	/**
	 * Write the embedded backend sources (see backend-embed.ts) into
	 * <pluginDir>/backend/. Overwrites when the on-disk content differs so the
	 * backend always matches the installed plugin version; untouched files are
	 * skipped to avoid needless writes. The backend folder is plugin-managed,
	 * not a user edit surface.
	 */
	private extractBackendFiles(): void {
		const backendDir = path.join(this.getPluginDir(), 'backend');
		for (const [relName, content] of Object.entries(BACKEND_FILES)) {
			const dest = path.join(backendDir, relName);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			const current = fs.existsSync(dest)
				? fs.readFileSync(dest, 'utf8')
				: null;
			if (current !== content) {
				fs.writeFileSync(dest, content, 'utf8');
			}
		}
	}

	private setStatus(state: 'idle' | 'recording'): void {
		const recording = state === 'recording';

		if (this.statusBarItem) {
			this.statusBarItem.setText(recording ? '● Transcribing' : 'Transcriber idle');
			this.statusBarItem.removeClasses([
				'live-transcriber-status-recording',
				'live-transcriber-status-idle',
			]);
			this.statusBarItem.addClass(
				recording
					? 'live-transcriber-status-recording'
					: 'live-transcriber-status-idle',
			);
			setTooltip(
				this.statusBarItem,
				recording ? 'Click to stop transcription' : 'Click to start transcription',
			);
		}

		if (this.ribbonIconEl) {
			setIcon(this.ribbonIconEl, recording ? 'square' : 'mic');
			setTooltip(
				this.ribbonIconEl,
				recording ? 'Stop transcription' : 'Start transcription',
			);
			this.ribbonIconEl.toggleClass('live-transcriber-ribbon-recording', recording);
		}
	}
}
