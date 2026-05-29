import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type LiveTranscriberPlugin from './main';

export interface TranscriberSettings {
	pythonPath: string; // '' = auto-detect
	hfToken: string;
	whisperModel: string;
	language: string; // ISO code, e.g. 'de'; '' = auto-detect
	outputFolder: string;
	inputDeviceId: string; // '' = system default input
	inputDeviceLabel: string; // human-readable label, for the transcript header
	chunkSeconds: number;
	speakerThreshold: number; // cosine-sim threshold for speaker matching
}

export const DEFAULT_SETTINGS: TranscriberSettings = {
	pythonPath: '',
	hfToken: '',
	whisperModel: 'mlx-community/whisper-large-v3-turbo',
	language: 'de',
	outputFolder: 'Transcripts',
	inputDeviceId: '',
	inputDeviceLabel: '',
	chunkSeconds: 8,
	speakerThreshold: 0.7,
};

const PYANNOTE_EMBED_URL =
	'https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM';

async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return devices.filter((d) => d.kind === 'audioinput');
}

export class LiveTranscriberSettingTab extends PluginSettingTab {
	private readonly plugin: LiveTranscriberPlugin;

	constructor(app: App, plugin: LiveTranscriberPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName('Transcription').setHeading();

		new Setting(containerEl)
			.setName('Whisper model')
			.setDesc('mlx-whisper model id. Downloaded on first use.')
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.whisperModel)
					.setValue(s.whisperModel)
					.onChange(async (v) => {
						s.whisperModel = v.trim() || DEFAULT_SETTINGS.whisperModel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Language')
			.setDesc('ISO code (e.g. "de", "en"). Leave empty to auto-detect.')
			.addText((t) =>
				t
					.setPlaceholder('de')
					.setValue(s.language)
					.onChange(async (v) => {
						s.language = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Chunk length')
			.setDesc('Seconds of audio buffered before each chunk is sent.')
			.addSlider((sl) =>
				sl
					.setLimits(2, 30, 1)
					.setValue(s.chunkSeconds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.chunkSeconds = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Speaker diarization').setHeading();

		new Setting(containerEl)
			.setName('HuggingFace token')
			.setDesc(
				createFragment((frag) => {
					frag.appendText(
						'Required for speaker labels. Accept the model terms at ',
					);
					frag.createEl('a', {
						text: 'pyannote/wespeaker-voxceleb-resnet34-LM',
						href: PYANNOTE_EMBED_URL,
					});
					frag.appendText(
						'. Without a token, transcription still works but without speaker names.',
					);
				}),
			)
			.addText((t) => {
				t.setPlaceholder('hf_...')
					.setValue(s.hfToken)
					.onChange(async (v) => {
						s.hfToken = v.trim();
						await this.plugin.saveSettings();
					});
				// Mask the token like a password field.
				t.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Speaker sensitivity')
			.setDesc(
				'How distinct two voices must be to count as different speakers. ' +
					'Higher = stricter (separates similar voices, but may split one ' +
					'speaker); lower = merges more. Takes effect on the next recording.',
			)
			.addSlider((sl) =>
				sl
					.setLimits(0.3, 0.9, 0.05)
					.setValue(s.speakerThreshold)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.speakerThreshold = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Audio & output').setHeading();

		const deviceSetting = new Setting(containerEl)
			.setName('Audio input device')
			.setDesc(
				'Your microphone, or a virtual device like BlackHole to capture ' +
					'system audio (e.g. a Teams call). See the README for BlackHole setup.',
			);
		// Dropdown is populated asynchronously (device labels need permission).
		deviceSetting.addDropdown((d) => {
			d.addOption('', 'Default input');
			d.setValue(s.inputDeviceId);
			void listAudioInputs().then((inputs) => {
				for (const dev of inputs) {
					if (!dev.deviceId || dev.deviceId === 'default') continue;
					d.addOption(
						dev.deviceId,
						dev.label || `Input ${dev.deviceId.slice(0, 6)}…`,
					);
				}
				d.setValue(s.inputDeviceId);
			});
			d.onChange(async (v) => {
				s.inputDeviceId = v;
				s.inputDeviceLabel = v
					? d.selectEl.selectedOptions[0]?.text ?? ''
					: '';
				await this.plugin.saveSettings();
			});
		});
		deviceSetting.addExtraButton((b) =>
			b
				.setIcon('refresh-cw')
				.setTooltip('Grant audio access & refresh device list')
				.onClick(async () => {
					try {
						const stream = await navigator.mediaDevices.getUserMedia({
							audio: true,
						});
						stream.getTracks().forEach((t) => t.stop());
						this.display(); // re-render with now-labeled devices
					} catch (e) {
						new Notice(`Live Transcriber: audio access denied (${String(e)})`);
					}
				}),
		);

		new Setting(containerEl)
			.setName('Output folder')
			.setDesc('Vault-relative folder for transcript files.')
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.outputFolder)
					.setValue(s.outputFolder)
					.onChange(async (v) => {
						s.outputFolder = v.trim() || DEFAULT_SETTINGS.outputFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Python backend').setHeading();

		new Setting(containerEl)
			.setName('Python path')
			.setDesc('Path to a Python 3.10+ executable. Empty = auto-detect.')
			.addText((t) =>
				t
					.setPlaceholder('auto-detect')
					.setValue(s.pythonPath)
					.onChange(async (v) => {
						s.pythonPath = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Dependencies')
			.setDesc(
				'Create the virtual environment and install the Python packages ' +
					'(mlx-whisper, pyannote.audio, torch, …). Can take several minutes.',
			)
			.addButton((b) =>
				b
					.setButtonText('Install dependencies')
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						b.setButtonText('Installing…');
						try {
							await this.plugin.installDependencies();
						} finally {
							b.setDisabled(false);
							b.setButtonText('Install dependencies');
						}
					}),
			);
	}
}
