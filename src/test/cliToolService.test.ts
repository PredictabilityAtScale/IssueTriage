import * as assert from 'assert';
import * as vscode from 'vscode';
import { CliToolService } from '../services/cliToolService';
import { StateService } from '../services/stateService';
import { TelemetryService } from '../services/telemetryService';
import type { SettingsService } from '../services/settingsService';

class MemoryMemento implements vscode.Memento {
	private readonly store = new Map<string, unknown>();

	public get<T>(key: string, defaultValue?: T): T | undefined {
		if (this.store.has(key)) {
			return this.store.get(key) as T;
		}
		return defaultValue;
	}

	public update(key: string, value: unknown): Thenable<void> {
		if (typeof value === 'undefined') {
			this.store.delete(key);
		} else {
			this.store.set(key, value);
		}
		return Promise.resolve();
	}

	public keys(): readonly string[] {
		return Array.from(this.store.keys());
	}
}

class NullChannel implements vscode.OutputChannel {
	public constructor(public readonly name = 'test') {}

	append(): void {}

	appendLine(): void {}

	replace(): void {}

	clear(): void {}

	show(): void {}

	hide(): void {}

	dispose(): void {}
}

type SettingsContract = Pick<SettingsService, 'get' | 'inspect' | 'update' | 'getWithEnvFallback'>;

class MockSettingsService implements SettingsContract {
	public constructor(private readonly values: Record<string, unknown>) {}

	public get<T>(key: string, defaultValue?: T): T | undefined {
		const value = this.values[key];
		if (typeof value === 'undefined') {
			return defaultValue;
		}
		return value as T;
	}

	public inspect<T>(_key: string): ReturnType<SettingsService['inspect']> {
		return undefined as unknown as ReturnType<SettingsService['inspect']>;
	}

	public async update<T>(_key: string, _value: T): Promise<void> {
		throw new Error('Not implemented in test mock.');
	}

	public getWithEnvFallback(key: string, envVar: string): string | undefined {
		const envValue = process.env[envVar];
		if (envValue && envValue.trim().length > 0) {
			return envValue.trim();
		}
		const value = this.get<string>(key);
		return value && value.trim().length > 0 ? value.trim() : undefined;
	}
}

suite('CliToolService', () => {
	test('runs configured tool and captures prompt context', async () => {
		const settings = new MockSettingsService({
			cliTools: [
				{ id: 'builtin.workspaceSnapshot', enabled: false },
				{
					id: 'test.echo',
					title: 'Echo Tool',
					description: 'Outputs a static string for testing.',
					command: process.execPath,
					args: ['-e', "console.log('cli-context')"],
					outputType: 'text'
				}
			]
		});
		const telemetry = new TelemetryService({ forceTelemetry: true, outputChannel: new NullChannel('telemetry') });
		const state = new StateService(new MemoryMemento(), new MemoryMemento());
		const cliService = new CliToolService(process.cwd(), settings as unknown as SettingsService, state, telemetry, new NullChannel('cli'));

		const tools = cliService.listTools();
		assert.ok(tools.some(tool => tool.id === 'test.echo'));

		const result = await cliService.runTool('test.echo', { force: true, reason: 'manual' });
		assert.ok(result.success);
		assert.ok(result.stdout.includes('cli-context'));

		const prompt = cliService.getPromptContext();
		assert.ok(prompt);
		assert.ok(prompt?.includes('test.echo'));

		cliService.dispose();
		telemetry.dispose();
	});
});
