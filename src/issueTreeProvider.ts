import * as vscode from 'vscode';
import type { IssueManager } from './issueManager';
import type { IssueSummary } from './services/githubClient';
import type { AssessmentService } from './services/assessmentService';

interface ReadinessDistribution {
	ready: number;
	prepare: number;
	review: number;
	manual: number;
}

export class IssueTreeProvider implements vscode.TreeDataProvider<TreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private activeFilter: string | undefined;

	constructor(
		private issueManager: IssueManager,
		private assessmentService: AssessmentService
	) {
		// Listen for state changes and refresh the tree
		this.issueManager.onDidChangeState(() => {
			this.refresh();
		});
	}

	setFilter(readinessCategory?: string | null): string | undefined {
		const normalized = typeof readinessCategory === 'string' && readinessCategory.length > 0
			? readinessCategory.toLowerCase()
			: undefined;
		this.activeFilter = this.activeFilter === normalized ? undefined : normalized;
		this.refresh();
		return this.activeFilter;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TreeItem): Promise<TreeItem[]> {
		if (!element) {
			// Root level - show repository, stats, and issue groups
			const snapshot = this.issueManager.getSnapshot();
			if (snapshot.loading && (!snapshot.selectedRepository || !snapshot.repositories.length)) {
				const loadingItem = new TreeItem('Loading Issue Triage…', vscode.TreeItemCollapsibleState.None, 'info');
				loadingItem.iconPath = new vscode.ThemeIcon('sync~spin');
				loadingItem.tooltip = 'Issue Triage is connecting and loading repository data.';
				return [loadingItem];
			}
			
			if (!snapshot.selectedRepository) {
				return [
					new TreeItem('No repository connected', vscode.TreeItemCollapsibleState.None, 'info'),
					new TreeItem('Click to connect', vscode.TreeItemCollapsibleState.None, 'action', {
						command: 'issuetriage.connectRepository',
						title: 'Connect Repository'
					})
				];
			}

			const items: TreeItem[] = [];
			
			// Repository selector (shows as expandable to trigger command)
			const repoItem = new TreeItem(
				snapshot.selectedRepository.fullName,
				vscode.TreeItemCollapsibleState.None,
				'repository',
				{
					command: 'issuetriage.changeRepository',
					title: 'Change Repository'
				},
				`Click to change repository`
			);
			repoItem.iconPath = new vscode.ThemeIcon('repo');
			items.push(repoItem);

			// ALWAYS filter to show only open issues in the sidebar, regardless of main panel state
			const openIssues = this.issueManager.getCachedOpenIssues();

			if (openIssues.length === 0) {
				items.push(new TreeItem('No open issues found', vscode.TreeItemCollapsibleState.None, 'info'));
				return items;
			}

			// Calculate readiness distribution for open issues only
			const distribution = await this.calculateReadinessDistribution(openIssues, snapshot.selectedRepository.fullName);
			const total = openIssues.length;
			const assessed = distribution.ready + distribution.prepare + distribution.review + distribution.manual;
			const notAssessed = total - assessed;
			const metrics = {
				repository: snapshot.selectedRepository.fullName,
				distribution,
				total,
				assessed,
				notAssessed
			};

			// Summary stats - always showing open issues count
			items.push(new TreeItem(
				`${total} open issue${total !== 1 ? 's' : ''}`,
				vscode.TreeItemCollapsibleState.None,
				'stats'
			));

			// Readiness distribution (clickable filters)
			if (assessed > 0) {
				const distributionHeader = new TreeItem(
					'READINESS DISTRIBUTION',
					vscode.TreeItemCollapsibleState.Expanded,
					'readinessHeader',
					undefined,
					undefined,
					metrics
				);
				distributionHeader.iconPath = new vscode.ThemeIcon('graph');
				items.push(distributionHeader);
			}

			// Issue grouping header
			const issuesHeader = new TreeItem(
				'ISSUES BY READINESS',
				vscode.TreeItemCollapsibleState.Expanded,
				'issuesHeader',
				undefined,
				undefined,
				metrics
			);
			issuesHeader.iconPath = new vscode.ThemeIcon('list-tree');
			items.push(issuesHeader);

			return items;
		}

		// Children of readiness distribution header
		if (element.contextValue === 'readinessHeader') {
			const snapshot = this.issueManager.getSnapshot();
			if (!snapshot.selectedRepository) {
				return [];
			}

			// ALWAYS filter to open issues only - use cached open issues independent of main panel filter
			const openIssues = this.issueManager.getCachedOpenIssues();

			const metrics = element.metadata as { repository: string; distribution: ReadinessDistribution } | undefined;
			const repository = metrics?.repository ?? snapshot.selectedRepository.fullName;
			const distribution = metrics?.distribution ?? await this.calculateReadinessDistribution(openIssues, repository);
			const filters: TreeItem[] = [];

			if (distribution.ready > 0) {
				const item = new TreeItem(
					`Automation Ready: ${distribution.ready}`,
					vscode.TreeItemCollapsibleState.None,
					'readinessFilter',
					{
						command: 'issuetriage.filterByReadiness',
						title: 'Filter by Ready',
						arguments: ['ready']
					}
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
				filters.push(item);
			}

			if (distribution.prepare > 0) {
				const item = new TreeItem(
					`Prep Required: ${distribution.prepare}`,
					vscode.TreeItemCollapsibleState.None,
					'readinessFilter',
					{
						command: 'issuetriage.filterByReadiness',
						title: 'Filter by Prepare',
						arguments: ['prepare']
					}
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiYellow'));
				filters.push(item);
			}

			if (distribution.review > 0) {
				const item = new TreeItem(
					`Needs Review: ${distribution.review}`,
					vscode.TreeItemCollapsibleState.None,
					'readinessFilter',
					{
						command: 'issuetriage.filterByReadiness',
						title: 'Filter by Review',
						arguments: ['review']
					}
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiYellow'));
				filters.push(item);
			}

			if (distribution.manual > 0) {
				const item = new TreeItem(
					`Manual Only: ${distribution.manual}`,
					vscode.TreeItemCollapsibleState.None,
					'readinessFilter',
					{
						command: 'issuetriage.filterByReadiness',
						title: 'Filter by Manual',
						arguments: ['manual']
					}
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiRed'));
				filters.push(item);
			}

			if (this.activeFilter) {
				const clearItem = new TreeItem(
					'Clear Readiness Filter',
					vscode.TreeItemCollapsibleState.None,
					'readinessFilter',
					{
						command: 'issuetriage.filterByReadiness',
						title: 'Clear readiness filter',
						arguments: [null]
					}
				);
				clearItem.iconPath = new vscode.ThemeIcon('close');
				filters.push(clearItem);
			}

			return filters;
		}

		if (element.contextValue === 'issuesHeader') {
			const snapshot = this.issueManager.getSnapshot();
			if (!snapshot.selectedRepository) {
				return [];
			}

			// ALWAYS filter to open issues only - use cached open issues independent of main panel filter
			const openIssues = this.issueManager.getCachedOpenIssues();

			const metrics = element.metadata as { repository: string; distribution: ReadinessDistribution; notAssessed: number } | undefined;
			const repository = metrics?.repository ?? snapshot.selectedRepository.fullName;
			const distribution = metrics?.distribution ?? await this.calculateReadinessDistribution(openIssues, repository);
			const notAssessed = metrics?.notAssessed ?? (openIssues.length - (distribution.ready + distribution.prepare + distribution.review + distribution.manual));
			const groups: TreeItem[] = [];
			const includeGroup = (key: string): boolean => {
				return !this.activeFilter || this.activeFilter === key;
			};

			if (notAssessed > 0 && includeGroup('notassessed')) {
				const item = new TreeItem(
					`Not Assessed (${notAssessed})`,
					vscode.TreeItemCollapsibleState.Collapsed,
					'issueGroupNotAssessed'
				);
				item.iconPath = new vscode.ThemeIcon('circle-outline');
				if (this.activeFilter === 'notassessed') {
					item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				}
				groups.push(item);
			}

			if (distribution.ready > 0 && includeGroup('ready')) {
				const item = new TreeItem(
					`Automation Ready (${distribution.ready})`,
					vscode.TreeItemCollapsibleState.Collapsed,
					'issueGroupReady'
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
				if (this.activeFilter === 'ready') {
					item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				}
				groups.push(item);
			}

			if (distribution.prepare > 0 && includeGroup('prepare')) {
				const item = new TreeItem(
					`Prep Required (${distribution.prepare})`,
					vscode.TreeItemCollapsibleState.Collapsed,
					'issueGroupPrepare'
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiYellow'));
				if (this.activeFilter === 'prepare') {
					item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				}
				groups.push(item);
			}

			if (distribution.review > 0 && includeGroup('review')) {
				const item = new TreeItem(
					`Needs Review (${distribution.review})`,
					vscode.TreeItemCollapsibleState.Collapsed,
					'issueGroupReview'
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiYellow'));
				if (this.activeFilter === 'review') {
					item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				}
				groups.push(item);
			}

			if (distribution.manual > 0 && includeGroup('manual')) {
				const item = new TreeItem(
					`Manual Only (${distribution.manual})`,
					vscode.TreeItemCollapsibleState.Collapsed,
					'issueGroupManual'
				);
				item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiRed'));
				if (this.activeFilter === 'manual') {
					item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				}
				groups.push(item);
			}

			if (!groups.length) {
				const message = this.activeFilter
					? `No issues match the ${this.activeFilter} filter.`
					: 'No assessed issues yet.';
				return [new TreeItem(message, vscode.TreeItemCollapsibleState.None, 'info')];
			}

			return groups;
		}

		// Children of issue groups
		if (element.contextValue?.startsWith('issueGroup')) {
			const snapshot = this.issueManager.getSnapshot();
			if (!snapshot.selectedRepository) {
				return [];
			}

			// ALWAYS filter to open issues only - use cached open issues independent of main panel filter
			const openIssues = this.issueManager.getCachedOpenIssues();

			const category = element.contextValue.replace('issueGroup', '').toLowerCase();
			const filteredIssues = await this.filterIssuesByCategory(openIssues, snapshot.selectedRepository.fullName, category);
			
			return Promise.all(filteredIssues.map(issue => this.createIssueTreeItem(issue, snapshot.selectedRepository!.fullName, category)));
		}

		return [];
	}

	private async calculateReadinessDistribution(issues: IssueSummary[], repository: string): Promise<ReadinessDistribution> {
		const distribution: ReadinessDistribution = {
			ready: 0,
			prepare: 0,
			review: 0,
			manual: 0
		};

		for (const issue of issues) {
			try {
				const assessment = await this.assessmentService.getLatestAssessment(repository, issue.number);
				if (assessment) {
					const readiness = this.getReadinessCategory(assessment.compositeScore);
					distribution[readiness]++;
				}
			} catch {
				// Skip issues without assessments
			}
		}

		return distribution;
	}

	private async filterIssuesByCategory(issues: IssueSummary[], repository: string, category: string): Promise<IssueSummary[]> {
		const filtered: IssueSummary[] = [];

		for (const issue of issues) {
			try {
				const assessment = await this.assessmentService.getLatestAssessment(repository, issue.number);
				
				if (category === 'notassessed') {
					if (!assessment) {
						filtered.push(issue);
					}
				} else {
					if (assessment) {
						const readiness = this.getReadinessCategory(assessment.compositeScore);
						if (readiness === category) {
							filtered.push(issue);
						}
					}
				}
			} catch {
				if (category === 'notassessed') {
					filtered.push(issue);
				}
			}
		}

		return filtered;
	}

	private getReadinessCategory(compositeScore: number): 'ready' | 'prepare' | 'review' | 'manual' {
		// Align thresholds with IssueManager.toReadiness (scores are 0-100)
		if (compositeScore >= 80) {
			return 'ready';
		} else if (compositeScore >= 60) {
			return 'prepare';
		} else if (compositeScore >= 40) {
			return 'review';
		} else {
			return 'manual';
		}
	}

	private async createIssueTreeItem(issue: IssueSummary, repository: string, category: string): Promise<TreeItem> {
		const label = `#${issue.number} ${issue.title}`;
		
		// Determine context value based on category for showing Send to Automation button
		let contextValue: string = 'issue';
		if (category === 'ready') {
			contextValue = 'issueReady';
		} else if (category === 'notassessed') {
			contextValue = 'issueNotAssessed';
		}
		
		const item = new TreeItem(
			label,
			vscode.TreeItemCollapsibleState.None,
			contextValue,
			{
				command: 'issuetriage.openPanel',
				title: 'Open Issue Triage Panel',
				arguments: [issue.number]
			},
			undefined,
			{ issueNumber: issue.number }
		);

		// Add icon based on state and readiness
		if (category === 'ready') {
			item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
		} else if (category === 'prepare') {
			item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiYellow'));
		} else if (category === 'review') {
			item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiYellow'));
		} else if (category === 'manual') {
			item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiRed'));
		} else {
			// Not assessed - use gray circle
			item.iconPath = new vscode.ThemeIcon('circle-outline');
		}

		// Build description with labels
		const descriptionParts: string[] = [];

		// Add labels
		if (issue.labels && issue.labels.length > 0) {
			descriptionParts.push(issue.labels.slice(0, 2).join(', '));
		}

		if (descriptionParts.length > 0) {
			item.description = descriptionParts.join(' • ');
		}

		// Build tooltip
		const tooltipParts = [
			`**#${issue.number}**: ${issue.title}`,
			`State: ${issue.state}`
		];

		if (issue.labels?.length) {
			tooltipParts.push(`Labels: ${issue.labels.join(', ')}`);
		}

		try {
			const assessment = await this.assessmentService.getLatestAssessment(repository, issue.number);
			if (assessment) {
				tooltipParts.push(`Composite Score: ${assessment.compositeScore.toFixed(1)}`);
			}
		} catch {
			// Skip if no assessment
		}

		item.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));

		return item;
	}
}

class TreeItem extends vscode.TreeItem {
	public metadata?: unknown;

	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public contextValue?: string,
		command?: vscode.Command,
		tooltip?: string,
		metadata?: unknown
	) {
		super(label, collapsibleState);
		this.command = command;
		this.tooltip = tooltip;
		this.metadata = metadata;
	}
}
