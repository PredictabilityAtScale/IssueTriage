import * as assert from 'assert';
import * as vscode from 'vscode';
import { IssueManager, NewIssueAnalysisResult } from '../issueManager';
import { StateService } from '../services/stateService';
import type { GitHubAuthService } from '../services/githubAuthService';
import type { GitHubClient } from '../services/githubClient';
import type { SettingsService } from '../services/settingsService';
import type { TelemetryService } from '../services/telemetryService';
import type { RiskIntelligenceService } from '../services/riskIntelligenceService';
import type { AssessmentService } from '../services/assessmentService';
import type { KeywordExtractionService } from '../services/keywordExtractionService';
import type { SimilarityService } from '../services/similarityService';
import type { SimilarIssue } from '../types/risk';

type TelemetryRecord = {
	name: string;
	properties?: Record<string, string>;
	measurements?: Record<string, number>;
};

type SimilarityRequest = {
	repository: string;
	keywords: string[];
	limit: number;
};

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

suite('IssueManager new issue workflow', () => {
	const authStub = {} as unknown as GitHubAuthService;
	const riskStub = {
		onDidUpdate: () => new vscode.Disposable(() => undefined)
	} as unknown as RiskIntelligenceService;
	const assessmentStub = {} as unknown as AssessmentService;

	test('analyzeNewIssueDraft filters to closed matches and returns confidence data', async () => {
		const globalState = new MemoryMemento();
		const workspaceState = new MemoryMemento();
		const stateService = new StateService(globalState, workspaceState);

		const telemetryEvents: TelemetryRecord[] = [];
		const telemetryStub = {
			trackEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
				telemetryEvents.push({ name, properties, measurements });
			}
		} as unknown as TelemetryService;

		const keywordCalls: Array<{ title: string; summary: string }> = [];
		const keywordExtractor = {
			extractKeywords: async (title: string, summary: string) => {
				keywordCalls.push({ title, summary });
				return { keywords: ['auth', 'security'], tokensUsed: 42 };
			}
		} as unknown as KeywordExtractionService;

		const similarityRequests: SimilarityRequest[] = [];
		const similarityMatches: SimilarIssue[] = [
			{
				repository: 'owner/repo',
				issueNumber: 101,
				riskLevel: 'medium',
				riskScore: 55,
				keywords: ['auth', 'login'],
				overlapScore: 0.7,
				sharedKeywords: ['auth'],
				calculatedAt: new Date().toISOString(),
				issueTitle: 'Login flow hardens authentication',
				issueSummary: 'Adjust auth pipeline to include MFA.',
				issueLabels: ['security', 'auth']
			},
			{
				repository: 'owner/repo',
				issueNumber: 102,
				riskLevel: 'low',
				riskScore: 20,
				keywords: ['auth'],
				overlapScore: 0.2,
				sharedKeywords: ['auth'],
				calculatedAt: new Date().toISOString(),
				issueTitle: 'Auth helper tidy-up',
				issueSummary: 'Non critical cleanup.',
				issueLabels: ['refactor']
			}
		];
		const similarity = {
			findSimilar: async (repository: string, keywords: string[], _current?: number, limit = 3) => {
				similarityRequests.push({ repository, keywords, limit });
				return similarityMatches;
			}
		} as unknown as SimilarityService;

		const githubStub = {
			getIssueDetails: async (_repository: string, issueNumber: number) => {
				return {
					number: issueNumber,
					title: `Issue ${issueNumber}`,
					url: `https://github.com/owner/repo/issues/${issueNumber}`,
					labels: [],
					assignees: [],
					milestone: undefined,
					updatedAt: new Date().toISOString(),
					createdAt: new Date().toISOString(),
					body: '',
					author: 'triager',
					state: issueNumber === 101 ? 'closed' : 'open',
					comments: []
				};
			}
		} as unknown as GitHubClient;

		const settingsStub = {
			get: (key: string) => {
				if (key === 'issueCreator.similarMatchLimit') {
					return 4;
				}
				return undefined;
			}
		} as unknown as SettingsService;

		const manager = new IssueManager(
			authStub,
			githubStub,
			settingsStub,
			stateService,
			telemetryStub,
			riskStub,
			assessmentStub,
			keywordExtractor,
			similarity
		);

		const internal = manager as unknown as {
			state: {
				selectedRepository?: { fullName: string };
			};
		};
		internal.state.selectedRepository = { fullName: 'owner/repo' };

		const result = await manager.analyzeNewIssueDraft({
			title: 'Add adaptive auth',
			summary: 'Introduce adaptive authentication to block suspicious logins.'
		});

		assert.strictEqual(keywordCalls.length, 1, 'expected keyword extraction call');
		assert.strictEqual(similarityRequests.length, 1, 'expected similarity lookup');
		assert.deepStrictEqual(result.keywords, ['auth', 'security']);
		assert.strictEqual(result.tokensUsed, 42);
		assert.strictEqual(result.matches.length, 1, 'should only include closed issues');
		assert.strictEqual(result.matches[0].issueNumber, 101);
		assert.strictEqual(result.matches[0].confidenceLevel, 'high');
		assert.ok(result.matches[0].confidenceLabel.includes('High'));
		assert.ok(result.matches[0].url.endsWith('/101'));

		const eventNames = telemetryEvents.map(event => event.name);
		assert.ok(eventNames.includes('issueCreator.analyzeRequested'));
		assert.ok(eventNames.includes('issueCreator.analyzeCompleted'));
	});

	test('createIssueFromDraft formats metadata and similar matches in body', async () => {
		const globalState = new MemoryMemento();
		const workspaceState = new MemoryMemento();
		const stateService = new StateService(globalState, workspaceState);

		const telemetryEvents: TelemetryRecord[] = [];
		const telemetryStub = {
			trackEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
				telemetryEvents.push({ name, properties, measurements });
			}
		} as unknown as TelemetryService;

		const keywordExtractor = {
			extractKeywords: async () => ({ keywords: ['ci'], tokensUsed: 0 })
		} as unknown as KeywordExtractionService;

		const similarity = {
			findSimilar: async () => []
		} as unknown as SimilarityService;

		let createdBody = '';
		let createdLabels: string[] | undefined;
		const githubStub = {
			createIssue: async (_repository: string, payload: { title: string; body: string; labels?: string[]; assignees?: string[] }) => {
				createdBody = payload.body;
				createdLabels = payload.labels;
				return 333;
			},
			getIssueDetails: async () => ({
				number: 10,
				title: 'demo',
				url: 'https://github.com/owner/repo/issues/10',
				labels: [],
				assignees: [],
				milestone: undefined,
				updatedAt: new Date().toISOString(),
				createdAt: new Date().toISOString(),
				body: '',
				author: 'triager',
				state: 'closed',
				comments: []
			})
		} as unknown as GitHubClient;

		const settingsStub = {
			get: (_key: string) => undefined
		} as unknown as SettingsService;

		const manager = new IssueManager(
			authStub,
			githubStub,
			settingsStub,
			stateService,
			telemetryStub,
			riskStub,
			assessmentStub,
			keywordExtractor,
			similarity
		);

		const internal = manager as unknown as {
			state: {
				selectedRepository?: { fullName: string };
			};
		};
		internal.state.selectedRepository = { fullName: 'owner/repo' };

		const analysis: NewIssueAnalysisResult = {
			keywords: ['auth', 'security'],
			tokensUsed: 12,
			matches: [
				{
					issueNumber: 200,
					title: 'Authentication regression fix',
					url: 'https://github.com/owner/repo/issues/200',
					state: 'closed',
					riskLevel: 'medium',
					riskScore: 40,
					overlapScore: 0.5,
					sharedKeywords: ['auth'],
					keywords: ['auth', 'oauth'],
					labels: ['security'],
					summary: 'Resolved earlier auth regression.',
					calculatedAt: new Date().toISOString(),
					confidenceLevel: 'medium',
					confidenceLabel: 'Medium confidence'
				}
			]
		};

		const result = await manager.createIssueFromDraft({
			title: 'Track adaptive auth rollout',
			summary: 'Document rollout plan for adaptive authentication.',
			labels: ['security', 'feature'],
			priority: 'P1'
		}, analysis);

		assert.strictEqual(result.issueNumber, 333);
		assert.ok(result.url.endsWith('/333'));
		assert.deepStrictEqual(createdLabels, ['security', 'feature']);
		assert.ok(createdBody.includes('## Summary'));
		assert.ok(createdBody.includes('adaptive authentication'));
		assert.ok(createdBody.includes('Medium confidence'));
		assert.ok(createdBody.includes('## Captured Keywords'));
		assert.ok(createdBody.includes('security'));

		const eventNames = telemetryEvents.map(event => event.name);
		assert.ok(eventNames.includes('issueCreator.createIssueRequested'));
		assert.ok(eventNames.includes('issueCreator.createIssueSuccess'));
	});
});
