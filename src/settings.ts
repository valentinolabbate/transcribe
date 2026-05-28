import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type LiveTranscriberPlugin from './main';
import type { AudioSource } from './audio-recorder';

export interface TranscriberSettings {
	pythonPath: string; // '' = auto-detect
	hfToken: string;
	whisperModel: string;
	language: string; // ISO code, e.g. 'de'; '' = auto-detect
	outputFolder: string;
	audioSource: AudioSource;
	chunkSeconds: number;
}

export const DEFAULT_SETTINGS: TranscriberSettings = {
	pythonPath: '',
	hfToken: '',
	whisperModel: 'mlx-community/whisper-large-v3-turbo',
	language: 'de',
	outputFolder: 'Transcripts',
	audioSource: 'microphone',
	chunkSeconds: 8,
};

const PYANNOTE_TERMS_URL =
	'https://huggingface.co/pyannote/speaker-diarization-3.1';

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
						text: 'pyannote/speaker-diarization-3.1',
						href: PYANNOTE_TERMS_URL,
					});
					frag.appendText(
						' (and the segmentation-3.0 model it pulls). Without a token, transcription still works but without speaker names.',
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

		new Setting(containerEl).setName('Audio & output').setHeading();

		new Setting(containerEl)
			.setName('Audio source')
			.setDesc(
				'Microphone, or system audio (needs BlackHole or similar on macOS).',
			)
			.addDropdown((d) =>
				d
					.addOption('microphone', 'Microphone')
					.addOption('system', 'System audio')
					.setValue(s.audioSource)
					.onChange(async (v) => {
						s.audioSource = v as AudioSource;
						await this.plugin.saveSettings();
						if (v === 'system') {
							new Notice(
								'System audio needs a virtual device like BlackHole. ' +
									'See the plugin README for setup.',
							);
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
