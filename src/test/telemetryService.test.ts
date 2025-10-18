import * as assert from 'assert';
import * as vscode from 'vscode';
import { TelemetryEvent, TelemetryService } from '../services/telemetryService';

class NullChannel implements vscode.OutputChannel {
	public readonly name = 'test';

	append(): void {}

	appendLine(): void {}

	replace(): void {}

	clear(): void {}

	show(_columnOrPreserveFocus?: boolean | vscode.ViewColumn, _preserveFocus?: boolean): void {}

	hide(): void {}

	dispose(): void {}
}

suite('TelemetryService', () => {
	test('emits events when enabled', () => {
		const events: TelemetryEvent[] = [];
		const telemetry = new TelemetryService({ forceTelemetry: true, outputChannel: new NullChannel() });
		const subscription = telemetry.onDidSendEvent(event => events.push(event));

		telemetry.trackEvent('test', { foo: 'bar' }, { latency: 1 });

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]?.name, 'test');
		assert.deepStrictEqual(events[0]?.properties, { foo: 'bar' });
		subscription.dispose();
		telemetry.dispose();
	});

	test('suppresses events when telemetry disabled', () => {
		const events: TelemetryEvent[] = [];
		const telemetry = new TelemetryService({ forceTelemetry: false, outputChannel: new NullChannel() });
		const subscription = telemetry.onDidSendEvent(event => events.push(event));

		telemetry.trackEvent('suppressed');

		assert.strictEqual(events.length, 0);
		subscription.dispose();
		telemetry.dispose();
	});
});
