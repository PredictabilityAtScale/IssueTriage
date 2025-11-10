import * as vscode from 'vscode';
import { GitHubAuthService, GitHubSessionMetadata } from './services/githubAuthService';
import {
	GitHubClient,
	IssueFilters,
	IssueSummary,
	RepositorySummary,
	UnlinkedPullRequest,
	UnlinkedCommit,
	PullRequestBackfillDetail,
	CommitBackfillDetail
} from './services/githubClient';
import { AssessmentService } from './services/assessmentService';
import type { AssessmentRecord } from './services/assessmentStorage';
import { SettingsService } from './services/settingsService';
import { StateService } from './services/stateService';
import { TelemetryService } from './services/telemetryService';
import { RiskIntelligenceService, RiskUpdateEvent } from './services/riskIntelligenceService';
import { KeywordExtractionService } from './services/keywordExtractionService';
import { ensureKeywordCoverage } from './services/keywordUtils';
import { SimilarityService } from './services/similarityService';
import { evaluateRecordReadiness, type AssessmentReadiness } from './services/assessmentReadiness';
import type { RiskLevel, RiskSummary, SimilarIssue } from './types/risk';

interface GitExtensionApiWrapper {
	getAPI(version: number): GitApi;
}

interface GitApi {
	repositories: GitRepository[];
	getRepository?(uri: vscode.Uri): GitRepository | undefined;
}

interface GitRepository {
	rootUri: vscode.Uri;
	state: {
		remotes: GitRemote[];
	};
}

interface GitRemote {
	name?: string;
	fetchUrl?: string;
	pushUrl?: string;
}

export interface FilterState extends IssueFilters {
	search?: string;
	state?: 'open' | 'closed';
	readiness?: AssessmentReadiness | 'all';
}

interface IssueAssessmentSummary {
	issueNumber: number;
	compositeScore: number;
	readinessScore: number;
	readiness: AssessmentReadiness;
	model: string;
	updatedAt: string;
	businessScore: number;
}

interface UnlinkedWorkState {
	loading: boolean;
	pullRequests: UnlinkedPullRequest[];
	commits: UnlinkedCommit[];
	lastUpdated?: string;
	error?: string;
}

interface BackfillIssueOptions {
	close?: boolean;
	silent?: boolean; // Suppress notifications and auto-refresh for batch operations
}

interface DashboardMetrics {
	totalIssuesAssessed: number;
	averageComposite?: number;
	assessmentsLastSevenDays: number;
	readinessDistribution: Record<AssessmentReadiness, number>;
}
type OpenIssueCacheFilters = Pick<FilterState, 'label' | 'assignee' | 'milestone' | 'search'>;

interface ResolvedUnlinkedRecord {
	pulls: number[];
	commits: string[];
}

type ResolvedUnlinkedState = Record<string, ResolvedUnlinkedRecord>;

interface QuestionResponse {
	answer: string;
	answeredAt: string;
	commentId?: number;
	commentUrl?: string;
}

type IssueQuestionResponseMap = Record<string, QuestionResponse>;
type RepositoryQuestionResponses = Record<string, IssueQuestionResponseMap>;
type StoredQuestionResponses = Record<string, RepositoryQuestionResponses>;

export interface NewIssueDraftInput {
	title: string;
	summary: string;
	labels?: string[];
	priority?: string;
	assignees?: string[];
}

export type SimilarityConfidenceLevel = 'high' | 'medium' | 'low';

export interface NewIssueSimilarityMatch {
	issueNumber: number;
	title: string;
	url: string;
	state: 'open' | 'closed';
	riskLevel: RiskLevel;
	riskScore: number;
	overlapScore: number;
	sharedKeywords: string[];
	keywords: string[];
	labels: string[];
	summary?: string;
	calculatedAt?: string;
	confidenceLevel: SimilarityConfidenceLevel;
	confidenceLabel: string;
}

export interface NewIssueAnalysisResult {
	keywords: string[];
	tokensUsed: number;
	matches: NewIssueSimilarityMatch[];
}

export interface NewIssueCreateResult {
	issueNumber: number;
	url: string;
	title: string;
}

interface IssueManagerState {
	loading: boolean;
	error?: string;
	repositories: RepositorySummary[];
	selectedRepository?: RepositorySummary;
	issues: IssueSummary[];
	issueMetadata: {
		labels: string[];
		assignees: string[];
		milestones: string[];
	};
	filters: FilterState;
	lastUpdated?: string;
	session?: GitHubSessionMetadata;
	automationLaunchEnabled: boolean;
	riskSummaries: Record<number, RiskSummary>;
	assessmentSummaries: Record<number, IssueAssessmentSummary>;
	dashboardMetrics?: DashboardMetrics;
	unlinkedWork: UnlinkedWorkState;
	questionResponses: RepositoryQuestionResponses;
}

const WORKSPACE_REPOSITORY_KEY = 'issuetriage.repository.selected';
const WORKSPACE_FILTER_KEY = 'issuetriage.repository.filters';
const WORKSPACE_RESOLVED_UNLINKED_KEY = 'issuetriage.unlinked.resolved';
const WORKSPACE_QUESTION_RESPONSES_KEY = 'issuetriage.assessment.questionResponses';
const DEFAULT_FILTERS: FilterState = {
	state: 'open',
	readiness: 'all'
};
const DEFAULT_COMMIT_LOOKBACK_DAYS = 90;

export class IssueManager implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<IssueManagerState>();
	private state: IssueManagerState = {
		loading: false,
		repositories: [],
		issues: [],
		issueMetadata: {
			labels: [],
			assignees: [],
			milestones: []
		},
		filters: { ...DEFAULT_FILTERS },
		automationLaunchEnabled: false,
		riskSummaries: {},
		assessmentSummaries: {},
		unlinkedWork: {
			loading: false,
			pullRequests: [],
			commits: []
		},
		questionResponses: {}
	};
	private allIssues: IssueSummary[] = [];
	private openIssueCache: Record<string, IssueSummary[]> = {};
	private openIssueCacheFilters: Record<string, OpenIssueCacheFilters> = {};
	private disposables: vscode.Disposable[] = [];
	private resolvedUnlinked: ResolvedUnlinkedState = {};
	private questionResponsesStore: StoredQuestionResponses = {};

	constructor(
		private readonly auth: GitHubAuthService,
		private readonly github: GitHubClient,
		private readonly settings: SettingsService,
		private readonly stateService: StateService,
		private readonly telemetry: TelemetryService,
		private readonly risk: RiskIntelligenceService,
		private readonly assessment: AssessmentService,
		private readonly keywordExtractor: KeywordExtractionService,
		private readonly similarity: SimilarityService
	) {
		const riskSubscription = this.risk.onDidUpdate(event => this.onRiskUpdate(event));
		this.disposables.push(riskSubscription);
		this.resolvedUnlinked = this.stateService.getWorkspace<ResolvedUnlinkedState>(WORKSPACE_RESOLVED_UNLINKED_KEY, {}) ?? {};
		this.questionResponsesStore = this.stateService.getWorkspace<StoredQuestionResponses>(WORKSPACE_QUESTION_RESPONSES_KEY, {}) ?? {};
	}

	public readonly onDidChangeState = this.emitter.event;
	private workspaceRepositorySlug?: string;

	public async initialize(): Promise<void> {
		try {
			const session = await this.auth.getSessionMetadata();
			if (session) {
				this.state = { ...this.state, session };
			}
			const storedRepository = this.stateService.getWorkspace<RepositorySummary>(WORKSPACE_REPOSITORY_KEY);
			const storedFilters = this.stateService.getWorkspace<FilterState>(WORKSPACE_FILTER_KEY, DEFAULT_FILTERS);
			if (storedRepository) {
				this.state.selectedRepository = storedRepository;
				this.workspaceRepositorySlug = this.normalizeRepositorySlug(storedRepository.fullName);
			}
			this.applyQuestionResponseState(this.state.selectedRepository?.fullName);
			this.state.filters = this.ensureFilterDefaults(storedFilters);
			if (!storedRepository) {
				this.workspaceRepositorySlug = await this.detectWorkspaceRepositorySlug();
			}
			this.state.loading = true;
			this.emitState();

			if (session) {
				await this.refreshRepositories();
				if (this.state.selectedRepository) {
					await this.refreshIssues(true);
				}
			}
		} catch (error) {
			this.setError(error instanceof Error ? error.message : 'Failed to initialize Issue Manager.');
		} finally {
			this.setLoading(false);
		}
	}

	public getSnapshot(): IssueManagerState {
		return { ...this.state };
	}

	public getCachedOpenIssues(): IssueSummary[] {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			return [];
		}
		const key = this.getResolvedStoreKey(repository);
		const cached = this.openIssueCache[key];
		if (cached) {
			return [...cached];
		}
		if (this.state.filters.state !== 'closed') {
			return this.state.issues
				.filter(issue => issue.state === 'open')
				.map(issue => ({ ...issue }));
		}
		return [];
	}

	public getAllIssues(): IssueSummary[] {
		return [...this.allIssues];
	}

	public async connectRepository(): Promise<void> {
		this.setLoading(true);
		try {
			if (!(await this.auth.hasValidSession())) {
				await this.auth.signIn();
			}
			this.state.session = await this.auth.getSessionMetadata();
			this.emitState();
			await this.refreshRepositories(true);
			if (!this.state.selectedRepository) {
				await this.promptForRepository();
			}
		} catch (error) {
			this.handleUserFacingError('Failed to connect to GitHub.', error);
		} finally {
			this.setLoading(false);
		}
	}

	public async changeRepository(): Promise<void> {
		this.setLoading(true);
		try {
			if (!(await this.auth.hasValidSession())) {
				await this.auth.signIn();
			}
			this.state.session = await this.auth.getSessionMetadata();
			this.emitState();
			await this.refreshRepositories(true);
			await this.promptForRepository();
		} catch (error) {
			this.handleUserFacingError('Failed to change repository.', error);
		} finally {
			this.setLoading(false);
		}
	}

	public async refreshIssues(forceRefresh = false): Promise<void> {
		if (!this.state.selectedRepository) {
			return;
		}

		this.setLoading(true);
		try {
			const fullName = this.state.selectedRepository.fullName;
			const filters: FilterState = { ...this.state.filters };
			const issues = await this.github.listIssues(fullName, {
				label: filters.label,
				assignee: filters.assignee,
				milestone: filters.milestone,
				state: filters.state
			}, forceRefresh);
			this.allIssues = issues;
			if (filters.state === 'closed') {
				await this.ensureOpenIssueCache(fullName, filters, forceRefresh);
			} else {
				this.cacheOpenIssues(fullName, issues, filters);
			}
			await this.updateAssessmentData(fullName);
			this.applyFilters();
			await this.updateRiskSummaries(fullName);
			await this.refreshUnlinkedWork(forceRefresh);
			this.state.lastUpdated = new Date().toISOString();
			this.state.error = undefined;
			this.emitState();
		} catch (error) {
			this.handleUserFacingError('Failed to load issues from GitHub.', error);
		} finally {
			this.setLoading(false);
		}
	}

	public async refreshAssessments(): Promise<void> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			return;
		}
		try {
			await this.updateAssessmentData(repository);
			this.applyFilters();
			this.emitState();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.assessments.refreshFailed', {
				repository,
				message
			});
		}
	}

	public async answerAssessmentQuestion(issueNumber: number, question: string, answer: string): Promise<{ repository: string; question: string; response: QuestionResponse; commentUrl?: string }> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			throw new Error('Select a repository before answering assessment questions.');
		}
		const normalizedQuestion = this.normalizeQuestionKey(question ?? '');
		if (!normalizedQuestion) {
			throw new Error('Question text is required.');
		}
		const trimmedAnswer = (answer ?? '').trim();
		if (!trimmedAnswer) {
			throw new Error('Provide an answer before submitting.');
		}

		const commentBody = this.buildQuestionComment(normalizedQuestion, trimmedAnswer);
		let commentId: number | undefined;
		try {
			commentId = await this.github.upsertIssueComment(repository, issueNumber, commentBody);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.questions.answerFailed', {
				repository,
				issue: String(issueNumber),
				message
			});
			throw new Error(`Failed to post answer: ${message}`);
		}

		const commentUrl = commentId ? `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${commentId}` : undefined;
		const repoKey = this.getQuestionStoreKey(repository);
		const repositoryResponses = this.questionResponsesStore[repoKey] ?? {};
		const issueKey = String(issueNumber);
		const issueResponses = repositoryResponses[issueKey] ?? {};
		const response: QuestionResponse = {
			answer: trimmedAnswer,
			answeredAt: new Date().toISOString(),
			commentId,
			commentUrl
		};
		issueResponses[normalizedQuestion] = response;
		repositoryResponses[issueKey] = issueResponses;
		this.questionResponsesStore[repoKey] = repositoryResponses;

		this.state.questionResponses = {
			...this.state.questionResponses,
			[issueKey]: {
				...(this.state.questionResponses[issueKey] ?? {}),
				[normalizedQuestion]: { ...response }
			}
		};

		await this.persistQuestionResponses();
		this.telemetry.trackEvent('issueManager.questions.answered', {
			repository,
			issue: String(issueNumber)
		});
		this.emitState();
		return { repository, question: normalizedQuestion, response, commentUrl };
	}

	public async analyzeNewIssueDraft(draft: NewIssueDraftInput): Promise<NewIssueAnalysisResult> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			throw new Error('Select a repository before creating new issues.');
		}

		const title = (draft.title ?? '').trim();
		const summary = (draft.summary ?? '').trim();
		if (!title) {
			throw new Error('Provide a title before analyzing a new issue.');
		}
		if (!summary) {
			throw new Error('Provide a summary before analyzing a new issue.');
		}

		const normalizedLabels = this.normalizeStringArray(draft.labels);
		const priority = this.normalizePriority(draft.priority);
		const similarityLimit = this.getSimilarityLimit();

		try {
			const keywordContext = {
				issueTitle: title,
				issueBody: summary,
				labels: normalizedLabels,
				repository
			};
			this.telemetry.trackEvent('issueCreator.analyzeRequested', {
				repository,
				labelCount: String(normalizedLabels.length),
				priority: priority ?? 'unspecified'
			}, {
				summaryLength: summary.length
			});

			const keywordResult = await this.keywordExtractor.extractKeywords(title, summary);
			const keywords = ensureKeywordCoverage(keywordResult.keywords, keywordContext);
			const matches = await this.similarity.findSimilar(repository, keywords, undefined, similarityLimit);
			const enrichedMatches = await this.enrichSimilarityMatches(repository, matches, similarityLimit);

			this.telemetry.trackEvent('issueCreator.analyzeCompleted', {
				repository,
				matchCount: String(enrichedMatches.length),
				priority: priority ?? 'unspecified'
			}, {
				tokensUsed: keywordResult.tokensUsed,
				keywordCount: keywords.length
			});

			return {
				keywords,
				tokensUsed: keywordResult.tokensUsed,
				matches: enrichedMatches
			};
		} catch (error) {
			const description = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueCreator.analyzeFailed', {
				repository,
				message: description
			});
			throw error instanceof Error ? error : new Error(description);
		}
	}

	public async createIssueFromDraft(draft: NewIssueDraftInput, analysis?: NewIssueAnalysisResult): Promise<NewIssueCreateResult> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			throw new Error('Select a repository before creating new issues.');
		}

		const title = (draft.title ?? '').trim();
		const summary = (draft.summary ?? '').trim();
		if (!title) {
			throw new Error('Issue title is required.');
		}
		if (!summary) {
			throw new Error('Issue summary is required.');
		}

		const labels = this.normalizeStringArray(draft.labels);
		const assignees = this.normalizeStringArray(draft.assignees);
		const priority = this.normalizePriority(draft.priority);
		const body = this.buildNewIssueBody({
			summary,
			labels,
			assignees,
			priority
		}, analysis);

		try {
			this.telemetry.trackEvent('issueCreator.createIssueRequested', {
				repository,
				labelCount: String(labels.length),
				assigneeCount: String(assignees.length),
				priority: priority ?? 'unspecified',
				matchCount: String(analysis?.matches.length ?? 0)
			}, {
				summaryLength: summary.length
			});

			const issueNumber = await this.github.createIssue(repository, {
				title,
				body,
				labels: labels.length ? labels : undefined,
				assignees: assignees.length ? assignees : undefined
			});
			const url = this.buildIssueUrl(repository, issueNumber);

			this.telemetry.trackEvent('issueCreator.createIssueSuccess', {
				repository,
				issue: String(issueNumber),
				priority: priority ?? 'unspecified',
				labelCount: String(labels.length),
				matchCount: String(analysis?.matches.length ?? 0)
			});

			void this.refreshIssues(true).catch(refreshError => {
				const refreshMessage = refreshError instanceof Error ? refreshError.message : String(refreshError);
				this.telemetry.trackEvent('issueCreator.refreshAfterCreateFailed', {
					repository,
					issue: String(issueNumber),
					message: refreshMessage
				});
			});

			return {
				issueNumber,
				url,
				title
			};
		} catch (error) {
			const description = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueCreator.createIssueFailed', {
				repository,
				message: description
			});
			throw error instanceof Error ? error : new Error(description);
		}
	}

	public async refreshRepositories(forceRefresh = false): Promise<void> {
		this.setLoading(true);
		try {
			if (!this.workspaceRepositorySlug) {
				this.workspaceRepositorySlug = await this.detectWorkspaceRepositorySlug();
			}
			const repositories = await this.github.listRepositories(forceRefresh);
			this.state.repositories = repositories;

			if (!this.state.selectedRepository) {
				const defaultRepo = this.getDefaultRepository(repositories);
				if (defaultRepo) {
					await this.selectRepository(defaultRepo.fullName, false);
				}
			} else {
				const fullName = this.state.selectedRepository.fullName;
				const match = repositories.find(repo => repo.fullName === fullName);
				if (match) {
					this.state.selectedRepository = match;
				} else {
					this.state.selectedRepository = undefined;
				}
			}
			this.applyQuestionResponseState(this.state.selectedRepository?.fullName);
			this.emitState();
		} catch (error) {
			this.handleUserFacingError('Failed to load repositories from GitHub.', error);
		} finally {
			this.setLoading(false);
		}
	}

	public async selectRepository(fullName: string, refresh = true): Promise<void> {
		const repository = this.state.repositories.find(repo => repo.fullName === fullName);
		if (!repository) {
			throw new Error(`Repository ${fullName} not found in cache.`);
		}
		this.telemetry.trackEvent('dashboard.repositorySelected', {
			repository: repository.fullName,
			visibility: repository.private ? 'private' : 'public'
		});
		this.state.selectedRepository = repository;
		this.workspaceRepositorySlug = this.normalizeRepositorySlug(repository.fullName);
		this.state.riskSummaries = {};
		this.applyQuestionResponseState(repository.fullName);
		await this.stateService.updateWorkspace(WORKSPACE_REPOSITORY_KEY, repository);
		this.emitState();
		if (refresh) {
			await this.refreshIssues(true);
		}
	}

	public async updateFilters(filters: FilterState): Promise<void> {
		const normalized = this.ensureFilterDefaults(filters);
		const previousState = this.state.filters.state;
		this.state.filters = normalized;
		await this.stateService.updateWorkspace(WORKSPACE_FILTER_KEY, normalized);
		
		// If the state filter (open/closed) changed, we need to refetch from GitHub
		if (previousState !== filters.state && this.state.selectedRepository) {
			await this.refreshIssues(true);
		} else {
			// Otherwise just apply client-side filters
			this.applyFilters();
			this.emitState();
		}
	}

	public async signOut(): Promise<void> {
		await this.auth.signOut();
		this.github.clearCaches();
		this.state = {
			loading: false,
			repositories: [],
			issues: [],
			issueMetadata: {
				labels: [],
				assignees: [],
				milestones: []
			},
			filters: { ...DEFAULT_FILTERS },
			automationLaunchEnabled: this.readAutomationFlag(),
			riskSummaries: {},
			assessmentSummaries: {},
			dashboardMetrics: undefined,
			unlinkedWork: {
				loading: false,
				pullRequests: [],
				commits: []
			},
			questionResponses: {}
		};
		this.allIssues = [];
		this.openIssueCache = {};
		this.openIssueCacheFilters = {};
		this.resolvedUnlinked = {};
		await this.stateService.updateWorkspace(WORKSPACE_REPOSITORY_KEY, undefined);
		await this.stateService.updateWorkspace(WORKSPACE_FILTER_KEY, undefined);
		await this.stateService.updateWorkspace(WORKSPACE_RESOLVED_UNLINKED_KEY, undefined);
		this.emitState();
	}

	public async linkPullRequestToIssue(pullNumber: number): Promise<void> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			void vscode.window.showWarningMessage('Connect to a repository before linking pull requests.');
			return;
		}
		const issueNumber = await this.promptForIssueSelection(repository, `Select an issue to link to PR #${pullNumber}`);
		if (!issueNumber) {
			return;
		}
		try {
			await this.github.linkPullRequestToIssue(repository, pullNumber, issueNumber);
			await this.markPullRequestResolved(repository, pullNumber);
			this.telemetry.trackEvent('issueManager.unlinked.pull.linked', {
				repository,
				pull: String(pullNumber),
				issue: String(issueNumber)
			});
			void vscode.window.showInformationMessage(`Linked pull request #${pullNumber} to issue #${issueNumber}.`);
			await this.refreshUnlinkedWork(true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.unlinked.pull.linkError', {
				repository,
				pull: String(pullNumber),
				message
			});
			void vscode.window.showErrorMessage(`Failed to link pull request #${pullNumber}: ${message}`);
		}
	}

	public async createIssueFromPullRequest(pullNumber: number, options: BackfillIssueOptions = {}): Promise<void> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			void vscode.window.showWarningMessage('Connect to a repository before creating backfill issues.');
			return;
		}
		const closeIssue = options.close ?? false;
		const silent = options.silent ?? false;
		try {
			const detail = await this.github.getPullRequestBackfillDetail(repository, pullNumber);
			const issuePayload = this.buildPullRequestBackfillIssue(repository, detail);
			const issueNumber = await this.github.createIssue(repository, issuePayload);
			await this.github.linkPullRequestToIssue(repository, pullNumber, issueNumber);
			if (closeIssue) {
				await this.github.updateIssueState(repository, issueNumber, 'closed');
			}
			await this.markPullRequestResolved(repository, pullNumber);
			this.telemetry.trackEvent('issueManager.unlinked.pull.issueCreated', {
				repository,
				pull: String(pullNumber),
				issue: String(issueNumber),
				state: closeIssue ? 'closed' : 'open'
			});
			if (!silent) {
				const issueUrl = `https://github.com/${repository}/issues/${issueNumber}`;
				const action = 'Open Issue';
				const selection = await vscode.window.showInformationMessage(`Created issue #${issueNumber} (${closeIssue ? 'closed' : 'open'}) for pull request #${pullNumber}.`, action);
				if (selection === action) {
					void vscode.env.openExternal(vscode.Uri.parse(issueUrl));
				}
				await this.refreshUnlinkedWork(true);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.unlinked.pull.createError', {
				repository,
				pull: String(pullNumber),
				message
			});
			if (!silent) {
				void vscode.window.showErrorMessage(`Unable to create backfill issue for PR #${pullNumber}: ${message}`);
			}
			throw error; // Re-throw for batch handling
		}
	}

	public async linkCommitToIssue(sha: string): Promise<void> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			void vscode.window.showWarningMessage('Connect to a repository before linking commits.');
			return;
		}
		const shortSha = sha.slice(0, 7);
		const issueNumber = await this.promptForIssueSelection(repository, `Select an issue to link commit ${shortSha}`);
		if (!issueNumber) {
			return;
		}
		try {
			await this.github.linkCommitToIssue(repository, sha, issueNumber);
			await this.markCommitResolved(repository, sha);
			this.telemetry.trackEvent('issueManager.unlinked.commit.linked', {
				repository,
				commit: shortSha,
				issue: String(issueNumber)
			});
			void vscode.window.showInformationMessage(`Linked commit ${shortSha} to issue #${issueNumber}.`);
			await this.refreshUnlinkedWork(true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.unlinked.commit.linkError', {
				repository,
				commit: shortSha,
				message
			});
			void vscode.window.showErrorMessage(`Failed to link commit ${shortSha}: ${message}`);
		}
	}

	public async createIssueFromCommit(sha: string, options: BackfillIssueOptions = {}): Promise<void> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			void vscode.window.showWarningMessage('Connect to a repository before creating backfill issues.');
			return;
		}
		const shortSha = sha.slice(0, 7);
		const closeIssue = options.close ?? false;
		const silent = options.silent ?? false;
		try {
			const detail = await this.github.getCommitBackfillDetail(repository, sha);
			const issuePayload = this.buildCommitBackfillIssue(repository, detail);
			const issueNumber = await this.github.createIssue(repository, issuePayload);
			await this.github.linkCommitToIssue(repository, sha, issueNumber);
			if (closeIssue) {
				await this.github.updateIssueState(repository, issueNumber, 'closed');
			}
			await this.markCommitResolved(repository, sha);
			this.telemetry.trackEvent('issueManager.unlinked.commit.issueCreated', {
				repository,
				commit: shortSha,
				issue: String(issueNumber),
				state: closeIssue ? 'closed' : 'open'
			});
			if (!silent) {
				const issueUrl = `https://github.com/${repository}/issues/${issueNumber}`;
				const action = 'Open Issue';
				const selection = await vscode.window.showInformationMessage(`Created issue #${issueNumber} (${closeIssue ? 'closed' : 'open'}) for commit ${shortSha}.`, action);
				if (selection === action) {
					void vscode.env.openExternal(vscode.Uri.parse(issueUrl));
				}
				await this.refreshUnlinkedWork(true);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.unlinked.commit.createError', {
				repository,
				commit: shortSha,
				message
			});
			if (!silent) {
				void vscode.window.showErrorMessage(`Unable to create backfill issue for commit ${shortSha}: ${message}`);
			}
			throw error; // Re-throw for batch handling
		}
	}

	public async refreshUnlinkedData(forceRefresh = true): Promise<void> {
		await this.refreshUnlinkedWork(forceRefresh);
	}

	public dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
		this.emitter.dispose();
	}

	private async promptForRepository(): Promise<void> {
		const repoPicks = this.state.repositories.map(repo => ({
			label: repo.fullName,
			description: repo.private ? 'Private' : 'Public'
		}));

		const selection = await vscode.window.showQuickPick(repoPicks, {
			placeHolder: 'Select a GitHub repository to triage'
		});

		if (!selection) {
			return;
		}

		await this.selectRepository(selection.label);
	}

	private getDefaultRepository(repositories: RepositorySummary[]): RepositorySummary | undefined {
		if (this.workspaceRepositorySlug) {
			const workspaceMatch = this.findRepositoryBySlug(repositories, this.workspaceRepositorySlug);
			if (workspaceMatch) {
				return workspaceMatch;
			}
		}
		const defaultSlug = this.settings.get<string>('github.defaultRepository');
		const normalizedDefault = this.normalizeRepositorySlug(defaultSlug ?? undefined);
		if (normalizedDefault) {
			const configuredMatch = this.findRepositoryBySlug(repositories, normalizedDefault);
			if (configuredMatch) {
				return configuredMatch;
			}
		}
		return repositories[0];
	}

	private async updateRiskSummaries(repository: string): Promise<void> {
		try {
			const riskMap = await this.risk.primeIssues(repository, this.allIssues);
			const summaries: Record<number, RiskSummary> = {};
			for (const [issueNumber, summary] of riskMap.entries()) {
				summaries[issueNumber] = summary;
			}
			this.state.riskSummaries = summaries;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.risk.primeFailed', {
				repository,
				message
			});
		}
	}

	private async refreshUnlinkedWork(forceRefresh: boolean): Promise<void> {
		const repository = this.state.selectedRepository?.fullName;
		if (!repository) {
			this.state.unlinkedWork = {
				loading: false,
				pullRequests: [],
				commits: [],
				lastUpdated: undefined,
				error: undefined
			};
			return;
		}

		const previous = this.state.unlinkedWork;
		this.state.unlinkedWork = {
			...previous,
			loading: true,
			error: undefined
		};
		this.emitState();

		try {
			const [pullRequests, commits] = await Promise.all([
				this.github.listUnlinkedPullRequests(repository, { state: 'all', limit: 25 }, forceRefresh),
				this.github.listCommitsWithoutPullRequests(repository, {
					limit: 25,
					since: this.calculateCommitLookbackIso()
				}, forceRefresh)
			]);
			const repoKey = this.getResolvedStoreKey(repository);
			const resolved = this.resolvedUnlinked[repoKey];
			const filteredPullRequests = resolved
				? pullRequests.filter(pr => !resolved.pulls.includes(pr.number))
				: pullRequests;
			const filteredCommits = resolved
				? commits.filter(commit => !resolved.commits.includes(commit.sha))
				: commits;
			this.state.unlinkedWork = {
				loading: false,
				pullRequests: filteredPullRequests,
				commits: filteredCommits,
				lastUpdated: new Date().toISOString(),
				error: undefined
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.state.unlinkedWork = {
				...previous,
				loading: false,
				error: message
			};
			this.telemetry.trackEvent('issueManager.unlinked.refreshFailed', {
				repository,
				message
			});
		}
		this.emitState();
	}

	private async promptForIssueSelection(repository: string, placeHolder: string): Promise<number | undefined> {
		try {
			const issues = await this.github.listIssues(repository, { state: 'all' }, true);
			if (!issues.length) {
				void vscode.window.showInformationMessage('No issues available to link yet. Create an issue first.');
				return undefined;
			}
			const items = issues.slice(0, 200).map(issue => ({
				label: `#${issue.number} · ${issue.title}`,
				description: issue.state === 'closed' ? 'Closed' : 'Open',
				issueNumber: issue.number
			}));
			const selection = await vscode.window.showQuickPick(items, {
				placeHolder,
				matchOnDescription: true
			});
			return selection?.issueNumber;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.unlinked.issuePickFailed', {
				repository,
				message
			});
			void vscode.window.showErrorMessage(`Unable to list issues: ${message}`);
			return undefined;
		}
	}

	private async updateAssessmentData(repository: string): Promise<void> {
		const summaries: Record<number, IssueAssessmentSummary> = {};
		const readinessDistribution: Record<AssessmentReadiness, number> = {
			ready: 0,
			prepare: 0,
			review: 0,
			manual: 0
		};
		let totalIssuesAssessed = 0;
		let compositeAccumulator = 0;
		let assessmentsLastSevenDays = 0;
		const now = Date.now();

		const historyResults = await Promise.all(this.allIssues.map(async issue => {
			try {
				const history = await this.assessment.getAssessmentHistory(repository, issue.number, 10);
				return { issueNumber: issue.number, history };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.telemetry.trackEvent('issueManager.assessments.historyFailed', {
					repository,
					issue: String(issue.number),
					message
				});
				return { issueNumber: issue.number, history: [] as AssessmentRecord[] };
			}
		}));

		for (const result of historyResults) {
			if (!result.history.length) {
				continue;
			}
			totalIssuesAssessed += 1;
			const latest = result.history[0];
			const readinessEvaluation = evaluateRecordReadiness(latest);
			const readiness = readinessEvaluation.readiness;
			readinessDistribution[readiness] += 1;
			compositeAccumulator += latest.compositeScore;
			summaries[result.issueNumber] = {
				issueNumber: result.issueNumber,
				compositeScore: latest.compositeScore,
				readinessScore: readinessEvaluation.blendedScore,
				readiness,
				model: latest.model,
				updatedAt: latest.createdAt,
				businessScore: latest.businessScore
			};
			for (const record of result.history) {
				const created = Date.parse(record.createdAt);
				if (Number.isFinite(created) && now - created <= 7 * 24 * 60 * 60 * 1000) {
					assessmentsLastSevenDays += 1;
				}
			}
		}

		const averageComposite = totalIssuesAssessed > 0
			? Number((compositeAccumulator / totalIssuesAssessed).toFixed(1))
			: undefined;

		this.state.assessmentSummaries = summaries;
		this.state.dashboardMetrics = {
			totalIssuesAssessed,
			averageComposite,
			assessmentsLastSevenDays,
			readinessDistribution
		};
	}

	private applyFilters(): void {
		const { filters } = this.state;
		let filtered = [...this.allIssues];
		if (filters.search) {
			const searchLower = filters.search.toLowerCase();
			filtered = filtered.filter(issue => issue.title.toLowerCase().includes(searchLower));
		}
		if (filters.label) {
			filtered = filtered.filter(issue => issue.labels.includes(filters.label as string));
		}
		if (filters.assignee) {
			filtered = filtered.filter(issue => issue.assignees.includes(filters.assignee as string));
		}
		if (filters.milestone) {
			filtered = filtered.filter(issue => issue.milestone === filters.milestone);
		}
		if (filters.readiness && filters.readiness !== 'all') {
			filtered = filtered.filter(issue => {
				const summary = this.state.assessmentSummaries[issue.number];
				return summary ? summary.readiness === filters.readiness : false;
			});
		}

		this.state.issues = filtered;
		this.state.issueMetadata = {
			labels: this.uniqueValues(this.allIssues.flatMap(issue => issue.labels)).sort(),
			assignees: this.uniqueValues(this.allIssues.flatMap(issue => issue.assignees)).sort(),
			milestones: this.uniqueValues(this.allIssues.map(issue => issue.milestone).filter(Boolean) as string[]).sort()
		};
	}

	private uniqueValues(values: string[]): string[] {
		return Array.from(new Set(values.filter(Boolean)));
	}

	private cacheOpenIssues(repository: string, issues: IssueSummary[], filters: FilterState): void {
		const key = this.getResolvedStoreKey(repository);
		this.openIssueCache[key] = issues
			.filter(issue => issue.state === 'open')
			.map(issue => ({ ...issue }));
		this.openIssueCacheFilters[key] = {
			label: filters.label,
			assignee: filters.assignee,
			milestone: filters.milestone,
			search: filters.search
		};
	}

	private async ensureOpenIssueCache(repository: string, filters: FilterState, forceRefresh: boolean): Promise<void> {
		const key = this.getResolvedStoreKey(repository);
		const cachedFilters = this.openIssueCacheFilters[key];
		const hasCachedIssues = Array.isArray(this.openIssueCache[key]);
		const filtersMatch = cachedFilters
			&& (cachedFilters.label ?? '') === (filters.label ?? '')
			&& (cachedFilters.assignee ?? '') === (filters.assignee ?? '')
			&& (cachedFilters.milestone ?? '') === (filters.milestone ?? '')
			&& (cachedFilters.search ?? '') === (filters.search ?? '');
		if (hasCachedIssues && filtersMatch && !forceRefresh) {
			return;
		}
		try {
			const openIssues = await this.github.listIssues(repository, {
				label: filters.label,
				assignee: filters.assignee,
				milestone: filters.milestone,
				state: 'open'
			}, forceRefresh);
			this.cacheOpenIssues(repository, openIssues, { ...filters, state: 'open' });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.openCache.refreshFailed', {
				repository,
				message
			});
		}
	}

	private async markPullRequestResolved(repository: string, pullNumber: number): Promise<void> {
		const repoKey = this.getResolvedStoreKey(repository);
		const record = this.resolvedUnlinked[repoKey] ?? { pulls: [], commits: [] };
		if (!record.pulls.includes(pullNumber)) {
			record.pulls.push(pullNumber);
			this.resolvedUnlinked[repoKey] = record;
			await this.persistResolvedUnlinked();
		}
		this.state.unlinkedWork = {
			...this.state.unlinkedWork,
			pullRequests: this.state.unlinkedWork.pullRequests.filter(pr => pr.number !== pullNumber)
		};
		this.emitState();
	}

	private async markCommitResolved(repository: string, sha: string): Promise<void> {
		const repoKey = this.getResolvedStoreKey(repository);
		const record = this.resolvedUnlinked[repoKey] ?? { pulls: [], commits: [] };
		if (!record.commits.includes(sha)) {
			record.commits.push(sha);
			this.resolvedUnlinked[repoKey] = record;
			await this.persistResolvedUnlinked();
		}
		this.state.unlinkedWork = {
			...this.state.unlinkedWork,
			commits: this.state.unlinkedWork.commits.filter(commit => commit.sha !== sha)
		};
		this.emitState();
	}

	private getResolvedStoreKey(repository: string): string {
		return this.normalizeRepositorySlug(repository) ?? repository.toLowerCase();
	}

	private async persistResolvedUnlinked(): Promise<void> {
		await this.stateService.updateWorkspace(WORKSPACE_RESOLVED_UNLINKED_KEY, this.resolvedUnlinked);
	}

	private applyQuestionResponseState(repository?: string): void {
		if (!repository) {
			this.state.questionResponses = {};
			return;
		}
		const repoKey = this.getQuestionStoreKey(repository);
		const stored = this.questionResponsesStore[repoKey];
		this.state.questionResponses = stored ? this.cloneQuestionResponses(stored) : {};
	}

	private async persistQuestionResponses(): Promise<void> {
		await this.stateService.updateWorkspace(WORKSPACE_QUESTION_RESPONSES_KEY, this.questionResponsesStore);
	}

	private getQuestionStoreKey(repository: string): string {
		return this.normalizeRepositorySlug(repository) ?? repository.toLowerCase();
	}

	private cloneQuestionResponses(source: RepositoryQuestionResponses): RepositoryQuestionResponses {
		const clone: RepositoryQuestionResponses = {};
		Object.entries(source ?? {}).forEach(([issueNumber, responses]) => {
			const issueClone: IssueQuestionResponseMap = {};
			Object.entries(responses ?? {}).forEach(([questionKey, response]) => {
				issueClone[questionKey] = { ...response };
			});
			clone[issueNumber] = issueClone;
		});
		return clone;
	}

	private normalizeStringArray(values?: string[]): string[] {
		if (!Array.isArray(values)) {
			return [];
		}
		const seen = new Set<string>();
		const result: string[] = [];
		for (const value of values) {
			if (typeof value !== 'string') {
				continue;
			}
			const trimmed = value.trim();
			if (!trimmed) {
				continue;
			}
			const key = trimmed.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			result.push(trimmed);
		}
		return result;
	}

	private normalizePriority(priority?: string): string | undefined {
		if (typeof priority !== 'string') {
			return undefined;
		}
		const trimmed = priority.trim();
		if (!trimmed) {
			return undefined;
		}
		if (/^p[0-9]$/i.test(trimmed)) {
			return trimmed.toUpperCase();
		}
		if (/^(high|medium|low)$/i.test(trimmed)) {
			const lower = trimmed.toLowerCase();
			return lower.charAt(0).toUpperCase() + lower.slice(1);
		}
		return trimmed;
	}

	private getSimilarityLimit(): number {
		const configured = this.settings.get<number>('issueCreator.similarMatchLimit', 3);
		if (typeof configured === 'number' && Number.isFinite(configured)) {
			const bounded = Math.floor(configured);
			return Math.min(Math.max(bounded, 1), 10);
		}
		return 3;
	}

	private evaluateSimilarityConfidence(score: number): { level: SimilarityConfidenceLevel; label: string } {
		if (score >= 0.6) {
			return { level: 'high', label: 'High confidence' };
		}
		if (score >= 0.35) {
			return { level: 'medium', label: 'Medium confidence' };
		}
		return { level: 'low', label: 'Low confidence' };
	}

	private buildIssueUrl(repository: string, issueNumber: number): string {
		return `https://github.com/${repository}/issues/${issueNumber}`;
	}

	private async enrichSimilarityMatches(repository: string, matches: SimilarIssue[], limit: number): Promise<NewIssueSimilarityMatch[]> {
		if (!matches.length) {
			return [];
		}
		const detailResults = await Promise.all(matches.map(async match => {
			try {
				const detail = await this.github.getIssueDetails(repository, match.issueNumber);
				return { match, detail };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.telemetry.trackEvent('issueCreator.similarityDetailFailed', {
					repository,
					issue: String(match.issueNumber),
					message
				});
				return { match, detail: undefined };
			}
		}));

		const enriched: NewIssueSimilarityMatch[] = [];
		for (const { match, detail } of detailResults) {
			if (detail?.state === 'open') {
				continue;
			}
			const confidence = this.evaluateSimilarityConfidence(match.overlapScore);
			const title = detail?.title ?? match.issueTitle ?? `#${match.issueNumber}`;
			const url = detail?.url ?? this.buildIssueUrl(repository, match.issueNumber);
			const summary = match.issueSummary;
			const labels = Array.isArray(match.issueLabels) ? this.normalizeStringArray(match.issueLabels) : [];
			enriched.push({
				issueNumber: match.issueNumber,
				title,
				url,
				state: 'closed',
				riskLevel: match.riskLevel,
				riskScore: match.riskScore,
				overlapScore: match.overlapScore,
				sharedKeywords: match.sharedKeywords,
				keywords: match.keywords ?? [],
				labels,
				summary,
				calculatedAt: match.calculatedAt,
				confidenceLevel: confidence.level,
				confidenceLabel: confidence.label
			});
			if (enriched.length >= limit) {
				break;
			}
		}
		return enriched;
	}

	private buildNewIssueBody(
		draft: { summary: string; labels: string[]; assignees: string[]; priority?: string },
		analysis?: NewIssueAnalysisResult
	): string {
		const lines: string[] = [];
		const summary = draft.summary.trim();
		lines.push('## Summary');
		lines.push('');
		lines.push(summary.length ? summary : '_No summary provided._');
		lines.push('');
		lines.push('## Metadata');
		lines.push(`- Priority: ${draft.priority ?? 'Unspecified'}`);
		lines.push(`- Labels: ${draft.labels.length ? draft.labels.join(', ') : 'None'}`);
		if (draft.assignees.length) {
			lines.push(`- Assignees: ${draft.assignees.join(', ')}`);
		}
		lines.push('');
		lines.push('## Similar Issues');
		if (analysis && analysis.matches.length) {
			analysis.matches.forEach(match => {
				lines.push(this.formatSimilarIssueLine(match));
				const matchSummary = match.summary?.trim();
				if (matchSummary) {
					lines.push(`  - ${matchSummary}`);
				}
			});
		} else {
			lines.push('- No related closed issues surfaced.');
		}
		if (analysis && analysis.keywords && analysis.keywords.length) {
			const keywordLine = this.normalizeStringArray(analysis.keywords).join(', ');
			if (keywordLine) {
				lines.push('');
				lines.push('## Captured Keywords');
				lines.push(keywordLine);
			}
		}
		lines.push('');
		lines.push('_Created via IssueTriage new issue flow._');
		return lines.join('\n');
	}

	private formatSimilarIssueLine(match: NewIssueSimilarityMatch): string {
		const shared = match.sharedKeywords.length ? match.sharedKeywords.join(', ') : 'none';
		const scorePercent = Math.round(match.overlapScore * 100);
		const riskLabel = `${match.riskLevel} risk · ${Math.round(match.riskScore)}`;
		const linkLabel = `${match.title} (#${match.issueNumber})`;
		return `- **${match.confidenceLabel}** · [${linkLabel}](${match.url}) · score ${scorePercent}% (shared keywords: ${shared}; ${riskLabel})`;
	}

	private normalizeQuestionKey(question: string): string {
		return question.trim();
	}

	private buildQuestionComment(question: string, answer: string): string {
		const lines = [
			'### IssueTriage Clarification',
			`**Question:** ${question}`,
			'',
			'**Answer:**',
			answer,
			'',
			'_Captured via IssueTriage assessment panel_.'
		];
		return lines.join('\n');
	}

	private calculateCommitLookbackIso(): string {
		const configured = this.settings.get<number>('backfill.commitWindowDays');
		const days = (typeof configured === 'number' && Number.isFinite(configured) && configured > 0)
			? configured
			: DEFAULT_COMMIT_LOOKBACK_DAYS;
		const millis = days * 24 * 60 * 60 * 1000;
		return new Date(Date.now() - millis).toISOString();
	}

	private buildPullRequestBackfillIssue(repository: string, detail: PullRequestBackfillDetail): { title: string; body: string } {
		const sanitizedTitle = detail.title?.trim() || `Pull Request #${detail.number}`;
		const shortTitle = sanitizedTitle.length > 70 ? `${sanitizedTitle.slice(0, 67)}…` : sanitizedTitle;
		const title = `Backfill: PR #${detail.number} ${shortTitle}`;
		const lines: string[] = [];
		lines.push('## Source Pull Request');
		lines.push(`- Repository: ${repository}`);
		lines.push(`- Pull Request: [#${detail.number}](${detail.url})`);
		lines.push(`- Author: ${detail.author ?? 'unknown'}`);
		lines.push(`- State: ${detail.state}`);
		lines.push(`- Created: ${this.formatIsoForBody(detail.createdAt)}`);
		lines.push(`- Updated: ${this.formatIsoForBody(detail.updatedAt)}`);
		if (detail.mergedAt) {
			lines.push(`- Merged: ${this.formatIsoForBody(detail.mergedAt)}`);
		}
		lines.push('');
		lines.push('## Summary of Changes');
		const summary = detail.bodyText?.trim() || detail.body?.trim();
		lines.push(summary && summary.length ? summary : '_No description provided._');
		lines.push('');
		lines.push('## Change Statistics');
		lines.push(`- Commits: ${detail.commits}`);
		lines.push(`- Files changed: ${detail.changedFiles}`);
		lines.push(`- Additions: ${detail.additions}`);
		lines.push(`- Deletions: ${detail.deletions}`);
		lines.push('');
		lines.push('## Key Files');
		if (detail.files.length) {
			const maxFiles = 10;
			detail.files.slice(0, maxFiles).forEach(file => {
				lines.push(`- ${file.path} (+${file.additions}/-${file.deletions})`);
			});
			if (detail.files.length > maxFiles) {
				lines.push(`- …and ${detail.files.length - maxFiles} more files`);
			}
		} else {
			lines.push('- _No file data available._');
		}
		lines.push('');
		lines.push('## Next Steps');
		lines.push('- [ ] Link this issue to risk analysis categories.');
		lines.push('- [ ] Triage outstanding tasks for this change set.');
		return { title, body: lines.join('\n') };
	}

	private buildCommitBackfillIssue(repository: string, detail: CommitBackfillDetail): { title: string; body: string } {
		const shortSha = detail.sha.slice(0, 7);
		const messageTitle = detail.message?.trim() || shortSha;
		const truncatedTitle = messageTitle.length > 70 ? `${messageTitle.slice(0, 67)}…` : messageTitle;
		const title = `Backfill: Commit ${shortSha} ${truncatedTitle}`;
		const lines: string[] = [];
		lines.push('## Source Commit');
		lines.push(`- Repository: ${repository}`);
		lines.push(`- Commit: [${detail.sha}](${detail.url})`);
		lines.push(`- Author: ${detail.author ?? 'unknown'}`);
		lines.push(`- Authored: ${this.formatIsoForBody(detail.authoredDate)}`);
		lines.push(`- Committed: ${this.formatIsoForBody(detail.committedDate)}`);
		lines.push('');
		lines.push('## Summary of Changes');
		const summary = detail.messageBody?.trim();
		lines.push(summary && summary.length ? summary : detail.message ?? '_No description provided._');
		lines.push('');
		lines.push('## Change Statistics');
		lines.push(`- Files changed: ${detail.changedFiles}`);
		lines.push(`- Additions: ${detail.additions}`);
		lines.push(`- Deletions: ${detail.deletions}`);
		lines.push('');
		lines.push('## Key Files');
		if (detail.files.length) {
			const maxFiles = 12;
			detail.files.slice(0, maxFiles).forEach(file => {
				lines.push(`- ${file.path} (+${file.additions}/-${file.deletions})`);
			});
			if (detail.files.length > maxFiles) {
				lines.push(`- …and ${detail.files.length - maxFiles} more files`);
			}
		} else {
			lines.push('- _No file data available._');
		}
		lines.push('');
		lines.push('## Next Steps');
		lines.push('- [ ] Review this commit and capture outstanding work.');
		lines.push('- [ ] Evaluate automation readiness once context is in place.');
		return { title, body: lines.join('\n') };
	}

	private formatIsoForBody(value?: string): string {
		if (!value) {
			return 'n/a';
		}
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return value;
		}
		return date.toISOString();
	}

	private setLoading(loading: boolean): void {
		this.state.loading = loading;
		this.emitState();
	}

	private setError(message: string | undefined): void {
		this.state.error = message;
		this.emitState();
	}

	private onRiskUpdate(event: RiskUpdateEvent): void {
		const selected = this.state.selectedRepository?.fullName;
		if (!selected) {
			return;
		}
		const eventSlug = this.normalizeRepositorySlug(event.repository);
		const selectedSlug = this.normalizeRepositorySlug(selected);
		if (!eventSlug || !selectedSlug || eventSlug !== selectedSlug) {
			return;
		}
		this.state.riskSummaries = {
			...this.state.riskSummaries,
			[event.issueNumber]: event.summary
		};
		this.emitState();
	}

	private emitState(): void {
		this.state.automationLaunchEnabled = this.readAutomationFlag();
		const hasSession = Boolean(this.state.session);
		const hasRepository = Boolean(this.state.selectedRepository);
		void vscode.commands.executeCommand('setContext', 'issuetriage.hasSession', hasSession);
		void vscode.commands.executeCommand('setContext', 'issuetriage.hasRepository', hasRepository);
		this.emitter.fire({
			...this.state,
			issues: [...this.state.issues],
			riskSummaries: { ...this.state.riskSummaries },
			assessmentSummaries: { ...this.state.assessmentSummaries },
			dashboardMetrics: this.state.dashboardMetrics
				? {
					...this.state.dashboardMetrics,
					readinessDistribution: { ...this.state.dashboardMetrics.readinessDistribution }
				}
				: undefined,
			unlinkedWork: {
				...this.state.unlinkedWork,
				pullRequests: [...this.state.unlinkedWork.pullRequests],
				commits: [...this.state.unlinkedWork.commits]
			},
			questionResponses: this.cloneQuestionResponses(this.state.questionResponses)
		});
	}

	private ensureFilterDefaults(filters?: FilterState): FilterState {
		return {
			...DEFAULT_FILTERS,
			...filters,
			readiness: filters?.readiness ?? DEFAULT_FILTERS.readiness,
			state: filters?.state ?? DEFAULT_FILTERS.state
		};
	}

	private readAutomationFlag(): boolean {
		return this.settings.get<boolean>('automation.launchEnabled', false) ?? false;
	}

	private handleUserFacingError(contextMessage: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.telemetry.trackEvent('issueManager.error', { message, context: contextMessage });
		vscode.window.showErrorMessage(`${contextMessage} ${message}`);
		this.setError(`${contextMessage} ${message}`);
	}

	private async detectWorkspaceRepositorySlug(): Promise<string | undefined> {
		try {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length === 0) {
				return undefined;
			}
			const gitExtension = vscode.extensions.getExtension<GitExtensionApiWrapper>('vscode.git');
			if (!gitExtension) {
				return undefined;
			}
			const gitExports: GitExtensionApiWrapper | undefined = gitExtension.isActive
				? gitExtension.exports
				: await gitExtension.activate();
			const api = gitExports?.getAPI?.(1);
			if (!api) {
				return undefined;
			}
			for (const folder of folders) {
				const repository = api.getRepository?.(folder.uri) ?? api.repositories.find(repo =>
					folder.uri.fsPath.startsWith(repo.rootUri.fsPath) || repo.rootUri.fsPath.startsWith(folder.uri.fsPath)
				);
				if (!repository) {
					continue;
				}
				const slug = this.pickRemoteSlug(repository.state.remotes);
				if (slug) {
					return this.normalizeRepositorySlug(slug);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('issueManager.workspaceRepoDetectError', { message });
		}
		return undefined;
	}

	private pickRemoteSlug(remotes: GitRemote[]): string | undefined {
		if (!remotes || remotes.length === 0) {
			return undefined;
		}
		const candidates = [...remotes];
		const originIndex = candidates.findIndex(remote => remote.name === 'origin');
		if (originIndex > 0) {
			const [origin] = candidates.splice(originIndex, 1);
			candidates.unshift(origin);
		}
		for (const remote of candidates) {
			const slug = this.extractSlugFromRemoteUrl(remote.fetchUrl) ?? this.extractSlugFromRemoteUrl(remote.pushUrl);
			if (slug) {
				return slug;
			}
		}
		return undefined;
	}

	private extractSlugFromRemoteUrl(url?: string): string | undefined {
		if (!url) {
			return undefined;
		}
		let normalized = url.trim();
		if (!normalized) {
			return undefined;
		}
		normalized = normalized.replace(/\.git$/i, '');
		normalized = normalized.replace(/\/+$/u, '');
		const hostIndex = normalized.toLowerCase().indexOf('github.com');
		if (hostIndex === -1) {
			return undefined;
		}
		const hostTerminator = hostIndex + 'github.com'.length;
		let pathPart = normalized.slice(hostTerminator);
		pathPart = pathPart.replace(/^[:/]+/, '');
		if (!pathPart) {
			return undefined;
		}
		const segments = pathPart.split('/');
		if (segments.length < 2) {
			return undefined;
		}
		const owner = segments[0];
		const repo = segments[1];
		if (!owner || !repo) {
			return undefined;
		}
		return `${owner}/${repo}`;
	}

	private findRepositoryBySlug(repositories: RepositorySummary[], slug: string | undefined): RepositorySummary | undefined {
		const normalized = this.normalizeRepositorySlug(slug);
		if (!normalized) {
			return undefined;
		}
		return repositories.find(repo => this.normalizeRepositorySlug(repo.fullName) === normalized);
	}

	private normalizeRepositorySlug(slug: string | undefined): string | undefined {
		if (!slug) {
			return undefined;
		}
		const trimmed = slug.trim();
		if (!trimmed) {
			return undefined;
		}
		return trimmed.toLowerCase();
	}
}
