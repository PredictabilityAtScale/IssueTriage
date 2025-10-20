// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { config as loadEnv } from 'dotenv';
import { CredentialService } from './services/credentialService';
import { SettingsService } from './services/settingsService';
import { TelemetryService } from './services/telemetryService';
import { StateService } from './services/stateService';
import { GitHubAuthService } from './services/githubAuthService';
import { GitHubClient } from './services/githubClient';
import type { IssueSummary } from './services/githubClient';
import { IssueManager, FilterState } from './issueManager';
import { AssessmentStorage } from './services/assessmentStorage';
import { AssessmentService, AssessmentError } from './services/assessmentService';
import { CliToolService } from './services/cliToolService';
import { RiskStorage } from './services/riskStorage';
import { RiskIntelligenceService } from './services/riskIntelligenceService';
import type { AssessmentRecord } from './services/assessmentStorage';
import type { RiskSummary } from './types/risk';

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
		assessment: undefined!,
		cliTools: undefined!,
		risk: undefined!,
		extensionUri: context.extensionUri
	};

	context.subscriptions.push(services.telemetry);
	services.telemetry.trackEvent('extension.activate');
	const secretSubscription = services.credentials.onDidChange(id => {
		services.telemetry.trackEvent('credentials.changed', { scope: id });
	});
	context.subscriptions.push(secretSubscription);

	const auth = new GitHubAuthService(services.credentials, services.settings, services.state, services.telemetry);
	const github = new GitHubClient(auth, services.settings, services.telemetry);
	const cliTools = new CliToolService(context.extensionUri.fsPath, services.settings, services.state, services.telemetry);
	const assessmentStorage = new AssessmentStorage(context.globalStorageUri.fsPath);
	const riskStorage = new RiskStorage(context.globalStorageUri.fsPath);
	const risk = new RiskIntelligenceService(riskStorage, github, services.settings, services.telemetry);
	const assessment = new AssessmentService(assessmentStorage, services.settings, services.telemetry, github, cliTools, risk);
	const issueManager = new IssueManager(auth, github, services.settings, services.state, services.telemetry, risk, assessment);
	services.auth = auth;
	services.github = github;
	services.issueManager = issueManager;
	services.assessment = assessment;
	services.cliTools = cliTools;
	services.risk = risk;
	context.subscriptions.push(issueManager);
	context.subscriptions.push(new vscode.Disposable(() => assessment.dispose()));
	context.subscriptions.push(cliTools);
	context.subscriptions.push(risk);
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

	const runContextTool = vscode.commands.registerCommand('issuetriage.runContextTool', async () => {
		const tools = services.cliTools.listTools().filter(tool => tool.enabled);
		if (!tools.length) {
			void vscode.window.showInformationMessage('No CLI context tools are available. Configure tools in IssueTriage settings.');
			return;
		}
		const picks = tools.map(tool => {
			const commandPreview = [tool.command, ...tool.args].join(' ').trim();
			const detail = tool.source === 'builtin'
				? 'Source: built-in tool'
				: (commandPreview.length > 80 ? `${commandPreview.slice(0, 77)}...` : commandPreview);
			return {
				label: tool.title,
				description: tool.description ?? (tool.source === 'builtin' ? 'Built-in CLI tool' : 'Workspace CLI tool'),
				detail,
				toolId: tool.id
			};
		});
		const selection = await vscode.window.showQuickPick(picks, {
			placeHolder: 'Select a CLI context tool to run'
		});
		if (!selection) {
			return;
		}
		try {
			const result = await vscode.window.withProgress({
				title: `Running ${selection.label}`,
				location: vscode.ProgressLocation.Notification
			}, () => services.cliTools.runTool(selection.toolId, { reason: 'manual', force: true }));
			const message = result.success
				? `${selection.label} completed in ${result.durationMs}ms.`
				: `${selection.label} failed (exit ${result.exitCode ?? 'n/a'}).`;
			const action = await vscode.window.showInformationMessage(message, 'View Output');
			if (action === 'View Output') {
				services.cliTools.showOutput();
			}
		} catch (error) {
			const description = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Failed to run ${selection.label}: ${description}`);
		}
	});
	const signOut = vscode.commands.registerCommand('issuetriage.signOut', async () => {
		await services.issueManager.signOut();
	});

	context.subscriptions.push(connectRepository, refreshIssues, assessIssue, runContextTool, signOut);
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
	cliTools: CliToolService;
	risk: RiskIntelligenceService;
	extensionUri: vscode.Uri;
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

		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.services.extensionUri, 'src', 'webview', 'panel.js'));
		const styles = this.getStyles(nonce);
		const bodyContent = this.getBodyContent();

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="${csp}">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Issue Triage</title>
			${styles}
		</head>
		<body>
			${bodyContent}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getStyles(nonce: string): string {
		return `<style nonce="${nonce}">
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

				.visually-hidden {
					position: absolute;
					width: 1px;
					height: 1px;
					padding: 0;
					margin: -1px;
					overflow: hidden;
					clip: rect(0, 0, 0, 0);
					white-space: nowrap;
					border: 0;
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
					outline: none;
				}

				button:focus-visible,
				select:focus-visible,
				input[type="search"]:focus-visible,
				.issue-card:focus-visible,
				.issue-action:focus-visible,
				.button-link:focus-visible,
				.state-tab:focus-visible,
				.compact-button:focus-visible {
					outline: 2px solid var(--vscode-focusBorder, #0078d4);
					outline-offset: 2px;
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

			.state-tabs {
				display: flex;
				gap: 4px;
				padding: 12px 16px 0 16px;
				border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			}

			.state-tab {
				padding: 8px 16px;
				border: none;
				background: transparent;
				color: var(--vscode-descriptionForeground);
				cursor: pointer;
				border-bottom: 2px solid transparent;
				font-weight: 500;
			}

			.state-tab.active {
				color: var(--vscode-foreground);
				border-bottom-color: var(--vscode-button-background);
			}

			.state-tab:hover:not(.active) {
				background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
			}

			.filters-bar {
				display: flex;
				gap: 12px;
				padding: 12px 16px;
				border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-button-background) 5%);
				flex-wrap: wrap;
				align-items: flex-end;
			}

			.filter-group {
				display: flex;
				flex-direction: column;
				gap: 4px;
				min-width: 140px;
			}

			.filter-group.search-group {
				flex: 1;
				min-width: 200px;
			}

		.filter-group.repo-group {
			min-width: 280px;
		}

		.filter-group.readiness-group {
			min-width: 180px;
		}

		.repo-controls {
			display: flex;
			gap: 8px;
			align-items: center;
		}

		.repo-controls select {
			flex: 1;
		}

		.compact-button {
			padding: 6px 12px;
			font-size: 12px;
			white-space: nowrap;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: transparent;
		}

		.filter-label {
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			font-weight: 600;
		}

		.container {
			display: grid;
			grid-template-columns: 1fr;
			height: calc(100vh - 160px);
		}

			@media (min-width: 960px) {
				.container {
					grid-template-columns: 1fr 1fr;
				}
			}

			.issue-list-panel {
				border-right: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				padding: 16px;
				overflow-y: auto;
				display: flex;
				flex-direction: column;
				gap: 12px;
				position: relative;
			}

			.analysis-actions {
				display: flex;
				justify-content: flex-end;
				align-items: center;
			}

			.analysis-actions[hidden] {
				display: none;
			}

			.overview-grid {
				display: grid;
				gap: 12px;
				grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			}

			.overview-card {
				border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				border-radius: 6px;
				padding: 12px;
				background: color-mix(in srgb, var(--vscode-editor-background) 93%, var(--vscode-button-background) 7%);
			}

			.overview-card h3 {
				margin: 0;
				font-size: 13px;
				text-transform: uppercase;
				letter-spacing: 0.05em;
				color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			}

			.overview-value {
				font-size: 24px;
				font-weight: 600;
				margin: 8px 0 4px;
			}

			.overview-subtitle {
				margin: 0;
				font-size: 12px;
				color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			}

			.overview-empty {
				border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				border-radius: 6px;
				padding: 16px;
				text-align: center;
				color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			}

			.overview-readiness .readiness-distribution {
				list-style: none;
				margin: 12px 0 0;
				padding: 0;
				display: grid;
				gap: 8px;
			}

			.readiness-distribution li {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				font-size: 12px;
			}

			.readiness-label {
				flex: 1;
			}

			.readiness-dot {
				width: 10px;
				height: 10px;
				border-radius: 999px;
				display: inline-block;
			}

			.readiness-dot.readiness-ready {
				background: rgba(46, 160, 67, 0.8);
			}

			.readiness-dot.readiness-prepare {
				background: rgba(187, 128, 9, 0.8);
			}

			.readiness-dot.readiness-review {
				background: rgba(229, 140, 33, 0.8);
			}

			.readiness-dot.readiness-manual {
				background: rgba(229, 83, 75, 0.8);
			}

			.loading-state {
				position: absolute;
				top: 0;
				left: 0;
				right: 0;
				bottom: 0;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				gap: 12px;
				background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent 15%);
				backdrop-filter: blur(2px);
				z-index: 1;
			}

			.loading-state[hidden] {
				display: none;
			}

			.loading-spinner {
				width: 28px;
				height: 28px;
				border-radius: 50%;
				border: 3px solid color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent 80%);
				border-top-color: var(--vscode-button-background);
				animation: issuetriage-spin 0.9s linear infinite;
			}

			@keyframes issuetriage-spin {
				from {
					transform: rotate(0deg);
				}
				to {
					transform: rotate(360deg);
				}
			}

			.detail-panel {
				padding: 16px;
				overflow-y: auto;
			}

				.backfill-panel {
					margin-top: 24px;
					padding: 16px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-button-background) 4%);
					display: flex;
					flex-direction: column;
					gap: 12px;
				}

				.backfill-header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
				}

				.backfill-header h2 {
					margin: 0;
					font-size: 16px;
				}

				.backfill-body {
					display: flex;
					flex-direction: column;
					gap: 16px;
				}

				.backfill-columns {
					display: grid;
					gap: 16px;
					grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
				}

				.backfill-section {
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 12px;
					background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-button-background) 6%);
					display: flex;
					flex-direction: column;
					gap: 12px;
				}

				.backfill-section header {
					display: flex;
					flex-direction: column;
					gap: 2px;
				}

				.backfill-section h3 {
					margin: 0;
					font-size: 14px;
				}

				.backfill-section p {
					margin: 0;
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.backfill-list {
					margin: 0;
					padding: 0;
					list-style: none;
					display: flex;
					flex-direction: column;
					gap: 10px;
				}

				.backfill-item {
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
					padding: 10px;
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					display: flex;
					flex-direction: column;
					gap: 8px;
				}

				.backfill-item-header {
					display: flex;
					align-items: flex-start;
					justify-content: space-between;
					gap: 8px;
				}

				.backfill-item-title {
					font-weight: 600;
					font-size: 13px;
				}

				.backfill-item-meta {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.backfill-stats {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
					font-size: 12px;
				}

				.backfill-buttons {
					display: flex;
					gap: 8px;
					flex-wrap: wrap;
				}

				.backfill-buttons button {
					padding: 4px 10px;
					font-size: 12px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
					cursor: pointer;
				}

				.backfill-buttons button:hover {
					border-color: var(--vscode-button-background);
				}

				.backfill-empty,
				.backfill-error,
				.backfill-loading {
					padding: 12px;
					border-radius: 6px;
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					text-align: center;
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.backfill-error {
					border-color: rgba(229, 83, 75, 0.55);
					color: rgba(229, 83, 75, 0.95);
				}

				.backfill-badge {
					display: inline-block;
					padding: 2px 6px;
					border-radius: 999px;
					font-size: 11px;
					background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-button-background) 15%);
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}

			.issue-list {
				display: grid;
				gap: 8px;
			}

			.issue-card {
					padding: 12px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					cursor: pointer;
					transition: border-color 0.1s ease, background 0.1s ease;
				}

				.issue-card-header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
					margin-bottom: 8px;
				}

				.issue-card-title {
					display: flex;
					align-items: center;
					gap: 8px;
					min-width: 0;
				}

			.issue-card.selected {
				border-color: var(--vscode-button-background);
				background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-button-background) 20%);
				box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder, var(--vscode-button-background)) 80%, transparent 20%);
			}

			.issue-card:focus-visible {
				border-color: var(--vscode-focusBorder, var(--vscode-button-background));
			}

			.issue-card.issue-state-closed {
				opacity: 0.85;
			}

			.issue-card h3 {
				margin: 0;
				font-size: 14px;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}				.risk-badge {
					padding: 2px 6px;
					border-radius: 999px;
					font-size: 11px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					text-transform: uppercase;
					letter-spacing: 0.05em;
				}

				.risk-badge.risk-low {
					background: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 18%, transparent);
					border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 35%, transparent);
				}

				.risk-badge.risk-medium {
					background: rgba(187, 128, 9, 0.2);
					border-color: rgba(187, 128, 9, 0.4);
				}

				.risk-badge.risk-high {
					background: rgba(229, 83, 75, 0.25);
					border-color: rgba(229, 83, 75, 0.55);
				}

				.risk-badge.risk-pending {
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
					border-style: dashed;
				}

				.risk-badge.risk-error {
					background: rgba(229, 83, 75, 0.15);
					border-color: rgba(229, 83, 75, 0.45);
				}

				.risk-badge.risk-stale {
					border-style: dashed;
				}

				.issue-card-actions {
					display: flex;
					align-items: center;
					gap: 6px;
					flex-wrap: wrap;
					justify-content: flex-end;
				}

				.issue-card-actions .issue-action {
					margin-left: auto;
				}

				.issue-action {
					padding: 4px 10px;
					font-size: 12px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					cursor: pointer;
					text-transform: uppercase;
					letter-spacing: 0.05em;
				}

				.issue-action:hover {
					border-color: var(--vscode-button-background);
				}

				.issue-action:disabled {
					opacity: 0.6;
					cursor: not-allowed;
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

			.composite-badge {
				background: color-mix(in srgb, var(--vscode-button-background) 25%, transparent 75%);
				border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			}

			.state-badge {
				background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-descriptionForeground) 10%);
				border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			}				.status {
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

				.risk-section {
					margin-top: 24px;
					padding: 16px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-button-background) 5%);
				}

				.risk-section h3 {
					margin-top: 0;
					margin-bottom: 8px;
				}

				.risk-level {
					font-weight: 600;
					margin-bottom: 12px;
				}

				.risk-level.risk-low {
					color: var(--vscode-testing-iconPassed, #2ea043);
				}

				.risk-level.risk-medium {
					color: rgba(187, 128, 9, 0.95);
				}

				.risk-level.risk-high {
					color: rgba(229, 83, 75, 0.95);
				}

				.risk-columns {
					display: grid;
					gap: 16px;
					grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
					margin-top: 12px;
				}

				.risk-metrics,
				.risk-drivers {
					margin: 0;
					padding-left: 18px;
				}

				.risk-metrics li,
				.risk-drivers li {
					margin-bottom: 6px;
				}

				.risk-meta {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					margin: 4px 0;
				}

				.assessment-history {
					margin-top: 24px;
				}

				.assessment-history h4 {
					margin: 0 0 12px;
					font-size: 14px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.history-timeline {
					position: relative;
					padding-left: 28px;
					margin-top: 12px;
					margin-bottom: 0;
					list-style: none;
				}

				.history-timeline::before {
					content: '';
					position: absolute;
					left: 8px;
					top: 0;
					bottom: 0;
					width: 2px;
					background: var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}

				.history-item {
					position: relative;
					margin-bottom: 20px;
					padding: 12px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: var(--vscode-editor-background);
				}

				.history-item::before {
					content: '';
					position: absolute;
					left: -24px;
					top: 16px;
					width: 10px;
					height: 10px;
					border-radius: 50%;
					background: var(--vscode-button-background);
					border: 2px solid var(--vscode-editor-background);
				}

				.history-item.latest::before {
					background: var(--vscode-testing-iconPassed, #2ea043);
				}

				.history-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 8px;
				}

				.history-timestamp {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.history-scores {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
					gap: 8px;
					margin-top: 8px;
				}

				.history-score {
					text-align: center;
					padding: 6px;
					border-radius: 4px;
					background: color-mix(in srgb, var(--vscode-editor-background) 93%, var(--vscode-button-background) 7%);
				}

				.history-score-label {
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.05em;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.history-score-value {
					font-size: 16px;
					font-weight: 600;
					margin-top: 2px;
				}

				.history-trend {
					font-size: 11px;
					margin-left: 4px;
				}

				.history-trend.up {
					color: var(--vscode-testing-iconPassed, #2ea043);
				}

				.history-trend.down {
					color: rgba(229, 83, 75, 0.95);
				}

				.history-empty {
					padding: 16px;
					text-align: center;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
				}
			</style>`;
	}

	private getBodyContent(): string {
		return `<div class="header">
				<div class="header-left">
					<h1>Issue Triage</h1>
					<div class="meta-row">
						<span id="accountLabel"></span>
						<span id="automationBadge" class="automation-badge" role="status" aria-live="polite"></span>
					</div>
				</div>
				<div class="toolbar">
					<button id="refresh">Refresh</button>
				</div>
			</div>
			<div id="filtersBar" class="filters-bar" aria-live="polite">
				<div class="filter-group repo-group">
					<label class="filter-label" id="repositoryLabel" for="repositorySelect">Repository</label>
					<div class="repo-controls" role="group" aria-labelledby="repositoryLabel">
						<select id="repositorySelect" aria-describedby="repositoryHelp"></select>
						<button id="connect" class="compact-button">Connect</button>
					</div>
					<p id="repositoryHelp" class="visually-hidden">Select a repository to load issues for IssueTriage.</p>
				</div>
				<div class="filter-group search-group">
					<label class="filter-label" for="searchInput">Search</label>
					<input type="search" id="searchInput" placeholder="Search titles" />
				</div>
				<div class="filter-group">
					<label class="filter-label" for="labelFilter">Label</label>
					<select id="labelFilter"></select>
				</div>
				<div class="filter-group">
					<label class="filter-label" for="assigneeFilter">Assignee</label>
					<select id="assigneeFilter"></select>
				</div>
				<div class="filter-group">
					<label class="filter-label" for="milestoneFilter">Milestone</label>
					<select id="milestoneFilter"></select>
				</div>
				<div class="filter-group readiness-group">
					<label class="filter-label" for="readinessFilter">Readiness</label>
					<select id="readinessFilter"></select>
				</div>
			</div>
			<div class="state-tabs" role="group" aria-label="Issue view selection">
				<button class="state-tab active" id="openTab" aria-pressed="true">Open</button>
				<button class="state-tab" id="closedTab" aria-pressed="false">Closed</button>
				<button class="state-tab" id="unlinkedTab" aria-pressed="false">Unlinked</button>
			</div>
			<div class="container">
				<div class="issue-list-panel" aria-label="Issue list and overview">
					<div id="issueSummary" class="meta-row" role="status" aria-live="polite"></div>
					<div id="analysisActions" class="analysis-actions" hidden>
						<button id="runAnalysisButton" class="compact-button" type="button">Run Analysis</button>
					</div>
					<h2 class="visually-hidden" id="overviewHeading">Overview metrics</h2>
					<section id="overviewMetrics" class="overview-grid" aria-labelledby="overviewHeading" aria-live="polite"></section>
					<h2 class="visually-hidden" id="issueListHeading">Issues</h2>
					<section id="issueList" class="issue-list" role="listbox" aria-labelledby="issueListHeading"></section>
					<div id="loadingState" class="loading-state" hidden role="status" aria-live="polite">
						<div class="loading-spinner" aria-hidden="true"></div>
						<p>Loading issues...</p>
					</div>
					<div id="emptyState" class="empty-state" hidden role="status" aria-live="polite">
						<p>No issues match your filters.</p>
					</div>
					<section id="backfillPanel" class="backfill-panel" aria-labelledby="backfillHeading" aria-live="polite" hidden>
						<div class="backfill-header">
							<h2 id="backfillHeading">Unlinked work</h2>
							<div class="backfill-actions">
								<button id="refreshBackfill" class="compact-button" type="button">Refresh</button>
							</div>
						</div>
						<div id="backfillBody" class="backfill-body"></div>
					</section>
				</div>
				<div class="detail-panel" aria-label="Assessment detail">
					<h2 class="visually-hidden" id="assessmentHeading">Assessment detail</h2>
					<section id="assessmentPanel" class="assessment-panel" aria-labelledby="assessmentHeading" aria-live="polite"></section>
				</div>
			</div>`;
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
				this.services.telemetry.trackEvent('dashboard.issueSelected', {
					repository,
					issue: String(issueNumber)
				});
				await this.sendLatestAssessment(repository, issueNumber);
				break;
			}
			case 'webview.getAssessmentHistory': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					break;
				}
				await this.sendAssessmentHistory(repository, issueNumber);
				break;
			}
			case 'webview.exportAssessment': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				const formatValue = typeof message.format === 'string' ? message.format : undefined;
				const format = formatValue === 'markdown' || formatValue === 'json' ? formatValue : undefined;
				if (issueNumber === undefined || !format) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					break;
				}
				await this.exportAssessment(repository, issueNumber, format);
				break;
			}
			case 'webview.linkPullRequest': {
				const pullNumber = this.parseIssueNumber(message.pullNumber);
				if (pullNumber === undefined) {
					break;
				}
				await this.services.issueManager.linkPullRequestToIssue(pullNumber);
				break;
			}
			case 'webview.createIssueFromPullRequest': {
				const pullNumber = this.parseIssueNumber(message.pullNumber);
				if (pullNumber === undefined) {
					break;
				}
					const state = typeof message.state === 'string' ? message.state : 'open';
					await this.services.issueManager.createIssueFromPullRequest(pullNumber, { close: state === 'closed' });
				break;
			}
			case 'webview.linkCommit': {
				const sha = typeof message.sha === 'string' ? message.sha : undefined;
				if (!sha) {
					break;
				}
				await this.services.issueManager.linkCommitToIssue(sha);
				break;
			}
			case 'webview.createIssueFromCommit': {
				const sha = typeof message.sha === 'string' ? message.sha : undefined;
				if (!sha) {
					break;
				}
					const state = typeof message.state === 'string' ? message.state : 'open';
					await this.services.issueManager.createIssueFromCommit(sha, { close: state === 'closed' });
				break;
			}
			case 'webview.refreshUnlinked':
				await this.services.issueManager.refreshUnlinkedData(true);
				break;
			case 'webview.filtersChanged': {
				const filters = this.ensureFilterPayload(message.filters);
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName ?? 'unselected';
				this.services.telemetry.trackEvent('dashboard.filtersChanged', {
					repository,
					state: filters.state ?? 'open',
					readiness: filters.readiness ?? 'all',
					label: filters.label ?? 'none',
					assignee: filters.assignee ?? 'none',
					milestone: filters.milestone ?? 'none',
					search: filters.search ? 'entered' : 'empty'
				}, {
					searchLength: filters.search ? filters.search.length : 0,
					visibleIssues: snapshot.issues.length
				});
				await this.services.issueManager.updateFilters(filters);
				break;
			}
			case 'webview.signOut':
				await this.services.issueManager.signOut();
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
			case 'webview.runAssessment': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					void vscode.window.showWarningMessage('Select a repository before running an assessment.');
					break;
				}
				this.panel.webview.postMessage({ type: 'assessment.loading', issueNumber });
				this.services.telemetry.trackEvent('assessment.quickRun.requested', {
					repository,
					issue: String(issueNumber)
				});
				try {
					const record = await vscode.window.withProgress({
						title: `Assessing issue #${issueNumber}`,
						location: vscode.ProgressLocation.Notification
					}, async () => this.services.assessment.assessIssue(repository, issueNumber));
					IssueTriagePanel.broadcastAssessment(record);
					vscode.window.showInformationMessage(`IssueTriage assessment complete for #${issueNumber}.`);
				} catch (error) {
					const messageText = formatAssessmentError(error);
					this.panel.webview.postMessage({
						type: 'assessment.error',
						issueNumber,
						message: messageText
					});
					vscode.window.showErrorMessage(`Assessment failed: ${messageText}`);
				}
				break;
			}
			case 'webview.runBulkAssessment': {
				const rawValues = Array.isArray(message.issueNumbers) ? message.issueNumbers : [];
				const issueNumbers = rawValues
					.map(value => this.parseIssueNumber(value))
					.filter((value): value is number => typeof value === 'number' && value > 0);
				const uniqueIssueNumbers = Array.from(new Set(issueNumbers)).slice(0, 5);
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					void vscode.window.showWarningMessage('Select a repository before running an assessment.');
					this.panel.webview.postMessage({ type: 'assessment.bulkComplete' });
					break;
				}
				if (!uniqueIssueNumbers.length) {
					void vscode.window.showInformationMessage('No unanalyzed open issues are ready for analysis.');
					this.panel.webview.postMessage({ type: 'assessment.bulkComplete' });
					break;
				}
				this.services.telemetry.trackEvent('assessment.bulkRun.requested', {
					repository,
					total: String(uniqueIssueNumbers.length)
				});
				const successes: number[] = [];
				const failures: Array<{ issue: number; message: string }> = [];
				try {
					await vscode.window.withProgress({
						title: `Running IssueTriage analysis (${uniqueIssueNumbers.length})`,
						location: vscode.ProgressLocation.Notification
					}, async progress => {
						let completed = 0;
						for (const issueNumber of uniqueIssueNumbers) {
							completed += 1;
							progress.report({ message: `Assessing #${issueNumber} (${completed}/${uniqueIssueNumbers.length})` });
							this.panel.webview.postMessage({ type: 'assessment.loading', issueNumber });
							try {
								const record = await this.services.assessment.assessIssue(repository, issueNumber);
								IssueTriagePanel.broadcastAssessment(record);
								successes.push(issueNumber);
							} catch (error) {
								const messageText = formatAssessmentError(error);
								failures.push({ issue: issueNumber, message: messageText });
								this.panel.webview.postMessage({
									type: 'assessment.error',
									issueNumber,
									message: messageText
								});
							}
						}
					});
					const successCount = successes.length;
					const failureCount = failures.length;
					if (successCount > 0) {
						const successMessage = successCount === 1
							? `Completed assessment for issue #${successes[0]}.`
							: `Completed assessments for ${successCount} issues.`;
						void vscode.window.showInformationMessage(successMessage);
					}
					if (failureCount > 0) {
						const detail = failures
							.slice(0, 3)
							.map(item => `#${item.issue}: ${item.message}`)
							.join('; ');
						const suffix = failureCount > 3 ? `; +${failureCount - 3} more` : '';
						void vscode.window.showErrorMessage(`Assessments failed for ${failureCount} issue${failureCount === 1 ? '' : 's'}: ${detail}${suffix}`);
					}
					this.services.telemetry.trackEvent('assessment.bulkRun.completed', {
						repository,
						successCount: String(successes.length),
						failureCount: String(failures.length)
					});
				} finally {
					await this.services.issueManager.refreshAssessments();
					this.panel.webview.postMessage({
						type: 'assessment.bulkComplete',
						summary: {
							successCount: successes.length,
							failureCount: failures.length
						}
					});
				}
				break;
			}
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

	private async sendAssessmentHistory(repository: string, issueNumber: number): Promise<void> {
		try {
			const records = await this.services.assessment.getAssessmentHistory(repository, issueNumber, 20);
			const history = records.map(record => this.toWebviewAssessment(record));
			this.panel.webview.postMessage({
				type: 'assessment.history',
				issueNumber,
				history
			});
		} catch (error) {
			this.panel.webview.postMessage({
				type: 'assessment.historyError',
				issueNumber,
				message: error instanceof Error ? error.message : 'Unable to load assessment history.'
			});
		}
	}

	private async exportAssessment(repository: string, issueNumber: number, format: 'markdown' | 'json'): Promise<void> {
		const snapshot = this.services.issueManager.getSnapshot();
		const issue = snapshot.issues.find(item => item.number === issueNumber);
		if (!issue) {
			void vscode.window.showWarningMessage(`Issue #${issueNumber} is no longer available to export.`);
			return;
		}

		let record: AssessmentRecord | undefined;
		try {
			record = await this.services.assessment.getLatestAssessment(repository, issueNumber);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unable to load latest assessment from disk.';
			void vscode.window.showErrorMessage(`IssueTriage export failed: ${message}`);
			return;
		}

		if (!record) {
			void vscode.window.showInformationMessage(`No IssueTriage assessment found for #${issueNumber}. Run an assessment before exporting.`);
			return;
		}

		const readiness = snapshot.assessmentSummaries[issueNumber]?.readiness;
		const riskSummary = snapshot.riskSummaries[issueNumber];
		const readinessMeta = this.getReadinessMetadata(readiness);
		const content = format === 'markdown'
			? this.createMarkdownExport(repository, issue, record, readinessMeta, riskSummary)
			: this.createJsonExport(repository, issue, record, readinessMeta, riskSummary);

		const defaultUri = this.buildDefaultExportUri(format, issue);
		const filters: Record<string, string[]> = format === 'markdown'
			? { Markdown: ['md', 'markdown'] }
			: { JSON: ['json'] };
		const saveUri = await vscode.window.showSaveDialog({
			defaultUri,
			saveLabel: format === 'markdown' ? 'Export Markdown' : 'Export JSON',
			filters
		});
		if (!saveUri) {
			return;
		}

		try {
			await fs.writeFile(saveUri.fsPath, content, 'utf8');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unable to write export file.';
			void vscode.window.showErrorMessage(`IssueTriage export failed: ${message}`);
			return;
		}

		this.services.telemetry.trackEvent('assessment.export', {
			repository,
			issue: String(issueNumber),
			format
		});

		const openAction = 'Open File';
		const selection = await vscode.window.showInformationMessage(
			`IssueTriage ${format === 'markdown' ? 'Markdown' : 'JSON'} export saved to ${saveUri.fsPath}.`,
			openAction
		);
		if (selection === openAction) {
			const document = await vscode.workspace.openTextDocument(saveUri);
			await vscode.window.showTextDocument(document, { preview: false });
		}
	}

	private buildDefaultExportUri(format: 'markdown' | 'json', issue: IssueSummary): vscode.Uri | undefined {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return undefined;
		}
		const extension = format === 'markdown' ? '.md' : '.json';
		const fileName = `issue-${issue.number}-assessment${extension}`;
		const filePath = path.join(workspaceFolder.uri.fsPath, fileName);
		return vscode.Uri.file(filePath);
	}

	private getReadinessMetadata(readiness?: string): { key?: string; label: string; description?: string } {
		switch (readiness) {
			case 'ready':
				return { key: 'ready', label: 'Automation Ready', description: 'Safe to hand off to automation.' };
			case 'prepare':
				return { key: 'prepare', label: 'Prep Required', description: 'Add missing context then reassess.' };
			case 'review':
				return { key: 'review', label: 'Needs Review', description: 'Human review recommended before automation.' };
			case 'manual':
				return { key: 'manual', label: 'Manual Only', description: 'Keep this issue manual for now.' };
			default:
				return { label: 'Not Assessed Yet' };
		}
	}

	private createMarkdownExport(
		repository: string,
		issue: IssueSummary,
		record: AssessmentRecord,
		readiness: { key?: string; label: string; description?: string },
		riskSummary: RiskSummary | undefined
	): string {
		const assessedAt = this.formatIsoDate(record.createdAt);
		const commentUrl = this.buildCommentUrl(record);
		const metadataLines = [
			`- Repository: ${repository}`,
			`- Issue: [#${issue.number}](${issue.url})`,
			`- Title: ${issue.title}`,
			`- State: ${issue.state}`,
			`- Labels: ${issue.labels.length ? issue.labels.join(', ') : 'None'}`,
			`- Assignees: ${issue.assignees.length ? issue.assignees.join(', ') : 'None'}`,
			`- Milestone: ${issue.milestone ?? 'None'}`,
			`- Updated: ${this.formatIsoDate(issue.updatedAt)}`
		];

		const tableLines = [
			'| Dimension | Score |',
			'| --- | --- |',
			`| Composite | ${record.compositeScore.toFixed(1)} |`,
			`| Requirements | ${record.requirementsScore.toFixed(1)} |`,
			`| Complexity | ${record.complexityScore.toFixed(1)} |`,
			`| Security | ${record.securityScore.toFixed(1)} |`,
			`| Business Impact | ${record.businessScore.toFixed(1)} |`
		];

		const recommendationLines = record.recommendations.length
			? record.recommendations.map(item => `- ${item}`)
			: ['- No immediate actions recommended.'];

		const riskLines = this.createMarkdownRiskSection(riskSummary);

		const sections: string[] = [
			`# IssueTriage Assessment · ${repository} #${issue.number} – ${issue.title}`,
			`_Generated ${new Date().toISOString()}_`,
			'',
			'## Issue Metadata',
			...metadataLines,
			'',
			'## Readiness',
			`**${readiness.label}** (Composite ${record.compositeScore.toFixed(1)})`
		];
		if (readiness.description) {
			sections.push(readiness.description);
		}
		sections.push('', ...tableLines, '', `Model: ${record.model}`, `Assessment Run: ${assessedAt}`, '', '## Summary', record.summary || 'No summary provided.', '', '## Recommendations', ...recommendationLines, '', ...riskLines, '', '## References', `- Issue: ${issue.url}`);

		if (commentUrl) {
			sections.push(`- Latest comment: ${commentUrl}`);
		}

		return sections.join('\n');
	}

	private createMarkdownRiskSection(riskSummary: RiskSummary | undefined): string[] {
		if (!riskSummary) {
			return ['## Risk Insights', 'No risk intelligence captured yet.'];
		}
		switch (riskSummary.status) {
			case 'pending':
				return ['## Risk Insights', 'Risk signals are still being collected for this issue.'];
			case 'error':
				return ['## Risk Insights', `Unable to load risk insights: ${riskSummary.message ?? 'An unexpected error occurred.'}`];
			case 'skipped':
				return ['## Risk Insights', riskSummary.message ?? 'Risk analysis was skipped for this issue.'];
			case 'ready':
				return this.buildReadyRiskLines(riskSummary);
			default:
				return ['## Risk Insights', 'Risk status unknown.'];
		}
	}

	private buildReadyRiskLines(summary: RiskSummary): string[] {
		const level = summary.riskLevel ?? 'low';
		const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
		const scoreText = typeof summary.riskScore === 'number' ? summary.riskScore.toFixed(0) : 'n/a';
		const lines = [
			'## Risk Insights',
			`**${levelLabel} Risk** (Score ${scoreText})`,
		];
		if (summary.stale) {
			lines.push('Signals are refreshing; data may be stale.');
		}
		if (summary.calculatedAt) {
			lines.push(`Calculated: ${this.formatIsoDate(summary.calculatedAt)}`);
		}
		if (summary.metrics) {
			lines.push('', '### Key Metrics');
			lines.push(`- Linked pull requests: ${summary.metrics.prCount}`);
			lines.push(`- Files touched: ${summary.metrics.filesTouched}`);
			lines.push(`- Total lines changed: ${summary.metrics.changeVolume}`);
			lines.push(`- Review signals: ${summary.metrics.reviewCommentCount}`);
		}
		if (summary.topDrivers && summary.topDrivers.length) {
			lines.push('', '### Risk Drivers');
			summary.topDrivers.forEach(item => {
				lines.push(`- ${item}`);
			});
		}
		return lines;
	}

	private createJsonExport(
		repository: string,
		issue: IssueSummary,
		record: AssessmentRecord,
		readiness: { key?: string; label: string; description?: string },
		riskSummary: RiskSummary | undefined
	): string {
		const payload: Record<string, unknown> = {
			generatedAt: new Date().toISOString(),
			repository,
			issue: {
				number: issue.number,
				title: issue.title,
				url: issue.url,
				state: issue.state,
				labels: issue.labels,
				assignees: issue.assignees,
				milestone: issue.milestone ?? null,
				updatedAt: this.formatIsoDate(issue.updatedAt)
			},
			assessment: {
				compositeScore: record.compositeScore,
				requirementsScore: record.requirementsScore,
				complexityScore: record.complexityScore,
				securityScore: record.securityScore,
				businessScore: record.businessScore,
				recommendations: record.recommendations,
				summary: record.summary,
				model: record.model,
				createdAt: this.formatIsoDate(record.createdAt),
				commentUrl: this.buildCommentUrl(record) ?? null
			}
		};
		if (readiness.key) {
			payload.readiness = {
				key: readiness.key,
				label: readiness.label,
				description: readiness.description ?? null
			};
		}
		if (riskSummary) {
			payload.risk = {
				status: riskSummary.status,
				riskLevel: riskSummary.riskLevel ?? null,
				riskScore: riskSummary.riskScore ?? null,
				calculatedAt: riskSummary.calculatedAt ? this.formatIsoDate(riskSummary.calculatedAt) : null,
				topDrivers: riskSummary.topDrivers ?? [],
				metrics: riskSummary.metrics ?? null,
				stale: Boolean(riskSummary.stale),
				message: riskSummary.message ?? null
			};
		}
		return JSON.stringify(payload, null, 2);
	}

	private formatIsoDate(value: string | undefined): string {
		if (!value) {
			return 'n/a';
		}
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return value;
		}
		return date.toISOString();
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
		const stateValue = this.normalizeString(payload.state);
		const normalizedState = stateValue === 'open' || stateValue === 'closed' ? stateValue : undefined;
		const readinessValue = this.normalizeString(payload.readiness);
		const normalizedReadiness = readinessValue === 'all'
			|| readinessValue === 'ready'
			|| readinessValue === 'prepare'
			|| readinessValue === 'review'
			|| readinessValue === 'manual'
			? readinessValue
			: undefined;
		return {
			search: this.normalizeString(payload.search),
			label: this.normalizeString(payload.label),
			assignee: this.normalizeString(payload.assignee),
			milestone: this.normalizeString(payload.milestone),
			state: normalizedState,
			readiness: normalizedReadiness
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
