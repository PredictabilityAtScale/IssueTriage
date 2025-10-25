import * as assert from 'assert';
import * as vscode from 'vscode';
import { IssueManager } from '../issueManager';
import { StateService } from '../services/stateService';
import type { GitHubAuthService } from '../services/githubAuthService';
import type { GitHubClient } from '../services/githubClient';
import type { SettingsService } from '../services/settingsService';
import type { TelemetryService } from '../services/telemetryService';
import type { RiskIntelligenceService } from '../services/riskIntelligenceService';
import type { AssessmentService } from '../services/assessmentService';
import type { KeywordExtractionService } from '../services/keywordExtractionService';
import type { SimilarityService } from '../services/similarityService';

type QuestionResponseStore = Record<string, Record<string, Record<string, unknown>>>;

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

suite('IssueManager assessment questions', () => {
	const authStub = {} as unknown as GitHubAuthService;
	const settingsStub = {
		get: () => undefined
	} as unknown as SettingsService;
	const telemetryStub = {
		trackEvent: () => undefined
	} as unknown as TelemetryService;
	const riskStub = {
		onDidUpdate: () => new vscode.Disposable(() => undefined)
	} as unknown as RiskIntelligenceService;
	const assessmentStub = {} as unknown as AssessmentService;
	const keywordExtractorStub = {
		extractKeywords: async () => ({ keywords: [], tokensUsed: 0 })
	} as unknown as KeywordExtractionService;
	const similarityStub = {
		findSimilar: async () => []
	} as unknown as SimilarityService;

	test('records responses and posts GitHub comment', async () => {
		const globalState = new MemoryMemento();
		const workspaceState = new MemoryMemento();
		const stateService = new StateService(globalState, workspaceState);
		const posted: Array<{ repository: string; issueNumber: number; body: string }> = [];
		const githubStub = {
			upsertIssueComment: async (repository: string, issueNumber: number, body: string) => {
				posted.push({ repository, issueNumber, body });
				return 12345;
			}
		} as unknown as GitHubClient;

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

		const internal = manager as unknown as {
			state: {
				selectedRepository?: { id: number; name: string; owner: string; fullName: string; private: boolean };
				questionResponses: Record<string, Record<string, unknown>>;
			};
			questionResponsesStore: QuestionResponseStore;
		};

		internal.state.selectedRepository = { id: 1, name: 'repo', owner: 'owner', fullName: 'owner/repo', private: false };

		await manager.answerAssessmentQuestion(42, 'What is needed?', 'Add acceptance criteria.');

		assert.strictEqual(posted.length, 1, 'Expected a single GitHub comment');
		assert.strictEqual(posted[0].repository, 'owner/repo');
		assert.strictEqual(posted[0].issueNumber, 42);
		assert.ok(posted[0].body.includes('What is needed?'), 'Comment should repeat the question');
		assert.ok(posted[0].body.includes('Add acceptance criteria.'), 'Comment should include the answer');

		const repoStore = internal.questionResponsesStore['owner/repo'];
		assert.ok(repoStore, 'Stored responses for repository');
		const issueStore = repoStore['42'];
		assert.ok(issueStore, 'Stored responses for issue');
		const response = issueStore['What is needed?'];
		assert.ok(response, 'Question response saved');

		const stateResponse = internal.state.questionResponses['42'];
		assert.ok(stateResponse, 'State includes question responses');
		assert.ok(stateResponse['What is needed?'], 'State response keyed by question');

		const persisted = workspaceState.get<QuestionResponseStore>('issuetriage.assessment.questionResponses');
		assert.ok(persisted, 'Responses persisted in workspace state');
		assert.ok(persisted && persisted['owner/repo'], 'Persisted repository entry present');
	});

	test('requires repository selection and non-empty answer', async () => {
		const globalState = new MemoryMemento();
		const workspaceState = new MemoryMemento();
		const stateService = new StateService(globalState, workspaceState);
		const githubStub = {
			upsertIssueComment: async () => 1
		} as unknown as GitHubClient;

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

		await assert.rejects(
			() => manager.answerAssessmentQuestion(7, 'Question', 'Reply'),
			/Select a repository/
		);

		const internal = manager as unknown as { state: { selectedRepository?: { id: number; name: string; owner: string; fullName: string; private: boolean } } };
		internal.state.selectedRepository = { id: 1, name: 'repo', owner: 'owner', fullName: 'owner/repo', private: false };

		await assert.rejects(
			() => manager.answerAssessmentQuestion(7, 'Question', '   '),
			/Provide an answer/
		);
	});
});
