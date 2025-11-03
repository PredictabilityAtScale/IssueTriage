import * as vscode from 'vscode';
import { UsageTapService } from './services/usageTapService';

export class UsageTapView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly customerId: string;

	constructor(
		private readonly usageTap: UsageTapService
	) {
		this.customerId = this.usageTap.getCustomerId();
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		const webview = webviewView.webview;
		
		webview.options = {
			enableScripts: true
		};
		
		webview.html = this.getLoadingHtml(webview);
		void (async () => {
			const provisioned = await this.usageTap.ensureCustomerProvisioned();
			if (!this.view || this.view.webview !== webview) {
				return;
			}
			if (!provisioned) {
				webview.html = this.getErrorHtml(webview, 'Unable to load UsageTap usage widget. Customer provisioning failed.');
				return;
			}
			webview.html = this.getHtml(webview);
		})().catch(error => {
			console.warn('[IssueTriage] Failed to ensure UsageTap customer for sidebar widget:', error);
			if (this.view?.webview) {
				this.view.webview.html = this.getErrorHtml(this.view.webview, 'Unable to load UsageTap usage widget. Check console for details.');
			}
		});

		const disposeListener = webviewView.onDidDispose(() => {
			this.view = undefined;
			disposeListener.dispose();
		});
	}

	dispose(): void {
		while (this.disposables.length) {
			const disposable = this.disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const iframeSrc = `https://usagetap.com/embed-api/render?api_key=ek-5p6ZQVeedlbzFRO5xN1YBlLtMihH9svY85fVKZQiOng&organization_id=dbc2357b-7ab0-4a5e-af23-4bd114afc044&customer_id=${encodeURIComponent(this.customerId)}&type=usage&format=compact&theme=auto&metrics=premiumCalls,standardCalls&refresh=60`;
		const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; frame-src https://usagetap.com; script-src 'nonce-${nonce}';`;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>LLM Usage</title>
	<style>
		:root {
			color-scheme: light dark;
			font-family: var(--vscode-font-family, Segoe WPC, Segoe UI, sans-serif);
			font-size: 12px;
		}

		body {
			margin: 0;
			padding: 12px;
			background: var(--vscode-editor-background, #1e1e1e);
			color: var(--vscode-foreground, #cccccc);
		}

		.usage-container {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}

		.usage-header {
			font-size: 13px;
			font-weight: 600;
			color: var(--vscode-foreground);
		}

		.usage-description {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			line-height: 1.4;
		}

		.usagetap-widget {
			width: 100%;
			min-height: 200px;
			border-radius: 12px;
			border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
			overflow: hidden;
			background: var(--vscode-editor-background, #1e1e1e);
		}

		/* Override UsageTap widget styles to match VS Code theme */
		.usagetap-widget iframe {
			border-radius: 0;
			border: 0;
		}
	</style>
</head>
<body>
	<div class="usage-container">
		<div class="usage-description">Monitor your included AI model usage and token consumption tracked by UsageTap.com. You can add your own API key in issue triage settings.</div>
		<!-- UsageTap Widget (iframe) -->
		<div class="usagetap-widget">
			<iframe src="${iframeSrc}"
				width="100%"
				height="200"
				frameborder="0"
				style="background: transparent;"
				allowtransparency="true"
				title="UsageTap usage summary">
			</iframe>
		</div>
		<script nonce="${nonce}">
			(function syncThemeSurface() {
				try {
					const computed = getComputedStyle(document.documentElement);
					const editorBg = (computed.getPropertyValue('--vscode-editor-background') || '').trim();
					document.body.style.background = editorBg || '#1e1e1e';
					const fg = (computed.getPropertyValue('--vscode-editor-foreground')
						|| computed.getPropertyValue('--vscode-foreground')
						|| '').trim();
					if (fg) {
						document.body.style.color = fg;
					}
				} catch (error) {
					console.warn('[IssueTriage] Failed to sync sidebar UsageTap theme', error);
					document.body.style.background = '#1e1e1e';
				}
			}());
		</script>
	</div>
</body>
</html>`;
	}

	private getLoadingHtml(webview: vscode.Webview): string {
		const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>LLM Usage</title>
	<style>
		body { margin: 0; padding: 12px; font-family: var(--vscode-font-family, Segoe WPC, Segoe UI, sans-serif); color: var(--vscode-foreground); background: transparent; }
		.loading { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
		.spinner { width: 24px; height: 24px; border-radius: 50%; border: 3px solid color-mix(in srgb, var(--vscode-editor-foreground) 35%, transparent); border-top-color: var(--vscode-button-background); animation: spin 1s linear infinite; }
		@keyframes spin { to { transform: rotate(360deg); } }
	</style>
</head>
<body>
	<div class="loading">
		<div class="spinner" aria-hidden="true"></div>
		<span>Preparing UsageTap widget…</span>
	</div>
</body>
</html>`;
	}

	private getErrorHtml(webview: vscode.Webview, message: string): string {
		const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>LLM Usage</title>
	<style>
		body { margin: 0; padding: 12px; font-family: var(--vscode-font-family, Segoe WPC, Segoe UI, sans-serif); color: var(--vscode-foreground); background: transparent; }
		.error { border-radius: 8px; border: 1px solid var(--vscode-editorError-border, rgba(229, 83, 75, 0.6)); background: color-mix(in srgb, var(--vscode-editor-background) 92%, rgba(229, 83, 75, 0.15)); padding: 16px; font-size: 12px; }
	</style>
</head>
<body>
	<div class="error">${message}</div>
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
