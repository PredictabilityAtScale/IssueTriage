import * as assert from 'assert';
import * as vscode from 'vscode';
import { AIIntegrationService } from '../services/aiIntegrationService';
import type { IssueDetail } from '../services/githubClient';

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

	const baseIssue: IssueDetail = {
		repository: 'owner/repo',
		number: 123,
		title: 'Test Issue',
		url: 'https://github.com/owner/repo/issues/123',
		labels: [],
		assignees: [],
		milestone: undefined,
		updatedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		state: 'open',
		body: 'Issue body content',
		author: 'reporter',
		comments: []
	};

	test('formatIssueContext creates basic context', () => {
		const context = service.formatIssueContext(baseIssue);

		assert.ok(context.includes('owner/repo'));
		assert.ok(context.includes('#123'));
		assert.ok(context.includes('Test Issue'));
		assert.ok(context.includes('Issue body content'));
	});

	test('formatIssueContext includes assessment when provided', () => {
		const context = service.formatIssueContext(
			{
				...baseIssue,
				body: 'Issue body'
			},
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

	test('formatIssueContext appends comment history', () => {
		const context = service.formatIssueContext({
			...baseIssue,
			comments: [
				{
					id: 1,
					body: 'First reply with details.',
					author: 'maintainer',
					createdAt: '2024-01-02T10:00:00Z',
					url: 'https://github.com/owner/repo/issues/123#issuecomment-1'
				},
				{
					id: 2,
					body: 'Thanks for the update!',
					author: 'reporter',
					createdAt: '2024-01-03T11:30:00Z'
				}
			]
		});

		assert.ok(context.includes('## Conversation History'));
		assert.ok(context.includes('Comment 1 · maintainer'));
		assert.ok(context.includes('First reply with details.'));
		assert.ok(context.includes('Comment 2 · reporter'));
		assert.ok(context.includes('Thanks for the update!'));
	});
});
