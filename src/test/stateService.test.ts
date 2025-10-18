import * as assert from 'assert';
import * as vscode from 'vscode';
import { StateService } from '../services/stateService';

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

suite('StateService', () => {
	test('persists workspace values', async () => {
		const globalState = new MemoryMemento();
		const workspaceState = new MemoryMemento();
		const state = new StateService(globalState, workspaceState);

		assert.strictEqual(state.getWorkspace('missing'), undefined);
		await state.updateWorkspace('foo', { hello: 'world' });
		assert.deepStrictEqual(state.getWorkspace('foo'), { hello: 'world' });

		await state.updateWorkspace('foo', undefined);
		assert.strictEqual(state.getWorkspace('foo'), undefined);
	});

	test('persists global values', async () => {
		const globalState = new MemoryMemento();
		const workspaceState = new MemoryMemento();
		const state = new StateService(globalState, workspaceState);

		await state.updateGlobal('token', 'abc');
		assert.strictEqual(state.getGlobal('token'), 'abc');
	});
});
