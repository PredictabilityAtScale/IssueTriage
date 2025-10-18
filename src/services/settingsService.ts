import * as vscode from 'vscode';

export class SettingsService {
	private readonly section = 'issuetriage';

	public get<T>(key: string, defaultValue?: T): T | undefined {
		const configuration = this.configuration;
		if (defaultValue === undefined) {
			return configuration.get<T>(key);
		}
		return configuration.get<T>(key, defaultValue);
	}

	public inspect<T>(key: string): ReturnType<vscode.WorkspaceConfiguration['inspect']> {
		return this.configuration.inspect<T>(key);
	}

	public async update<T>(key: string, value: T, target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace): Promise<void> {
		await this.configuration.update(key, value, target);
	}

	public getWithEnvFallback(key: string, envVar: string): string | undefined {
		const envValue = process.env[envVar];
		if (envValue && envValue.trim().length > 0) {
			return envValue.trim();
		}
		const value = this.get<string>(key);
		return value && value.trim().length > 0 ? value.trim() : undefined;
	}

	private get configuration(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(this.section);
	}
}
