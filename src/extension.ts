// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	console.log('IssueTriage extension activated.');

	const openPanel = vscode.commands.registerCommand('issuetriage.openPanel', () => {
		IssueTriagePanel.createOrShow(context);
	});

	context.subscriptions.push(openPanel);
}

// This method is called when your extension is deactivated
export function deactivate() {}

class IssueTriagePanel {
	public static readonly viewType = 'issuetriage.panel';
	private static currentPanel: IssueTriagePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(context: vscode.ExtensionContext) {
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

		IssueTriagePanel.currentPanel = new IssueTriagePanel(panel, context.extensionUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this.panel = panel;
		this.extensionUri = extensionUri;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.update();
	}

	private update() {
		this.panel.title = 'Issue Triage';
		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
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
					padding: 16px;
					background: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
				}

				h1 {
					margin-top: 0;
					font-size: 18px;
				}

				section {
					margin-top: 16px;
				}

				details {
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 12px;
					margin-top: 12px;
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
				}

				details[open] summary {
					font-weight: 600;
				}

				summary {
					cursor: pointer;
				}

				button {
					margin-top: 12px;
					padding: 6px 12px;
					border-radius: 4px;
					border: 1px solid transparent;
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
				}

				button:hover {
					filter: brightness(1.05);
				}

				.status-pill {
					display: inline-flex;
					align-items: center;
					gap: 6px;
					padding: 4px 10px;
					border-radius: 999px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-button-background) 12%);
					font-weight: 500;
				}

				.checklist {
					display: grid;
					gap: 10px;
					margin-top: 12px;
				}

				.checklist label {
					display: flex;
					align-items: flex-start;
					gap: 10px;
				}

				.checklist input {
					margin-top: 3px;
				}

				.metric {
					display: flex;
					justify-content: space-between;
					margin-top: 12px;
					padding: 8px 12px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}
			</style>
		</head>
		<body>
			<h1>Issue Triage Dashboard</h1>
			<p class="status-pill"><span id="statusEmoji" aria-hidden="true">🟡</span><span id="statusLabel">Needs Review</span></p>
			<p>Run through these readiness checks to understand how close an issue is to implementation. Toggle the items that apply.</p>

			<section>
				<h2>Risk &amp; Readiness Checklist</h2>
				<div class="checklist">
					<label><input type="checkbox" data-weight="2">Clear problem statement and acceptance criteria</label>
					<label><input type="checkbox" data-weight="2">User impact assessed with supporting evidence</label>
					<label><input type="checkbox" data-weight="1">Dependencies identified and owners aligned</label>
					<label><input type="checkbox" data-weight="1">Security and privacy considerations reviewed</label>
					<label><input type="checkbox" data-weight="1">Rough delivery estimate agreed with the team</label>
					<label><input type="checkbox" data-weight="1">Test strategy or success metrics drafted</label>
				</div>
			</section>

			<section>
				<h2>Risk Notes</h2>
				<details open>
					<summary>Scope clarity</summary>
					<p>Ensure the issue links to design specs, documents, or supporting cases so the scope is explicit.</p>
				</details>
				<details>
					<summary>Operational readiness</summary>
					<p>Confirm alerting, runbooks, and rollout safeguards exist if this change impacts production systems.</p>
				</details>
				<details>
					<summary>Stakeholder alignment</summary>
					<p>Identify reviewers and approvers early to avoid delays once implementation starts.</p>
				</details>
			</section>

			<section>
				<h2>Summary</h2>
				<div class="metric">
					<strong>Readiness score</strong>
					<span id="score">0 / 8</span>
				</div>
				<div class="metric">
					<strong>Recommended next step</strong>
					<span id="nextStep">Collect more detail before scheduling.</span>
				</div>
				<button id="reset">Reset checklist</button>
			</section>

			<script nonce="${nonce}">
				const points = Array.from(document.querySelectorAll('input[type="checkbox"]'));
				const totalWeight = points.reduce((sum, checkbox) => sum + Number(checkbox.dataset.weight ?? '1'), 0);
				const statusEmoji = document.getElementById('statusEmoji');
				const statusLabel = document.getElementById('statusLabel');
				const scoreLabel = document.getElementById('score');
				const nextStep = document.getElementById('nextStep');
				const reset = document.getElementById('reset');

				function recompute() {
					const achieved = points.reduce((sum, checkbox) => sum + (checkbox.checked ? Number(checkbox.dataset.weight ?? '1') : 0), 0);
					scoreLabel.textContent = achieved + ' / ' + totalWeight;

					const ratio = totalWeight === 0 ? 0 : achieved / totalWeight;
					if (ratio >= 0.75) {
						statusEmoji.textContent = '🟢';
						statusLabel.textContent = 'Ready to Schedule';
						nextStep.textContent = 'Slot the work into the upcoming iteration and confirm owners.';
					} else if (ratio >= 0.4) {
						statusEmoji.textContent = '🟡';
						statusLabel.textContent = 'Needs Review';
						nextStep.textContent = 'Review outstanding items with stakeholders and clarify unknowns.';
					} else {
						statusEmoji.textContent = '🔴';
						statusLabel.textContent = 'Not Ready';
						nextStep.textContent = 'Gather missing information before the issue can be scheduled.';
					}
				}

				points.forEach(checkbox => checkbox.addEventListener('change', recompute));
				reset.addEventListener('click', () => {
					points.forEach(checkbox => { checkbox.checked = false; });
					recompute();
				});

				recompute();
			</script>
		</body>
		</html>`;
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
