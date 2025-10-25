import * as assert from 'assert';
import * as vscode from 'vscode';
import { AIIntegrationService } from '../services/aiIntegrationService';

suite('AIIntegrationService Tests', () => {
	let service: AIIntegrationService;

	setup(() => {
		service = new AIIntegrationService();
	});

	test('getEnvironmentInfo returns app information', () => {
		const info = service.getEnvironmentInfo();
		assert.ok(info.app);
		assert.strictEqual(typeof info.isCursor, 'boolean');
		assert.strictEqual(typeof info.isVSCode, 'boolean');
	});

	test('getAvailableAssistants returns at least one assistant', () => {
		const assistants = service.getAvailableAssistants();
		assert.ok(assistants.length > 0);
		assert.ok(assistants.every(a => a.id && a.name));
	});

	test('formatIssueContext creates basic context', () => {
		const context = service.formatIssueContext(
			'owner/repo',
			123,
			'Test Issue',
			'Issue body content',
			'https://github.com/owner/repo/issues/123'
		);

		assert.ok(context.includes('owner/repo'));
		assert.ok(context.includes('#123'));
		assert.ok(context.includes('Test Issue'));
		assert.ok(context.includes('Issue body content'));
	});

	test('formatIssueContext includes assessment when provided', () => {
		const context = service.formatIssueContext(
			'owner/repo',
			123,
			'Test Issue',
			'Issue body',
			'https://github.com/owner/repo/issues/123',
			{
				compositeScore: 85.5,
				recommendations: ['Question 1', 'Question 2'],
				summary: 'Test summary'
			}
		);

		assert.ok(context.includes('85.5'));
		assert.ok(context.includes('Test summary'));
		assert.ok(context.includes('Question 1'));
		assert.ok(context.includes('Question 2'));
	});
});
