export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskMetrics {
	prCount: number;
	filesTouched: number;
	totalAdditions: number;
	totalDeletions: number;
	changeVolume: number;
	reviewCommentCount: number;
	prReviewCommentCount: number;
	prDiscussionCommentCount: number;
	prChangeRequestCount: number;
	directCommitCount: number;
	directCommitAdditions: number;
	directCommitDeletions: number;
	directCommitChangeVolume: number;
}

export interface RiskEvidence {
	label: string;
	detail?: string;
	url?: string;
	prSummary?: string;
	prNumber?: number;
}

export interface RiskFileChange {
	path: string;
	additions: number;
	deletions: number;
	changeVolume: number;
	references: string[];
}

export interface RiskProfile {
	repository: string;
	issueNumber: number;
	riskLevel: RiskLevel;
	riskScore: number;
	calculatedAt: string;
	lookbackDays: number;
	labelFilters: string[];
	metrics: RiskMetrics;
	evidence: RiskEvidence[];
	drivers: string[];
	issueTitle: string;
	issueSummary: string;
	issueLabels: string[];
	changeSummary: string;
	fileChanges: RiskFileChange[];
	keywords?: string[];
	commentId?: number;
}

export interface RiskSummary {
	status: 'pending' | 'ready' | 'error' | 'skipped';
	riskLevel?: RiskLevel;
	riskScore?: number;
	calculatedAt?: string;
	topDrivers?: string[];
	metrics?: Pick<RiskMetrics, 'prCount' | 'filesTouched' | 'changeVolume' | 'reviewCommentCount' | 'directCommitCount' | 'prReviewCommentCount' | 'prDiscussionCommentCount' | 'prChangeRequestCount'>;
	message?: string;
	stale?: boolean;
	keywords?: string[];
}

/**
 * Similarity match result with keyword overlap analysis
 */
export interface SimilarIssue {
	repository: string;
	issueNumber: number;
	riskLevel: RiskLevel;
	riskScore: number;
	keywords: string[];
	overlapScore: number;
	sharedKeywords: string[];
	calculatedAt: string;
	issueTitle?: string;
	issueSummary?: string;
	issueLabels?: string[];
}

/**
 * Export manifest for historical dataset
 */
export interface ExportManifest {
	exportRunId: string;
	repoSlug: string;
	issuesExported: number;
	snapshotsExported: number;
	keywordCoveragePct: number;
	exportStartedAt: string;
	exportCompletedAt: string;
	schemaVersion: string;
	tokenUsageSummary?: {
		totalTokens: number;
		estimatedCost?: number;
	};
	validationReport: {
		passed: boolean;
		warnings: string[];
		errors: string[];
	};
}

/**
 * Backfill progress tracking
 */
export interface BackfillProgress {
	totalIssues: number;
	processedIssues: number;
	successCount: number;
	failureCount: number;
	skippedCount: number;
	currentIssue?: number;
	status: 'running' | 'completed' | 'failed' | 'cancelled';
	startedAt: string;
	completedAt?: string;
	tokensUsed: number;
	errors: Array<{
		issueNumber: number;
		message: string;
	}>;
	mode?: 'missing' | 'all';
}
