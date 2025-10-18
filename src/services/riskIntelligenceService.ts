import * as vscode from 'vscode';
import type { IssueSummary, IssueRiskSnapshot, PullRequestRiskData } from './githubClient';
import type { RiskProfileStore } from './riskStorage';
import type { RiskProfile, RiskSummary, RiskMetrics, RiskLevel } from '../types/risk';

interface SettingsReader {
	get<T>(key: string, defaultValue?: T): T | undefined;
}

interface TelemetryClient {
	trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
}

type RiskTask = {
	repository: string;
	issueNumber: number;
	updatedAt?: string;
	lookbackDays: number;
	labelFilters: string[];
};

export interface RiskUpdateEvent {
	repository: string;
	issueNumber: number;
	summary: RiskSummary;
	profile?: RiskProfile;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const HYDRATION_DELAY_MS = 750;

export class RiskIntelligenceService implements vscode.Disposable {
	private readonly summaryCache = new Map<string, Map<number, RiskSummary>>();
	private readonly profileCache = new Map<string, Map<number, RiskProfile>>();
	private readonly queue: RiskTask[] = [];
	private readonly queuedKeys = new Set<string>();
	private processing = false;
	private disposed = false;
	private readonly emitter = new vscode.EventEmitter<RiskUpdateEvent>();

	public readonly onDidUpdate = this.emitter.event;

	constructor(
		private readonly storage: RiskProfileStore,
		private readonly github: { getIssueRiskSnapshot(repository: string, issueNumber: number): Promise<IssueRiskSnapshot> },
		private readonly settings: SettingsReader,
		private readonly telemetry: TelemetryClient
	) {}

	public async primeIssues(repository: string, issues: IssueSummary[]): Promise<Map<number, RiskSummary>> {
		const normalizedRepo = this.normalizeRepository(repository);
		const lookbackDays = this.getLookbackDays();
		const labelFilters = this.getLabelFilters();

		await this.storage.initialize();
		const issueNumbers = issues.map(issue => issue.number);
		const storedProfiles = await this.storage.getProfiles(repository, issueNumbers);
		const profilesByNumber = new Map(storedProfiles.map(profile => [profile.issueNumber, profile]));

		const summaries = new Map<number, RiskSummary>();
		for (const issue of issues) {
			const stored = profilesByNumber.get(issue.number);
			const evaluation = this.evaluateIssue(issue, stored, lookbackDays, labelFilters);
			summaries.set(issue.number, evaluation.summary);
			this.cacheSummary(normalizedRepo, issue.number, evaluation.summary);
			if (evaluation.profile) {
				this.cacheProfile(normalizedRepo, evaluation.profile);
			}
			if (evaluation.hydrate) {
				this.enqueue({ repository, issueNumber: issue.number, updatedAt: issue.updatedAt, lookbackDays, labelFilters });
			}
		}

		this.processQueue().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('risk.queue.processFailed', { repository, message });
		});

		return summaries;
	}

	public getSummary(repository: string, issueNumber: number): RiskSummary | undefined {
		const repoKey = this.normalizeRepository(repository);
		return this.summaryCache.get(repoKey)?.get(issueNumber);
	}

	public async getProfile(repository: string, issueNumber: number): Promise<RiskProfile | undefined> {
		const repoKey = this.normalizeRepository(repository);
		const cached = this.profileCache.get(repoKey)?.get(issueNumber);
		if (cached) {
			return cached;
		}
		const stored = await this.storage.getProfile(repository, issueNumber);
		if (stored) {
			this.cacheProfile(repoKey, stored);
		}
		return stored;
	}

	public async waitForIdle(timeoutMs = 10_000): Promise<void> {
		const start = Date.now();
		while (!this.disposed && (this.processing || this.queue.length > 0)) {
			if (Date.now() - start > timeoutMs) {
				throw new Error('Timed out waiting for risk hydration queue.');
			}
			await delay(35);
		}
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.queue.length = 0;
		this.queuedKeys.clear();
		this.emitter.dispose();
		void this.storage.dispose();
	}

	private evaluateIssue(issue: IssueSummary, stored: RiskProfile | undefined, lookbackDays: number, labelFilters: string[]): { summary: RiskSummary; profile?: RiskProfile; hydrate: boolean } {
		const skipReason = this.shouldSkip(issue, lookbackDays, labelFilters);
		if (skipReason) {
			return {
				summary: {
					status: 'skipped',
					message: skipReason
				},
				hydrate: false
			};
		}

		if (!stored) {
			return {
				summary: {
					status: 'pending',
					message: 'Collecting historical risk signals…'
				},
				hydrate: true
			};
		}

		const stale = this.isStale(issue, stored, lookbackDays, labelFilters);
		return {
			summary: this.toSummary(stored, stale),
			profile: stored,
			hydrate: stale
		};
	}

	private shouldSkip(issue: IssueSummary, lookbackDays: number, labelFilters: string[]): string | undefined {
		const updatedAt = Date.parse(issue.updatedAt);
		if (Number.isFinite(updatedAt)) {
			const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
			if (Date.now() - updatedAt > lookbackMs) {
				return `Outside lookback window (${lookbackDays}d).`;
			}
		}
		if (labelFilters.length) {
			const labelsLower = issue.labels.map(label => label.toLowerCase());
			const hasMatch = labelFilters.some(filter => labelsLower.some(label => label.includes(filter)));
			if (!hasMatch) {
				return 'Filtered by label preferences.';
			}
		}
		return undefined;
	}

	private isStale(issue: IssueSummary, profile: RiskProfile, lookbackDays: number, labelFilters: string[]): boolean {
		if (profile.lookbackDays !== lookbackDays) {
			return true;
		}
		if (!this.sameFilters(profile.labelFilters, labelFilters)) {
			return true;
		}
		const calculatedAt = Date.parse(profile.calculatedAt);
		if (!Number.isFinite(calculatedAt)) {
			return true;
		}
		const updatedAt = Date.parse(issue.updatedAt);
		if (Number.isFinite(updatedAt) && updatedAt > calculatedAt) {
			return true;
		}
		return Date.now() - calculatedAt > CACHE_TTL_MS;
	}

	private sameFilters(a: string[], b: string[]): boolean {
		if (a.length !== b.length) {
			return false;
		}
		const sort = (values: string[]) => [...values].map(item => item.toLowerCase()).sort();
		const [sortedA, sortedB] = [sort(a), sort(b)];
		return sortedA.every((value, index) => value === sortedB[index]);
	}

	private enqueue(task: RiskTask): void {
		if (this.disposed) {
			return;
		}
		const key = `${this.normalizeRepository(task.repository)}#${task.issueNumber}`;
		if (this.queuedKeys.has(key)) {
			return;
		}
		this.queue.push(task);
		this.queuedKeys.add(key);
	}

	private async processQueue(): Promise<void> {
		if (this.processing || this.disposed) {
			return;
		}
		this.processing = true;
		try {
			while (!this.disposed && this.queue.length > 0) {
				const task = this.queue.shift();
				if (!task) {
					break;
				}
				const key = `${this.normalizeRepository(task.repository)}#${task.issueNumber}`;
				this.queuedKeys.delete(key);
				await this.runTask(task);
				if (this.queue.length > 0) {
					await delay(HYDRATION_DELAY_MS);
				}
			}
		} finally {
			this.processing = false;
		}
	}

	private async runTask(task: RiskTask): Promise<void> {
		if (this.disposed) {
			return;
		}
		const repoKey = this.normalizeRepository(task.repository);
		const pendingSummary: RiskSummary = {
			status: 'pending',
			message: 'Collecting historical risk signals…'
		};
		this.cacheSummary(repoKey, task.issueNumber, pendingSummary);
		this.emitUpdate(task.repository, task.issueNumber, pendingSummary);

		try {
			const snapshot = await this.github.getIssueRiskSnapshot(task.repository, task.issueNumber);
			
			// Skip if no pull requests are linked - no meaningful risk data
			if (!snapshot.pullRequests || snapshot.pullRequests.length === 0) {
				const skipSummary: RiskSummary = {
					status: 'skipped',
					message: 'No linked pull requests found. Risk analysis requires merged PR history.'
				};
				this.cacheSummary(repoKey, task.issueNumber, skipSummary);
				this.emitUpdate(task.repository, task.issueNumber, skipSummary);
				this.telemetry.trackEvent('risk.skippedNoPRs', {
					repository: task.repository,
					issue: String(task.issueNumber)
				});
				return;
			}

			const profile = this.buildProfile(task, snapshot);
			await this.storage.saveProfile(profile);
			this.cacheProfile(repoKey, profile);
			const summary = this.toSummary(profile, false);
			this.cacheSummary(repoKey, task.issueNumber, summary);
			this.emitUpdate(task.repository, task.issueNumber, summary, profile);
			this.telemetry.trackEvent('risk.hydrationComplete', {
				repository: task.repository,
				issue: String(task.issueNumber),
				level: summary.riskLevel ?? 'unknown'
			}, summary.riskScore ? { riskScore: summary.riskScore } : undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const summary: RiskSummary = {
				status: 'error',
				message
			};
			this.cacheSummary(repoKey, task.issueNumber, summary);
			this.emitUpdate(task.repository, task.issueNumber, summary);
			this.telemetry.trackEvent('risk.hydrationFailed', {
				repository: task.repository,
				issue: String(task.issueNumber),
				message
			});
		}
	}

	private buildProfile(task: RiskTask, snapshot: IssueRiskSnapshot): RiskProfile {
		const metrics = this.computeMetrics(snapshot.pullRequests);
		const riskScore = this.calculateRiskScore(metrics);
		const riskLevel = this.scoreToLevel(riskScore);
		const drivers = this.identifyDrivers(metrics);
		const evidence = this.buildEvidence(snapshot.pullRequests);
		return {
			repository: task.repository,
			issueNumber: task.issueNumber,
			riskLevel,
			riskScore,
			metrics,
			evidence,
			drivers,
			lookbackDays: task.lookbackDays,
			labelFilters: task.labelFilters,
			calculatedAt: new Date().toISOString()
		};
	}

	private computeMetrics(pullRequests: PullRequestRiskData[]): RiskMetrics {
		return pullRequests.reduce<RiskMetrics>((acc, pr) => {
			acc.prCount += 1;
			acc.filesTouched += pr.changedFiles ?? 0;
			acc.totalAdditions += pr.additions ?? 0;
			acc.totalDeletions += pr.deletions ?? 0;
			acc.changeVolume += (pr.additions ?? 0) + (pr.deletions ?? 0);
			const reviewFriction = (pr.reviewComments ?? 0) + (pr.comments ?? 0) + (pr.reviewStates?.CHANGES_REQUESTED ?? 0) * 2;
			acc.reviewCommentCount += reviewFriction;
			return acc;
		}, {
			prCount: 0,
			filesTouched: 0,
			totalAdditions: 0,
			totalDeletions: 0,
			changeVolume: 0,
			reviewCommentCount: 0
		});
	}

	private calculateRiskScore(metrics: RiskMetrics): number {
		const prScore = Math.min(40, metrics.prCount * 15);
		const fileScore = Math.min(20, Math.floor(metrics.filesTouched / 5) * 5);
		const churnScore = Math.min(20, Math.floor(metrics.changeVolume / 200) * 5);
		const reviewScore = Math.min(20, Math.floor(metrics.reviewCommentCount / 5) * 5);
		const score = prScore + fileScore + churnScore + reviewScore;
		return Math.min(100, Math.max(0, score));
	}

	private scoreToLevel(score: number): RiskLevel {
		if (score >= 70) {
			return 'high';
		}
		if (score >= 40) {
			return 'medium';
		}
		return 'low';
	}

	private identifyDrivers(metrics: RiskMetrics): string[] {
		const drivers: string[] = [];
		if (metrics.prCount > 1) {
			drivers.push(`${metrics.prCount} pull requests were required for similar work.`);
		}
		if (metrics.filesTouched >= 25) {
			drivers.push(`${metrics.filesTouched} files touched across linked pull requests.`);
		}
		if (metrics.changeVolume >= 1000) {
			drivers.push(`${metrics.changeVolume} lines changed recently.`);
		}
		if (metrics.reviewCommentCount >= 15) {
			drivers.push(`High review friction with ${metrics.reviewCommentCount} comments or change requests.`);
		}
		return drivers.slice(0, 5);
	}

	private buildEvidence(pullRequests: PullRequestRiskData[]): RiskProfile['evidence'] {
		return pullRequests.slice(0, 5).map(pr => ({
			label: `PR #${pr.number}`,
			detail: `${pr.changedFiles ?? 0} files · +${pr.additions ?? 0}/-${pr.deletions ?? 0} · ${pr.reviewComments ?? 0} review comments`,
			url: pr.url,
			prSummary: pr.title,
			prNumber: pr.number
		}));
	}

	private toSummary(profile: RiskProfile, stale: boolean): RiskSummary {
		return {
			status: 'ready',
			riskLevel: profile.riskLevel,
			riskScore: profile.riskScore,
			calculatedAt: profile.calculatedAt,
			topDrivers: profile.drivers.slice(0, 3),
			metrics: {
				prCount: profile.metrics.prCount,
				filesTouched: profile.metrics.filesTouched,
				changeVolume: profile.metrics.changeVolume,
				reviewCommentCount: profile.metrics.reviewCommentCount
			},
			stale
		};
	}

	private cacheSummary(repository: string, issueNumber: number, summary: RiskSummary): void {
		if (!this.summaryCache.has(repository)) {
			this.summaryCache.set(repository, new Map());
		}
		this.summaryCache.get(repository)?.set(issueNumber, { ...summary });
	}

	private cacheProfile(repository: string, profile: RiskProfile): void {
		if (!this.profileCache.has(repository)) {
			this.profileCache.set(repository, new Map());
		}
		this.profileCache.get(repository)?.set(profile.issueNumber, { ...profile });
	}

	private emitUpdate(repository: string, issueNumber: number, summary: RiskSummary, profile?: RiskProfile): void {
		this.emitter.fire({ repository, issueNumber, summary, profile });
	}

	private normalizeRepository(value: string): string {
		return value.toLowerCase();
	}

	private getLookbackDays(): number {
		const configured = this.settings.get<number>('risk.lookbackDays');
		if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
			return Math.min(365, Math.max(30, Math.floor(configured)));
		}
		return 180;
	}

	private getLabelFilters(): string[] {
		const configured = this.settings.get<string[]>('risk.labelFilters', []) ?? [];
		return configured
			.map(label => label.trim().toLowerCase())
			.filter(label => label.length > 0);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
