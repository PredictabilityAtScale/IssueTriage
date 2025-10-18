import * as vscode from 'vscode';
import { GitHubAuthService, GitHubSessionMetadata } from './services/githubAuthService';
import { GitHubClient, IssueFilters, IssueSummary, RepositorySummary } from './services/githubClient';
import { SettingsService } from './services/settingsService';
import { StateService } from './services/stateService';
import { TelemetryService } from './services/telemetryService';

export interface FilterState extends IssueFilters {
	search?: string;
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
}

const WORKSPACE_REPOSITORY_KEY = 'issuetriage.repository.selected';
const WORKSPACE_FILTER_KEY = 'issuetriage.repository.filters';

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
		filters: {},
		automationLaunchEnabled: false
	};
	private allIssues: IssueSummary[] = [];
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly auth: GitHubAuthService,
		private readonly github: GitHubClient,
		private readonly settings: SettingsService,
		private readonly stateService: StateService,
		private readonly telemetry: TelemetryService
	) {}

	public readonly onDidChangeState = this.emitter.event;

	public async initialize(): Promise<void> {
		try {
			const session = await this.auth.getSessionMetadata();
			if (session) {
				this.state = { ...this.state, session };
			}
			const storedRepository = this.stateService.getWorkspace<RepositorySummary>(WORKSPACE_REPOSITORY_KEY);
			const storedFilters = this.stateService.getWorkspace<FilterState>(WORKSPACE_FILTER_KEY, {});
			if (storedRepository) {
				this.state.selectedRepository = storedRepository;
			}
			if (storedFilters) {
				this.state.filters = storedFilters;
			}
			this.emitState();

			if (session && storedRepository) {
				await this.refreshRepositories();
				await this.refreshIssues();
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
			await this.promptForRepository();
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
			const issues = await this.github.listIssues(fullName, filters, forceRefresh);
			this.allIssues = issues;
			this.applyFilters();
			this.state.lastUpdated = new Date().toISOString();
			this.state.error = undefined;
			this.emitState();
		} catch (error) {
			this.handleUserFacingError('Failed to load issues from GitHub.', error);
		} finally {
			this.setLoading(false);
		}
	}

	public async refreshRepositories(forceRefresh = false): Promise<void> {
		this.setLoading(true);
		try {
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
		this.state.selectedRepository = repository;
		await this.stateService.updateWorkspace(WORKSPACE_REPOSITORY_KEY, repository);
		this.emitState();
		if (refresh) {
			await this.refreshIssues(true);
		}
	}

	public async updateFilters(filters: FilterState): Promise<void> {
		this.state.filters = filters;
		await this.stateService.updateWorkspace(WORKSPACE_FILTER_KEY, filters);
		this.applyFilters();
		this.emitState();
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
			filters: {},
			automationLaunchEnabled: this.readAutomationFlag()
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
		const defaultSlug = this.settings.get<string>('github.defaultRepository');
		if (defaultSlug) {
			return repositories.find(repo => repo.fullName.toLowerCase() === defaultSlug.toLowerCase());
		}
		return repositories[0];
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

	private emitState(): void {
		this.state.automationLaunchEnabled = this.readAutomationFlag();
		this.emitter.fire({ ...this.state, issues: [...this.state.issues] });
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
}
