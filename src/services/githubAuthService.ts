import * as vscode from 'vscode';
import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device';
import { CredentialService } from './credentialService';
import { SettingsService } from './settingsService';
import { StateService } from './stateService';
import { TelemetryService } from './telemetryService';

const TOKEN_SECRET_KEY = 'github.oauth.token';
const REFRESH_TOKEN_SECRET_KEY = 'github.oauth.refresh';
const SESSION_STATE_KEY = 'github.session';

interface DeviceVerification {
	verification_uri: string;
	user_code: string;
	expires_in: number;
	interval: number;
	verification_uri_complete?: string;
}

export interface GitHubSessionMetadata {
	login: string;
	name?: string;
	scopes: string[];
	expiresAt?: string;
	avatarUrl?: string;
}

export interface GitHubAuthConfig {
	clientId: string;
	clientSecret: string;
	scopes: string[];
}

export class GitHubAuthService {
	private readonly scopes = ['repo', 'read:user'];

	constructor(
		private readonly credentials: CredentialService,
		private readonly settings: SettingsService,
		private readonly state: StateService,
		private readonly telemetry: TelemetryService
	) {}

	public async getSessionMetadata(): Promise<GitHubSessionMetadata | undefined> {
		return this.state.getGlobal<GitHubSessionMetadata>(SESSION_STATE_KEY);
	}

	public async hasValidSession(): Promise<boolean> {
		const metadata = await this.getSessionMetadata();
		if (!metadata) {
			return false;
		}
		const token = await this.credentials.retrieveSecret(TOKEN_SECRET_KEY);
		if (!token) {
			return false;
		}
		if (!metadata.expiresAt) {
			return true;
		}
		return new Date(metadata.expiresAt).getTime() > Date.now();
	}

	public async getAccessToken(): Promise<string | undefined> {
		if (!(await this.hasValidSession())) {
			return undefined;
		}
		return this.credentials.retrieveSecret(TOKEN_SECRET_KEY);
	}

	public async signIn(): Promise<GitHubSessionMetadata> {
		const config = this.resolveConfig();
		const auth = createOAuthDeviceAuth({
			clientType: 'oauth-app',
			clientId: config.clientId,
			clientSecret: config.clientSecret,
			scopes: config.scopes,
			onVerification: (verification: DeviceVerification) => {
				this.handleVerification(verification);
			}
		} as unknown as Parameters<typeof createOAuthDeviceAuth>[0]);

		this.telemetry.trackEvent('github.auth.start');
		const result = await auth({ type: 'oauth' }) as { token: string; refreshToken?: string; expiresAt?: string };
		const token = result.token;

		await this.credentials.storeSecret(TOKEN_SECRET_KEY, token);
		if (result.refreshToken) {
			await this.credentials.storeSecret(REFRESH_TOKEN_SECRET_KEY, result.refreshToken);
		}

		const metadata = await this.enrichSession(token, result.expiresAt);
		await this.state.updateGlobal(SESSION_STATE_KEY, metadata);
		this.telemetry.trackEvent('github.auth.completed');
		return metadata;
	}

	public async signOut(): Promise<void> {
		await this.credentials.deleteSecret(TOKEN_SECRET_KEY);
		await this.credentials.deleteSecret(REFRESH_TOKEN_SECRET_KEY);
		await this.state.updateGlobal(SESSION_STATE_KEY, undefined);
		this.telemetry.trackEvent('github.auth.signOut');
	}

	private resolveConfig(): GitHubAuthConfig {
		const clientId = this.settings.get<string>('github.oauthClientId') || process.env.ISSUETRIAGE_GITHUB_CLIENT_ID;
		const clientSecret = this.settings.get<string>('github.oauthClientSecret') || process.env.ISSUETRIAGE_GITHUB_CLIENT_SECRET;
		if (!clientId || !clientSecret) {
			throw new Error('GitHub OAuth client credentials are not configured. Set the settings issuetriage.github.oauthClientId and issuetriage.github.oauthClientSecret or use environment variables ISSUETRIAGE_GITHUB_CLIENT_ID / ISSUETRIAGE_GITHUB_CLIENT_SECRET.');
		}
		return { clientId, clientSecret, scopes: this.scopes };
	}

	private handleVerification(verification: DeviceVerification): void {
		const message = `Open ${verification.verification_uri} and enter code ${verification.user_code}`;
		void vscode.env.openExternal(vscode.Uri.parse(verification.verification_uri));
		void vscode.env.clipboard.writeText(verification.user_code);
		void vscode.window.showInformationMessage(message, 'Copy Code', 'Open Verification URL').then(selection => {
			if (selection === 'Copy Code') {
				void vscode.env.clipboard.writeText(verification.user_code);
			}
			if (selection === 'Open Verification URL') {
				void vscode.env.openExternal(vscode.Uri.parse(verification.verification_uri_complete ?? verification.verification_uri));
			}
		});
	}

	private async enrichSession(token: string, expiresAt?: string): Promise<GitHubSessionMetadata> {
		const { Octokit } = await import('@octokit/core');
		const octokit = new Octokit({ auth: token });
		const { data } = await octokit.request('GET /user');
		return {
			login: data.login,
			name: data.name ?? undefined,
			scopes: this.scopes,
			expiresAt,
			avatarUrl: data.avatar_url ?? undefined
		};
	}
}
