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

	private get configuration(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(this.section);
	}
}
