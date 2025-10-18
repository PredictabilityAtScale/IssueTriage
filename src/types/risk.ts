export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskMetrics {
	prCount: number;
	filesTouched: number;
	totalAdditions: number;
	totalDeletions: number;
	changeVolume: number;
	reviewCommentCount: number;
}

export interface RiskEvidence {
	label: string;
	detail?: string;
	url?: string;
	prSummary?: string;
	prNumber?: number;
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
}

export interface RiskSummary {
	status: 'pending' | 'ready' | 'error' | 'skipped';
	riskLevel?: RiskLevel;
	riskScore?: number;
	calculatedAt?: string;
	topDrivers?: string[];
	metrics?: Pick<RiskMetrics, 'prCount' | 'filesTouched' | 'changeVolume' | 'reviewCommentCount'>;
	message?: string;
	stale?: boolean;
}
