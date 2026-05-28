import { spawn, exec, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Minimum Python version the backend requires (see CLAUDE.md). */
const MIN_PYTHON = [3, 10] as const;

export interface PythonManagerOptions {
	/** Absolute path to the plugin folder inside the vault. */
	pluginDir: string;
	/** Explicit Python executable; '' / undefined = auto-detect. */
	pythonPath?: string;
}

export type ProgressFn = (line: string) => void;

/**
 * Owns the Python side of the plugin: locating a suitable interpreter,
 * creating the venv, installing dependencies, and spawning / killing the
 * backend subprocess. Pure Node (no `obsidian` import) so it stays testable.
 */
export class PythonManager {
	private readonly pluginDir: string;
	private configuredPython: string;
	private proc: ChildProcessWithoutNullStreams | null = null;

	constructor(opts: PythonManagerOptions) {
		this.pluginDir = opts.pluginDir;
		this.configuredPython = (opts.pythonPath ?? '').trim();
	}

	/** Update the configured interpreter (used when settings change). */
	setPythonPath(pythonPath: string): void {
		this.configuredPython = (pythonPath ?? '').trim();
	}

	// ---- Paths -------------------------------------------------------------

	get venvDir(): string {
		return path.join(this.pluginDir, 'venv');
	}

	/** Python executable inside the venv (platform-aware). */
	get venvPython(): string {
		return process.platform === 'win32'
			? path.join(this.venvDir, 'Scripts', 'python.exe')
			: path.join(this.venvDir, 'bin', 'python3');
	}

	get backendDir(): string {
		return path.join(this.pluginDir, 'backend');
	}

	get backendEntry(): string {
		return path.join(this.backendDir, 'main.py');
	}

	get requirementsFile(): string {
		return path.join(this.backendDir, 'requirements.txt');
	}

	venvExists(): boolean {
		return fs.existsSync(this.venvPython);
	}

	// ---- Detection ---------------------------------------------------------

	/**
	 * Resolve a usable system Python interpreter (>= MIN_PYTHON).
	 * Honours an explicitly configured path, otherwise probes common names.
	 * Throws with a descriptive message if none qualifies.
	 */
	async detectPython(): Promise<string> {
		const candidates = this.configuredPython
			? [this.configuredPython]
			: await this.systemCandidates();

		const tried: string[] = [];
		for (const exe of candidates) {
			const version = await this.probeVersion(exe);
			if (version && this.meetsMinimum(version)) {
				return exe;
			}
			tried.push(version ? `${exe} (${version.join('.')})` : exe);
		}

		throw new Error(
			`No suitable Python found (need >= ${MIN_PYTHON.join('.')}). ` +
				`Tried: ${tried.join(', ') || 'none'}. ` +
				'Install Python 3.10+ or set the path in settings.',
		);
	}

	/** Candidate executables to probe via PATH lookup. */
	private async systemCandidates(): Promise<string[]> {
		const names =
			process.platform === 'win32'
				? ['python3', 'python']
				: ['python3', 'python'];
		const lookup = process.platform === 'win32' ? 'where' : 'which';

		const found: string[] = [];
		for (const name of names) {
			try {
				const { stdout } = await execAsync(`${lookup} ${name}`);
				const first = stdout.split(/\r?\n/).find((l) => l.trim());
				if (first) found.push(first.trim());
			} catch {
				// not on PATH — ignore
			}
		}

		// GUI apps on macOS (Obsidian/Electron) don't inherit the shell PATH,
		// so `which python3` often only sees the system 3.9 in /usr/bin. Probe
		// well-known install locations too. probeVersion() tolerates missing
		// paths, so listing non-existent ones is harmless.
		found.push(...this.wellKnownCandidates());

		// Dedupe while preserving order.
		return [...new Set(found.length ? found : names)];
	}

	/** Common absolute interpreter locations not always on the GUI PATH. */
	private wellKnownCandidates(): string[] {
		if (process.platform === 'win32') return [];
		const fixed = [
			'/opt/homebrew/bin/python3', // Apple Silicon Homebrew
			'/usr/local/bin/python3', // Intel Homebrew
			'/Library/Frameworks/Python.framework/Versions/Current/bin/python3', // python.org
		];
		// Versioned Homebrew kegs, newest first (e.g. /opt/homebrew/opt/python@3.13/...).
		const versioned: string[] = [];
		for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
			try {
				for (const name of fs.readdirSync(prefix)) {
					if (/^python@3\.\d+$/.test(name)) {
						versioned.push(path.join(prefix, name, 'libexec', 'bin', 'python3'));
					}
				}
			} catch {
				// prefix doesn't exist — ignore
			}
		}
		versioned.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		return [...fixed, ...versioned];
	}

	/** Returns [major, minor] for an interpreter, or null if it can't run. */
	private async probeVersion(exe: string): Promise<[number, number] | null> {
		try {
			const { stdout, stderr } = await execAsync(
				`"${exe}" -c "import sys;print('%d.%d'%sys.version_info[:2])"`,
			);
			const text = (stdout || stderr).trim();
			const m = text.match(/(\d+)\.(\d+)/);
			if (!m) return null;
			return [parseInt(m[1], 10), parseInt(m[2], 10)];
		} catch {
			return null;
		}
	}

	private meetsMinimum(version: [number, number]): boolean {
		const [maj, min] = version;
		if (maj !== MIN_PYTHON[0]) return maj > MIN_PYTHON[0];
		return min >= MIN_PYTHON[1];
	}

	// ---- Environment setup -------------------------------------------------

	/** Create the venv using the detected (or configured) interpreter. */
	async createVenv(onProgress?: ProgressFn): Promise<void> {
		const python = await this.detectPython();
		onProgress?.(`Creating virtual environment with ${python}...`);
		await execAsync(`"${python}" -m venv "${this.venvDir}"`);
		if (!this.venvExists()) {
			throw new Error(`venv creation did not produce ${this.venvPython}`);
		}
		onProgress?.('Virtual environment created.');
	}

	/**
	 * Install backend dependencies into the venv. Creates the venv first if
	 * needed. Streams pip output line-by-line to `onProgress`.
	 */
	async installDependencies(onProgress?: ProgressFn): Promise<void> {
		if (!this.venvExists()) {
			await this.createVenv(onProgress);
		}
		if (!fs.existsSync(this.requirementsFile)) {
			throw new Error(`requirements.txt not found at ${this.requirementsFile}`);
		}

		await this.runStreaming(
			this.venvPython,
			['-m', 'pip', 'install', '--upgrade', 'pip'],
			onProgress,
		);
		await this.runStreaming(
			this.venvPython,
			['-m', 'pip', 'install', '-r', this.requirementsFile],
			onProgress,
		);
		onProgress?.('Dependencies installed.');
	}

	/** Run a command, forwarding stdout+stderr lines to `onProgress`. */
	private runStreaming(
		cmd: string,
		args: string[],
		onProgress?: ProgressFn,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
			const forward = (buf: Buffer) => {
				const text = buf.toString();
				for (const line of text.split(/\r?\n/)) {
					if (line.trim()) onProgress?.(line.trim());
				}
			};
			child.stdout.on('data', forward);
			child.stderr.on('data', forward);
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} exited with code ${code}`));
			});
		});
	}

	// ---- Backend subprocess -----------------------------------------------

	isRunning(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	/**
	 * Spawn the backend subprocess and return it. Caller wires stdio via
	 * stdio-protocol (step 4). Throws if the venv or entry point is missing,
	 * or if a backend is already running.
	 */
	spawnBackend(): ChildProcessWithoutNullStreams {
		if (this.isRunning()) {
			throw new Error('Backend already running');
		}
		if (!this.venvExists()) {
			throw new Error('venv missing — install dependencies first');
		}
		if (!fs.existsSync(this.backendEntry)) {
			throw new Error(`backend entry not found at ${this.backendEntry}`);
		}

		const proc = spawn(this.venvPython, [this.backendEntry], {
			cwd: this.backendDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, PYTHONUNBUFFERED: '1' },
		});
		this.proc = proc;
		proc.on('close', () => {
			if (this.proc === proc) this.proc = null;
		});
		return proc;
	}

	/** Terminate the backend if running. Safe to call repeatedly. */
	kill(): void {
		if (this.proc && this.proc.exitCode === null) {
			this.proc.kill();
		}
		this.proc = null;
	}
}

/** Best-effort home expansion for user-entered paths like "~/py/bin/python3". */
export function expandHome(p: string): string {
	if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
	return p;
}
