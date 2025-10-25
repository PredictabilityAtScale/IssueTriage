import * as assert from 'assert';
import { SimilarityService } from '../services/similarityService';
import type { RiskProfileStore } from '../services/riskStorage';
import type { RiskProfile } from '../types/risk';

class MockRiskStore implements RiskProfileStore {
	private profiles: RiskProfile[] = [];

	constructor(profiles: RiskProfile[] = []) {
		this.profiles = profiles;
	}

	public async initialize(): Promise<void> {
		return;
	}

	public async dispose(): Promise<void> {
		this.profiles = [];
	}

	public async saveProfile(profile: RiskProfile): Promise<void> {
		this.profiles.push(profile);
	}

	public async getProfile(repository: string, issueNumber: number): Promise<RiskProfile | undefined> {
		return this.profiles.find(p => p.repository === repository && p.issueNumber === issueNumber);
	}

	public async getProfiles(repository: string, issueNumbers: number[]): Promise<RiskProfile[]> {
		return this.profiles.filter(p => p.repository === repository && issueNumbers.includes(p.issueNumber));
	}

	public async searchByKeywords(repository: string, keywords: string[], limit = 10): Promise<RiskProfile[]> {
		// Simple mock: return profiles that share at least one keyword
		return this.profiles
			.filter(p => {
				if (!p.keywords || p.keywords.length === 0) {
					return false;
				}
				const profileKeywords = p.keywords.map(k => k.toLowerCase());
				const searchKeywords = keywords.map(k => k.toLowerCase());
				return searchKeywords.some(sk => profileKeywords.includes(sk));
			})
			.slice(0, limit);
	}

	public async getClosedIssuesWithoutKeywords(repository: string, limit = 100): Promise<RiskProfile[]> {
		return this.profiles
			.filter(p => p.repository === repository && (!p.keywords || p.keywords.length === 0))
			.slice(0, limit);
	}

	public async getKeywordCoverage(repository: string): Promise<{ total: number; withKeywords: number; coverage: number }> {
		const repoProfiles = this.profiles.filter(p => p.repository === repository);
		const withKeywords = repoProfiles.filter(p => p.keywords && p.keywords.length > 0).length;
		const total = repoProfiles.length;
		const coverage = total > 0 ? (withKeywords / total) * 100 : 0;
		return { total, withKeywords, coverage };
	}

	public async getAllProfiles(repository: string): Promise<RiskProfile[]> {
		return this.profiles.filter(p => p.repository === repository);
	}
}

suite('SimilarityService', () => {
	test('should calculate Jaccard similarity correctly', async () => {
		const store = new MockRiskStore([
			{
				repository: 'test/repo',
				issueNumber: 1,
				riskLevel: 'medium',
				riskScore: 50,
				keywords: ['auth', 'security', 'api'],
				calculatedAt: new Date().toISOString(),
				lookbackDays: 180,
				labelFilters: [],
				metrics: {
					prCount: 1,
					filesTouched: 5,
					totalAdditions: 100,
					totalDeletions: 50,
					changeVolume: 150,
					reviewCommentCount: 3,
					prReviewCommentCount: 3,
					prDiscussionCommentCount: 0,
					prChangeRequestCount: 0,
					directCommitCount: 0,
					directCommitAdditions: 0,
					directCommitDeletions: 0,
					directCommitChangeVolume: 0
				},
				evidence: [],
				drivers: [],
				issueTitle: 'Issue 1',
				issueSummary: 'Mock summary for issue 1',
				issueLabels: [],
				changeSummary: '',
				fileChanges: []
			},
			{
				repository: 'test/repo',
				issueNumber: 2,
				riskLevel: 'low',
				riskScore: 20,
				keywords: ['auth', 'refactor', 'cleanup'],
				calculatedAt: new Date().toISOString(),
				lookbackDays: 180,
				labelFilters: [],
				metrics: {
					prCount: 1,
					filesTouched: 2,
					totalAdditions: 50,
					totalDeletions: 30,
					changeVolume: 80,
					reviewCommentCount: 1,
					prReviewCommentCount: 1,
					prDiscussionCommentCount: 0,
					prChangeRequestCount: 0,
					directCommitCount: 0,
					directCommitAdditions: 0,
					directCommitDeletions: 0,
					directCommitChangeVolume: 0
				},
				evidence: [],
				drivers: [],
				issueTitle: 'Issue 2',
				issueSummary: 'Mock summary for issue 2',
				issueLabels: [],
				changeSummary: '',
				fileChanges: []
			}
		]);

		const service = new SimilarityService(store);

		// Search with keywords that match both issues
		const results = await service.findSimilar('test/repo', ['auth', 'security'], undefined, 5);

		assert.ok(results.length > 0, 'Should find similar issues');
		assert.ok(results[0].sharedKeywords.includes('auth'), 'Should identify shared keywords');
		assert.ok(results[0].overlapScore > 0, 'Should calculate overlap score');
	});

	test('should rank by Jaccard score', async () => {
		const store = new MockRiskStore([
			{
				repository: 'test/repo',
				issueNumber: 1,
				riskLevel: 'high',
				riskScore: 80,
				keywords: ['auth', 'security', 'api'], // 2/4 overlap with search
				calculatedAt: new Date().toISOString(),
				lookbackDays: 180,
				labelFilters: [],
				metrics: {
					prCount: 2,
					filesTouched: 10,
					totalAdditions: 200,
					totalDeletions: 100,
					changeVolume: 300,
					reviewCommentCount: 5,
					prReviewCommentCount: 5,
					prDiscussionCommentCount: 0,
					prChangeRequestCount: 0,
					directCommitCount: 0,
					directCommitAdditions: 0,
					directCommitDeletions: 0,
					directCommitChangeVolume: 0
				},
				evidence: [],
				drivers: [],
				issueTitle: 'Issue 1',
				issueSummary: 'Mock summary for issue 1',
				issueLabels: [],
				changeSummary: '',
				fileChanges: []
			},
			{
				repository: 'test/repo',
				issueNumber: 2,
				riskLevel: 'medium',
				riskScore: 50,
				keywords: ['auth', 'security', 'breaking-change'], // 3/4 overlap with search
				calculatedAt: new Date().toISOString(),
				lookbackDays: 180,
				labelFilters: [],
				metrics: {
					prCount: 1,
					filesTouched: 5,
					totalAdditions: 100,
					totalDeletions: 50,
					changeVolume: 150,
					reviewCommentCount: 2,
					prReviewCommentCount: 2,
					prDiscussionCommentCount: 0,
					prChangeRequestCount: 0,
					directCommitCount: 0,
					directCommitAdditions: 0,
					directCommitDeletions: 0,
					directCommitChangeVolume: 0
				},
				evidence: [],
				drivers: [],
				issueTitle: 'Issue 2',
				issueSummary: 'Mock summary for issue 2',
				issueLabels: [],
				changeSummary: '',
				fileChanges: []
			}
		]);

		const service = new SimilarityService(store);

		const results = await service.findSimilar('test/repo', ['auth', 'security', 'breaking-change'], undefined, 5);

		assert.ok(results.length >= 2, 'Should find both issues');
		// Issue 2 should rank higher (3/4 overlap vs 2/5 overlap)
		assert.strictEqual(results[0].issueNumber, 2, 'Should rank by Jaccard similarity');
		assert.ok(results[0].overlapScore > results[1].overlapScore, 'Higher overlap should rank first');
	});

	test('should exclude current issue from results', async () => {
		const store = new MockRiskStore([
			{
				repository: 'test/repo',
				issueNumber: 1,
				riskLevel: 'medium',
				riskScore: 50,
				keywords: ['auth', 'security'],
				calculatedAt: new Date().toISOString(),
				lookbackDays: 180,
				labelFilters: [],
				metrics: {
					prCount: 1,
					filesTouched: 5,
					totalAdditions: 100,
					totalDeletions: 50,
					changeVolume: 150,
					reviewCommentCount: 2,
					prReviewCommentCount: 2,
					prDiscussionCommentCount: 0,
					prChangeRequestCount: 0,
					directCommitCount: 0,
					directCommitAdditions: 0,
					directCommitDeletions: 0,
					directCommitChangeVolume: 0
				},
				evidence: [],
				drivers: [],
				issueTitle: 'Issue 1',
				issueSummary: 'Mock summary for issue 1',
				issueLabels: [],
				changeSummary: '',
				fileChanges: []
			}
		]);

		const service = new SimilarityService(store);

		const results = await service.findSimilar('test/repo', ['auth', 'security'], 1, 5);

		assert.strictEqual(results.length, 0, 'Should exclude current issue from results');
	});

	test('should handle empty keyword list', async () => {
		const store = new MockRiskStore([]);
		const service = new SimilarityService(store);

		const results = await service.findSimilar('test/repo', [], undefined, 5);

		assert.strictEqual(results.length, 0, 'Should return empty results for empty keywords');
	});
});
