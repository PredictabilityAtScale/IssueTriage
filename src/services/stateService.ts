import * as vscode from 'vscode';

export class StateService {
	constructor(private readonly globalState: vscode.Memento, private readonly workspaceState: vscode.Memento) {}

	public getWorkspace<T>(key: string, defaultValue?: T): T | undefined {
		const value = this.workspaceState.get<T>(key);
		return value ?? defaultValue;
	}

	public async updateWorkspace<T>(key: string, value: T | undefined): Promise<void> {
		if (typeof value === 'undefined') {
			await this.workspaceState.update(key, undefined);
			return;
		}
		await this.workspaceState.update(key, value);
	}

	public getGlobal<T>(key: string, defaultValue?: T): T | undefined {
		const value = this.globalState.get<T>(key);
		return value ?? defaultValue;
	}

	public async updateGlobal<T>(key: string, value: T | undefined): Promise<void> {
		if (typeof value === 'undefined') {
			await this.globalState.update(key, undefined);
			return;
		}
		await this.globalState.update(key, value);
	}
}
