import type { RiskProfileStore } from './riskStorage';
import type { SimilarIssue } from '../types/risk';

export class SimilarityService {
	constructor(private readonly storage: RiskProfileStore) {}

	/**
	 * Find similar issues using FTS5 keyword search and Jaccard similarity re-ranking
	 */
	public async findSimilar(
		repository: string,
		keywords: string[],
		currentIssueNumber?: number,
		limit = 5
	): Promise<SimilarIssue[]> {
		if (keywords.length === 0) {
			return [];
		}

		// Query FTS5 for keyword matches (returns more results for re-ranking)
		const candidates = await this.storage.searchByKeywords(repository, keywords, limit * 3);
		
		// Filter out the current issue if provided
		const filtered = currentIssueNumber
			? candidates.filter((profile) => profile.issueNumber !== currentIssueNumber)
			: candidates;

		// Calculate Jaccard similarity and build result objects
		const scored = filtered
			.filter((profile) => profile.keywords && profile.keywords.length > 0)
			.map((profile) => {
				const profileKeywords = profile.keywords ?? [];
				const { overlap, score } = this.calculateJaccardSimilarity(keywords, profileKeywords);
				
				return {
					repository: profile.repository,
					issueNumber: profile.issueNumber,
					riskLevel: profile.riskLevel,
					riskScore: profile.riskScore,
					keywords: profileKeywords,
					issueTitle: profile.issueTitle,
					issueSummary: profile.issueSummary,
					issueLabels: profile.issueLabels ?? [],
					overlapScore: score,
					sharedKeywords: overlap,
					calculatedAt: profile.calculatedAt
				} as SimilarIssue;
			});

		// Sort by Jaccard score descending, then by risk score descending
		scored.sort((a: SimilarIssue, b: SimilarIssue) => {
			if (b.overlapScore !== a.overlapScore) {
				return b.overlapScore - a.overlapScore;
			}
			return b.riskScore - a.riskScore;
		});

		return scored.slice(0, limit);
	}

	/**
	 * Calculate Jaccard similarity: |A ∩ B| / |A ∪ B|
	 * Returns both the overlap score and shared keywords
	 */
	private calculateJaccardSimilarity(
		setA: string[],
		setB: string[]
	): { overlap: string[]; score: number } {
		const normalizedA = new Set(setA.map(kw => kw.toLowerCase()));
		const normalizedB = new Set(setB.map(kw => kw.toLowerCase()));

		const intersection = new Set<string>();
		for (const item of normalizedA) {
			if (normalizedB.has(item)) {
				intersection.add(item);
			}
		}

		const union = new Set([...normalizedA, ...normalizedB]);
		const score = union.size === 0 ? 0 : intersection.size / union.size;

		return {
			overlap: Array.from(intersection),
			score
		};
	}
}
