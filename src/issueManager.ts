import * as vscode from 'vscode';
import { GitHubAuthService, GitHubSessionMetadata } from './services/githubAuthService';
import { GitHubClient, IssueFilters, IssueSummary, RepositorySummary } from './services/githubClient';
import { AssessmentService } from './services/assessmentService';
import type { AssessmentRecord } from './services/assessmentStorage';
import { SettingsService } from './services/settingsService';
import { StateService } from './services/stateService';
import { TelemetryService } from './services/telemetryService';
import { RiskIntelligenceService, RiskUpdateEvent } from './services/riskIntelligenceService';
import type { RiskSummary } from './types/risk';

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

type AssessmentReadiness = 'ready' | 'prepare' | 'review' | 'manual';

interface IssueAssessmentSummary {
	issueNumber: number;
	compositeScore: number;
	readiness: AssessmentReadiness;
	model: string;
	updatedAt: string;
}

interface DashboardMetrics {
	totalIssuesAssessed: number;
	averageComposite?: number;
	assessmentsLastSevenDays: number;
	readinessDistribution: Record<AssessmentReadiness, number>;
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
}

const WORKSPACE_REPOSITORY_KEY = 'issuetriage.repository.selected';
const WORKSPACE_FILTER_KEY = 'issuetriage.repository.filters';
const DEFAULT_FILTERS: FilterState = {
	state: 'open',
	readiness: 'all'
};

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
		assessmentSummaries: {}
	};
	private allIssues: IssueSummary[] = [];
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly auth: GitHubAuthService,
		private readonly github: GitHubClient,
		private readonly settings: SettingsService,
		private readonly stateService: StateService,
		private readonly telemetry: TelemetryService,
		private readonly risk: RiskIntelligenceService,
		private readonly assessment: AssessmentService
		) {
		const riskSubscription = this.risk.onDidUpdate(event => this.onRiskUpdate(event));
		this.disposables.push(riskSubscription);
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
			this.state.filters = this.ensureFilterDefaults(storedFilters);
			if (!storedRepository) {
				this.workspaceRepositorySlug = await this.detectWorkspaceRepositorySlug();
			}
			this.emitState();

			if (session) {
				await this.refreshRepositories();
				if (this.state.selectedRepository) {
					await this.refreshIssues(true);
				}
			}
		} catch (error) {
			this.setError(error instanceof Error ? error.message : 'Failed to initialize Issue Manager.');
		}
	}

	public getSnapshot(): IssueManagerState {
		return { ...this.state };
	}

	public async connectRepository(): Promise<void> {
		try {
			if (!(await this.auth.hasValidSession())) {
				await this.auth.signIn();
				this.state.session = await this.auth.getSessionMetadata();
			}
			await this.refreshRepositories(true);
			if (!this.state.selectedRepository) {
				await this.promptForRepository();
			}
		} catch (error) {
			this.handleUserFacingError('Failed to connect to GitHub.', error);
		}
	}

	public async refreshIssues(forceRefresh = false): Promise<void> {
		if (!this.state.selectedRepository) {
			return;
		}

		this.setLoading(true);
		try {
			const fullName = this.state.selectedRepository.fullName;
			const filters = this.state.filters;
			const issues = await this.github.listIssues(fullName, {
				label: filters.label,
				assignee: filters.assignee,
				milestone: filters.milestone,
				state: filters.state
			}, forceRefresh);
			this.allIssues = issues;
			await this.updateAssessmentData(fullName);
			this.applyFilters();
			await this.updateRiskSummaries(fullName);
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
			dashboardMetrics: undefined
		};
		this.allIssues = [];
		await this.stateService.updateWorkspace(WORKSPACE_REPOSITORY_KEY, undefined);
		await this.stateService.updateWorkspace(WORKSPACE_FILTER_KEY, undefined);
		this.emitState();
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
			const readiness = this.toReadiness(latest.compositeScore);
			readinessDistribution[readiness] += 1;
			compositeAccumulator += latest.compositeScore;
			summaries[result.issueNumber] = {
				issueNumber: result.issueNumber,
				compositeScore: latest.compositeScore,
				readiness,
				model: latest.model,
				updatedAt: latest.createdAt
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

	private toReadiness(score: number): AssessmentReadiness {
		if (score >= 80) {
			return 'ready';
		}
		if (score >= 60) {
			return 'prepare';
		}
		if (score >= 40) {
			return 'review';
		}
		return 'manual';
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
				: undefined
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
