import * as vscode from 'vscode';
import type {
	IssueSummary,
	IssueRiskSnapshot,
	PullRequestRiskData,
	CommitRiskData,
	PullRequestBackfillDetail,
	CommitBackfillDetail,
	IssueDetail
} from './githubClient';
import type { RiskProfileStore } from './riskStorage';
import type { RiskProfile, RiskSummary, RiskMetrics, RiskLevel, RiskFileChange, RiskEvidence } from '../types/risk';
import type { KeywordExtractionService } from './keywordExtractionService';
import { ensureKeywordCoverage } from './keywordUtils';
import type { KeywordContext } from './keywordUtils';

interface SettingsReader {
	get<T>(key: string, defaultValue?: T): T | undefined;
}

interface TelemetryClient {
	trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
}

interface GitHubIssueClient {
	getIssueRiskSnapshot(repository: string, issueNumber: number): Promise<IssueRiskSnapshot>;
	getIssueDetails(repository: string, issueNumber: number): Promise<IssueDetail>;
	getPullRequestBackfillDetail(repository: string, pullNumber: number): Promise<PullRequestBackfillDetail>;
	getCommitBackfillDetail(repository: string, sha: string): Promise<CommitBackfillDetail>;
	upsertIssueComment(repository: string, issueNumber: number, body: string, commentId?: number): Promise<number | undefined>;
}

type RiskTask = {
	repository: string;
	issueNumber: number;
	updatedAt?: string;
	lookbackDays: number;
	labelFilters: string[];
	force?: boolean;
};

interface ParsedRiskComment {
	riskLevel: RiskLevel;
	riskScore: number;
	metrics: RiskMetrics;
	evidence: RiskEvidence[];
	drivers: string[];
	keywords?: string[];
	lookbackDays?: number;
	labelFilters?: string[];
	calculatedAt?: string;
	changeSummary?: string;
	fileChanges?: RiskFileChange[];
}

export interface RiskUpdateEvent {
	repository: string;
	issueNumber: number;
	summary: RiskSummary;
	profile?: RiskProfile;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const HYDRATION_DELAY_MS = 750;
const RISK_COMMENT_TAG = '<!-- IssueTriage Risk Intelligence -->';

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
		private readonly github: GitHubIssueClient,
		private readonly settings: SettingsReader,
		private readonly telemetry: TelemetryClient,
		private readonly keywordExtractor?: KeywordExtractionService
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

	public async getKeywordCoverage(repository: string): Promise<{ total: number; withKeywords: number; coverage: number }> {
		return this.storage.getKeywordCoverage(repository);
	}

	public async getProfileCount(repository: string): Promise<number> {
		const coverage = await this.getKeywordCoverage(repository);
		return coverage.total;
	}

	public async findIssuesMissingProfiles(repository: string, issues: IssueSummary[]): Promise<IssueSummary[]> {
		if (!issues.length) {
			return [];
		}
		await this.storage.initialize();
		const unique = this.dedupeIssues(issues);
		const stored = await this.storage.getProfiles(repository, unique.map(issue => issue.number));
		const existing = new Set(stored.map(profile => profile.issueNumber));
		return unique.filter(issue => !existing.has(issue.number));
	}

	public async hydrateProfilesFromGitHub(repository: string, issues: IssueSummary[], options: { limit?: number } = {}): Promise<number> {
		if (!issues.length) {
			return 0;
		}
		await this.storage.initialize();
		const normalizedRepo = this.normalizeRepository(repository);
		const unique = this.dedupeIssues(issues);
		const limit = typeof options.limit === 'number' && options.limit > 0
			? Math.min(options.limit, unique.length)
			: unique.length;
		const slice = unique.slice(0, limit);
		const stored = await this.storage.getProfiles(repository, slice.map(issue => issue.number));
		const existing = new Set(stored.map(profile => profile.issueNumber));
		let hydrated = 0;
		for (const issue of slice) {
			if (existing.has(issue.number)) {
				continue;
			}
			try {
				const detail = await this.github.getIssueDetails(repository, issue.number);
				const comment = this.findLatestRiskComment(detail);
				if (!comment) {
					continue;
				}
				const parsed = this.parseRiskComment(comment.body);
				if (!parsed) {
					this.telemetry.trackEvent('risk.hydrate.parseSkipped', {
						repository,
						issue: String(issue.number)
					});
					continue;
				}
				const profile: RiskProfile = {
					repository,
					issueNumber: issue.number,
					riskLevel: parsed.riskLevel,
					riskScore: parsed.riskScore,
					metrics: parsed.metrics,
					evidence: parsed.evidence,
					drivers: parsed.drivers,
					lookbackDays: parsed.lookbackDays ?? this.getLookbackDays(),
					labelFilters: parsed.labelFilters ?? this.getLabelFilters(),
					calculatedAt: parsed.calculatedAt ?? new Date().toISOString(),
					keywords: parsed.keywords,
					issueTitle: detail.title,
					issueSummary: this.buildIssueSummary(detail.body),
					issueLabels: detail.labels,
					changeSummary: parsed.changeSummary ?? '',
					fileChanges: parsed.fileChanges ?? [],
					commentId: comment.id
				};
				await this.storage.saveProfile(profile);
				this.cacheProfile(normalizedRepo, profile);
				const summary = this.toSummary(profile, false);
				this.cacheSummary(normalizedRepo, issue.number, summary);
				this.emitUpdate(repository, issue.number, summary, profile);
				hydrated += 1;
				this.telemetry.trackEvent('risk.hydrate.saved', {
					repository,
					issue: String(issue.number)
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.telemetry.trackEvent('risk.hydrate.failed', {
					repository,
					issue: String(issue.number),
					message
				});
			}
		}
		return hydrated;
	}

	public queueHydration(repository: string, issues: IssueSummary[], options: { force?: boolean } = {}): void {
		if (!issues.length) {
			return;
		}
		const lookbackDays = this.getLookbackDays();
		const labelFilters = this.getLabelFilters();
		const repoKey = this.normalizeRepository(repository);
		for (const issue of this.dedupeIssues(issues)) {
			const pending: RiskSummary = {
				status: 'pending',
				message: 'Collecting historical risk signals…'
			};
			this.cacheSummary(repoKey, issue.number, pending);
			this.emitUpdate(repository, issue.number, pending);
			this.enqueue({
				repository,
				issueNumber: issue.number,
				updatedAt: issue.updatedAt,
				lookbackDays,
				labelFilters,
				force: options.force ?? false
			});
		}
		this.processQueue().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('risk.queue.processFailed', { repository, message });
		});
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
		if (issue.state !== 'closed' && Number.isFinite(updatedAt)) {
			const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
			if (Date.now() - updatedAt > lookbackMs) {
				return `Outside lookback window (${lookbackDays}d).`;
			}
		}
		if (issue.state !== 'closed' && labelFilters.length) {
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
		// Never mark closed issues as stale based on time alone - they won't change
		// and keywords have already been extracted
		if (issue.state === 'closed') {
			return false;
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
			const previousProfile = await this.storage.getProfile(task.repository, task.issueNumber);
			const pullRequests = snapshot.pullRequests ?? [];
			const commits = snapshot.commits ?? [];
			if (pullRequests.length === 0 && commits.length === 0) {
				const skipSummary: RiskSummary = {
					status: 'skipped',
					message: 'No linked pull requests or commits found. Risk analysis requires recent change history.'
				};
				this.cacheSummary(repoKey, task.issueNumber, skipSummary);
				this.emitUpdate(task.repository, task.issueNumber, skipSummary);
				this.telemetry.trackEvent('risk.skippedNoHistory', {
					repository: task.repository,
					issue: String(task.issueNumber)
				});
				return;
			}
			const issueDetail = await this.github.getIssueDetails(task.repository, task.issueNumber);
			const existingComment = this.findLatestRiskComment(issueDetail);
			const parsedComment = existingComment ? this.parseRiskComment(existingComment.body) : undefined;
			const reuseCommentId = !task.force;
			const commentId = reuseCommentId ? (previousProfile?.commentId ?? existingComment?.id) : undefined;
			const allowKeywordExtraction = !previousProfile && !existingComment;

			const profile = await this.buildProfile(task, snapshot, issueDetail, {
				previousProfile,
				parsedComment,
				commentId,
				allowKeywordExtraction
			});

			// Post comment to GitHub if enabled
			const publishComments = this.shouldPublishComments();
			if (publishComments) {
				try {
					const markdown = this.buildRiskComment(profile);
					const postedCommentId = await this.github.upsertIssueComment(
						task.repository,
						task.issueNumber,
						markdown,
						profile.commentId
					);
					if (postedCommentId) {
						profile.commentId = postedCommentId;
					}
				} catch (commentError) {
					this.telemetry.trackEvent('risk.commentFailed', {
						repository: task.repository,
						issue: String(task.issueNumber),
						message: commentError instanceof Error ? commentError.message : String(commentError)
					});
					// Continue processing even if comment fails
				}
			}

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

	private async buildProfile(
		task: RiskTask,
		snapshot: IssueRiskSnapshot,
		issue: IssueDetail,
		options: {
			previousProfile?: RiskProfile;
			parsedComment?: ParsedRiskComment;
			commentId?: number;
			allowKeywordExtraction: boolean;
		}
	): Promise<RiskProfile> {
		const pullRequests = snapshot.pullRequests ?? [];
		const commits = snapshot.commits ?? [];
		const metrics = this.computeMetrics(pullRequests, commits);
		const riskScore = this.calculateRiskScore(metrics);
		const riskLevel = this.scoreToLevel(riskScore);
		const drivers = this.identifyDrivers(metrics);
		const evidence = this.buildEvidence(pullRequests, commits);
		const fileChanges = await this.collectFileChanges(task.repository, pullRequests, commits);
		const issueSummary = this.buildIssueSummary(issue.body);
		const changeSummary = this.buildChangeSummary(metrics, evidence, fileChanges);
		const keywordContext = {
			issueTitle: issue.title,
			issueBody: issue.body,
			labels: issue.labels,
			evidenceSummaries: evidence.map(item => item.prSummary ?? item.detail ?? item.label),
			filePaths: fileChanges.map(file => file.path),
			changeSummary,
			repository: task.repository
		};

		let keywords = options.previousProfile?.keywords ?? options.parsedComment?.keywords;
		if (this.keywordExtractor && options.allowKeywordExtraction) {
			const extracted = await this.tryExtractKeywords(task, issue.title, issue.body, keywordContext);
			if (extracted && extracted.length > 0) {
				keywords = extracted;
			}
		}
		const coveredKeywords = ensureKeywordCoverage(keywords, keywordContext);

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
			calculatedAt: new Date().toISOString(),
			keywords: coveredKeywords.length ? coveredKeywords : undefined,
			issueTitle: issue.title,
			issueSummary,
			issueLabels: issue.labels,
			changeSummary,
			fileChanges,
			commentId: options.commentId
		};
	}

	private async tryExtractKeywords(
		task: RiskTask,
		title: string,
		body: string,
		context: KeywordContext
	): Promise<string[] | undefined> {
		if (!this.keywordExtractor) {
			return undefined;
		}
		try {
			const result = await this.keywordExtractor.extractKeywords(title, body, task.issueNumber);
			return ensureKeywordCoverage(result.keywords, context);
		} catch (error) {
			this.telemetry.trackEvent('risk.keywordExtractionFailed', {
				repository: task.repository,
				issue: String(task.issueNumber),
				message: error instanceof Error ? error.message : String(error)
			});
			return undefined;
		}
	}

	private buildIssueSummary(body: string): string {
		const normalized = (body ?? '').replace(/\r/g, '');
		const paragraphs = normalized
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0);
		const candidate = paragraphs.slice(0, 2).join(' ');
		const summary = candidate || normalized.slice(0, 320);
		const trimmed = summary.trim();
		if (!trimmed) {
			return '';
		}
		return trimmed.length > 320 ? `${trimmed.slice(0, 317)}...` : trimmed;
	}

	private buildChangeSummary(
		metrics: RiskMetrics,
		evidence: RiskProfile['evidence'],
		fileChanges: RiskFileChange[]
	): string {
		const parts: string[] = [];
		if (metrics.prCount > 0) {
			parts.push(`${metrics.prCount} PR${metrics.prCount === 1 ? '' : 's'} merged`);
		}
		if (metrics.directCommitCount > 0) {
			parts.push(`${metrics.directCommitCount} direct commit${metrics.directCommitCount === 1 ? '' : 's'}`);
		}
		if (metrics.filesTouched > 0) {
			parts.push(`${metrics.filesTouched} files touched (+${metrics.totalAdditions}/-${metrics.totalDeletions})`);
		}
		if (fileChanges.length > 0) {
			const topFiles = fileChanges.slice(0, 3).map(file => file.path);
			parts.push(`Focus areas: ${topFiles.join(', ')}`);
		}
		const headline = evidence.find(item => item.prSummary);
		if (headline?.prSummary) {
			parts.push(`Recent work: ${headline.prSummary}`);
		} else if (evidence[0]?.detail) {
			parts.push(`Recent work: ${evidence[0].detail}`);
		}
		return parts.join('. ');
	}

	private async collectFileChanges(
		repository: string,
		pullRequests: PullRequestRiskData[],
		commits: CommitRiskData[]
	): Promise<RiskFileChange[]> {
		const aggregated = new Map<string, { additions: number; deletions: number; references: Set<string> }>();
		const maxSources = 3;
		const maxFilesPerSource = 50;

		const record = (path: string, additions: number, deletions: number, reference: string) => {
			const normalizedPath = path?.trim();
			if (!normalizedPath) {
				return;
			}
			const entry = aggregated.get(normalizedPath) ?? {
				additions: 0,
				deletions: 0,
				references: new Set<string>()
			};
			entry.additions += additions;
			entry.deletions += deletions;
			entry.references.add(reference);
			aggregated.set(normalizedPath, entry);
		};

		if (pullRequests.length > 0) {
			for (const pr of pullRequests.slice(0, maxSources)) {
				try {
					const detail = await this.github.getPullRequestBackfillDetail(repository, pr.number);
					for (const file of detail.files.slice(0, maxFilesPerSource)) {
						record(file.path, file.additions ?? 0, file.deletions ?? 0, `PR #${pr.number}`);
					}
				} catch (error) {
					this.telemetry.trackEvent('risk.fileCollectionFailed', {
						repository,
						reference: `PR #${pr.number}`,
						source: 'pull_request',
						message: error instanceof Error ? error.message : String(error)
					});
				}
			}
		} else {
			for (const commit of commits.slice(0, maxSources)) {
				try {
					const detail = await this.github.getCommitBackfillDetail(repository, commit.sha);
					for (const file of detail.files.slice(0, maxFilesPerSource)) {
						record(file.path, file.additions ?? 0, file.deletions ?? 0, commit.sha.slice(0, 7));
					}
				} catch (error) {
					this.telemetry.trackEvent('risk.fileCollectionFailed', {
						repository,
						reference: commit.sha.slice(0, 7),
						source: 'commit',
						message: error instanceof Error ? error.message : String(error)
					});
				}
			}
		}

		return Array.from(aggregated.entries())
			.map(([path, info]) => ({
				path,
				additions: info.additions,
				deletions: info.deletions,
				changeVolume: info.additions + info.deletions,
				references: Array.from(info.references).slice(0, 5)
			}))
			.sort((a, b) => b.changeVolume - a.changeVolume)
			.slice(0, maxFilesPerSource);
	}

	private computeMetrics(pullRequests: PullRequestRiskData[], commits: CommitRiskData[]): RiskMetrics {
		const includeCommits = pullRequests.length === 0;
		const metrics: RiskMetrics = {
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

		for (const pr of pullRequests) {
			metrics.prCount += 1;
			metrics.filesTouched += pr.changedFiles ?? 0;
			metrics.totalAdditions += pr.additions ?? 0;
			metrics.totalDeletions += pr.deletions ?? 0;
			metrics.changeVolume += (pr.additions ?? 0) + (pr.deletions ?? 0);
			const reviewComments = pr.reviewComments ?? 0;
			const discussionComments = pr.comments ?? 0;
			const changeRequests = pr.reviewStates?.CHANGES_REQUESTED ?? 0;
			metrics.prReviewCommentCount += reviewComments;
			metrics.prDiscussionCommentCount += discussionComments;
			metrics.prChangeRequestCount += changeRequests;
			const reviewFriction = reviewComments + discussionComments + changeRequests * 2;
			metrics.reviewCommentCount += reviewFriction;
		}

		if (includeCommits) {
			for (const commit of commits) {
				metrics.directCommitCount += 1;
				metrics.filesTouched += commit.changedFiles ?? 0;
				metrics.directCommitAdditions += commit.additions ?? 0;
				metrics.directCommitDeletions += commit.deletions ?? 0;
				metrics.directCommitChangeVolume += (commit.additions ?? 0) + (commit.deletions ?? 0);
				metrics.totalAdditions += commit.additions ?? 0;
				metrics.totalDeletions += commit.deletions ?? 0;
				metrics.changeVolume += (commit.additions ?? 0) + (commit.deletions ?? 0);
			}
		}

		return metrics;
	}

	private calculateRiskScore(metrics: RiskMetrics): number {
		const changeSets = metrics.prCount + metrics.directCommitCount;
		const prScore = Math.min(40, changeSets * 15);
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
		if (metrics.directCommitCount > 0 && metrics.prCount === 0) {
			drivers.push(`${metrics.directCommitCount} direct commits linked to this issue.`);
		}
		if (metrics.filesTouched >= 25) {
			const scope = metrics.prCount > 0 ? 'pull requests' : 'direct commits';
			drivers.push(`${metrics.filesTouched} files touched across linked ${scope}.`);
		}
		if (metrics.changeVolume >= 1000) {
			drivers.push(`${metrics.changeVolume} lines changed recently.`);
		}
		if (metrics.reviewCommentCount >= 15) {
			drivers.push(`High review friction with ${metrics.reviewCommentCount} comments or change requests.`);
		}
		if (metrics.directCommitChangeVolume >= 600 && metrics.prCount === 0) {
			drivers.push(`${metrics.directCommitChangeVolume} lines changed across direct commits.`);
		}
		return drivers.slice(0, 5);
	}

	private buildEvidence(pullRequests: PullRequestRiskData[], commits: CommitRiskData[]): RiskProfile['evidence'] {
		if (pullRequests.length > 0) {
			return pullRequests.slice(0, 5).map(pr => ({
				label: `PR #${pr.number}`,
				detail: `${pr.changedFiles ?? 0} files · +${pr.additions ?? 0}/-${pr.deletions ?? 0} · ${pr.reviewComments ?? 0} review comments`,
				url: pr.url,
				prSummary: pr.title,
				prNumber: pr.number
			}));
		}
		return commits.slice(0, 5).map(commit => ({
			label: `Commit ${commit.sha.slice(0, 7)}`,
			detail: `${commit.changedFiles ?? 0} files · +${commit.additions ?? 0}/-${commit.deletions ?? 0}`,
			url: commit.url,
			prSummary: commit.message
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
				reviewCommentCount: profile.metrics.reviewCommentCount,
				directCommitCount: profile.metrics.directCommitCount,
				prReviewCommentCount: profile.metrics.prReviewCommentCount,
				prDiscussionCommentCount: profile.metrics.prDiscussionCommentCount,
				prChangeRequestCount: profile.metrics.prChangeRequestCount
			},
			keywords: profile.keywords?.slice(0, 8),
			stale
		};
	}

	private buildRiskComment(profile: RiskProfile): string {
		const riskLevelLabel = profile.riskLevel.charAt(0).toUpperCase() + profile.riskLevel.slice(1);
		const calculatedDate = new Date(profile.calculatedAt).toLocaleString();
		
		const metricLines = [
			`- ${profile.metrics.prCount} linked pull request${profile.metrics.prCount === 1 ? '' : 's'}`,
			`- ${profile.metrics.directCommitCount} direct commit${profile.metrics.directCommitCount === 1 ? '' : 's'}`,
			`- ${profile.metrics.filesTouched} file${profile.metrics.filesTouched === 1 ? '' : 's'} touched`,
			`- ${profile.metrics.changeVolume} line${profile.metrics.changeVolume === 1 ? '' : 's'} changed`,
			`- ${profile.metrics.reviewCommentCount} review friction signal${profile.metrics.reviewCommentCount === 1 ? '' : 's'}`
		];

		const driverLines = profile.drivers.length
			? profile.drivers.map(driver => `- ${driver}`)
			: ['- No significant risk drivers identified.'];

		const evidenceLines: string[] = [];
		for (const item of profile.evidence.slice(0, 5)) {
			const link = item.url ? `[${item.label}](${item.url})` : item.label;
			const detail = item.detail ? ` — ${item.detail}` : '';
			evidenceLines.push(`- ${link}${detail}`);
		}

		const keywordLines: string[] = [];
		if (profile.keywords && profile.keywords.length) {
			const uniqueKeywords = Array.from(new Set(profile.keywords.map(keyword => keyword.trim()).filter(Boolean)));
			if (uniqueKeywords.length) {
				keywordLines.push('**Keywords:**');
				for (const keyword of uniqueKeywords) {
					keywordLines.push(`- ${keyword}`);
				}
			}
		}

		return [
			'<!-- IssueTriage Risk Intelligence -->',
			'### IssueTriage Risk Intelligence',
			`**${riskLevelLabel} risk** · Score ${Math.round(profile.riskScore)}`,
			'',
			`_Last updated: ${calculatedDate}_`,
			'',
			'**Key metrics:**',
			...metricLines,
			'',
			'**Top drivers:**',
			...driverLines,
			'',
			'**Evidence:**',
			...evidenceLines,
			'',
			...keywordLines,
			'',
			`_Analyzed ${profile.lookbackDays} days of history_`
		].join('\n');
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

	private shouldPublishComments(): boolean {
		const configured = this.settings.get<boolean>('risk.publishComments');
		return configured !== false; // Default to true
	}

	private dedupeIssues(issues: IssueSummary[]): IssueSummary[] {
		const map = new Map<number, IssueSummary>();
		for (const issue of issues) {
			const existing = map.get(issue.number);
			if (!existing) {
				map.set(issue.number, issue);
				continue;
			}
			const existingTime = Date.parse(existing.updatedAt) || 0;
			const candidateTime = Date.parse(issue.updatedAt) || 0;
			if (candidateTime > existingTime) {
				map.set(issue.number, issue);
			}
		}
		return Array.from(map.values()).sort((a, b) => {
			const left = Date.parse(b.updatedAt) || 0;
			const right = Date.parse(a.updatedAt) || 0;
			return left - right;
		});
	}

	private findLatestRiskComment(issue: { comments?: Array<{ id: number; body: string; updatedAt?: string; createdAt?: string }> }): { id: number; body: string; updatedAt?: string; createdAt?: string } | undefined {
		const comments = issue.comments ?? [];
		const matches = comments.filter(comment => typeof comment.body === 'string' && comment.body.includes(RISK_COMMENT_TAG));
		if (!matches.length) {
			return undefined;
		}
		return matches
			.slice()
			.sort((a, b) => {
				const timeA = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
				const timeB = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
				if (timeA !== timeB) {
					return timeB - timeA;
				}
				const idA = typeof a.id === 'number' ? a.id : 0;
				const idB = typeof b.id === 'number' ? b.id : 0;
				return idB - idA;
			})[0];
	}

	private parseRiskComment(body: string): ParsedRiskComment | undefined {
		if (typeof body !== 'string' || !body.includes(RISK_COMMENT_TAG)) {
			return undefined;
		}
		const normalized = body.replace(/\r/g, '');
		const headerMatch = normalized.match(/\*\*(\w+)\s+risk\*\*\s*·\s*Score\s+([0-9]+(?:\.[0-9]+)?)/i);
		if (!headerMatch) {
			return undefined;
		}
		const riskLevelRaw = headerMatch[1]?.toLowerCase();
		const level: RiskLevel = riskLevelRaw === 'high' || riskLevelRaw === 'medium' ? riskLevelRaw : 'low';
		const riskScore = Number.parseFloat(headerMatch[2] ?? '0');
		const calculatedMatch = normalized.match(/_Last updated:\s*([^_]+)_/i);
		let calculatedAt: string | undefined;
		if (calculatedMatch?.[1]) {
			const timestamp = new Date(calculatedMatch[1]);
			if (!Number.isNaN(timestamp.getTime())) {
				calculatedAt = timestamp.toISOString();
			}
		}
		const lookbackMatch = normalized.match(/_Analyzed\s+([0-9]+)\s+days of history_/i);
		const lookbackDays = lookbackMatch ? Number.parseInt(lookbackMatch[1], 10) : undefined;

		const metrics: RiskMetrics = {
			prCount: this.extractFirstNumber(normalized, /-\s*([0-9]+)\s+linked pull requests?/i),
			filesTouched: this.extractFirstNumber(normalized, /-\s*([0-9]+)\s+files?\s+touched/i),
			totalAdditions: 0,
			totalDeletions: 0,
			changeVolume: this.extractFirstNumber(normalized, /-\s*([0-9]+)\s+lines?\s+changed/i),
			reviewCommentCount: this.extractFirstNumber(normalized, /-\s*([0-9]+)\s+review friction signals?/i),
			prReviewCommentCount: 0,
			prDiscussionCommentCount: 0,
			prChangeRequestCount: 0,
			directCommitCount: this.extractFirstNumber(normalized, /-\s*([0-9]+)\s+direct commits?/i),
			directCommitAdditions: 0,
			directCommitDeletions: 0,
			directCommitChangeVolume: 0
		};

		const labelFilters: string[] = [];
		const drivers: string[] = [];
		const evidence: RiskEvidence[] = [];
		let keywords: string[] | undefined;
		let changeSummary: string | undefined;
		let fileChanges: RiskFileChange[] | undefined;
		let section: 'none' | 'drivers' | 'evidence' | 'keywords' = 'none';
		const lines = normalized.split('\n').map(line => line.trim()).filter(line => line.length > 0);
		for (const line of lines) {
			if (section === 'keywords') {
				if (line.startsWith('- ')) {
					const keyword = line.slice(2).trim();
					if (keyword) {
						if (!keywords) {
							keywords = [];
						}
						if (!keywords.includes(keyword)) {
							keywords.push(keyword);
						}
					}
					continue;
				}
				section = 'none';
			}
			if (line.startsWith('**Top drivers:**')) {
				section = 'drivers';
				continue;
			}
			if (line.startsWith('**Evidence:**')) {
				section = 'evidence';
				continue;
			}
			if (line.startsWith('**Keywords:**')) {
				const keywordText = line.replace('**Keywords:**', '').trim();
				if (keywordText) {
					keywords = keywordText.split(',').map(kw => kw.trim()).filter(Boolean);
					section = 'none';
				} else {
					if (!keywords) {
						keywords = [];
					}
					section = 'keywords';
				}
				continue;
			}
			if (line.startsWith('Recent work:')) {
				changeSummary = line;
				continue;
			}
			if (line.startsWith('Focus areas:')) {
				const paths = line.replace('Focus areas:', '').split(',').map(item => item.trim()).filter(Boolean);
				if (paths.length) {
					fileChanges = paths.map<RiskFileChange>(path => ({
						path,
						additions: 0,
						deletions: 0,
						changeVolume: 0,
						references: []
					}));
				}
				continue;
			}
			if (line.startsWith('**')) {
				section = 'none';
				continue;
			}
			if (section === 'drivers' && line.startsWith('- ')) {
				drivers.push(line.slice(2).trim());
				continue;
			}
			if (section === 'evidence' && line.startsWith('- ')) {
				const evidenceItem = this.parseEvidenceLine(line);
				if (evidenceItem) {
					evidence.push(evidenceItem);
				}
			}
		}

		return {
			riskLevel: level,
			riskScore: Number.isFinite(riskScore) ? riskScore : 0,
			metrics,
			evidence,
			drivers,
			keywords: keywords && keywords.length ? keywords : undefined,
			lookbackDays,
			labelFilters,
			calculatedAt,
			changeSummary,
			fileChanges
		};
	}

	private extractFirstNumber(input: string, pattern: RegExp): number {
		const match = input.match(pattern);
		if (!match?.[1]) {
			return 0;
		}
		const value = Number.parseInt(match[1], 10);
		return Number.isFinite(value) ? value : 0;
	}

	private parseEvidenceLine(line: string): RiskEvidence | undefined {
		const trimmed = line.replace(/^-\s*/, '');
		const linkMatch = trimmed.match(/^\[(.+?)\]\((.+?)\)(?:\s*—\s*(.+))?$/);
		const plainMatch = trimmed.match(/^([^—]+?)(?:\s*—\s*(.+))?$/);
		let label: string | undefined;
		let url: string | undefined;
		let detail: string | undefined;
		if (linkMatch) {
			label = linkMatch[1]?.trim();
			url = linkMatch[2]?.trim();
			detail = linkMatch[3]?.trim();
		} else if (plainMatch) {
			label = plainMatch[1]?.trim();
			detail = plainMatch[2]?.trim();
		}
		if (!label) {
			return undefined;
		}
		const evidence: RiskEvidence = { label };
		if (url) {
			evidence.url = url;
		}
		if (detail) {
			evidence.detail = detail;
		}
		const prNumberMatch = label.match(/PR\s+#([0-9]+)/i);
		if (prNumberMatch?.[1]) {
			const prNumber = Number.parseInt(prNumberMatch[1], 10);
			if (Number.isFinite(prNumber)) {
				evidence.prNumber = prNumber;
			}
		}
		return evidence;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
