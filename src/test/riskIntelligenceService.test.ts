import * as assert from 'assert';
import { RiskIntelligenceService } from '../services/riskIntelligenceService';
import type { RiskProfileStore } from '../services/riskStorage';
import type { IssueRiskSnapshot, PullRequestRiskData, IssueSummary } from '../services/githubClient';
import type { RiskProfile } from '../types/risk';

type SettingsRecord = Record<string, unknown>;

class MemoryRiskStore implements RiskProfileStore {
	private readonly store = new Map<string, RiskProfile>();

	public async initialize(): Promise<void> {
		return;
	}

	public async dispose(): Promise<void> {
		this.store.clear();
	}

	public async saveProfile(profile: RiskProfile): Promise<void> {
		this.store.set(this.key(profile.repository, profile.issueNumber), profile);
	}

	public async getProfile(repository: string, issueNumber: number): Promise<RiskProfile | undefined> {
		return this.store.get(this.key(repository, issueNumber));
	}

	public async getProfiles(repository: string, issueNumbers: number[]): Promise<RiskProfile[]> {
		return issueNumbers
			.map(issueNumber => this.store.get(this.key(repository, issueNumber)))
			.filter((profile): profile is RiskProfile => Boolean(profile));
	}

	private key(repository: string, issueNumber: number): string {
		return `${repository}#${issueNumber}`;
	}
}

class StubSettings {
	constructor(private readonly values: SettingsRecord = {}) {}

	public get<T>(key: string): T | undefined {
		return this.values[key] as T | undefined;
	}
}

class StubTelemetry {
	public trackEvent(): void {
		// no-op for tests
	}
}

class FakeGitHubClient {
	constructor(private readonly snapshots: Map<string, IssueRiskSnapshot>) {}

	public async getIssueRiskSnapshot(repository: string, issueNumber: number): Promise<IssueRiskSnapshot> {
		const key = `${repository}#${issueNumber}`;
		const snapshot = this.snapshots.get(key);
		if (!snapshot) {
			throw new Error('snapshot not found');
		}
		return snapshot;
	}
}

suite('RiskIntelligenceService', () => {
	test('hydrates risk metrics and caches results', async () => {
		const store = new MemoryRiskStore();
		const pullRequests: PullRequestRiskData[] = [
			{
				number: 10,
				title: 'Large change',
				url: 'https://example.com/pr/10',
				state: 'closed',
				mergedAt: new Date().toISOString(),
				additions: 800,
				deletions: 200,
				changedFiles: 30,
				commits: 5,
				reviewComments: 12,
				comments: 3,
				reviewStates: { CHANGES_REQUESTED: 2, APPROVED: 1 },
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			},
			{
				number: 11,
				title: 'Follow-up fix',
				url: 'https://example.com/pr/11',
				state: 'closed',
				mergedAt: new Date().toISOString(),
				additions: 150,
				deletions: 50,
				changedFiles: 8,
				commits: 2,
				reviewComments: 6,
				comments: 1,
				reviewStates: { APPROVED: 1 },
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}
		];
		const snapshot: IssueRiskSnapshot = {
			issueNumber: 42,
			pullRequests
		};
		const github = new FakeGitHubClient(new Map([[ 'owner/repo#42', snapshot ]]));
		const settings = new StubSettings({ 'risk.lookbackDays': 180 });
		const telemetry = new StubTelemetry();
		const service = new RiskIntelligenceService(store, github as any, settings as any, telemetry);

		const issues: IssueSummary[] = [
			{
				number: 42,
				title: 'Complex issue',
				url: 'https://example.com/issue/42',
				labels: [],
				assignees: [],
				milestone: undefined,
				updatedAt: new Date().toISOString()
			}
		];

		const initialSummaries = await service.primeIssues('owner/repo', issues);
		const primeSummary = initialSummaries.get(42);
		assert.ok(primeSummary);
		assert.strictEqual(primeSummary?.status, 'pending');

		await service.waitForIdle();

		const summary = service.getSummary('owner/repo', 42);
		assert.ok(summary);
		assert.strictEqual(summary?.status, 'ready');
		assert.strictEqual(summary?.riskLevel, 'high');
		assert.ok(summary?.metrics);
		assert.strictEqual(summary?.metrics?.prCount, 2);

		const profile = await service.getProfile('owner/repo', 42);
		assert.ok(profile);
		assert.strictEqual(profile?.metrics.prCount, 2);
		assert.strictEqual(profile?.metrics.changeVolume, 1200);
	});

	test('skips issues outside lookback window', async () => {
		const store = new MemoryRiskStore();
		const github = new FakeGitHubClient(new Map());
		const settings = new StubSettings({ 'risk.lookbackDays': 30 });
		const telemetry = new StubTelemetry();
		const service = new RiskIntelligenceService(store, github as any, settings as any, telemetry);

		const issues: IssueSummary[] = [
			{
				number: 7,
				title: 'Legacy issue',
				url: 'https://example.com/issue/7',
				labels: [],
				assignees: [],
				milestone: undefined,
				updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
			}
		];

		const summaries = await service.primeIssues('owner/repo', issues);
		const summary = summaries.get(7);
		assert.ok(summary);
		assert.strictEqual(summary?.status, 'skipped');
		assert.strictEqual(summary?.message, 'Outside lookback window (30d).');
	});
});
