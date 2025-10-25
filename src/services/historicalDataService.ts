import * as fs from 'fs';
import * as path from 'path';
import type { RiskProfileStore } from './riskStorage';
import type { ExportManifest } from '../types/risk';

interface TelemetryClient {
	trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
}

export interface ExportOptions {
	repository: string;
	outputDir?: string;
	minKeywordCoverage?: number;
}

export interface ExportResult {
	success: boolean;
	manifest: ExportManifest;
	datasetPath: string;
	manifestPath: string;
}

export interface ExportTextResult {
	content: string;
	count: number;
	keywordCoveragePct: number;
}

export class HistoricalDataService {
	constructor(
		private readonly storage: RiskProfileStore,
		private readonly storageDir: string,
		private readonly telemetry: TelemetryClient
	) {}

	/**
	 * Export historical dataset and create manifest
	 */
	public async exportDataset(options: ExportOptions): Promise<ExportResult> {
		const {
			repository,
			outputDir = path.join(this.storageDir, 'exports'),
			minKeywordCoverage = 0.95
		} = options;

		const exportRunId = this.generateExportRunId();
		const startedAt = new Date().toISOString();

		this.telemetry.trackEvent('dataset.exportStarted', {
			repository,
			exportRunId
		});

		await fs.promises.mkdir(outputDir, { recursive: true });

		// The dataset is the risk-profiles.db itself with FTS5 index
		// For MVP, we just validate and create manifest
		await this.storage.initialize();

		// Validate the dataset
		const validation = await this.validateDataset(repository, minKeywordCoverage);
		const completedAt = new Date().toISOString();

		const manifest: ExportManifest = {
			exportRunId,
			repoSlug: repository,
			issuesExported: validation.totalIssues,
			snapshotsExported: validation.totalSnapshots,
			keywordCoveragePct: validation.keywordCoveragePct,
			exportStartedAt: startedAt,
			exportCompletedAt: completedAt,
			schemaVersion: '1.0.0',
			validationReport: {
				passed: validation.passed,
				warnings: validation.warnings,
				errors: validation.errors
			}
		};

		// Write manifest
		const manifestPath = path.join(outputDir, `manifest-${exportRunId}.json`);
		await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

		// For MVP, the dataset is the risk-profiles.db in the storage directory
		const datasetPath = path.join(this.storageDir, 'risk-profiles.db');

		this.telemetry.trackEvent('dataset.exportCompleted', {
			repository,
			exportRunId,
			passed: String(validation.passed),
			keywordCoverage: String(validation.keywordCoveragePct)
		});

		return {
			success: validation.passed,
			manifest,
			datasetPath,
			manifestPath
		};
	}

	public async exportDatasetText(options: { repository: string; format?: 'json' | 'jsonl' }): Promise<ExportTextResult> {
		const { repository, format = 'json' } = options;

		await this.storage.initialize();
		const profiles = await this.storage.getAllProfiles(repository);
		const coverage = await this.storage.getKeywordCoverage(repository);
		const metadata = {
			repository,
			exportedAt: new Date().toISOString(),
			totalIssues: coverage.total,
			withKeywords: coverage.withKeywords,
			keywordCoveragePct: coverage.coverage,
			profilesExported: profiles.length
		};

		let content: string;
		if (format === 'jsonl') {
			const header = JSON.stringify({ type: 'metadata', payload: metadata });
			const rows = profiles.map(profile => JSON.stringify({ type: 'profile', payload: profile }));
			content = [header, ...rows].join('\n');
		} else {
			content = JSON.stringify({ metadata, profiles }, null, 2);
		}

		return {
			content,
			count: profiles.length,
			keywordCoveragePct: coverage.coverage
		};
	}

	/**
	 * Validate the dataset for export readiness
	 */
	private async validateDataset(repository: string, minCoverage: number): Promise<{
		totalIssues: number;
		totalSnapshots: number;
		keywordCoveragePct: number;
		passed: boolean;
		warnings: string[];
		errors: string[];
	}> {
		const warnings: string[] = [];
		const errors: string[] = [];

		// Use the efficient getKeywordCoverage method
		const coverage = await this.storage.getKeywordCoverage(repository);
		
		const totalIssues = coverage.total;
		const issuesWithKeywords = coverage.withKeywords;
		const keywordCoveragePct = coverage.coverage;

		// Validation checks
		if (keywordCoveragePct < minCoverage * 100) {
			const missing = totalIssues - issuesWithKeywords;
			if (keywordCoveragePct < 95) {
				errors.push(
					`Keyword coverage ${keywordCoveragePct.toFixed(1)}% is below required ${(minCoverage * 100).toFixed(0)}%. ${missing} issues need keywords.`
				);
			} else {
				warnings.push(
					`Keyword coverage ${keywordCoveragePct.toFixed(1)}% is slightly below target. ${missing} issues need keywords.`
				);
			}
		}

		if (totalIssues < 10) {
			warnings.push(
				`Only ${totalIssues} issues found. Dataset may be too small for effective training.`
			);
		}

		const passed = errors.length === 0;

		return {
			totalIssues,
			totalSnapshots: issuesWithKeywords,
			keywordCoveragePct,
			passed,
			warnings,
			errors
		};
	}

	/**
	 * Generate a unique export run ID
	 */
	private generateExportRunId(): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const random = Math.random().toString(36).slice(2, 8);
		return `${timestamp}_${random}`;
	}
}
