import * as assert from 'assert';
import * as vscode from 'vscode';
import { IssueManager } from '../issueManager';
import { StateService } from '../services/stateService';
import type { GitHubAuthService } from '../services/githubAuthService';
import type { GitHubClient, IssueSummary } from '../services/githubClient';
import type { SettingsService } from '../services/settingsService';
import type { TelemetryService } from '../services/telemetryService';
import type { RiskIntelligenceService } from '../services/riskIntelligenceService';
import type { AssessmentService } from '../services/assessmentService';
import type { KeywordExtractionService } from '../services/keywordExtractionService';
import type { SimilarityService } from '../services/similarityService';

type RiskQueueRequest = {
	repository: string;
	issues: IssueSummary[];
	options: { force?: boolean };
};

class MemoryMemento implements vscode.Memento {
	private readonly store = new Map<string, unknown>();

	public get<T>(key: string, defaultValue?: T): T | undefined {
		if (this.store.has(key)) {
			return this.store.get(key) as T;
		}
		return defaultValue;
	}

	public update(key: string, value: unknown): Thenable<void> {
		if (typeof value === 'undefined') {
			this.store.delete(key);
		} else {
			this.store.set(key, value);
		}
		return Promise.resolve();
	}

	public keys(): readonly string[] {
		return Array.from(this.store.keys());
	}
}

suite('IssueManager risk analysis', () => {
	const authStub = {} as unknown as GitHubAuthService;
	const githubStub = {} as unknown as GitHubClient;
	const assessmentStub = {} as unknown as AssessmentService;
	const settingsStub = {
		get: () => undefined
	} as unknown as SettingsService;
	const keywordExtractorStub = {
		extractKeywords: async () => ({ keywords: [], tokensUsed: 0 })
	} as unknown as KeywordExtractionService;
	const similarityStub = {
		findSimilar: async () => []
	} as unknown as SimilarityService;

	test('requires repository selection', () => {
		const telemetryCalls: Array<{ event: string }> = [];
		const telemetryStub = {
			trackEvent: (event: string) => {
				telemetryCalls.push({ event });
			}
		} as unknown as TelemetryService;
		const riskStub = {
			onDidUpdate: () => new vscode.Disposable(() => undefined),
			queueHydration: () => undefined
		} as unknown as RiskIntelligenceService;
		const manager = new IssueManager(
			authStub,
			githubStub,
			settingsStub,
			new StateService(new MemoryMemento(), new MemoryMemento()),
			telemetryStub,
			riskStub,
			assessmentStub,
			keywordExtractorStub,
			similarityStub
		);

		const result = manager.analyzeRiskSignals(101);
		assert.strictEqual(result.success, false);
		assert.ok(result.message && /Select a repository/i.test(result.message));
		assert.strictEqual(telemetryCalls.length, 0, 'Should not emit telemetry when repository missing');
	});

	test('requires issue to exist in current cache', () => {
		const telemetryCalls: Array<{ event: string }> = [];
		const telemetryStub = {
			trackEvent: (event: string) => {
				telemetryCalls.push({ event });
			}
		} as unknown as TelemetryService;
		const riskStub = {
			onDidUpdate: () => new vscode.Disposable(() => undefined),
			queueHydration: () => undefined
		} as unknown as RiskIntelligenceService;
		const stateService = new StateService(new MemoryMemento(), new MemoryMemento());
		const manager = new IssueManager(
			authStub,
			githubStub,
			settingsStub,
			stateService,
			telemetryStub,
			riskStub,
			assessmentStub,
			keywordExtractorStub,
			similarityStub
		);

		const internals = manager as unknown as { state: { selectedRepository?: { id: number; name: string; owner: string; fullName: string; private: boolean } } };
		internals.state.selectedRepository = { id: 1, name: 'repo', owner: 'owner', fullName: 'owner/repo', private: false };

		const result = manager.analyzeRiskSignals(202);
		assert.strictEqual(result.success, false);
		assert.ok(result.message && /Issue #202/i.test(result.message));
		assert.strictEqual(telemetryCalls.length, 0, 'Should not emit telemetry when issue is missing');
	});

	test('queues hydration with telemetry when issue is available', () => {
		const telemetryCalls: Array<{ event: string; data: Record<string, string> }> = [];
		const telemetryStub = {
			trackEvent: (event: string, data?: Record<string, string>) => {
				telemetryCalls.push({ event, data: data ?? {} });
			}
		} as unknown as TelemetryService;
		const queued: RiskQueueRequest[] = [];
		const riskStub = {
			onDidUpdate: () => new vscode.Disposable(() => undefined),
			queueHydration: (repository: string, issues: IssueSummary[], options: { force?: boolean }) => {
				queued.push({ repository, issues, options });
			}
		} as unknown as RiskIntelligenceService;
		const stateService = new StateService(new MemoryMemento(), new MemoryMemento());
		const manager = new IssueManager(
			authStub,
			githubStub,
			settingsStub,
			stateService,
			telemetryStub,
			riskStub,
			assessmentStub,
			keywordExtractorStub,
			similarityStub
		);

		const internals = manager as unknown as {
			state: { selectedRepository?: { id: number; name: string; owner: string; fullName: string; private: boolean } };
			allIssues: IssueSummary[];
		};
		internals.state.selectedRepository = { id: 7, name: 'repo', owner: 'owner', fullName: 'owner/repo', private: false };
		internals.allIssues = [{
			number: 303,
			title: 'Closed bug fix',
			url: 'https://example.invalid',
			labels: [],
			assignees: [],
			updatedAt: new Date().toISOString(),
			state: 'closed'
		}];

		const result = manager.analyzeRiskSignals(303, { force: true });
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.message, undefined);
		assert.strictEqual(queued.length, 1, 'Expected hydration request to be queued');
		assert.strictEqual(queued[0].repository, 'owner/repo');
		assert.strictEqual(queued[0].issues.length, 1);
		assert.strictEqual(queued[0].issues[0].number, 303);
		assert.deepStrictEqual(queued[0].options, { force: true });
		assert.strictEqual(telemetryCalls.length, 1);
		assert.strictEqual(telemetryCalls[0].event, 'issueManager.risk.manualQueued');
		assert.strictEqual(telemetryCalls[0].data.repository, 'owner/repo');
		assert.strictEqual(telemetryCalls[0].data.issue, '303');
		assert.strictEqual(telemetryCalls[0].data.force, 'true');
	});
});
