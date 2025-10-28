import * as assert from 'assert';
import { RiskIntelligenceService } from '../services/riskIntelligenceService';
import type { RiskProfileStore } from '../services/riskStorage';
import type { IssueRiskSnapshot, PullRequestRiskData, CommitRiskData, IssueSummary, IssueDetail } from '../services/githubClient';
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

	public async searchByKeywords(repository: string, keywords: string[], limit = 10): Promise<RiskProfile[]> {
		return [];
	}

	public async getClosedIssuesWithoutKeywords(repository: string, limit = 100): Promise<RiskProfile[]> {
		return [];
	}

	public async getKeywordCoverage(repository: string): Promise<{ total: number; withKeywords: number; coverage: number }> {
		return { total: 0, withKeywords: 0, coverage: 0 };
	}

	public async getAllProfiles(repository: string): Promise<RiskProfile[]> {
		return Array.from(this.store.values()).filter(profile => profile.repository === repository);
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
	constructor(
		private readonly snapshots: Map<string, IssueRiskSnapshot>,
		private readonly issues: Map<string, IssueDetail>,
		private readonly pullRequestDetails: Map<string, { files: Array<{ path: string; additions?: number; deletions?: number }> }> = new Map(),
		private readonly commitDetails: Map<string, { files: Array<{ path: string; additions?: number; deletions?: number }> }> = new Map()
	) {}

	public async getIssueRiskSnapshot(repository: string, issueNumber: number): Promise<IssueRiskSnapshot> {
		const key = `${repository}#${issueNumber}`;
		const snapshot = this.snapshots.get(key);
		if (!snapshot) {
			throw new Error('snapshot not found');
		}
		return snapshot;
	}

	public async getIssueDetails(repository: string, issueNumber: number) {
		const key = `${repository}#${issueNumber}`;
		const detail = this.issues.get(key);
		if (!detail) {
			throw new Error('issue detail not found');
		}
		return detail;
	}

	public async getPullRequestBackfillDetail(repository: string, pullNumber: number) {
		const key = `${repository}#${pullNumber}`;
		return this.pullRequestDetails.get(key) ?? { files: [] };
	}

	public async getCommitBackfillDetail(repository: string, sha: string) {
		const key = `${repository}#${sha}`;
		return this.commitDetails.get(key) ?? { files: [] };
	}

	public static buildIssueDetail(issue: IssueSummary & { body?: string; author?: string }): IssueDetail {
		return {
			number: issue.number,
			title: issue.title,
			body: issue.body ?? '',
			url: issue.url,
			repository: 'owner/repo',
			author: issue.author ?? 'octocat',
			labels: issue.labels,
			assignees: issue.assignees,
			milestone: issue.milestone,
			updatedAt: issue.updatedAt,
			createdAt: issue.updatedAt,
			state: issue.state,
			comments: []
		};
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
			pullRequests,
			commits: []
		};
		const issues: IssueSummary[] = [
			{
				number: 42,
				title: 'Complex issue',
				url: 'https://example.com/issue/42',
				labels: [],
				assignees: [],
				milestone: undefined,
				updatedAt: new Date().toISOString(),
				state: 'open'
			}
		];
		const issueDetail = FakeGitHubClient.buildIssueDetail({ ...issues[0], body: 'Complex issue body describing regression risk.' });
		const prDetails = new Map([
			['owner/repo#10', { files: [{ path: 'src/auth/service.ts', additions: 500, deletions: 120 }] }],
			['owner/repo#11', { files: [{ path: 'src/auth/fix.ts', additions: 80, deletions: 20 }] }]
		]);
		const github = new FakeGitHubClient(
			new Map([[ 'owner/repo#42', snapshot ]]),
			new Map([[ 'owner/repo#42', issueDetail ]]),
			prDetails
		);
		const settings = new StubSettings({ 'risk.lookbackDays': 180 });
		const telemetry = new StubTelemetry();
		const service = new RiskIntelligenceService(store, github as any, settings as any, telemetry);

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
		assert.strictEqual(summary?.metrics?.directCommitCount, 0);
		assert.strictEqual(summary?.metrics?.prReviewCommentCount, 18);
		assert.strictEqual(summary?.metrics?.prDiscussionCommentCount, 4);
		assert.strictEqual(summary?.metrics?.prChangeRequestCount, 2);

		const profile = await service.getProfile('owner/repo', 42);
		assert.ok(profile);
		assert.strictEqual(profile?.metrics.prCount, 2);
		assert.strictEqual(profile?.metrics.directCommitCount, 0);
		assert.strictEqual(profile?.metrics.changeVolume, 1200);
		assert.strictEqual(profile?.metrics.directCommitChangeVolume, 0);
		assert.strictEqual(profile?.metrics.reviewCommentCount, 26);
		assert.strictEqual(profile?.metrics.prReviewCommentCount, 18);
		assert.strictEqual(profile?.metrics.prDiscussionCommentCount, 4);
		assert.strictEqual(profile?.metrics.prChangeRequestCount, 2);
	});

	test('uses direct commits when no pull requests are linked', async () => {
		const store = new MemoryRiskStore();
		const commits: CommitRiskData[] = [
			{
				sha: 'abc123def456',
				message: 'Backfill hotfix for production',
				url: 'https://example.com/commit/abc123',
				additions: 600,
				deletions: 150,
				changedFiles: 40,
				author: 'octocat',
				authoredDate: new Date().toISOString(),
				committedDate: new Date().toISOString()
			}
		];
		const snapshot: IssueRiskSnapshot = {
			issueNumber: 77,
			pullRequests: [],
			commits
		};
		const issues: IssueSummary[] = [
			{
				number: 77,
				title: 'Legacy backfill',
				url: 'https://example.com/issue/77',
				labels: [],
				assignees: [],
				milestone: undefined,
				updatedAt: new Date().toISOString(),
				state: 'open'
			}
		];
		const issueDetail = FakeGitHubClient.buildIssueDetail({ ...issues[0], body: 'Legacy backfill body', author: 'maintainer' });
		const commitDetails = new Map([
			['owner/repo#abc123def456', { files: [{ path: 'server/core.ts', additions: 600, deletions: 150 }] }]
		]);
		const github = new FakeGitHubClient(
			new Map([[ 'owner/repo#77', snapshot ]]),
			new Map([[ 'owner/repo#77', issueDetail ]]),
			new Map(),
			commitDetails
		);
		const settings = new StubSettings({ 'risk.lookbackDays': 90 });
		const telemetry = new StubTelemetry();
		const service = new RiskIntelligenceService(store, github as any, settings as any, telemetry);

		await service.primeIssues('owner/repo', issues);
		await service.waitForIdle();

		const summary = service.getSummary('owner/repo', 77);
		assert.ok(summary);
		assert.strictEqual(summary?.status, 'ready');
		assert.ok(summary?.metrics);
		assert.strictEqual(summary?.metrics?.prCount, 0);
		assert.strictEqual(summary?.metrics?.directCommitCount, 1);
		assert.strictEqual(summary?.riskLevel, 'medium');
		assert.strictEqual(summary?.metrics?.prReviewCommentCount, 0);
		assert.strictEqual(summary?.metrics?.prDiscussionCommentCount, 0);
		assert.strictEqual(summary?.metrics?.prChangeRequestCount, 0);

		const profile = await service.getProfile('owner/repo', 77);
		assert.ok(profile);
		assert.strictEqual(profile?.metrics.directCommitCount, 1);
		assert.strictEqual(profile?.metrics.changeVolume, 750);
		assert.strictEqual(profile?.metrics.directCommitChangeVolume, 750);
		assert.strictEqual(profile?.metrics.prReviewCommentCount, 0);
		assert.strictEqual(profile?.metrics.prDiscussionCommentCount, 0);
		assert.strictEqual(profile?.metrics.prChangeRequestCount, 0);
	});

	test('skips issues outside lookback window', async () => {
		const store = new MemoryRiskStore();
		const github = new FakeGitHubClient(new Map(), new Map());
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
				updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
				state: 'open'
			}
		];

		const summaries = await service.primeIssues('owner/repo', issues);
		const summary = summaries.get(7);
		assert.ok(summary);
		assert.strictEqual(summary?.status, 'skipped');
		assert.strictEqual(summary?.message, 'Outside lookback window (30d).');
	});
});
