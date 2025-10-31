import type { SettingsService } from './settingsService';
import type { TelemetryService } from './telemetryService';
import { LlmGateway, MissingApiKeyError, LOCAL_API_KEY_MISSING_MESSAGE } from './llmGateway';
import type { UsageTapOperationHooks, UsageTapService } from './usageTapService';
import { GENERIC_KEYWORDS, normalizeKeywords } from './keywordUtils';

export interface KeywordExtractionResult {
	keywords: string[];
	tokensUsed: number;
}

export class KeywordExtractionService {
	constructor(
		private readonly settings: SettingsService,
		private readonly telemetry: TelemetryService,
		private readonly llm: LlmGateway,
		private readonly usageTap?: UsageTapService
	) {}

	/**
	 * Extract 5-8 keywords from issue title and body using LLM
	 */
	public async extractKeywords(
		issueTitle: string,
		issueBody: string,
		issueNumber?: number
	): Promise<KeywordExtractionResult> {
		const model = this.settings.get<string>('assessment.standardModel', 'openai/gpt-5-mini') ?? 'openai/gpt-5-mini';
		const prompt = this.buildKeywordPrompt(issueTitle, issueBody);

		const execute = async (hooks?: UsageTapOperationHooks): Promise<KeywordExtractionResult> => {
			let response: Awaited<ReturnType<typeof fetch>>;
			try {
				response = await this.llm.requestChatCompletion({
				model,
				messages: [
					{
						role: 'system',
						content:
							'You are a keyword extraction assistant. Extract 5-8 concise keywords from GitHub issues representing components, change types, and risk signals. Return ONLY a comma-separated list of lowercase keywords, no explanation.'
					},
					{
						role: 'user',
						content: prompt
					}
				],
				temperature: 0.1,
				max_tokens: 100
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				hooks?.setError(error instanceof MissingApiKeyError ? 'MISSING_API_KEY' : 'LLM_REQUEST_FAILED', message);
				throw error;
			}

			if (!response.ok) {
				const text = await response.text();
				const message = `LLM request failed (${response.status}): ${text}`;
				hooks?.setError('LLM_HTTP_ERROR', message);
				throw new Error(message);
			}

			let json: any;
			try {
				json = await response.json();
			} catch (error) {
				hooks?.setError('LLM_PARSE_ERROR', 'Keyword extraction response was unreadable.');
				throw error instanceof Error ? error : new Error(String(error));
			}

			const usage = this.usageTap?.extractUsageFromOpenAIResponse(json, model);
			if (usage && hooks) {
				hooks.setUsage(usage);
			}

			const content = json?.choices?.[0]?.message?.content;
			const tokensUsed = json?.usage?.total_tokens ?? 0;

			if (typeof content !== 'string') {
				hooks?.setError('LLM_RESPONSE_INVALID', 'Keyword extraction response missing content.');
				throw new Error('LLM response missing message content.');
			}

			const keywords = this.parseKeywords(content.trim());

			if (issueNumber) {
				this.telemetry.trackEvent('keywords.extracted', {
					issue: String(issueNumber),
					count: String(keywords.length),
					model
				}, { tokensUsed });
			}

			return { keywords, tokensUsed };
		};

		const runner = async (): Promise<KeywordExtractionResult> => {
			try {
				if (!this.usageTap) {
					return await execute();
				}
				const requested = this.usageTap.resolveRequestedEntitlements(model);
				const tags = issueNumber ? ['keywords', `issue-${issueNumber}`] : ['keywords'];
				return await this.usageTap.runWithUsage({
					feature: 'keywords.extract',
					requested,
					tags
				}, async hooks => execute(hooks));
			} catch (error) {
				throw error;
			}
		};

		try {
			return await runner();
		} catch (error) {
			if (error instanceof MissingApiKeyError) {
				throw new Error(LOCAL_API_KEY_MISSING_MESSAGE);
			}
			this.telemetry.trackEvent('keywords.extractionFailed', {
				issue: issueNumber ? String(issueNumber) : 'unknown',
				message: error instanceof Error ? error.message : String(error)
			});
			throw error;
		}
	}

	/**
	 * Build the prompt for keyword extraction
	 */
	private buildKeywordPrompt(title: string, body: string): string {
		const truncatedBody = body.length > 1000 ? body.slice(0, 1000) + '...' : body;
		
		return `Extract 5-8 concise keywords from this GitHub issue. Focus on:
- Components/subsystems (e.g., "authentication", "database", "ui")
- Change type (e.g., "refactor", "bugfix", "feature", "migration")
- Risk signals (e.g., "breaking-change", "security", "performance", "dependencies")

Title: ${title}

Body:
${truncatedBody}

Return ONLY a comma-separated list of lowercase keywords (e.g., "auth, middleware, refactor, security, breaking-change").`;
	}

	/**
	 * Parse keyword string into array, ensuring 5-8 keywords
	 */
	private parseKeywords(response: string): string[] {
		// Remove common prefixes from LLM responses
		let cleaned = response
			.replace(/^keywords:\s*/i, '')
			.replace(/^here are the keywords:\s*/i, '')
			.replace(/^extracted keywords:\s*/i, '')
			.trim();

		const candidateKeywords = cleaned
			.split(/[,\n]/)
			.map(kw => kw.trim().toLowerCase())
			.filter(kw => kw.length > 0 && kw.length < 30); // Filter out empty and overly long

		let keywords = normalizeKeywords(candidateKeywords);

		// Ensure we have 5-8 keywords
		if (keywords.length < 5) {
			for (const fallback of GENERIC_KEYWORDS) {
				if (!keywords.includes(fallback)) {
					keywords.push(fallback);
				}
				if (keywords.length >= 5) {
					break;
				}
			}
		}

		return keywords.slice(0, 8); // Cap at 8
	}
}
