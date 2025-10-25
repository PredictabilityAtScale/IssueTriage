import * as assert from 'assert';
import { KeywordBackfillService } from '../services/keywordBackfillService';
import type { RiskProfileStore } from '../services/riskStorage';
import type { RiskProfile, RiskMetrics } from '../types/risk';


function cloneProfile(profile: RiskProfile): RiskProfile {
	return JSON.parse(JSON.stringify(profile));
}

class RecordingRiskStore implements RiskProfileStore {
	public savedProfiles: RiskProfile[] = [];
	public missingCalls: Array<{ repo: string; limit: number } | { repo: string; limit: undefined }> = [];
	public allCalls: Array<{ repo: string }> = [];

	constructor(private readonly missingProfiles: RiskProfile[] = [], private readonly allProfiles: RiskProfile[] = []) {
	}

	public async initialize(): Promise<void> {
		return;
	}

	public async dispose(): Promise<void> {
		this.savedProfiles = [];
	}

	public async saveProfile(profile: RiskProfile): Promise<void> {
		this.savedProfiles.push(cloneProfile(profile));
	}

	public async getProfile(repository: string, issueNumber: number): Promise<RiskProfile | undefined> {
		void repository;
		void issueNumber;
		return undefined;
	}

	public async getProfiles(repository: string, issueNumbers: number[]): Promise<RiskProfile[]> {
		void repository;
		void issueNumbers;
		return [];
	}

	public async getAllProfiles(repository: string): Promise<RiskProfile[]> {
		this.allCalls.push({ repo: repository });
		return this.allProfiles.map(profile => cloneProfile(profile));
	}

	public async getClosedIssuesWithoutKeywords(repository: string, limit = 50): Promise<RiskProfile[]> {
		this.missingCalls.push({ repo: repository, limit });
		const effectiveLimit = typeof limit === 'number' ? limit : this.missingProfiles.length;
		return this.missingProfiles.slice(0, effectiveLimit).map(profile => cloneProfile(profile));
	}

	public async searchByKeywords(repository: string, keywords: string[], limit = 10): Promise<RiskProfile[]> {
		void repository;
		void keywords;
		void limit;
		return [];
	}

	public async getKeywordCoverage(repository: string): Promise<{ total: number; withKeywords: number; coverage: number }> {
		void repository;
		return { total: 0, withKeywords: 0, coverage: 0 };
	}
}

class StubKeywordExtractor {
	public async extractKeywords(issueTitle: string, issueBody: string, issueNumber?: number): Promise<{ keywords: string[]; tokensUsed: number }> {
		void issueTitle;
		void issueBody;
		void issueNumber;
		return { keywords: ['extracted-keyword'], tokensUsed: 42 };
	}
}

class StubTelemetry {
	public trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
		void name;
		void properties;
		void measurements;
		// noop for tests
	}
}

class StubGitHubClient {
	public async getIssueDetails(repository: string, issueNumber: number) {
		void repository;
		void issueNumber;
		return {
			number: 1,
			title: 'Closed issue',
			body: 'Details',
			state: 'closed' as const,
			labels: []
		};
	}
}

function buildMetrics(): RiskMetrics {
	return {
		prCount: 0,
		filesTouched: 0,
		totalAdditions: 0,
		totalDeletions: 0,
		changeVolume: 0,
		reviewCommentCount: 0,
		prReviewCommentCount: 0,
		prDiscussionCommentCount: 0,
		prChangeRequestCount: 0,
		directCommitCount: 0,
		directCommitAdditions: 0,
		directCommitDeletions: 0,
		directCommitChangeVolume: 0
	};
}

function buildProfile(issueNumber: number): RiskProfile {
	return {
		repository: 'owner/repo',
		issueNumber,
		riskLevel: 'low',
		riskScore: 5,
		calculatedAt: new Date().toISOString(),
		lookbackDays: 180,
		labelFilters: [],
		metrics: buildMetrics(),
		evidence: [],
		drivers: [],
		issueTitle: `Issue ${issueNumber}`,
		issueSummary: 'Summary',
		issueLabels: [],
		changeSummary: '',
		fileChanges: []
	};
}

suite('KeywordBackfillService', () => {
	test('backfills only issues missing keywords by default', async () => {
		const missingProfile = buildProfile(101);
		const store = new RecordingRiskStore([missingProfile], []);
		const service = new KeywordBackfillService(
			store,
			new StubGitHubClient() as any,
			new StubKeywordExtractor() as any,
			new StubTelemetry() as any
		);

		const result = await service.backfillKeywords('owner/repo', {
			delayMs: 0,
			maxTokensPerRun: 1000,
			mode: 'missing'
		});

		assert.strictEqual(result.mode, 'missing');
		assert.strictEqual(result.totalIssues, 1);
		assert.strictEqual(result.successCount, 1);
		assert.strictEqual(store.missingCalls.length, 1);
		assert.strictEqual(store.missingCalls[0]?.limit, 50);
		assert.strictEqual(store.allCalls.length, 0);
		assert.ok(store.savedProfiles.length >= 1);
	});

	test('can refresh keywords for all stored profiles', async () => {
		const profiles = [buildProfile(201), buildProfile(202)];
		const store = new RecordingRiskStore([], profiles);
		const service = new KeywordBackfillService(
			store,
			new StubGitHubClient() as any,
			new StubKeywordExtractor() as any,
			new StubTelemetry() as any
		);

		const result = await service.backfillKeywords('owner/repo', {
			delayMs: 0,
			maxTokensPerRun: 1000,
			mode: 'all'
		});

		assert.strictEqual(result.mode, 'all');
		assert.strictEqual(result.totalIssues, 2);
		assert.strictEqual(result.successCount, 2);
		assert.strictEqual(store.allCalls.length, 1);
		assert.strictEqual(store.missingCalls.length, 0);
		assert.ok(store.savedProfiles.length >= 2);
	});
});
