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
import { AssessmentStorage } from './services/assessmentStorage';
import { AssessmentService, AssessmentError } from './services/assessmentService';
import type { AssessmentRecord } from './services/assessmentStorage';

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
		issueManager: undefined!,
		assessment: undefined!
	};

	context.subscriptions.push(services.telemetry);
	services.telemetry.trackEvent('extension.activate');
	const secretSubscription = services.credentials.onDidChange(id => {
		services.telemetry.trackEvent('credentials.changed', { scope: id });
	});
	context.subscriptions.push(secretSubscription);

	const auth = new GitHubAuthService(services.credentials, services.settings, services.state, services.telemetry);
	const github = new GitHubClient(auth, services.settings, services.telemetry);
	const assessmentStorage = new AssessmentStorage(context.globalStorageUri.fsPath);
	const assessment = new AssessmentService(assessmentStorage, services.settings, services.telemetry, github);
	const issueManager = new IssueManager(auth, github, services.settings, services.state, services.telemetry);
	services.auth = auth;
	services.github = github;
	services.issueManager = issueManager;
	services.assessment = assessment;
	context.subscriptions.push(issueManager);
	context.subscriptions.push(new vscode.Disposable(() => assessment.dispose()));
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
	const assessIssue = vscode.commands.registerCommand('issuetriage.assessIssue', async () => {
		const snapshot = services.issueManager.getSnapshot();
		const repository = snapshot.selectedRepository;
		if (!repository) {
			void vscode.window.showWarningMessage('Select a repository before running an assessment.');
			return;
		}
		const issues = snapshot.issues;
		if (!issues.length) {
			void vscode.window.showWarningMessage('No issues available to assess. Refresh the list and try again.');
			return;
		}

		const picks = issues.map(issue => ({
			label: `#${issue.number} · ${issue.title}`,
			issueNumber: issue.number
		}));
		const selection = await vscode.window.showQuickPick(picks, {
			placeHolder: 'Select an issue to assess'
		});
		if (!selection) {
			return;
		}

		await vscode.window.withProgress({
			title: `Assessing issue #${selection.issueNumber}`,
			location: vscode.ProgressLocation.Notification
		}, async progress => {
			progress.report({ message: 'Requesting analysis from OpenRouter' });
			try {
				const record = await services.assessment.assessIssue(repository.fullName, selection.issueNumber);
				const composite = record.compositeScore.toFixed(1);
				IssueTriagePanel.broadcastAssessment(record);
				vscode.window.showInformationMessage(`IssueTriage assessment complete for #${selection.issueNumber} (Composite ${composite}).`);
			} catch (error) {
				const userMessage = formatAssessmentError(error);
				vscode.window.showErrorMessage(`Assessment failed: ${userMessage}`);
			}
		});
	});
	const signOut = vscode.commands.registerCommand('issuetriage.signOut', async () => {
		await services.issueManager.signOut();
	});

	context.subscriptions.push(connectRepository, refreshIssues, assessIssue, signOut);
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
	assessment: AssessmentService;
}

class IssueTriagePanel {
	public static readonly viewType = 'issuetriage.panel';
	private static currentPanel: IssueTriagePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly services: ServiceBundle;
	private disposables: vscode.Disposable[] = [];
	private readonly stateListener: vscode.Disposable;

	public static broadcastAssessment(record: AssessmentRecord): void {
		IssueTriagePanel.currentPanel?.postAssessment(record);
	}

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

				.header-left {
					display: flex;
					flex-direction: column;
					gap: 4px;
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
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					cursor: pointer;
					transition: border-color 0.1s ease, background 0.1s ease;
				}

				.issue-card.selected {
					border-color: var(--vscode-button-background);
					background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-button-background) 20%);
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

				.assessment-panel {
					margin-top: 24px;
					padding: 16px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-button-background) 4%);
				}

				.assessment-panel h2 {
					margin: 0 0 4px 0;
					font-size: 16px;
				}

				.assessment-panel p {
					margin: 4px 0;
				}

				.assessment-empty,
				.assessment-loading,
				.assessment-error {
					text-align: center;
					padding: 24px 8px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.score-grid {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
					gap: 12px;
					margin: 16px 0;
				}

				.score-card {
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 10px;
					background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
				}

				.score-card strong {
					display: block;
					font-size: 11px;
					text-transform: uppercase;
					letter-spacing: 0.05em;
					margin-bottom: 4px;
				}

				.score-card span {
					font-size: 20px;
					font-weight: 600;
				}

				.recommendations-list {
					margin: 0 0 0 16px;
					padding: 0;
				}

				.recommendations-list li {
					margin-bottom: 6px;
				}

				.assessment-actions {
					display: flex;
					gap: 8px;
					flex-wrap: wrap;
					margin-top: 16px;
				}

				.button-link {
					background: none;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 4px;
					padding: 6px 10px;
					color: inherit;
					cursor: pointer;
				}

				.button-link:hover {
					border-color: var(--vscode-button-background);
				}

				.automation-badge {
					padding: 2px 8px;
					border-radius: 999px;
					font-size: 11px;
					border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
				}

				.automation-badge.enabled {
					background: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 18%, transparent);
					border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 35%, transparent);
				}

				.automation-badge.disabled {
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
					border-style: dashed;
				}

				.readiness-pill {
					display: inline-block;
					padding: 4px 10px;
					border-radius: 999px;
					font-size: 12px;
					font-weight: 600;
					text-transform: uppercase;
					border: 1px solid rgba(128,128,128,0.45);
				}

				.readiness-ready {
					background: rgba(46, 160, 67, 0.2);
					border-color: rgba(46, 160, 67, 0.5);
				}

				.readiness-prepare {
					background: rgba(187, 128, 9, 0.2);
					border-color: rgba(187, 128, 9, 0.5);
				}

				.readiness-review {
					background: rgba(229, 140, 33, 0.25);
					border-color: rgba(229, 140, 33, 0.55);
				}

				.readiness-manual {
					background: rgba(229, 83, 75, 0.25);
					border-color: rgba(229, 83, 75, 0.55);
				}
			</style>
		</head>
		<body>
			<div class="header">
				<div class="header-left">
					<h1>Issue Triage</h1>
					<div class="meta-row">
						<span id="accountLabel"></span>
						<span id="automationBadge" class="automation-badge" role="status" aria-live="polite"></span>
					</div>
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
					<section id="assessmentPanel" class="assessment-panel" aria-live="polite"></section>
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
				const automationBadge = document.getElementById('automationBadge');
				const assessmentPanel = document.getElementById('assessmentPanel');

				let latestState = null;
				let selectedIssueNumber = undefined;
				let latestAssessment = null;

				window.addEventListener('message', event => {
					const message = event.data;
					if (!message) {
						return;
					}
					switch (message.type) {
						case 'stateUpdate':
							latestState = message.state;
							renderState(latestState);
							break;
						case 'assessment.loading':
							if (message.issueNumber === selectedIssueNumber) {
								renderAssessmentLoading();
							}
							break;
						case 'assessment.result':
							if (message.issueNumber === selectedIssueNumber) {
								if (message.assessment) {
									renderAssessmentResult(message.assessment);
								} else {
									renderAssessmentEmpty('Run an IssueTriage assessment to populate this panel.');
								}
							}
							break;
						case 'assessment.error':
							if (message.issueNumber === selectedIssueNumber) {
								renderAssessmentError(typeof message.message === 'string' ? message.message : 'Unable to load assessment.');
							}
							break;
						default:
							break;
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

				issueList.addEventListener('click', event => {
					const card = event.target.closest('.issue-card');
					if (!card) {
						return;
					}
					const issueNumber = Number(card.getAttribute('data-issue-number'));
					if (Number.isNaN(issueNumber)) {
						return;
					}
					selectIssue(issueNumber);
				});

				issueList.addEventListener('dblclick', event => {
					const card = event.target.closest('.issue-card');
					if (!card) {
						return;
					}
					const url = card.getAttribute('data-url');
					if (url) {
						vscodeApi.postMessage({ type: 'webview.openIssue', url });
					}
				});

				assessmentPanel.addEventListener('click', event => {
					const button = event.target.closest('button[data-action]');
					if (!button) {
						return;
					}
					const action = button.getAttribute('data-action');
					if (action === 'openIssue') {
						const issueUrl = getIssueUrl(selectedIssueNumber);
						if (issueUrl) {
							vscodeApi.postMessage({ type: 'webview.openIssue', url: issueUrl });
						}
					} else if (action === 'openComment') {
						const commentUrl = button.getAttribute('data-url');
						if (commentUrl) {
							vscodeApi.postMessage({ type: 'webview.openUrl', url: commentUrl });
						}
					}
				});

				function renderState(state) {
					const { loading, session, repositories, selectedRepository, issues, issueMetadata, filters, error, lastUpdated, automationLaunchEnabled } = state;

					connectButton.disabled = loading;
					refreshButton.disabled = loading || !selectedRepository;

					if (session) {
						accountLabel.textContent = 'Signed in as ' + session.login;
						statusBlock.textContent = selectedRepository ? 'Connected to ' + selectedRepository.fullName : 'Select a repository to get started.';
					} else {
						accountLabel.textContent = 'Not signed in';
						statusBlock.textContent = 'Sign in to connect your repository.';
					}

					if (automationLaunchEnabled) {
						automationBadge.textContent = 'Automation Launch Enabled';
						automationBadge.classList.add('enabled');
						automationBadge.classList.remove('disabled');
					} else {
						automationBadge.textContent = 'Automation Launch Disabled';
						automationBadge.classList.add('disabled');
						automationBadge.classList.remove('enabled');
					}

					if (error) {
						statusBlock.textContent = error;
					}

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

					enforceSelection();
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
					return '<article class="issue-card" data-issue-number="' + issue.number + '" data-url="' + issue.url + '">' +
						'<h3>#' + issue.number + ' · ' + issue.title + '</h3>' +
						'<div class="meta-row">' +
							'<span>Updated ' + updatedText + '</span>' +
							(assigneeText ? '<span>' + assigneeText + '</span>' : '') +
							(milestoneText ? '<span>' + milestoneText + '</span>' : '') +
						'</div>' +
						(labelBadges ? '<div class="meta-row">' + labelBadges + '</div>' : '') +
					'</article>';
				}

				function enforceSelection() {
					if (!latestState || !latestState.selectedRepository) {
						selectedIssueNumber = undefined;
						renderAssessmentEmpty('Connect to a repository to view assessments.');
						return;
					}
					if (!latestState.issues.length) {
						selectedIssueNumber = undefined;
						renderAssessmentEmpty('No assessments yet. Run an IssueTriage assessment to populate this panel.');
						return;
					}
					const existingNumbers = latestState.issues.map(issue => issue.number);
					if (!selectedIssueNumber || !existingNumbers.includes(selectedIssueNumber)) {
						selectIssue(existingNumbers[0]);
					} else {
						highlightSelectedIssue();
					}
				}

				function selectIssue(issueNumber) {
					if (selectedIssueNumber === issueNumber) {
						highlightSelectedIssue();
						return;
					}
					selectedIssueNumber = issueNumber;
					latestAssessment = null;
					highlightSelectedIssue();
					renderAssessmentLoading();
					if (latestState && latestState.selectedRepository) {
						vscodeApi.postMessage({ type: 'webview.selectIssue', issueNumber });
					}
				}

				function highlightSelectedIssue() {
					const cards = issueList.querySelectorAll('.issue-card');
					cards.forEach(card => {
						const number = Number(card.getAttribute('data-issue-number'));
						if (!Number.isNaN(number) && number === selectedIssueNumber) {
							card.classList.add('selected');
						} else {
							card.classList.remove('selected');
						}
					});
				}

				function getIssueUrl(issueNumber) {
					if (!latestState) {
						return undefined;
					}
					const issue = latestState.issues.find(item => item.number === issueNumber);
					return issue ? issue.url : undefined;
				}

				function getReadiness(score) {
					if (score >= 80) {
						return { label: 'Automation Ready', className: 'readiness-ready', description: 'Safe to hand off to automation.' };
					}
					if (score >= 60) {
						return { label: 'Prep Required', className: 'readiness-prepare', description: 'Add missing context then reassess.' };
					}
					if (score >= 40) {
						return { label: 'Needs Review', className: 'readiness-review', description: 'Human review recommended before automation.' };
					}
					return { label: 'Manual Only', className: 'readiness-manual', description: 'Keep this issue manual for now.' };
				}

				function renderAssessmentLoading() {
					assessmentPanel.innerHTML = '<div class="assessment-loading">Loading latest assessment…</div>';
				}

				function renderAssessmentEmpty(message) {
					latestAssessment = null;
					assessmentPanel.innerHTML = '<div class="assessment-empty">' + message + '</div>';
				}

				function renderAssessmentError(message) {
					latestAssessment = null;
					assessmentPanel.innerHTML = '<div class="assessment-error">' + message + '</div>';
				}

				function renderAssessmentResult(data) {
					latestAssessment = data;
					const readiness = getReadiness(data.compositeScore);
					const updatedAt = new Date(data.createdAt).toLocaleString();
					const issueUrl = getIssueUrl(data.issueNumber);
					const recommendations = (data.recommendations && data.recommendations.length ? data.recommendations : ['No immediate actions recommended.']).map(item => '<li>' + item + '</li>').join('');
					const lines = [
						'<div>',
						'<h2>Assessment · #' + data.issueNumber + '</h2>',
						'<p><span class="readiness-pill ' + readiness.className + '">' + readiness.label + '</span></p>',
						'<p>' + readiness.description + '</p>',
						'<p>Composite ' + data.compositeScore.toFixed(1) + ' · Model ' + data.model + ' · Last run ' + updatedAt + '</p>',
						'</div>',
						'<div class="score-grid">',
						'<div class="score-card"><strong>Composite</strong><span>' + data.compositeScore.toFixed(1) + '</span></div>',
						'<div class="score-card"><strong>Requirements</strong><span>' + data.requirementsScore.toFixed(1) + '</span></div>',
						'<div class="score-card"><strong>Complexity</strong><span>' + data.complexityScore.toFixed(1) + '</span></div>',
						'<div class="score-card"><strong>Security</strong><span>' + data.securityScore.toFixed(1) + '</span></div>',
						'<div class="score-card"><strong>Business</strong><span>' + data.businessScore.toFixed(1) + '</span></div>',
						'</div>',
						'<div>',
						'<h3>Summary</h3>',
						'<p>' + data.summary + '</p>',
						'</div>',
						'<div>',
						'<h3>Recommendations</h3>',
						'<ul class="recommendations-list">' + recommendations + '</ul>',
						'</div>',
						'<div class="assessment-actions">'
					];
					if (issueUrl) {
						lines.push('<button class="button-link" data-action="openIssue">Open Issue</button>');
					}
					if (data.commentUrl) {
						lines.push('<button class="button-link" data-action="openComment" data-url="' + data.commentUrl + '">View Latest Comment</button>');
					}
					lines.push('</div>');
					assessmentPanel.innerHTML = lines.join('');
				}

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
			case 'webview.selectIssue': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					break;
				}
				await this.sendLatestAssessment(repository, issueNumber);
				break;
			}
			case 'webview.filtersChanged':
				await this.services.issueManager.updateFilters(this.ensureFilterPayload(message.filters));
				break;
			case 'webview.openIssue':
				if (typeof message.url === 'string') {
					await vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
			case 'webview.openUrl':
				if (typeof message.url === 'string') {
					await vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
			default:
				break;
		}
	}

	private parseIssueNumber(value: unknown): number | undefined {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.trunc(value);
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return Math.trunc(parsed);
			}
		}
		return undefined;
	}

	private async sendLatestAssessment(repository: string, issueNumber: number): Promise<void> {
		this.panel.webview.postMessage({ type: 'assessment.loading', issueNumber });
		try {
			const record = await this.services.assessment.getLatestAssessment(repository, issueNumber);
			if (!record) {
				this.panel.webview.postMessage({ type: 'assessment.result', issueNumber, assessment: null });
				return;
			}
			this.panel.webview.postMessage({
				type: 'assessment.result',
				issueNumber,
				assessment: this.toWebviewAssessment(record)
			});
		} catch (error) {
			this.panel.webview.postMessage({
				type: 'assessment.error',
				issueNumber,
				message: formatAssessmentError(error)
			});
		}
	}

	private postAssessment(record: AssessmentRecord): void {
		const snapshot = this.services.issueManager.getSnapshot();
		if (snapshot.selectedRepository?.fullName !== record.repository) {
			return;
		}
		this.panel.webview.postMessage({
			type: 'assessment.result',
			issueNumber: record.issueNumber,
			assessment: this.toWebviewAssessment(record)
		});
	}

	private toWebviewAssessment(record: AssessmentRecord): Record<string, unknown> {
		return {
			repository: record.repository,
			issueNumber: record.issueNumber,
			compositeScore: record.compositeScore,
			requirementsScore: record.requirementsScore,
			complexityScore: record.complexityScore,
			securityScore: record.securityScore,
			businessScore: record.businessScore,
			recommendations: [...record.recommendations],
			summary: record.summary,
			model: record.model,
			createdAt: record.createdAt,
			commentUrl: this.buildCommentUrl(record)
		};
	}

	private buildCommentUrl(record: AssessmentRecord): string | undefined {
		if (!record.commentId) {
			return undefined;
		}
		return `https://github.com/${record.repository}/issues/${record.issueNumber}#issuecomment-${record.commentId}`;
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

function formatAssessmentError(error: unknown): string {
	if (error instanceof AssessmentError) {
		switch (error.code) {
			case 'missingApiKey':
				return 'OpenRouter API key not configured. Update IssueTriage settings to continue.';
			case 'invalidResponse':
				return 'The assessment response was invalid. Please retry in a moment.';
			case 'storageError':
				return 'Unable to read or write assessments on disk. Check workspace permissions.';
			case 'providerError':
			default:
				return error.message;
		}
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
