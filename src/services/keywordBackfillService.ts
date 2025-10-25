import * as vscode from 'vscode';
import type { RiskProfileStore } from './riskStorage';
import type { KeywordExtractionService } from './keywordExtractionService';
import { ensureKeywordCoverage } from './keywordUtils';
import type { KeywordContext } from './keywordUtils';
import type { BackfillProgress, RiskProfile } from '../types/risk';

interface GitHubIssueClient {
	getIssueDetails(repository: string, issueNumber: number): Promise<{
		number: number;
		title: string;
		body: string;
		state: 'open' | 'closed';
		labels: string[];
	}>;
}

interface TelemetryClient {
	trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
}

export interface BackfillOptions {
	batchSize?: number;
	delayMs?: number;
	maxTokensPerRun?: number;
	mode?: 'missing' | 'all';
}

export class KeywordBackfillService implements vscode.Disposable {
	private currentProgress: BackfillProgress | undefined;
	private cancelled = false;
	private readonly emitter = new vscode.EventEmitter<BackfillProgress>();
	public readonly onProgress = this.emitter.event;

	constructor(
		private readonly storage: RiskProfileStore,
		private readonly github: GitHubIssueClient,
		private readonly keywordExtractor: KeywordExtractionService,
		private readonly telemetry: TelemetryClient
	) {}

	public dispose(): void {
		this.emitter.dispose();
	}

	/**
	 * Backfill keywords for issues missing them
	 */
	public async backfillKeywords(
		repository: string,
		options: BackfillOptions = {}
	): Promise<BackfillProgress> {
		const {
			delayMs = 500,
			maxTokensPerRun = 200000
		} = options;
		const mode = options.mode ?? 'missing';
		const effectiveBatchSize = typeof options.batchSize === 'number' && options.batchSize > 0
			? options.batchSize
			: (mode === 'missing' ? 50 : undefined);

		this.cancelled = false;
		await this.storage.initialize();

		let profiles: RiskProfile[];
		if (mode === 'all') {
			profiles = await this.storage.getAllProfiles(repository);
			if (typeof effectiveBatchSize === 'number') {
				profiles = profiles.slice(0, effectiveBatchSize);
			}
		} else {
			const limit = typeof effectiveBatchSize === 'number' ? effectiveBatchSize : 50;
			profiles = await this.storage.getClosedIssuesWithoutKeywords(repository, limit);
		}

		const progress: BackfillProgress = {
			totalIssues: profiles.length,
			processedIssues: 0,
			successCount: 0,
			failureCount: 0,
			skippedCount: 0,
			status: 'running',
			startedAt: new Date().toISOString(),
			tokensUsed: 0,
			errors: [],
			mode
		};

		this.currentProgress = progress;
		this.emitProgress(progress);

		this.telemetry.trackEvent('keywords.backfillStarted', {
			repository,
			totalIssues: String(progress.totalIssues),
			mode
		});

		for (const profile of profiles) {
			if (this.cancelled) {
				progress.status = 'cancelled';
				break;
			}

			progress.currentIssue = profile.issueNumber;
			this.emitProgress(progress);
			let issueDetails: Awaited<ReturnType<GitHubIssueClient['getIssueDetails']>> | undefined;

			try {
				// Check token budget
				if (progress.tokensUsed >= maxTokensPerRun) {
					const remaining = profiles.length - progress.processedIssues;
					this.telemetry.trackEvent('keywords.backfillTokenLimitReached', {
						repository,
						tokensUsed: String(progress.tokensUsed),
						remaining: String(remaining),
						mode
					});
					progress.status = 'completed';
					progress.currentIssue = undefined;
					break;
				}

				// Fetch issue details
				issueDetails = await this.github.getIssueDetails(repository, profile.issueNumber);
				const issue = issueDetails;

				// Skip if not closed
				if (issue.state !== 'closed') {
					progress.skippedCount++;
					progress.processedIssues++;
					continue;
				}

				const context = this.buildKeywordContext(profile, issue);

				// Extract keywords
				const result = await this.keywordExtractor.extractKeywords(
					issue.title,
					issue.body,
					issue.number
				);

				// Update profile with refined keywords
				profile.keywords = ensureKeywordCoverage(result.keywords, context);
				await this.storage.saveProfile(profile);

				progress.successCount++;
				progress.tokensUsed += result.tokensUsed;

				// Delay between requests to respect rate limits
				if (delayMs > 0) {
					await this.delay(delayMs);
				}
			} catch (error) {
				progress.failureCount++;
				progress.errors.push({
					issueNumber: profile.issueNumber,
					message: error instanceof Error ? error.message : String(error)
				});

				this.telemetry.trackEvent('keywords.backfillIssueFailed', {
					repository,
					issue: String(profile.issueNumber),
					message: error instanceof Error ? error.message : String(error)
				});

				const fallbackContext = this.buildKeywordContext(profile, issueDetails);
				profile.keywords = ensureKeywordCoverage(undefined, fallbackContext);
				await this.storage.saveProfile(profile);
			} finally {
				progress.processedIssues++;
				this.emitProgress(progress);
			}
		}

		if (progress.status === 'running') {
			progress.status = 'completed';
		}
		progress.completedAt = new Date().toISOString();
		progress.currentIssue = undefined;
		this.emitProgress(progress);

		this.telemetry.trackEvent('keywords.backfillCompleted', {
			repository,
			status: progress.status,
			successCount: String(progress.successCount),
			failureCount: String(progress.failureCount),
			mode
		}, {
			tokensUsed: progress.tokensUsed
		});

		return progress;
	}

	/**
	 * Cancel the current backfill operation
	 */
	public cancel(): void {
		this.cancelled = true;
	}

	/**
	 * Get current progress
	 */
	public getProgress(): BackfillProgress | undefined {
		return this.currentProgress ? { ...this.currentProgress } : undefined;
	}

	private buildKeywordContext(profile: RiskProfile, issue?: { title?: string; body?: string; labels?: string[] }): KeywordContext {
		const issueTitle = issue?.title ?? profile.issueTitle ?? '';
		const issueBody = issue?.body ?? profile.issueSummary ?? '';
		const labels = new Set<string>(profile.issueLabels ?? []);
		for (const label of issue?.labels ?? []) {
			if (label) {
				labels.add(label);
			}
		}
		return {
			issueTitle,
			issueBody,
			labels: Array.from(labels),
			evidenceSummaries: (profile.evidence ?? []).map(item => item.prSummary ?? item.detail ?? item.label),
			filePaths: (profile.fileChanges ?? []).map(file => file.path),
			changeSummary: profile.changeSummary ?? '',
			repository: profile.repository
		};
	}

	private emitProgress(progress: BackfillProgress): void {
		this.emitter.fire({ ...progress });
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
