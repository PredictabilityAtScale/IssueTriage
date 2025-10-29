import * as vscode from 'vscode';
import type { IssueManager } from './issueManager';

interface ReadinessDefinition {
	key: string;
	label: string;
}

interface MatrixPoint {
	issueNumber: number;
	title: string;
	readinessScore: number;
	businessScore: number;
	readinessKey: string;
	readinessLabel: string;
	url?: string;
}

const READINESS_LABELS: Record<string, string> = {
	ready: 'Automation Ready',
	prepare: 'Prep Required',
	review: 'Needs Review',
	manual: 'Manual Only'
};

const READINESS_ORDER: string[] = ['ready', 'prepare', 'review', 'manual'];

type IssueManagerSnapshot = ReturnType<IssueManager['getSnapshot']>;

type SidebarMessage = {
	type: 'sidebarMatrix.update';
	dataset: MatrixPoint[];
	legend: ReadinessDefinition[];
	repository?: string;
	updatedAt?: string;
};

type SidebarInboundMessage = {
	type: 'sidebarMatrix.openIssue';
	url?: string;
};

export class SidebarMatrixView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private lastSnapshot: IssueManagerSnapshot;
	private lastDataset: MatrixPoint[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly issueManager: IssueManager) {
		this.lastSnapshot = this.issueManager.getSnapshot();
		this.disposables.push(
			this.issueManager.onDidChangeState(state => {
				this.lastSnapshot = state;
				this.postState(state);
			})
		);
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		const webview = webviewView.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')]
		};
		webview.html = this.getHtml(webview);

		const disposeListener = webviewView.onDidDispose(() => {
			this.view = undefined;
			disposeListener.dispose();
		});

		webview.onDidReceiveMessage(async message => {
			this.handleMessage(message as SidebarInboundMessage);
		});

		this.postState(this.lastSnapshot);
	}

	dispose(): void {
		while (this.disposables.length) {
			const disposable = this.disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}

	private async handleMessage(message: SidebarInboundMessage): Promise<void> {
		if (!message || typeof message.type !== 'string') {
			return;
		}
		if (message.type === 'sidebarMatrix.openIssue' && typeof message.url === 'string' && message.url.length > 0) {
			try {
				await vscode.env.openExternal(vscode.Uri.parse(message.url));
			} catch (error) {
				const description = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Unable to open issue: ${description}`);
			}
		}
	}

	private postState(snapshot?: IssueManagerSnapshot): void {
		if (!this.view) {
			return;
		}
		const state = snapshot ?? this.issueManager.getSnapshot();
		let dataset: MatrixPoint[];
		if ((state.filters?.state ?? 'open') === 'open') {
			dataset = this.collectMatrixPoints(state);
			this.lastDataset = dataset.slice();
		} else {
			dataset = this.lastDataset;
		}
		const legend: ReadinessDefinition[] = READINESS_ORDER.map(key => ({ key, label: READINESS_LABELS[key] ?? key }));
		const payload: SidebarMessage = {
			type: 'sidebarMatrix.update',
			dataset,
			legend,
			repository: state.selectedRepository?.fullName,
			updatedAt: state.lastUpdated
		};
		void this.view.webview.postMessage(payload);
		this.view.description = dataset.length ? `${dataset.length} assessed` : 'Assess open issues to populate the matrix';
	}

	private collectMatrixPoints(state: IssueManagerSnapshot): MatrixPoint[] {
		const issues = Array.isArray(state.issues) ? state.issues : [];
		const summaries = state.assessmentSummaries ?? {};
		const points: MatrixPoint[] = [];

		for (const issue of issues) {
			if (!issue || issue.state !== 'open') {
				continue;
			}
			const summary = summaries[issue.number];
			if (!summary || typeof summary.businessScore !== 'number') {
				continue;
			}
			const readinessScore = this.clampScore(summary.compositeScore);
			const businessScore = this.clampScore(summary.businessScore);
			const readinessKey = summary.readiness ?? 'prepare';
			const readinessLabel = READINESS_LABELS[readinessKey] ?? readinessKey;
			points.push({
				issueNumber: issue.number,
				title: typeof issue.title === 'string' ? issue.title : `Issue #${issue.number}`,
				readinessScore,
				businessScore,
				readinessKey,
				readinessLabel,
				url: typeof issue.url === 'string' ? issue.url : undefined
			});
		}

		points.sort((a, b) => {
			if (b.businessScore !== a.businessScore) {
				return b.businessScore - a.businessScore;
			}
			return b.readinessScore - a.readinessScore;
		});

		return points;
	}

	private clampScore(value: number | undefined): number {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) {
			return 0;
		}
		return Math.max(0, Math.min(100, Math.round(numeric * 10) / 10));
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'sidebarMatrix.js'));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Opportunity Mix</title>
	<style nonce="${nonce}">
		:root {
			color-scheme: light dark;
			font-family: var(--vscode-font-family, Segoe WPC, Segoe UI, sans-serif);
			font-size: 12px;
		}

		body {
			margin: 0;
			padding: 12px;
			background: transparent;
			color: var(--vscode-foreground);
		}

		.visually-hidden {
			position: absolute;
			width: 1px;
			height: 1px;
			margin: -1px;
			padding: 0;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			border: 0;
		}

		.sidebar-matrix {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.matrix-legend {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
		}

		.matrix-legend-item {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 2px 6px;
			border-radius: 999px;
			background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
			border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			font-size: 11px;
		}

		.matrix-legend-swatch {
			width: 8px;
			height: 8px;
			border-radius: 50%;
		}

		.matrix-legend-swatch.readiness-ready { background: rgba(46, 160, 67, 0.9); }
		.matrix-legend-swatch.readiness-prepare { background: rgba(187, 128, 9, 0.9); }
		.matrix-legend-swatch.readiness-review { background: rgba(229, 140, 33, 0.9); }
		.matrix-legend-swatch.readiness-manual { background: rgba(229, 83, 75, 0.9); }

		.sidebar-matrix-wrapper {
			position: relative;
			width: 100%;
			aspect-ratio: 4 / 3;
			overflow: visible;
			border-radius: 6px;
			border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
		}

		.sidebar-matrix-wrapper svg {
			display: block;
			width: 100%;
			height: 100%;
			overflow: visible;
		}

		.sidebar-matrix-empty {
			position: absolute;
			inset: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			text-align: center;
			padding: 12px;
			font-size: 12px;
			color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			background: color-mix(in srgb, var(--vscode-editor-background) 96%, transparent 4%);
		}

		.sidebar-matrix-wrapper[data-has-data="true"] .sidebar-matrix-empty {
			display: none;
		}

		.sidebar-matrix-legend {
			margin-top: 8px;
			justify-content: center;
		}

		.matrix-axis {
			stroke: color-mix(in srgb, var(--vscode-editor-foreground) 24%, transparent 76%);
			stroke-width: 0.5;
		}

		.matrix-axis.axis-mid {
			stroke-dasharray: 2 2;
		}

		.matrix-label {
			font-size: 10px;
			fill: color-mix(in srgb, var(--vscode-editor-foreground) 48%, transparent 52%);
			letter-spacing: 0.08em;
		}

		.matrix-point {
			stroke: transparent;
			cursor: pointer;
		}

		.matrix-point:focus {
			outline: none;
			stroke: var(--vscode-focusBorder, #0098ff);
			stroke-width: 1.6;
		}

		.matrix-point.readiness-ready { fill: rgba(46, 160, 67, 0.9); }
		.matrix-point.readiness-prepare { fill: rgba(187, 128, 9, 0.9); }
		.matrix-point.readiness-review { fill: rgba(229, 140, 33, 0.9); }
		.matrix-point.readiness-manual { fill: rgba(229, 83, 75, 0.9); }

		.matrix-info-panel {
			margin-top: 8px;
			padding: 8px 10px;
			border-radius: 4px;
			border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-button-background) 4%);
			min-height: 52px;
			font-size: 11px;
			line-height: 1.4;
		}

		.matrix-info-panel[hidden] {
			display: none;
		}

		.matrix-info-title {
			font-weight: 600;
			margin: 0 0 4px 0;
			font-size: 12px;
			color: var(--vscode-foreground);
		}

		.matrix-info-meta {
			color: var(--vscode-descriptionForeground, #888);
			font-size: 11px;
			margin: 2px 0;
		}

		.matrix-info-empty {
			color: var(--vscode-descriptionForeground, #888);
			font-style: italic;
		}
	</style>
</head>
<body>
	<section class="sidebar-matrix" aria-labelledby="sidebarMatrixHeading">
		<h2 id="sidebarMatrixHeading" class="visually-hidden">Opportunity Mix</h2>
		<div class="sidebar-matrix-wrapper" id="sidebarMatrixWrapper" data-has-data="false">
			<svg id="sidebarMatrixSvg" viewBox="0 0 100 100" role="img" aria-label="Readiness vs business value"></svg>
			<div class="sidebar-matrix-empty" id="sidebarMatrixEmpty">Assess open issues to visualize readiness versus value.</div>
		</div>
		<div class="matrix-legend sidebar-matrix-legend" id="sidebarMatrixLegend" aria-hidden="true"></div>
		<div class="matrix-info-panel" id="sidebarMatrixInfo" hidden>
			<div class="matrix-info-empty">Hover over a point to see details</div>
		</div>
	</section>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
