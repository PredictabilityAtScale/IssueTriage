import * as vscode from 'vscode';

export interface AIAssistant {
	id: string;
	name: string;
	available: boolean;
	commandId?: string;
}

export class AIIntegrationService {
	public getAvailableAssistants(): AIAssistant[] {
		const assistants: AIAssistant[] = [];
		const appName = vscode.env.appName.toLowerCase();

		// Detect Cursor
		if (appName.includes('cursor')) {
			assistants.push({
				id: 'cursor',
				name: 'Cursor Composer',
				available: true,
				commandId: 'cursor.composer'
			});
		}

		// Detect GitHub Copilot Chat
		const copilotChat = vscode.extensions.getExtension('github.copilot-chat');
		if (copilotChat) {
			assistants.push({
				id: 'copilot-chat',
				name: 'GitHub Copilot',
				available: copilotChat.isActive || true,
				commandId: 'workbench.panel.chat.view.copilot'
			});
		}

		// Detect standard GitHub Copilot (older versions)
		const copilot = vscode.extensions.getExtension('github.copilot');
		if (copilot && !copilotChat) {
			assistants.push({
				id: 'copilot',
				name: 'GitHub Copilot',
				available: copilot.isActive || true
			});
		}

		// If no specific assistant detected, offer clipboard fallback
		if (assistants.length === 0) {
			assistants.push({
				id: 'clipboard',
				name: 'Copy to Clipboard',
				available: true
			});
		}

		return assistants;
	}

	public async sendToAssistant(assistant: AIAssistant, issueContext: string): Promise<void> {
		switch (assistant.id) {
			case 'cursor':
				// Cursor: Copy to clipboard and notify user to open Composer
				await vscode.env.clipboard.writeText(issueContext);
				const cursorAction = await vscode.window.showInformationMessage(
					'Issue context copied! Open Cursor Composer (Cmd/Ctrl+I) to paste.',
					'Open Composer'
				);
				if (cursorAction === 'Open Composer') {
					// Try to open Cursor Composer if command exists
					try {
						await vscode.commands.executeCommand('aichat.newchataction');
					} catch {
						// Command might not be available, user can open manually
					}
				}
				break;

			case 'copilot-chat':
				// GitHub Copilot Chat: Open chat panel and copy context
				await vscode.env.clipboard.writeText(issueContext);
				try {
					await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
					vscode.window.showInformationMessage('Issue context copied! Paste into Copilot Chat.');
				} catch (error) {
					vscode.window.showWarningMessage('Could not open Copilot Chat. Context copied to clipboard.');
				}
				break;

			case 'copilot':
				// Legacy Copilot: Just copy to clipboard
				await vscode.env.clipboard.writeText(issueContext);
				vscode.window.showInformationMessage('Issue context copied to clipboard!');
				break;

			case 'clipboard':
			default:
				// Fallback: Copy to clipboard
				await vscode.env.clipboard.writeText(issueContext);
				vscode.window.showInformationMessage('Issue context copied to clipboard!');
				break;
		}
	}

	public formatIssueContext(
		repository: string,
		issueNumber: number,
		title: string,
		body: string,
		url: string,
		assessment?: {
			compositeScore: number;
			recommendations: string[];
			summary: string;
		}
	): string {
		const lines = [
			'# GitHub Issue Context',
			'',
			`**Repository:** ${repository}`,
			`**Issue:** #${issueNumber}`,
			`**Title:** ${title}`,
			`**URL:** ${url}`,
			''
		];

		if (assessment) {
			lines.push(
				'## IssueTriage Assessment',
				'',
				`**Automation Readiness Score:** ${assessment.compositeScore.toFixed(1)}/100`,
				'',
				`**Summary:** ${assessment.summary}`,
				''
			);

			if (assessment.recommendations.length > 0) {
				lines.push(
					'**Questions to Address:**',
					...assessment.recommendations.map(rec => `- ${rec}`),
					''
				);
			}
		}

		lines.push(
			'## Issue Description',
			'',
			body || '(No description provided)',
			'',
			'---',
			'',
			'Please implement this GitHub issue. Consider the assessment recommendations if provided.'
		);

		return lines.join('\n');
	}

	public getEnvironmentInfo(): { app: string; isCursor: boolean; isVSCode: boolean } {
		const appName = vscode.env.appName;
		return {
			app: appName,
			isCursor: appName.toLowerCase().includes('cursor'),
			isVSCode: appName.toLowerCase().includes('visual studio code')
		};
	}

	/**
	 * Checks if the given repository matches the currently open workspace folder's git repository.
	 * Returns true if they match, false if they don't, or undefined if workspace repo can't be determined.
	 */
	public async isWorkspaceRepository(issueRepository: string): Promise<boolean | undefined> {
		const normalized = this.normalizeRepositorySlug(issueRepository);
		if (!normalized) {
			return undefined;
		}

		const workspaceSlug = await this.detectWorkspaceRepositorySlug();
		if (!workspaceSlug) {
			return undefined; // Can't determine workspace repo
		}

		return normalized === workspaceSlug;
	}

	private async detectWorkspaceRepositorySlug(): Promise<string | undefined> {
		try {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length === 0) {
				return undefined;
			}

			const gitExtension = vscode.extensions.getExtension<any>('vscode.git');
			if (!gitExtension) {
				return undefined;
			}

			const gitExports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
			const api = gitExports?.getAPI?.(1);
			if (!api) {
				return undefined;
			}

			for (const folder of folders) {
				const repository = api.getRepository?.(folder.uri) ?? api.repositories.find((repo: any) =>
					folder.uri.fsPath.startsWith(repo.rootUri.fsPath) || repo.rootUri.fsPath.startsWith(folder.uri.fsPath)
				);

				if (!repository) {
					continue;
				}

				const slug = this.pickRemoteSlug(repository.state.remotes);
				if (slug) {
					return this.normalizeRepositorySlug(slug);
				}
			}
		} catch {
			// Silently fail - workspace detection is optional
		}
		return undefined;
	}

	private pickRemoteSlug(remotes: any[]): string | undefined {
		if (!remotes || remotes.length === 0) {
			return undefined;
		}

		const candidates = [...remotes];
		const originIndex = candidates.findIndex(remote => remote.name === 'origin');
		if (originIndex > 0) {
			const [origin] = candidates.splice(originIndex, 1);
			candidates.unshift(origin);
		}

		for (const remote of candidates) {
			const slug = this.extractSlugFromRemoteUrl(remote.fetchUrl) ?? this.extractSlugFromRemoteUrl(remote.pushUrl);
			if (slug) {
				return slug;
			}
		}
		return undefined;
	}

	private extractSlugFromRemoteUrl(url?: string): string | undefined {
		if (!url) {
			return undefined;
		}

		let normalized = url.trim();
		if (!normalized) {
			return undefined;
		}

		normalized = normalized.replace(/\.git$/i, '');
		normalized = normalized.replace(/\/+$/u, '');

		const hostIndex = normalized.toLowerCase().indexOf('github.com');
		if (hostIndex === -1) {
			return undefined;
		}

		const hostTerminator = hostIndex + 'github.com'.length;
		let pathPart = normalized.slice(hostTerminator);
		pathPart = pathPart.replace(/^[:/]+/, '');

		if (!pathPart) {
			return undefined;
		}

		const segments = pathPart.split('/');
		if (segments.length < 2) {
			return undefined;
		}

		const owner = segments[0];
		const repo = segments[1];

		if (!owner || !repo) {
			return undefined;
		}

		return `${owner}/${repo}`;
	}

	private normalizeRepositorySlug(slug: string | undefined): string | undefined {
		if (!slug) {
			return undefined;
		}
		const trimmed = slug.trim();
		if (!trimmed) {
			return undefined;
		}
		return trimmed.toLowerCase();
	}
}
