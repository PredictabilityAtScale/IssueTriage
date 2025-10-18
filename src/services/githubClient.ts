import { GitHubAuthService } from './githubAuthService';
import { SettingsService } from './settingsService';
import { TelemetryService } from './telemetryService';

const CACHE_TTL_MS = 60_000;

type RepoResponseItem = {
	id: number;
	name: string;
	full_name: string;
	private?: boolean;
	owner?: { login?: string };
	permissions?: {
		admin: boolean;
		push: boolean;
		pull: boolean;
	};
};

type IssueResponseItem = {
	number: number;
	title: string;
	html_url: string;
	labels?: Array<string | { name?: string }>;
	assignees?: Array<{ login?: string } | null>;
	milestone?: { title?: string } | null;
	updated_at: string;
	pull_request?: unknown;
};

export interface RepositorySummary {
	id: number;
	name: string;
	owner: string;
	fullName: string;
	private: boolean;
	permissions?: {
		admin: boolean;
		push: boolean;
		pull: boolean;
	};
}

export interface IssueSummary {
	number: number;
	title: string;
	url: string;
	labels: string[];
	assignees: string[];
	milestone?: string;
	updatedAt: string;
}

export interface IssueFilters {
	label?: string;
	assignee?: string;
	milestone?: string;
	search?: string;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

export class GitHubClient {
	private readonly repoCache = new Map<string, CacheEntry<RepositorySummary[]>>();
	private readonly issueCache = new Map<string, CacheEntry<IssueSummary[]>>();

	constructor(
		private readonly auth: GitHubAuthService,
		private readonly settings: SettingsService,
		private readonly telemetry: TelemetryService
	) {}

	public async listRepositories(forceRefresh = false): Promise<RepositorySummary[]> {
		const cacheKey = 'default';
		if (!forceRefresh) {
			const cached = this.getFromCache(this.repoCache, cacheKey);
			if (cached) {
				return cached;
			}
		}

		const token = await this.requireToken();
		const client = await this.createClient(token);

		try {
			const orgFilter = this.settings.get<string>('github.orgFilter');
			const repos = await client.paginate('GET /user/repos', {
				per_page: 100,
				sort: 'updated',
				direction: 'desc'
			}) as RepoResponseItem[];
			const normalized = repos
				.filter((repo: RepoResponseItem) => !orgFilter || repo.owner?.login === orgFilter)
				.map((repo: RepoResponseItem) => ({
					id: repo.id,
					name: repo.name,
					owner: repo.owner?.login ?? 'unknown',
					fullName: repo.full_name,
					private: repo.private ?? false,
					permissions: repo.permissions as RepositorySummary['permissions']
				}));
			this.storeInCache(this.repoCache, cacheKey, normalized);
			return normalized;
		} catch (error) {
			this.handleError('github.repos.failed', error);
			throw error;
		}
	}

	public async listIssues(fullName: string, filters: IssueFilters = {}, forceRefresh = false): Promise<IssueSummary[]> {
		const cacheKey = `${fullName}:${JSON.stringify(filters)}`;
		if (!forceRefresh) {
			const cached = this.getFromCache(this.issueCache, cacheKey);
			if (cached) {
				return cached;
			}
		}

		const token = await this.requireToken();
		const client = await this.createClient(token);
		const [owner, repo] = fullName.split('/');
		if (!owner || !repo) {
			throw new Error(`Invalid repository name: ${fullName}`);
		}

		try {
			const params: Record<string, string | number | undefined> = {
				owner,
				repo,
				per_page: 50,
				state: 'open',
				labels: filters.label || undefined,
				assignee: filters.assignee || undefined,
				milestone: filters.milestone || undefined
			};

			const issuesResponse = await client.paginate('GET /repos/{owner}/{repo}/issues', params) as IssueResponseItem[];
			const filteredIssues = issuesResponse.filter(issue => !issue.pull_request);
			let normalized: IssueSummary[] = filteredIssues.map((issue: IssueResponseItem) => ({
				number: issue.number,
				title: issue.title,
				url: issue.html_url,
				labels: issue.labels?.map((label: string | { name?: string }) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean) ?? [],
				assignees: issue.assignees?.map((assignee: { login?: string } | null) => assignee?.login ?? '').filter(Boolean) ?? [],
				milestone: issue.milestone?.title,
				updatedAt: issue.updated_at
			}));

			if (filters.search) {
				const searchLower = filters.search.toLowerCase();
				normalized = normalized.filter(issue => issue.title.toLowerCase().includes(searchLower));
			}

			this.storeInCache(this.issueCache, cacheKey, normalized);
			return normalized;
		} catch (error) {
			this.handleError('github.issues.failed', error);
			throw error;
		}
	}

	public clearCaches(): void {
		this.repoCache.clear();
		this.issueCache.clear();
	}

	private async requireToken(): Promise<string> {
		const token = await this.auth.getAccessToken();
		if (!token) {
			throw new Error('GitHub authentication required. Run the \"Issue Triage: Connect Repository\" command.');
		}
		return token;
	}

	private getFromCache<T>(store: Map<string, CacheEntry<T>>, key: string): T | undefined {
		const entry = store.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiresAt < Date.now()) {
			store.delete(key);
			return undefined;
		}
		return entry.value;
	}

	private storeInCache<T>(store: Map<string, CacheEntry<T>>, key: string, value: T): void {
		store.set(key, {
			value,
			expiresAt: Date.now() + CACHE_TTL_MS
		});
	}

	private async createClient(token: string): Promise<any> {
		const [{ Octokit }, { paginateRest }] = await Promise.all([
			import('@octokit/core'),
			import('@octokit/plugin-paginate-rest')
		]);
		const OctokitWithPlugins = (Octokit as any).plugin(paginateRest);
		return new OctokitWithPlugins({ auth: token });
	}

	private handleError(eventName: string, error: unknown): void {
		const requestError = error as { status?: number; message?: string };
		const info: Record<string, string> = {
			message: requestError?.message ?? (error instanceof Error ? error.message : 'Unknown error')
		};
		if (typeof requestError?.status === 'number') {
			info.status = String(requestError.status);
		}
		this.telemetry.trackEvent(eventName, info);
	}
}
