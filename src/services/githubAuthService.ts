import * as vscode from 'vscode';
import { CredentialService } from './credentialService';
import { StateService } from './stateService';
import { TelemetryService } from './telemetryService';
import { LlmGateway } from './llmGateway';

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

interface RemoteDeviceStartResponse {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
	interval: number;
}

interface RemoteDevicePollSuccess {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	scope?: string;
	tokenType?: string;
}

export class GitHubAuthService {
	private readonly scopes = ['repo', 'read:user'];

	constructor(
		private readonly credentials: CredentialService,
		private readonly state: StateService,
		private readonly telemetry: TelemetryService,
		private readonly llmGateway: LlmGateway
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
		const llmMode = this.llmGateway.getMode();
		const authMode = 'remote';
		this.telemetry.trackEvent('github.auth.start', { authMode, llmMode });
		try {
			const metadata = await this.signInViaProxy();
			this.telemetry.trackEvent('github.auth.completed', { authMode, llmMode });
			return metadata;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.telemetry.trackEvent('github.auth.failed', { authMode, llmMode, message });
			throw error instanceof Error ? error : new Error(message);
		}
	}

	public async signOut(): Promise<void> {
		await this.credentials.deleteSecret(TOKEN_SECRET_KEY);
		await this.credentials.deleteSecret(REFRESH_TOKEN_SECRET_KEY);
		await this.state.updateGlobal(SESSION_STATE_KEY, undefined);
		this.telemetry.trackEvent('github.auth.signOut');
	}

	private async signInViaProxy(): Promise<GitHubSessionMetadata> {
		const baseUrl = this.getProxyBaseUrl();
		const start = await this.startProxyDeviceFlow(baseUrl);
		this.handleVerification({
			verification_uri: start.verificationUri,
			verification_uri_complete: start.verificationUriComplete,
			user_code: start.userCode,
			expires_in: start.expiresIn,
			interval: start.interval
		});
		const pollResult = await this.pollProxyDeviceFlow(baseUrl, start.deviceCode, start.interval, start.expiresIn);
		const expiresAt = typeof pollResult.expiresIn === 'number'
			? new Date(Date.now() + pollResult.expiresIn * 1000).toISOString()
			: undefined;
		return this.persistSession(pollResult.accessToken, pollResult.refreshToken, expiresAt);
	}

	private async persistSession(token: string, refreshToken?: string, expiresAt?: string): Promise<GitHubSessionMetadata> {
		await this.credentials.storeSecret(TOKEN_SECRET_KEY, token);
		if (refreshToken) {
			await this.credentials.storeSecret(REFRESH_TOKEN_SECRET_KEY, refreshToken);
		} else {
			await this.credentials.deleteSecret(REFRESH_TOKEN_SECRET_KEY);
		}
		const metadata = await this.enrichSession(token, expiresAt);
		await this.state.updateGlobal(SESSION_STATE_KEY, metadata);
		return metadata;
	}

	private handleVerification(verification: DeviceVerification): void {
		const verificationUrl = verification.verification_uri_complete ?? verification.verification_uri;
		const message = `Open ${verificationUrl} and enter code ${verification.user_code}`;
		void vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
		void vscode.env.clipboard.writeText(verification.user_code);
		void vscode.window.showInformationMessage(message, 'Copy Code', 'Open Verification URL').then(selection => {
			if (selection === 'Copy Code') {
				void vscode.env.clipboard.writeText(verification.user_code);
			}
			if (selection === 'Open Verification URL') {
				void vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
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

	private getProxyBaseUrl(): string {
		const base = this.llmGateway.getRemoteBaseUrl();
		if (!base) {
			throw new Error('IssueTriage auth proxy URL is not configured. Set `ISSUETRIAGE_LLM_REMOTE_URL` or the Assessment: Remote Endpoint setting.');
		}
		if (!base.startsWith('https://')) {
			throw new Error('IssueTriage auth proxy URL must use HTTPS for security. Configured URL: ' + base);
		}
		return base;
	}

	private async startProxyDeviceFlow(baseUrl: string): Promise<RemoteDeviceStartResponse> {
		let response: Response;
		try {
			response = await fetch(`${baseUrl}/oauth/device/start`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({ scopes: this.scopes })
			});
		} catch (error) {
			throw new Error('Unable to reach the IssueTriage auth proxy. Verify that the Cloudflare worker is deployed and reachable.');
		}

		if (!response.ok) {
			const text = await response.text();
			throw new Error(text || 'Failed to start GitHub device authorization through the auth proxy.');
		}

		const payload = await response.json() as Partial<RemoteDeviceStartResponse>;
		if (!payload.deviceCode || !payload.userCode || !payload.verificationUri || typeof payload.expiresIn !== 'number' || typeof payload.interval !== 'number') {
			throw new Error('Auth proxy returned an invalid device authorization payload.');
		}
		return payload as RemoteDeviceStartResponse;
	}

	private async pollProxyDeviceFlow(baseUrl: string, deviceCode: string, intervalSeconds: number, expiresInSeconds: number): Promise<RemoteDevicePollSuccess> {
		const deadline = Date.now() + expiresInSeconds * 1000;
		let waitSeconds = Math.max(intervalSeconds, 1);
		const maxRetries = 3;
		let consecutiveFailures = 0;

		while (Date.now() < deadline) {
			let response: Response;
			try {
				response = await fetch(`${baseUrl}/oauth/device/poll`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json'
					},
					body: JSON.stringify({ deviceCode })
				});
				consecutiveFailures = 0; // Reset on successful connection
			} catch (error) {
				consecutiveFailures++;
				if (consecutiveFailures >= maxRetries) {
					throw new Error('Lost connection to the IssueTriage auth proxy while waiting for authorization. Please check your network and try again.');
				}
				// Exponential backoff: 2s, 4s, 8s
				const backoffMs = Math.min(2000 * Math.pow(2, consecutiveFailures - 1), 8000);
				await this.delay(backoffMs);
				continue;
			}

			const text = await response.text();
			let payload: Record<string, unknown>;
			try {
				payload = text ? JSON.parse(text) as Record<string, unknown> : {};
			} catch {
				throw new Error(`Auth proxy returned an unexpected response (${response.status}).`);
			}

			if (response.status === 200) {
				const accessToken = payload.accessToken;
				if (typeof accessToken !== 'string' || !accessToken) {
					throw new Error('Auth proxy did not return an access token.');
				}
				return {
					accessToken,
					refreshToken: typeof payload.refreshToken === 'string' && payload.refreshToken ? payload.refreshToken : undefined,
					expiresIn: typeof payload.expiresIn === 'number' ? payload.expiresIn : undefined,
					scope: typeof payload.scope === 'string' ? payload.scope : undefined,
					tokenType: typeof payload.tokenType === 'string' ? payload.tokenType : undefined
				};
			}

			if (response.status === 202) {
				const status = typeof payload.status === 'string' ? payload.status : 'authorization_pending';
				if (status === 'slow_down') {
					waitSeconds += 5;
				} else if (typeof payload.retryAfter === 'number' && payload.retryAfter > 0) {
					waitSeconds = payload.retryAfter;
				}
				await this.delay(waitSeconds * 1000);
				continue;
			}

			const errorDescription = typeof payload.errorDescription === 'string'
				? payload.errorDescription
				: typeof payload.message === 'string'
					? payload.message
					: typeof payload.error === 'string'
						? payload.error
						: `Authorization failed (${response.status}).`;
			throw new Error(errorDescription);
		}

		throw new Error('GitHub authorization timed out. Please try signing in again.');
	}

	private async delay(ms: number): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, ms));
	}
}
