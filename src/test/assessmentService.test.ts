import * as assert from 'assert';
import { AssessmentService, AssessmentError } from '../services/assessmentService';
import type { AssessmentRecord } from '../services/assessmentStorage';
import type { SettingsService } from '../services/settingsService';
import type { TelemetryService } from '../services/telemetryService';
import type { GitHubClient, IssueDetail } from '../services/githubClient';
import type { CliToolService } from '../services/cliToolService';
import type { RiskIntelligenceService } from '../services/riskIntelligenceService';
import type { RiskSummary } from '../types/risk';

type SettingsContract = Pick<SettingsService, 'get' | 'getWithEnvFallback'>;
type TelemetryContract = Pick<TelemetryService, 'trackEvent'>;
type GitHubContract = Pick<GitHubClient, 'getIssueDetails' | 'upsertIssueComment'>;
type CliContract = Pick<CliToolService, 'ensureAutoRunResults' | 'getPromptContext'>;
type RiskContract = Pick<RiskIntelligenceService, 'getSummary'>;

class MockAssessmentStorage {
	public saved?: AssessmentRecord;
	public latest?: AssessmentRecord;

	public async initialize(): Promise<void> {
		// no-op
	}

	public async dispose(): Promise<void> {
		// no-op
	}

	public async saveAssessment(record: AssessmentRecord): Promise<AssessmentRecord> {
		const stored: AssessmentRecord = { ...record, id: record.id ?? 1 };
		this.saved = stored;
		return stored;
	}

	public async getLatestAssessment(): Promise<AssessmentRecord | undefined> {
		return this.latest;
	}

	public async getAssessments(): Promise<AssessmentRecord[]> {
		return this.saved ? [this.saved] : [];
	}
}

class MockSettingsService implements SettingsContract {
	public constructor(private readonly values: Record<string, unknown>, private readonly env: Record<string, string> = {}) {}

	public get<T>(key: string, defaultValue?: T): T | undefined {
		if (Object.prototype.hasOwnProperty.call(this.values, key)) {
			return this.values[key] as T;
		}
		return defaultValue;
	}

	public getWithEnvFallback(key: string, envVar: string): string | undefined {
		if (this.env[envVar]?.trim()) {
			return this.env[envVar]!.trim();
		}
		const value = this.get<string>(key);
		return value && value.trim().length > 0 ? value.trim() : undefined;
	}
}

class MockTelemetryService implements TelemetryContract {
	public readonly events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];

	public trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
		this.events.push({ name, properties, measurements });
	}
}

class MockGitHubClient implements GitHubContract {
	public issue?: IssueDetail;
	public commentBodies: string[] = [];
	public commentRequests: Array<{ repository: string; issue: number; body: string; commentId?: number }> = [];

	public async getIssueDetails(): Promise<IssueDetail> {
		if (!this.issue) {
			throw new Error('Issue not configured');
		}
		return this.issue;
	}

	public async upsertIssueComment(repository: string, issueNumber: number, body: string, commentId?: number): Promise<number | undefined> {
		this.commentBodies.push(body);
		this.commentRequests.push({ repository, issue: issueNumber, body, commentId });
		return commentId ?? 101;
	}
}

class MockCliToolService implements CliContract {
	public autoRuns = 0;

	public async ensureAutoRunResults(): Promise<void> {
		this.autoRuns += 1;
	}

	public getPromptContext(): string | undefined {
		return 'CLI tool context';
	}
}

class MockRiskService implements RiskContract {
	public summary?: RiskSummary;

	public getSummary(): RiskSummary | undefined {
		return this.summary;
	}
}

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

suite('AssessmentService', () => {
	let originalFetch: typeof globalThis.fetch;

	suiteSetup(() => {
		originalFetch = globalThis.fetch;
	});

	suiteTeardown(() => {
		globalThis.fetch = originalFetch;
	});

	teardown(() => {
		globalThis.fetch = originalFetch;
	});

	test('throws when API key is missing', async () => {
		const storage = new MockAssessmentStorage();
		const settings = new MockSettingsService({});
		const telemetry = new MockTelemetryService();
		const github = new MockGitHubClient();
		const cli = new MockCliToolService();
		const risk = new MockRiskService();

		const service = new AssessmentService(storage as unknown as any, settings as unknown as SettingsService, telemetry as unknown as TelemetryService, github as unknown as GitHubClient, cli as unknown as CliToolService, risk as unknown as RiskIntelligenceService);

		await assert.rejects(async () => service.assessIssue('owner/repo', 1), (error: unknown) => {
			assert.ok(error instanceof AssessmentError);
			assert.strictEqual(error.code, 'missingApiKey');
			return true;
		});
	});

	test('adjusts scores using risk summary and posts comment', async () => {
		const storage = new MockAssessmentStorage();
		const settings = new MockSettingsService({
			'assessment.preferredModel': 'openai/gpt-5-mini',
			'assessment.publishComments': true,
			'assessment.apiKey': 'fallback-key'
		}, {
			ISSUETRIAGE_OPENROUTER_API_KEY: 'test-key'
		});
		const telemetry = new MockTelemetryService();
		const github = new MockGitHubClient();
		github.issue = {
			repository: 'owner/repo',
			number: 42,
			title: 'Improve caching',
			url: 'https://github.com/owner/repo/issues/42',
			labels: ['performance'],
			assignees: ['octocat'],
			milestone: 'v1',
			updatedAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			body: 'Investigate cache invalidation behaviour',
			author: 'octocat',
			state: 'open'
		};
		const cli = new MockCliToolService();
		const risk = new MockRiskService();
		risk.summary = {
			status: 'ready',
			riskLevel: 'high',
			riskScore: 80
		};

		const mockResponse = {
			choices: [
				{
					message: {
						content: '{"summary":"Looks good","scores":{"composite":80,"requirements":90,"complexity":70,"security":60,"business":55},"recommendations":["Add more tests"]}'
					}
				}
			]
		};

		globalThis.fetch = (async () => {
			return {
				ok: true,
				json: async () => mockResponse,
				text: async () => JSON.stringify(mockResponse)
			} as Response;
		}) as FetchLike;

		const service = new AssessmentService(storage as unknown as any, settings as unknown as SettingsService, telemetry as unknown as TelemetryService, github as unknown as GitHubClient, cli as unknown as CliToolService, risk as unknown as RiskIntelligenceService);

		const record = await service.assessIssue('owner/repo', 42);

		assert.ok(storage.saved, 'assessment should be persisted');
		assert.strictEqual(storage.saved?.compositeScore, 64, 'composite score should reflect high-risk modifier (80 * 0.8)');
		assert.strictEqual(storage.saved?.complexityScore, 56, 'complexity score should be adjusted (70 * 0.8)');
		assert.strictEqual(storage.saved?.requirementsScore, 90);
		assert.strictEqual(record.commentId, 101);
		assert.strictEqual(cli.autoRuns, 1, 'CLI tools should auto-run before assessments');
		assert.ok(github.commentBodies[0]?.includes('<!-- IssueTriage Assessment -->'));
		const riskAdjustedEvent = telemetry.events.find(event => event.name === 'assessment.riskAdjusted');
		assert.ok(riskAdjustedEvent, 'risk adjustment telemetry should be emitted');
	});
});
