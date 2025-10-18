import * as vscode from 'vscode';
import type { SettingsService } from './settingsService';

export interface TelemetryEvent {
	name: string;
	properties?: Record<string, string>;
	measurements?: Record<string, number>;
}

export interface TelemetryOptions {
	forceTelemetry?: boolean;
	outputChannel?: vscode.OutputChannel;
	settings?: SettingsService;
}

export class TelemetryService implements vscode.Disposable {
	private readonly channel: vscode.OutputChannel;
	private readonly channelOwned: boolean;
	private readonly emitter = new vscode.EventEmitter<TelemetryEvent>();
	private readonly settings?: SettingsService;
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;

	constructor(private readonly options: TelemetryOptions = {}) {
		this.channel = options.outputChannel ?? vscode.window.createOutputChannel('IssueTriage');
		this.channelOwned = !options.outputChannel;
		this.settings = options.settings;

		if (this.settings) {
			const subscription = vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('issuetriage.telemetry.enabled')) {
					this.channel.appendLine('[telemetry] Preference updated for issuetriage.telemetry.enabled');
				}
			});
			this.disposables.push(subscription);
		}
	}

	public readonly onDidSendEvent = this.emitter.event;

	public trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
		if (!this.telemetryEnabled || this.disposed) {
			return;
		}

		const event: TelemetryEvent = { name, properties, measurements };
		this.emitter.fire(event);

		const measurementLabel = measurements ? ` ${JSON.stringify(measurements)}` : '';
		const propertyLabel = properties ? ` ${JSON.stringify(properties)}` : '';
		this.channel.appendLine(`[telemetry] ${name}${propertyLabel}${measurementLabel}`);
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.emitter.dispose();
		this.disposables.forEach(disposable => disposable.dispose());
		if (this.channelOwned) {
			this.channel.dispose();
		}
	}

	private get telemetryEnabled(): boolean {
		if (typeof this.options.forceTelemetry === 'boolean') {
			return this.options.forceTelemetry;
		}
		const settingPreference = this.settings?.get<boolean>('telemetry.enabled');
		if (settingPreference === false) {
			return false;
		}
		if (settingPreference === true) {
			return true;
		}
		return vscode.env.isTelemetryEnabled;
	}
}
