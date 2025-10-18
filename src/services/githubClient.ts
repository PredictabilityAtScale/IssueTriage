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

type IssueDetailResponse = IssueResponseItem & {
	body?: string | null;
	user?: { login?: string | null } | null;
	created_at?: string;
};

type CommentResponse = {
	id: number;
	body: string;
	user?: { login?: string | null } | null;
};

type IssueEventResponse = {
	event?: string;
	created_at?: string;
	source?: {
		type?: string;
		issue?: {
			number?: number;
			pull_request?: {
				html_url?: string;
				url?: string;
			};
		};
	};
};

type PullRequestResponse = {
	number: number;
	title: string;
	html_url: string;
	state: 'open' | 'closed';
	merged_at?: string | null;
	additions?: number;
	deletions?: number;
	changed_files?: number;
	review_comments?: number;
	comments?: number;
	commits?: number;
	created_at?: string;
	updated_at?: string;
};

type PullRequestReviewResponse = {
	id: number;
	state?: string;
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

export interface IssueDetail extends IssueSummary {
	repository: string;
	body: string;
	author: string;
	createdAt?: string;
}

export interface PullRequestRiskData {
	number: number;
	title: string;
	url: string;
	state: 'open' | 'closed';
	mergedAt?: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	commits: number;
	reviewComments: number;
	comments: number;
	reviewStates: Record<string, number>;
	createdAt?: string;
	updatedAt?: string;
}

export interface IssueRiskSnapshot {
	issueNumber: number;
	pullRequests: PullRequestRiskData[];
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
	private readonly pullRequestRiskCache = new Map<string, CacheEntry<PullRequestRiskData>>();
	private readonly issueRiskCache = new Map<string, CacheEntry<IssueRiskSnapshot>>();

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
		const { owner, repo } = this.parseRepository(fullName);

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

	public async getIssueDetails(fullName: string, issueNumber: number): Promise<IssueDetail> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		try {
			const response = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
				owner,
				repo,
				issue_number: issueNumber
			});
			const data = response.data as IssueDetailResponse;
			return {
				repository: fullName,
				number: data.number,
				title: data.title,
				url: data.html_url,
				labels: data.labels?.map((label: string | { name?: string }) => (typeof label === 'string' ? label : label?.name ?? '')).filter(Boolean) ?? [],
				assignees: data.assignees?.map((assignee: { login?: string } | null) => assignee?.login ?? '').filter(Boolean) ?? [],
				milestone: data.milestone?.title,
				updatedAt: data.updated_at,
				createdAt: data.created_at,
				body: (data.body ?? '').trim(),
				author: data.user?.login ?? 'unknown'
			};
		} catch (error) {
			this.handleError('github.issue.detail.failed', error);
			throw error;
		}
	}

	public async upsertIssueComment(fullName: string, issueNumber: number, body: string, commentId?: number): Promise<number | undefined> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		if (commentId) {
			try {
				await client.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
					owner,
					repo,
					comment_id: commentId,
					body
				});
				return commentId;
			} catch (error) {
				const status = (error as { status?: number })?.status;
				if (status && status !== 404) {
					this.handleError('github.issue.comment.updateFailed', error);
					throw error;
				}
			}
		}

		try {
			const response = await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
				owner,
				repo,
				issue_number: issueNumber,
				body
			});
			const data = response.data as CommentResponse;
			return data.id;
		} catch (error) {
			this.handleError('github.issue.comment.createFailed', error);
			throw error;
		}
	}

	public clearCaches(): void {
		this.repoCache.clear();
		this.issueCache.clear();
		this.pullRequestRiskCache.clear();
		this.issueRiskCache.clear();
	}

	public async getIssueRiskSnapshot(fullName: string, issueNumber: number): Promise<IssueRiskSnapshot> {
		const cacheKey = `risk:${fullName}:${issueNumber}`;
		const cached = this.getFromCache(this.issueRiskCache, cacheKey);
		if (cached) {
			return cached;
		}

		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);

		const events = await client.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/events', {
			owner,
			repo,
			issue_number: issueNumber,
			per_page: 100
		}) as IssueEventResponse[];

		const pullNumbers = new Set<number>();
		for (const event of events) {
			const prNumber = this.extractPullRequestNumber(event);
			if (prNumber) {
				pullNumbers.add(prNumber);
			}
		}

		const pullRequests: PullRequestRiskData[] = [];
		for (const prNumber of pullNumbers) {
			try {
				const data = await this.fetchPullRequestRiskData(client, owner, repo, prNumber);
				if (data) {
					pullRequests.push(data);
				}
			} catch (error) {
				this.handleError('github.pull.riskFetchFailed', error);
			}
		}

		const snapshot: IssueRiskSnapshot = {
			issueNumber,
			pullRequests
		};
		this.storeInCache(this.issueRiskCache, cacheKey, snapshot);
		return snapshot;
	}

	private extractPullRequestNumber(event: IssueEventResponse): number | undefined {
		if (event?.source?.issue?.pull_request && typeof event.source.issue.number === 'number') {
			return event.source.issue.number;
		}
		if (event?.source?.type === 'pull_request' && typeof event?.source?.issue?.number === 'number') {
			return event.source.issue.number;
		}
		return undefined;
	}

	private async fetchPullRequestRiskData(client: any, owner: string, repo: string, pullNumber: number): Promise<PullRequestRiskData | undefined> {
		const cacheKey = `${owner}/${repo}#${pullNumber}`;
		const cached = this.getFromCache(this.pullRequestRiskCache, cacheKey);
		if (cached) {
			return cached;
		}

		try {
			const response = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
				owner,
				repo,
				pull_number: pullNumber
			});
			const data = response.data as PullRequestResponse;
			const reviewStates = await this.fetchReviewStates(client, owner, repo, pullNumber);
			const record: PullRequestRiskData = {
				number: data.number,
				title: data.title,
				url: data.html_url,
				state: data.state,
				mergedAt: data.merged_at ?? undefined,
				additions: data.additions ?? 0,
				deletions: data.deletions ?? 0,
				changedFiles: data.changed_files ?? 0,
				commits: data.commits ?? 0,
				reviewComments: data.review_comments ?? 0,
				comments: data.comments ?? 0,
				reviewStates,
				createdAt: data.created_at ?? undefined,
				updatedAt: data.updated_at ?? undefined
			};
			this.storeInCache(this.pullRequestRiskCache, cacheKey, record);
			return record;
		} catch (error) {
			this.handleError('github.pull.fetchFailed', error);
			return undefined;
		}
	}

	private async fetchReviewStates(client: any, owner: string, repo: string, pullNumber: number): Promise<Record<string, number>> {
		try {
			const reviews = await client.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
				owner,
				repo,
				pull_number: pullNumber,
				per_page: 100
			}) as PullRequestReviewResponse[];
			return reviews.reduce<Record<string, number>>((acc, review) => {
				const state = (review.state ?? '').toUpperCase();
				if (!state) {
					return acc;
				}
				acc[state] = (acc[state] ?? 0) + 1;
				return acc;
			}, {});
		} catch (error) {
			this.handleError('github.pull.reviewsFailed', error);
			return {};
		}
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

	private parseRepository(fullName: string): { owner: string; repo: string } {
		const [owner, repo] = fullName.split('/');
		if (!owner || !repo) {
			throw new Error(`Invalid repository name: ${fullName}`);
		}
		return { owner, repo };
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
