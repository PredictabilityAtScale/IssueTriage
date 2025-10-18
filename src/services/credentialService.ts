import * as vscode from 'vscode';

export class CredentialService {
	private readonly namespace: string;

	constructor(private readonly storage: vscode.SecretStorage, namespace = 'issuetriage') {
		this.namespace = namespace;
	}

	public async storeSecret(id: string, value: string): Promise<void> {
		await this.storage.store(this.toKey(id), value);
	}

	public async retrieveSecret(id: string): Promise<string | undefined> {
		return this.storage.get(this.toKey(id));
	}

	public async deleteSecret(id: string): Promise<void> {
		await this.storage.delete(this.toKey(id));
	}

	public onDidChange(listener: (id: string) => void, thisArgs?: unknown): vscode.Disposable {
		return this.storage.onDidChange(event => {
			if (event.key.startsWith(`${this.namespace}.`)) {
				listener(event.key.slice(this.namespace.length + 1));
			}
		}, thisArgs);
	}

	private toKey(id: string): string {
		return `${this.namespace}.${id}`;
	}
}
