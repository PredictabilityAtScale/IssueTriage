// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { existsSync } from 'fs';
import * as path from 'path';
import { config as loadEnv } from 'dotenv';
import { CredentialService } from './services/credentialService';
import { SettingsService } from './services/settingsService';
import { TelemetryService } from './services/telemetryService';
import { StateService } from './services/stateService';
import { GitHubAuthService } from './services/githubAuthService';
import { GitHubClient } from './services/githubClient';
import { IssueManager, FilterState } from './issueManager';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	console.log('IssueTriage extension activated.');

	try {
		const envPath = path.join(context.extensionUri.fsPath, '.env');
		if (existsSync(envPath)) {
			loadEnv({ path: envPath });
			console.log('IssueTriage environment variables loaded from .env file.');
		}
	} catch (error) {
		console.warn('IssueTriage could not load .env file.', error);
	}

	const settings = new SettingsService();
	const state = new StateService(context.globalState, context.workspaceState);
	const services: ServiceBundle = {
		credentials: new CredentialService(context.secrets),
		settings,
		telemetry: new TelemetryService({ settings }),
		state,
		auth: undefined!,
		github: undefined!,
		issueManager: undefined!
	};

	context.subscriptions.push(services.telemetry);
	services.telemetry.trackEvent('extension.activate');
	const secretSubscription = services.credentials.onDidChange(id => {
		services.telemetry.trackEvent('credentials.changed', { scope: id });
	});
	context.subscriptions.push(secretSubscription);

	const auth = new GitHubAuthService(services.credentials, services.settings, services.state, services.telemetry);
	const github = new GitHubClient(auth, services.settings, services.telemetry);
	const issueManager = new IssueManager(auth, github, services.settings, services.state, services.telemetry);
	services.auth = auth;
	services.github = github;
	services.issueManager = issueManager;
	context.subscriptions.push(issueManager);
	void issueManager.initialize().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		services.telemetry.trackEvent('issueManager.initializeFailed', { message });
	});

	const openPanel = vscode.commands.registerCommand('issuetriage.openPanel', () => {
		IssueTriagePanel.createOrShow(services);
	});

	context.subscriptions.push(openPanel);

	const connectRepository = vscode.commands.registerCommand('issuetriage.connectRepository', async () => {
		await services.issueManager.connectRepository();
	});
	const refreshIssues = vscode.commands.registerCommand('issuetriage.refreshIssues', async () => {
		await services.issueManager.refreshIssues(true);
	});
	const signOut = vscode.commands.registerCommand('issuetriage.signOut', async () => {
		await services.issueManager.signOut();
	});

	context.subscriptions.push(connectRepository, refreshIssues, signOut);
}

// This method is called when your extension is deactivated
export function deactivate() {}

interface ServiceBundle {
	credentials: CredentialService;
	settings: SettingsService;
	telemetry: TelemetryService;
	state: StateService;
	auth: GitHubAuthService;
	github: GitHubClient;
	issueManager: IssueManager;
}

class IssueTriagePanel {
	public static readonly viewType = 'issuetriage.panel';
	private static currentPanel: IssueTriagePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly services: ServiceBundle;
	private disposables: vscode.Disposable[] = [];
	private readonly stateListener: vscode.Disposable;

	public static createOrShow(services: ServiceBundle) {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (IssueTriagePanel.currentPanel) {
			IssueTriagePanel.currentPanel.panel.reveal(column);
			IssueTriagePanel.currentPanel.update();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			IssueTriagePanel.viewType,
			'Issue Triage',
			column,
			{
				enableScripts: true
			}
		);

		IssueTriagePanel.currentPanel = new IssueTriagePanel(panel, services);
	}

	private constructor(panel: vscode.WebviewPanel, services: ServiceBundle) {
		this.panel = panel;
		this.services = services;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.update();
		this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message), undefined, this.disposables);
		this.stateListener = this.services.issueManager.onDidChangeState(state => {
			this.postState(state);
		});
		this.disposables.push(this.stateListener);
	}

	private update() {
		this.panel.title = 'Issue Triage';
		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
		this.services.telemetry.trackEvent('panel.rendered');
	}

	public dispose() {
		IssueTriagePanel.currentPanel = undefined;

		while (this.disposables.length) {
			const disposable = this.disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
		this.panel.dispose();
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="${csp}">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Issue Triage</title>
			<style nonce="${nonce}">
				:root {
					color-scheme: light dark;
					font-family: var(--vscode-font-family, Segoe WPC, Segoe UI, sans-serif);
					font-size: 13px;
				}

				body {
					margin: 0;
					padding: 0;
					background: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
				}

				.header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					padding: 16px;
					border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}

				.header h1 {
					font-size: 18px;
					margin: 0;
				}

				.toolbar {
					display: flex;
					gap: 8px;
					align-items: center;
				}

				button, select, input[type="search"] {
					font: inherit;
					padding: 6px 10px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: var(--vscode-editor-background);
					color: inherit;
				}

				button.primary {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border-color: transparent;
				}

				button:disabled {
					opacity: 0.6;
					cursor: not-allowed;
				}

				.container {
					display: grid;
					grid-template-columns: 1fr;
					height: calc(100vh - 60px);
				}

				@media (min-width: 960px) {
					.container {
						grid-template-columns: 320px 1fr;
					}
				}

				.sidebar {
					border-right: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					padding: 16px;
					overflow-y: auto;
				}

				.content {
					padding: 16px;
					overflow-y: auto;
				}

				.issue-list {
					display: grid;
					gap: 8px;
				}

				.filters {
					display: grid;
					gap: 12px;
					margin-top: 16px;
				}

				.filters label {
					display: flex;
					flex-direction: column;
					gap: 4px;
					font-size: 11px;
					text-transform: uppercase;
					letter-spacing: 0.05em;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.filters label > span {
					font-weight: 600;
				}

				.filters select,
				.filters input[type="search"] {
					width: 100%;
					margin: 0;
				}

				.issue-card {
					padding: 12px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
					cursor: pointer;
				}

				.issue-card h3 {
					margin: 0 0 8px 0;
					font-size: 14px;
				}

				.meta-row {
					display: flex;
					flex-wrap: wrap;
					gap: 6px;
					font-size: 12px;
				}

				.badge {
					padding: 2px 6px;
					border-radius: 999px;
					background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-button-background) 15%);
				}

				.status {
					padding: 12px;
					border-radius: 6px;
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					margin-bottom: 16px;
				}

				.empty-state {
					text-align: center;
					padding: 48px 16px;
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
				}
			</style>
		</head>
		<body>
			<div class="header">
				<div>
					<h1>Issue Triage</h1>
					<div id="accountLabel" class="meta-row"></div>
				</div>
				<div class="toolbar">
					<button id="connect" class="primary">Connect GitHub</button>
					<button id="refresh">Refresh</button>
				</div>
			</div>
			<div class="container">
				<aside class="sidebar">
					<div class="status" id="statusBlock">Sign in to connect your repository.</div>
					<div class="filters" aria-live="polite">
						<label>
							<span>Repository</span>
							<select id="repositorySelect"></select>
						</label>
						<label>
							<span>Search</span>
							<input type="search" id="searchInput" placeholder="Search titles" />
						</label>
						<label>
							<span>Label</span>
							<select id="labelFilter"></select>
						</label>
						<label>
							<span>Assignee</span>
							<select id="assigneeFilter"></select>
						</label>
						<label>
							<span>Milestone</span>
							<select id="milestoneFilter"></select>
						</label>
					</div>
				</aside>
				<main class="content">
					<div id="issueSummary" class="meta-row"></div>
					<section id="issueList" class="issue-list"></section>
					<div id="emptyState" class="empty-state" hidden>
						<p>No issues match your filters.</p>
					</div>
				</main>
			</div>

			<script nonce="${nonce}">
				const vscodeApi = acquireVsCodeApi();
				const connectButton = document.getElementById('connect');
				const refreshButton = document.getElementById('refresh');
				const repositorySelect = document.getElementById('repositorySelect');
				const searchInput = document.getElementById('searchInput');
				const labelFilter = document.getElementById('labelFilter');
				const assigneeFilter = document.getElementById('assigneeFilter');
				const milestoneFilter = document.getElementById('milestoneFilter');
				const statusBlock = document.getElementById('statusBlock');
				const issueList = document.getElementById('issueList');
				const emptyState = document.getElementById('emptyState');
				const issueSummary = document.getElementById('issueSummary');
				const accountLabel = document.getElementById('accountLabel');

				let latestState = null;

				window.addEventListener('message', event => {
					const message = event.data;
					if (message?.type === 'stateUpdate') {
						latestState = message.state;
						renderState(latestState);
					}
				});

				connectButton.addEventListener('click', () => {
					vscodeApi.postMessage({ type: 'webview.connect' });
				});

				refreshButton.addEventListener('click', () => {
					vscodeApi.postMessage({ type: 'webview.refresh' });
				});

				repositorySelect.addEventListener('change', event => {
					const value = event.target.value;
					vscodeApi.postMessage({ type: 'webview.selectRepository', repository: value });
				});

				function onFilterChanged() {
					const filters = {
						search: searchInput.value || undefined,
						label: labelFilter.value || undefined,
						assignee: assigneeFilter.value || undefined,
						milestone: milestoneFilter.value || undefined
					};
					vscodeApi.postMessage({ type: 'webview.filtersChanged', filters });
				}

				searchInput.addEventListener('input', onFilterChanged);
				labelFilter.addEventListener('change', onFilterChanged);
				assigneeFilter.addEventListener('change', onFilterChanged);
				milestoneFilter.addEventListener('change', onFilterChanged);

				function renderState(state) {
					const { loading, session, repositories, selectedRepository, issues, issueMetadata, filters, error, lastUpdated } = state;

					connectButton.disabled = loading;
					refreshButton.disabled = loading || !selectedRepository;

					if (session) {
						accountLabel.textContent = 'Signed in as ' + session.login;
						statusBlock.textContent = selectedRepository ? 'Connected to ' + selectedRepository.fullName : 'Select a repository to get started.';
					} else {
						accountLabel.textContent = 'Not signed in';
						statusBlock.textContent = 'Sign in to connect your repository.';
					}

					if (error) {
						statusBlock.textContent = error;
					}

					// Populate repository list
					repositorySelect.innerHTML = '';
					const defaultOption = document.createElement('option');
					defaultOption.value = '';
					defaultOption.textContent = repositories.length ? 'Select repository' : 'No repositories available';
					repositorySelect.appendChild(defaultOption);
					repositories.forEach(repo => {
						const option = document.createElement('option');
						option.value = repo.fullName;
						option.textContent = repo.fullName;
						if (selectedRepository && repo.fullName === selectedRepository.fullName) {
							option.selected = true;
						}
						repositorySelect.appendChild(option);
					});

					renderFilterOptions(labelFilter, issueMetadata.labels, filters.label, 'All labels');
					renderFilterOptions(assigneeFilter, issueMetadata.assignees, filters.assignee, 'All assignees');
					renderFilterOptions(milestoneFilter, issueMetadata.milestones, filters.milestone, 'All milestones');

					if (!loading && issues.length === 0) {
						emptyState.hidden = false;
						issueList.innerHTML = '';
					} else {
						emptyState.hidden = true;
						issueList.innerHTML = issues.map(issue => renderIssue(issue)).join('');
					}

					if (selectedRepository) {
						const summaryBase = issues.length + ' open issues';
						const updatedText = lastUpdated ? ' · Updated ' + new Date(lastUpdated).toLocaleString() : '';
						issueSummary.textContent = summaryBase + updatedText;
					} else {
						issueSummary.textContent = '';
					}
				}

				function renderFilterOptions(selectElement, values, selectedValue, placeholder) {
					selectElement.innerHTML = '';
					const option = document.createElement('option');
					option.value = '';
					option.textContent = placeholder;
					selectElement.appendChild(option);
					values.forEach(value => {
						const optionEl = document.createElement('option');
						optionEl.value = value;
						optionEl.textContent = value;
						if (value === selectedValue) {
							optionEl.selected = true;
						}
						selectElement.appendChild(optionEl);
					});
				}

				function renderIssue(issue) {
					const labelBadges = issue.labels.map(label => '<span class="badge">' + label + '</span>').join(' ');
					const assigneeText = issue.assignees.length ? '· Assigned to ' + issue.assignees.join(', ') : '';
					const milestoneText = issue.milestone ? '· Milestone ' + issue.milestone : '';
					const updatedText = new Date(issue.updatedAt).toLocaleString();
					return '<article class="issue-card" data-url="' + issue.url + '">' +
						'<h3>#' + issue.number + ' · ' + issue.title + '</h3>' +
						'<div class="meta-row">' +
							'<span>Updated ' + updatedText + '</span>' +
							'<span>' + assigneeText + '</span>' +
							'<span>' + milestoneText + '</span>' +
						'</div>' +
						'<div class="meta-row">' + labelBadges + '</div>' +
					'</article>';
				}

				issueList.addEventListener('click', event => {
					const card = event.target.closest('.issue-card');
					if (!card) {
						return;
					}
					const url = card.getAttribute('data-url');
					vscodeApi.postMessage({ type: 'webview.openIssue', url });
				});

				vscodeApi.postMessage({ type: 'webview.ready' });
			</script>
		</body>
		</html>`;
	}

	private postState(state: unknown): void {
		this.panel.webview.postMessage({ type: 'stateUpdate', state });
	}

	private async handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
		switch (message.type) {
			case 'webview.ready':
				this.postState(this.services.issueManager.getSnapshot());
				break;
			case 'webview.connect':
				await this.services.issueManager.connectRepository();
				break;
			case 'webview.refresh':
				await this.services.issueManager.refreshIssues(true);
				break;
			case 'webview.selectRepository':
				if (typeof message.repository === 'string' && message.repository) {
					await this.services.issueManager.selectRepository(message.repository);
				}
				break;
			case 'webview.filtersChanged':
				await this.services.issueManager.updateFilters(this.ensureFilterPayload(message.filters));
				break;
			case 'webview.openIssue':
				if (typeof message.url === 'string') {
					await vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
			default:
				break;
		}
	}

	private normalizeString(value: unknown): string | undefined {
		if (typeof value !== 'string' || value.trim() === '') {
			return undefined;
		}
		return value;
	}

	private ensureFilterPayload(value: unknown): FilterState {
		if (!value || typeof value !== 'object') {
			return {};
		}
		const payload = value as Record<string, unknown>;
		return {
			search: this.normalizeString(payload.search),
			label: this.normalizeString(payload.label),
			assignee: this.normalizeString(payload.assignee),
			milestone: this.normalizeString(payload.milestone)
		};
	}
}

function getNonce(): string {
	const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i += 1) {
		result += charset.charAt(Math.floor(Math.random() * charset.length));
	}
	return result;
}
