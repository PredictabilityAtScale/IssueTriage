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
	state?: string;
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
	created_at?: string;
	updated_at?: string;
	html_url?: string;
};

type IssueEventResponse = {
	event?: string;
	created_at?: string;
	actor?: { login?: string | null } | null;
	commit_id?: string | null;
	commit_url?: string | null;
	source?: {
		type?: string;
		issue?: {
			number?: number;
			pull_request?: {
				html_url?: string;
				url?: string;
			};
		};
		commit?: {
			sha?: string;
			url?: string;
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
	state: 'open' | 'closed';
}

export interface IssueComment {
	id: number;
	body: string;
	author: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
}

export interface IssueDetail extends IssueSummary {
	repository: string;
	body: string;
	author: string;
	createdAt?: string;
	comments: IssueComment[];
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

export interface CommitRiskData {
	sha: string;
	message: string;
	url: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	author?: string;
	authoredDate?: string;
	committedDate?: string;
}

export interface IssueRiskSnapshot {
	issueNumber: number;
	pullRequests: PullRequestRiskData[];
	commits: CommitRiskData[];
}

export interface UnlinkedPullRequest {
	number: number;
	title: string;
	url: string;
	state: 'open' | 'closed' | 'merged';
	author?: string;
	createdAt?: string;
	updatedAt?: string;
	mergedAt?: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	commits: number;
	headRefName?: string;
	baseRefName?: string;
}

export interface UnlinkedCommit {
	sha: string;
	message: string;
	url: string;
	author?: string;
	authoredDate?: string;
	committedDate?: string;
	additions: number;
	deletions: number;
	changedFiles: number;
}

export interface PullRequestBackfillDetail extends UnlinkedPullRequest {
	body?: string;
	bodyText?: string;
	files: Array<{
		path: string;
		additions: number;
		deletions: number;
	}>;
}

export interface CommitBackfillDetail extends UnlinkedCommit {
	messageBody?: string;
	files: Array<{
		path: string;
		additions: number;
		deletions: number;
	}>;
}

export interface IssueFilters {
	label?: string;
	assignee?: string;
	milestone?: string;
	search?: string;
	state?: 'open' | 'closed' | 'all';
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

export class GitHubClient {
	private readonly repoCache = new Map<string, CacheEntry<RepositorySummary[]>>();
	private readonly issueCache = new Map<string, CacheEntry<IssueSummary[]>>();
	private readonly pullRequestRiskCache = new Map<string, CacheEntry<PullRequestRiskData>>();
	private readonly commitRiskCache = new Map<string, CacheEntry<CommitRiskData>>();
	private readonly issueRiskCache = new Map<string, CacheEntry<IssueRiskSnapshot>>();
	private readonly unlinkedPullRequestCache = new Map<string, CacheEntry<UnlinkedPullRequest[]>>();
	private readonly unlinkedCommitCache = new Map<string, CacheEntry<UnlinkedCommit[]>>();

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
				state: filters.state || 'open',
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
				updatedAt: issue.updated_at,
				state: issue.state as 'open' | 'closed' || 'open'
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
			const [issueResponse, commentsResponse] = await Promise.all([
				client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
					owner,
					repo,
					issue_number: issueNumber
				}),
				client.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
					owner,
					repo,
					issue_number: issueNumber,
					per_page: 100
				})
			]);
			const data = issueResponse.data as IssueDetailResponse;
			const issueComments = Array.isArray(commentsResponse)
				? (commentsResponse as CommentResponse[])
				: [];
			const comments: IssueComment[] = issueComments.map(comment => ({
				id: comment.id,
				body: typeof comment.body === 'string' ? comment.body : '',
				author: comment.user?.login ?? 'unknown',
				createdAt: comment.created_at ?? undefined,
				updatedAt: comment.updated_at ?? undefined,
				url: comment.html_url ?? undefined
			}));
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
				author: data.user?.login ?? 'unknown',
				state: (data.state as 'open' | 'closed') || 'open',
				comments
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
		this.commitRiskCache.clear();
		this.issueRiskCache.clear();
		this.unlinkedPullRequestCache.clear();
		this.unlinkedCommitCache.clear();
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
		const commitShas = new Set<string>();
		for (const event of events) {
			const prNumber = this.extractPullRequestNumber(event);
			if (prNumber) {
				pullNumbers.add(prNumber);
			}
			const commitSha = this.extractCommitSha(event);
			if (commitSha) {
				commitShas.add(commitSha);
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

		const commits: CommitRiskData[] = [];
		if (pullNumbers.size === 0) {
			const comments = await client.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
				owner,
				repo,
				issue_number: issueNumber,
				per_page: 100
			}) as CommentResponse[];
			for (const comment of comments) {
				const commentShas = this.extractCommitShasFromBody(comment?.body, owner, repo);
				for (const sha of commentShas) {
					commitShas.add(sha);
				}
			}
			const commitLimit = 30;
			let processedCommits = 0;
			for (const sha of commitShas) {
				if (processedCommits >= commitLimit) {
					break;
				}
				const commit = await this.fetchCommitRiskData(client, owner, repo, sha);
				if (commit) {
					commits.push(commit);
				}
				processedCommits += 1;
			}
		}

		const snapshot: IssueRiskSnapshot = {
			issueNumber,
			pullRequests,
			commits
		};
		this.storeInCache(this.issueRiskCache, cacheKey, snapshot);
		return snapshot;
	}

	public async listUnlinkedPullRequests(
		fullName: string,
		options: { state?: 'open' | 'closed' | 'all'; limit?: number } = {},
		forceRefresh = false
	): Promise<UnlinkedPullRequest[]> {
		const normalizedLimit = Math.min(Math.max(options.limit ?? 20, 1), 100);
		const cacheKey = `${fullName}:${options.state ?? 'open'}:${normalizedLimit}`;
		if (!forceRefresh) {
			const cached = this.getFromCache(this.unlinkedPullRequestCache, cacheKey);
			if (cached) {
				return cached;
			}
		}

		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		const states = this.toGraphqlPullRequestStates(options.state);
		const candidates: any[] = [];
		let cursor: string | undefined;
		let hasNextPage = true;
		let safetyCounter = 0;

		while (hasNextPage && candidates.length < normalizedLimit * 3 && safetyCounter < 6) {
			safetyCounter += 1;
			const pageSize = Math.min(50, Math.max(10, normalizedLimit * 2));
			try {
				const response = await client.graphql(
					`query($owner: String!, $repo: String!, $first: Int!, $after: String, $states: [PullRequestState!]) {
						repository(owner: $owner, name: $repo) {
							pullRequests(first: $first, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
								pageInfo {
									hasNextPage
									endCursor
								}
								nodes {
									number
									title
									url
									state
									headRefName
									baseRefName
									bodyText
									body
									author { login }
									createdAt
									updatedAt
									mergedAt
									additions
									deletions
									changedFiles
									commits {
										totalCount
									}
									closingIssuesReferences(first: 1) {
										totalCount
									}
								}
							}
						}
					}
				`,
					{ owner, repo, first: pageSize, after: cursor, states }
				);
				const connection = response?.repository?.pullRequests;
				const nodes: any[] = connection?.nodes ?? [];
				nodes.forEach(node => {
					if (!node) {
						return;
					}
					const hasClosingReferences = (node.closingIssuesReferences?.totalCount ?? 0) > 0;
					if (hasClosingReferences) {
						return;
					}
					if (this.pullRequestBodyHasIssueReference(fullName, node.bodyText ?? node.body ?? '')) {
						return;
					}
					candidates.push(node);
				});
				hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
				cursor = connection?.pageInfo?.endCursor ?? undefined;
			} catch (error) {
				this.handleError('github.pull.unlinkedListFailed', error);
				throw error;
			}
		}

		const results: UnlinkedPullRequest[] = [];
		for (const node of candidates) {
			if (!node) {
				continue;
			}
			const linked = await this.pullRequestHasLinkedIssues(client, owner, repo, node.number).catch(() => false);
			if (linked) {
				continue;
			}
			results.push(this.normalizeUnlinkedPullRequestNode(node));
			if (results.length >= normalizedLimit) {
				break;
			}
		}

		this.storeInCache(this.unlinkedPullRequestCache, cacheKey, results);
		return results;
	}

	public async listCommitsWithoutPullRequests(
		fullName: string,
		options: { limit?: number; since?: string } = {},
		forceRefresh = false
	): Promise<UnlinkedCommit[]> {
		const normalizedLimit = Math.min(Math.max(options.limit ?? 20, 1), 200);
		const cacheKey = `${fullName}:${options.since ?? 'none'}:${normalizedLimit}`;
		if (!forceRefresh) {
			const cached = this.getFromCache(this.unlinkedCommitCache, cacheKey);
			if (cached) {
				return cached;
			}
		}

		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		const historySize = Math.min(normalizedLimit * 3, 200);

		let historyNodes: any[] = [];
		try {
			const response = await client.graphql(
				`query($owner: String!, $repo: String!, $first: Int!, $since: GitTimestamp) {
					repository(owner: $owner, name: $repo) {
						defaultBranchRef {
							target {
								... on Commit {
									history(first: $first, since: $since) {
										nodes {
											oid
											messageHeadline
											messageBody
											authoredDate
											committedDate
											url
											additions
											deletions
											changedFiles
											author { user { login } name }
											associatedPullRequests(first: 1) {
												totalCount
											}
										}
									}
								}
							}
						}
					}
				}
			`,
				{ owner, repo, first: historySize, since: options.since ?? null }
			);
			historyNodes = response?.repository?.defaultBranchRef?.target?.history?.nodes ?? [];
		} catch (error) {
			this.handleError('github.commit.unlinkedListFailed', error);
			throw error;
		}

		const commits: UnlinkedCommit[] = [];
		for (const node of historyNodes) {
			if (!node) {
				continue;
			}
			const associatedCount = node.associatedPullRequests?.totalCount ?? 0;
			if (associatedCount > 0) {
				continue;
			}
			commits.push(this.normalizeUnlinkedCommitNode(node, fullName));
			if (commits.length >= normalizedLimit) {
				break;
			}
		}

		this.storeInCache(this.unlinkedCommitCache, cacheKey, commits);
		return commits;
	}

	public async getPullRequestBackfillDetail(fullName: string, pullNumber: number): Promise<PullRequestBackfillDetail> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		try {
			const response = await client.graphql(
				`query($owner: String!, $repo: String!, $number: Int!) {
					repository(owner: $owner, name: $repo) {
						pullRequest(number: $number) {
							number
							title
							url
							state
							body
							bodyText
							headRefName
							baseRefName
							author { login }
							createdAt
							updatedAt
							mergedAt
							additions
							deletions
							changedFiles
							commits { totalCount }
							files(first: 100) {
								nodes {
									path
									additions
									deletions
								}
							}
						}
					}
				}
			`,
				{ owner, repo, number: pullNumber }
			);
			const node = response?.repository?.pullRequest;
			if (!node) {
				throw new Error(`Pull request #${pullNumber} not found in ${fullName}.`);
			}
			return {
				...this.normalizeUnlinkedPullRequestNode(node),
				body: node.body ?? undefined,
				bodyText: node.bodyText ?? undefined,
				files: (node.files?.nodes ?? []).map((file: any) => ({
					path: file?.path ?? 'unknown',
					additions: file?.additions ?? 0,
					deletions: file?.deletions ?? 0
				}))
			};
		} catch (error) {
			this.handleError('github.pull.backfillDetailFailed', error);
			throw error;
		}
	}

	public async getCommitBackfillDetail(fullName: string, sha: string): Promise<CommitBackfillDetail> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		try {
			const response = await client.request('GET /repos/{owner}/{repo}/commits/{ref}', {
				owner,
				repo,
				ref: sha
			});
			const data = response.data as any;
			const summary: CommitBackfillDetail = {
				sha: data.sha,
				message: data.commit?.message?.split('\n')[0] ?? data.commit?.message ?? sha,
				url: data.html_url,
				author: data.author?.login ?? data.commit?.author?.name ?? undefined,
				authoredDate: data.commit?.author?.date,
				committedDate: data.commit?.committer?.date,
				additions: data.stats?.additions ?? 0,
				deletions: data.stats?.deletions ?? 0,
				changedFiles: data.files ? data.files.length : 0,
				messageBody: data.commit?.message ?? undefined,
				files: (data.files ?? []).map((file: any) => ({
					path: file?.filename ?? 'unknown',
					additions: file?.additions ?? 0,
					deletions: file?.deletions ?? 0
				}))
			};
			return summary;
		} catch (error) {
			this.handleError('github.commit.backfillDetailFailed', error);
			throw error;
		}
	}

	public async linkPullRequestToIssue(fullName: string, pullNumber: number, issueNumber: number): Promise<void> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		try {
			const response = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
				owner,
				repo,
				pull_number: pullNumber
			});
			const data = response.data as { body?: string };
			const reference = `#${issueNumber}`;
			const existingBody = (data.body ?? '').trimEnd();
			if (existingBody.includes(reference)) {
				return;
			}
			const separator = existingBody.length ? '\n\n' : '';
			const updatedBody = `${existingBody}${separator}Linked to ${reference}`;
			await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
				owner,
				repo,
				issue_number: pullNumber,
				body: updatedBody
			});
		} catch (error) {
			this.handleError('github.pull.linkFailed', error);
			throw error;
		}
	}

	public async linkCommitToIssue(fullName: string, sha: string, issueNumber: number): Promise<void> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		const commitUrl = `https://github.com/${owner}/${repo}/commit/${sha}`;
		const body = `Linking commit ${sha.slice(0, 7)} to this issue for backfill context.\n\n${commitUrl}`;
		try {
			await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
				owner,
				repo,
				issue_number: issueNumber,
				body
			});
		} catch (error) {
			this.handleError('github.commit.linkFailed', error);
			throw error;
		}
	}

	public async createIssue(fullName: string, input: { title: string; body: string; labels?: string[]; assignees?: string[] }): Promise<number> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		try {
			const response = await client.request('POST /repos/{owner}/{repo}/issues', {
				owner,
				repo,
				title: input.title,
				body: input.body,
				labels: input.labels,
				assignees: input.assignees
			});
			return (response.data as { number?: number }).number ?? 0;
		} catch (error) {
			this.handleError('github.issue.createFailed', error);
			throw error;
		}
	}

	public async updateIssueState(fullName: string, issueNumber: number, state: 'open' | 'closed'): Promise<void> {
		const token = await this.requireToken();
		const client = await this.createClient(token);
		const { owner, repo } = this.parseRepository(fullName);
		try {
			await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
				owner,
				repo,
				issue_number: issueNumber,
				state
			});
			this.issueCache.clear();
		} catch (error) {
			this.handleError('github.issue.updateStateFailed', error);
			throw error;
		}
	}

	private toGraphqlPullRequestStates(state?: 'open' | 'closed' | 'all'): string[] {
		switch (state) {
			case 'all':
				return ['OPEN', 'MERGED', 'CLOSED'];
			case 'closed':
				return ['CLOSED', 'MERGED'];
			default:
				return ['OPEN'];
		}
	}

	private normalizePullRequestState(value: string | undefined): 'open' | 'closed' | 'merged' {
		switch ((value ?? '').toUpperCase()) {
			case 'MERGED':
				return 'merged';
			case 'CLOSED':
				return 'closed';
			default:
				return 'open';
		}
	}

	private pullRequestBodyHasIssueReference(fullName: string, body: string): boolean {
		if (!body) {
			return false;
		}
		const [owner, repo] = fullName.toLowerCase().split('/');
		if (!owner || !repo) {
			return false;
		}
		const normalizedBody = body.toLowerCase();
		const crossRepoPattern = /([a-z0-9_.-]+\/[a-z0-9_.-]+)#(\d+)/gi;
		let crossMatch: RegExpExecArray | null;
		const seenIssues = new Set<number>();
		while ((crossMatch = crossRepoPattern.exec(normalizedBody))) {
			const targetRepo = crossMatch[1];
			const issue = Number.parseInt(crossMatch[2], 10);
			if (!Number.isFinite(issue)) {
				continue;
			}
			if (targetRepo === `${owner}/${repo}`) {
				seenIssues.add(issue);
			}
		}
		if (seenIssues.size > 0) {
			return true;
		}
		const localPattern = /#(\d+)/g;
		let localMatch: RegExpExecArray | null;
		while ((localMatch = localPattern.exec(normalizedBody))) {
			const issue = Number.parseInt(localMatch[1], 10);
			if (Number.isFinite(issue)) {
				return true;
			}
		}
		return false;
	}

	private async pullRequestHasLinkedIssues(client: any, owner: string, repo: string, pullNumber: number): Promise<boolean> {
		try {
			const events = await client.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/events', {
				owner,
				repo,
				issue_number: pullNumber,
				per_page: 100
			}) as IssueEventResponse[];
			return events.some(event => this.isLinkedIssueEvent(event));
		} catch (error) {
			this.handleError('github.pull.linkCheckFailed', error);
			return false;
		}
	}

	private isLinkedIssueEvent(event: IssueEventResponse | undefined): boolean {
		if (!event) {
			return false;
		}
		if (event.event === 'connected') {
			return true;
		}
		if (event.event === 'cross-referenced') {
			const issue = event.source?.issue;
			if (issue && typeof issue.number === 'number') {
				return true;
			}
		}
		return false;
	}

	private extractCommitShasFromBody(body: string | undefined, owner: string, repo: string): string[] {
		if (!body) {
			return [];
		}
		const pattern = new RegExp(`https://github\\.com/${this.escapeForRegex(owner)}/${this.escapeForRegex(repo)}/commit/([0-9a-f]{7,40})`, 'ig');
		const shas = new Set<string>();
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(body))) {
			const sha = match[1]?.trim();
			if (sha) {
				shas.add(sha);
			}
		}
		return Array.from(shas);
	}

	private escapeForRegex(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private normalizeUnlinkedPullRequestNode(node: any): UnlinkedPullRequest {
		const prNumber = typeof node.number === 'number'
			? node.number
			: Number.parseInt(String(node.number ?? '0'), 10) || 0;
		return {
			number: prNumber,
			title: node.title ?? `Pull Request #${node.number}`,
			url: node.url ?? '',
			state: this.normalizePullRequestState(node.state),
			author: node.author?.login ?? undefined,
			createdAt: node.createdAt ?? undefined,
			updatedAt: node.updatedAt ?? undefined,
			mergedAt: node.mergedAt ?? undefined,
			additions: node.additions ?? 0,
			deletions: node.deletions ?? 0,
			changedFiles: node.changedFiles ?? 0,
			commits: node.commits?.totalCount ?? 0,
			headRefName: node.headRefName ?? undefined,
			baseRefName: node.baseRefName ?? undefined
		};
	}

	private normalizeUnlinkedCommitNode(node: any, fullName: string): UnlinkedCommit {
		const sha: string = node.oid ?? '';
		const defaultUrl = sha ? `https://github.com/${fullName}/commit/${sha}` : '';
		return {
			sha,
			message: node.messageHeadline ?? (node.messageBody ? String(node.messageBody).split('\n')[0] : sha),
			url: node.url ?? defaultUrl,
			author: node.author?.user?.login ?? node.author?.name ?? undefined,
			authoredDate: node.authoredDate ?? undefined,
			committedDate: node.committedDate ?? undefined,
			additions: node.additions ?? 0,
			deletions: node.deletions ?? 0,
			changedFiles: node.changedFiles ?? 0
		};
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

	private extractCommitSha(event: IssueEventResponse): string | undefined {
		const directSha = typeof event?.commit_id === 'string' && event.commit_id.length >= 7
			? event.commit_id
			: undefined;
		if (directSha) {
			return directSha;
		}
		const sourceType = event?.source?.type?.toLowerCase();
		if (sourceType === 'commit') {
			const sourceSha = event?.source?.commit?.sha;
			if (typeof sourceSha === 'string' && sourceSha.length >= 7) {
				return sourceSha;
			}
			const rawSourceUrl = event?.source?.commit?.url ?? event.commit_url ?? undefined;
			const sourceUrl = typeof rawSourceUrl === 'string' ? rawSourceUrl : undefined;
			const fromUrl = this.extractShaFromUrl(sourceUrl);
			if (fromUrl) {
				return fromUrl;
			}
		}
		const fallbackUrl = typeof event?.commit_url === 'string' ? event.commit_url : undefined;
		return this.extractShaFromUrl(fallbackUrl);
	}

	private extractShaFromUrl(url: string | undefined): string | undefined {
		if (!url) {
			return undefined;
		}
		const match = /commit\/([0-9a-f]{7,40})/i.exec(url);
		return match ? match[1] : undefined;
	}

	private async fetchCommitRiskData(client: any, owner: string, repo: string, sha: string): Promise<CommitRiskData | undefined> {
		const cacheKey = `${owner}/${repo}@${sha}`;
		const cached = this.getFromCache(this.commitRiskCache, cacheKey);
		if (cached) {
			return cached;
		}

		try {
			const response = await client.request('GET /repos/{owner}/{repo}/commits/{ref}', {
				owner,
				repo,
				ref: sha
			});
			const data = response.data as any;
			const record: CommitRiskData = {
				sha: data.sha ?? sha,
				message: data.commit?.message?.split('\n')[0] ?? data.commit?.message ?? sha,
				url: data.html_url ?? `https://github.com/${owner}/${repo}/commit/${sha}`,
				additions: data.stats?.additions ?? 0,
				deletions: data.stats?.deletions ?? 0,
				changedFiles: Array.isArray(data.files) ? data.files.length : 0,
				author: data.author?.login ?? data.commit?.author?.name ?? undefined,
				authoredDate: data.commit?.author?.date ?? undefined,
				committedDate: data.commit?.committer?.date ?? undefined
			};
			if (!record.changedFiles && typeof data.stats?.total === 'number') {
				record.changedFiles = data.stats.total;
			}
			this.storeInCache(this.commitRiskCache, cacheKey, record);
			return record;
		} catch (error) {
			this.handleError('github.commit.fetchFailed', error);
			return undefined;
		}
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
