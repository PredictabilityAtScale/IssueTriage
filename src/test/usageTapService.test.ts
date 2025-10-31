import * as assert from 'assert';
import type { SettingsService } from '../services/settingsService';
import type { TelemetryService } from '../services/telemetryService';
import { UsageTapService } from '../services/usageTapService';
import type { UsageTapUsagePayload } from '../services/usageTapService';
import type { UsageTapClient, WithUsageContext, SubscriptionSnapshot, EntitlementHints, EndCallRequest } from '@usagetap/sdk' with { "resolution-mode": "import" };

type SettingsContract = Pick<SettingsService, 'get' | 'getWithEnvFallback'>;
type TelemetryContract = Pick<TelemetryService, 'trackEvent'>;

class MockSettings implements SettingsContract {
	public constructor(private readonly values: Record<string, unknown> = {}) {}

	public get<T>(key: string, defaultValue?: T): T | undefined {
		if (Object.prototype.hasOwnProperty.call(this.values, key)) {
			return this.values[key] as T;
		}
		return defaultValue;
	}

	public getWithEnvFallback(key: string, envVar: string): string | undefined {
		const envValue = process.env[envVar];
		if (envValue && envValue.trim()) {
			return envValue.trim();
		}
		const value = this.get<string>(key);
		return value && value.trim().length > 0 ? value.trim() : undefined;
	}
}

class MockTelemetry implements TelemetryContract {
	public readonly events: Array<{ name: string; properties?: Record<string, string> | undefined }> = [];

	public trackEvent(name: string, properties?: Record<string, string>): void {
		this.events.push({ name, properties });
	}
}

class StubUsageTapClient {
	public createCustomerCalls = 0;
	public beginRequests: Array<{ feature?: string; tags?: string[] }> = [];
	public recordedUsage?: UsageTapUsagePayload;
	public recordedError?: { code?: string; message?: string };
	private readonly subscription: SubscriptionSnapshot = {
		id: null,
		usagePlanVersionId: null,
		planName: null,
		planVersion: null,
		limitType: 'NONE',
		reasoningLevel: 'NONE',
		lastReplenishedAt: null,
		nextReplenishAt: null,
		subscriptionVersion: null
	};
	private readonly hints: EntitlementHints = {
		suggestedModelTier: 'standard',
		reasoningLevel: 'NONE',
		policy: 'NONE'
	};

	public async createCustomer(): Promise<unknown> {
		this.createCustomerCalls += 1;
		return { result: { status: 'ACCEPTED' }, data: { newCustomer: false }, correlationId: 'corr' };
	}

	public async withUsage<T>(beginRequest: Record<string, unknown>, handler: (context: WithUsageContext) => Promise<T>): Promise<T> {
		this.beginRequests.push({ feature: beginRequest.feature as string | undefined, tags: beginRequest.tags as string[] | undefined });
		const context: WithUsageContext = {
			begin: {
				result: { status: 'ACCEPTED' },
				correlationId: 'corr',
				data: {
					callId: 'call_123',
					startTime: new Date().toISOString(),
					newCustomer: false,
					canceled: false,
					policy: 'NONE',
					allowed: { standard: true, premium: false, audio: false, image: false, search: false, reasoningLevel: 'NONE' },
					entitlementHints: this.hints,
					meters: {},
					remainingRatios: {},
					subscription: this.subscription
				}
			},
			setUsage: (usage: UsageTapUsagePayload) => {
				this.recordedUsage = { ...usage };
			},
			setError: (error: EndCallRequest['error']) => {
				this.recordedError = error ?? undefined;
			}
		};
		return handler(context);
	}
}

suite('UsageTapService', () => {
	test('runWithUsage falls back when API key missing', async () => {
		const settings = new MockSettings({ 'telemetry.enabled': true });
		const telemetry = new MockTelemetry();
		const service = new UsageTapService(settings as unknown as SettingsService, telemetry as unknown as TelemetryService);
		let invoked = false;
		await service.runWithUsage({ feature: 'test.noop' }, async hooks => {
			invoked = true;
			hooks.setUsage({ inputTokens: 5 });
			return 'ok';
		});
		assert.ok(invoked, 'handler should execute even without UsageTap credentials');
		assert.strictEqual(telemetry.events.length, 0);
	});

	test('runWithUsage delegates to UsageTap client when configured', async () => {
		const settings = new MockSettings({
			'telemetry.enabled': true,
			'telemetry.usagetapKey': 'test-key'
		});
		const telemetry = new MockTelemetry();
		const client = new StubUsageTapClient();
		const service = new UsageTapService(settings as unknown as SettingsService, telemetry as unknown as TelemetryService, {
			customerId: 'customer-123',
			clientFactory: () => client as unknown as UsageTapClient
		});

		await service.runWithUsage({ feature: 'assessment.generate', tags: ['unit-test'] }, async hooks => {
			hooks.setUsage({ inputTokens: 42, responseTokens: 11 });
			return 'done';
		});

		assert.strictEqual(client.createCustomerCalls, 1, 'should provision customer');
		assert.strictEqual(client.beginRequests.length, 1, 'should begin a UsageTap call');
		assert.deepStrictEqual(client.recordedUsage, { inputTokens: 42, responseTokens: 11 });
		assert.strictEqual(client.recordedError, undefined);
	});

	test('runWithUsage records vendor error when handler throws', async () => {
		const settings = new MockSettings({
			'telemetry.enabled': true,
			'telemetry.usagetapKey': 'ek-btNBcPLtj7iGrTduOP4I6bxbJhEWXMaNkpJBNfVIYuM'
		});
		const telemetry = new MockTelemetry();
		const client = new StubUsageTapClient();
		const service = new UsageTapService(settings as unknown as SettingsService, telemetry as unknown as TelemetryService, {
			customerId: 'customer-123',
			clientFactory: () => client as unknown as UsageTapClient
		});

		await assert.rejects(async () => {
			await service.runWithUsage({ feature: 'keywords.extract' }, async () => {
				throw new Error('boom');
			});
		});

		assert.ok(client.recordedError, 'should record an error');
		assert.strictEqual(client.recordedError?.code, 'VENDOR_ERROR');
		assert.strictEqual(client.recordedUsage, undefined, 'usage should not be recorded when handler fails');
	});
});
