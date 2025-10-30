import type { SettingsService } from './settingsService';

export type LlmMode = 'local' | 'remote';

export const LOCAL_API_KEY_MISSING_MESSAGE = 'OpenRouter API key not configured. Update settings or set ISSUETRIAGE_OPENROUTER_API_KEY, or set ISSUETRIAGE_LLM_MODE=remote to use the IssueTriage worker.';

export class MissingApiKeyError extends Error {
	public constructor(message: string = LOCAL_API_KEY_MISSING_MESSAGE) {
		super(message);
		this.name = 'MissingApiKeyError';
	}
}

type SettingsProvider = Pick<SettingsService, 'get' | 'getWithEnvFallback'>;

const DEFAULT_REMOTE_BASE_URL = 'https://issue-triage-worker.troy-magennis.workers.dev';
const DEFAULT_LOCAL_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_REFERER = 'https://github.com/PredictabilityAtScale/IssueTriage';
const DEFAULT_APP_NAME = 'IssueTriage VS Code Extension';

export class LlmGateway {
	public constructor(private readonly settings: SettingsProvider) {}

	public getMode(): LlmMode {
		const configured = this.settings.getWithEnvFallback('assessment.llmMode', 'ISSUETRIAGE_LLM_MODE');
		const normalized = configured?.toLowerCase();
		return normalized === 'local' ? 'local' : 'remote';
	}

	public hasLocalApiKey(): boolean {
		return Boolean(this.getLocalApiKey());
	}

	public async requestChatCompletion(body: unknown): Promise<Response> {
		const mode = this.getMode();
		if (mode === 'remote') {
			const endpoint = `${this.getRemoteBaseUrl()}/llm`;
			return fetch(endpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify(body)
			});
		}

		const apiKey = this.getLocalApiKey();
		if (!apiKey) {
			throw new MissingApiKeyError();
		}

		const endpoint = `${this.getLocalBaseUrl()}/chat/completions`;
		return fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
				'HTTP-Referer': this.getReferer(),
				'X-Title': this.getAppName()
			},
			body: JSON.stringify(body)
		});
	}

	private getLocalApiKey(): string | undefined {
		return this.settings.getWithEnvFallback('assessment.apiKey', 'ISSUETRIAGE_OPENROUTER_API_KEY');
	}

	private getLocalBaseUrl(): string {
		const configured = this.settings.getWithEnvFallback('assessment.openRouterBaseUrl', 'ISSUETRIAGE_OPENROUTER_API_BASE');
		return (configured && configured.trim().length > 0 ? configured : DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, '');
	}

	public getRemoteBaseUrl(): string {
		const configured = this.settings.getWithEnvFallback('assessment.remoteEndpoint', 'ISSUETRIAGE_LLM_REMOTE_URL');
		return (configured && configured.trim().length > 0 ? configured : DEFAULT_REMOTE_BASE_URL).replace(/\/+$/, '');
	}

	private getReferer(): string {
		const configured = this.settings.getWithEnvFallback('assessment.openRouterSiteUrl', 'ISSUETRIAGE_OPENROUTER_SITE_URL');
		return configured && configured.trim().length > 0 ? configured : DEFAULT_REFERER;
	}

	private getAppName(): string {
		const configured = this.settings.getWithEnvFallback('assessment.openRouterAppName', 'ISSUETRIAGE_OPENROUTER_APP_NAME');
		return configured && configured.trim().length > 0 ? configured : DEFAULT_APP_NAME;
	}
}
