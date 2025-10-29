import * as assert from 'assert';
import { KeywordExtractionService } from '../services/keywordExtractionService';
import type { LlmGateway } from '../services/llmGateway';

class MockSettings {
	private readonly values: Record<string, any>;

	constructor(values: Record<string, any> = {}) {
		this.values = values;
	}

	public get<T>(key: string, defaultValue?: T): T | undefined {
		return (this.values[key] as T) ?? defaultValue;
	}

	public getWithEnvFallback(key: string, envKey: string): string | undefined {
		return this.values[key] ?? process.env[envKey];
	}
}

class MockTelemetry {
	public events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];

	public trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
		this.events.push({ name, properties, measurements });
	}
}

suite('KeywordExtractionService', () => {
	test('should parse keywords from LLM response', () => {
		const settings = new MockSettings({
			'assessment.apiKey': 'test-key',
			'assessment.standardModel': 'openai/gpt-5-mini'
		});
		const telemetry = new MockTelemetry();
		const gateway = {
			getMode: () => 'local',
			hasLocalApiKey: () => true,
			requestChatCompletion: async () => {
				throw new Error('Not implemented in keyword parsing tests');
			}
		} as unknown as LlmGateway;
		const service = new KeywordExtractionService(settings as any, telemetry as any, gateway);

		// Test the private parseKeywords method via type casting
		const privateService = service as any;
		
		// Test basic comma-separated keywords
		const result1 = privateService.parseKeywords('auth, middleware, refactor, security, breaking-change');
		assert.strictEqual(result1.length, 5);
		assert.ok(result1.includes('auth'));
		assert.ok(result1.includes('middleware'));
		assert.ok(result1.includes('security'));

		// Test with prefix removal
		const result2 = privateService.parseKeywords('Keywords: database, api, performance, cache, optimization');
		assert.strictEqual(result2.length, 5);
		assert.ok(result2.includes('database'));
		assert.ok(result2.includes('performance'));

		// Test deduplication
		const result3 = privateService.parseKeywords('auth, api, auth, security, api, refactor');
		assert.ok(result3.length <= 6);
		const uniqueCount = new Set(result3).size;
		assert.strictEqual(result3.length, uniqueCount, 'Should deduplicate keywords');

		// Test padding when too few keywords
		const result4 = privateService.parseKeywords('auth, api');
		assert.ok(result4.length >= 5, 'Should pad to minimum 5 keywords');

		// Test capping at 8 keywords
		const result5 = privateService.parseKeywords('a, b, c, d, e, f, g, h, i, j, k');
		assert.ok(result5.length <= 8, 'Should cap at 8 keywords');
	});

	test('should handle various keyword formats', () => {
		const settings = new MockSettings({
			'assessment.apiKey': 'test-key',
			'assessment.standardModel': 'openai/gpt-5-mini'
		});
		const telemetry = new MockTelemetry();
		const gateway = {
			getMode: () => 'local',
			hasLocalApiKey: () => true,
			requestChatCompletion: async () => {
				throw new Error('Not implemented in keyword parsing tests');
			}
		} as unknown as LlmGateway;
		const service = new KeywordExtractionService(settings as any, telemetry as any, gateway);
		const privateService = service as any;

		// Newline separated
		const result1 = privateService.parseKeywords('auth\nmiddleware\nrefactor\nsecurity\nbreaking-change');
		assert.strictEqual(result1.length, 5);

		// Mixed separators
		const result2 = privateService.parseKeywords('auth, middleware\nrefactor, security\nbreaking-change');
		assert.strictEqual(result2.length, 5);

		// With extra whitespace
		const result3 = privateService.parseKeywords('  auth  ,  middleware  ,  refactor  ');
		assert.ok(result3.includes('auth'));
		assert.ok(result3.includes('middleware'));
		assert.ok(result3.includes('refactor'));
	});
});
