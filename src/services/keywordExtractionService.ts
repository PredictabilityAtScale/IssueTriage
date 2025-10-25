import type { SettingsService } from './settingsService';
import type { TelemetryService } from './telemetryService';
import { GENERIC_KEYWORDS, normalizeKeywords } from './keywordUtils';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface KeywordExtractionResult {
	keywords: string[];
	tokensUsed: number;
}

export class KeywordExtractionService {
	constructor(
		private readonly settings: SettingsService,
		private readonly telemetry: TelemetryService
	) {}

	/**
	 * Extract 5-8 keywords from issue title and body using LLM
	 */
	public async extractKeywords(
		issueTitle: string,
		issueBody: string,
		issueNumber?: number
	): Promise<KeywordExtractionResult> {
		const apiKey = this.settings.getWithEnvFallback(
			'assessment.apiKey',
			'ISSUETRIAGE_OPENROUTER_API_KEY'
		);
		
		if (!apiKey) {
			throw new Error(
				'OpenRouter API key not configured. Update settings or set ISSUETRIAGE_OPENROUTER_API_KEY.'
			);
		}

		const model = this.settings.get<string>('assessment.standardModel', 'openai/gpt-5-mini') ?? 'openai/gpt-5-mini';
		const prompt = this.buildKeywordPrompt(issueTitle, issueBody);

		try {
			const response = await fetch(OPENROUTER_ENDPOINT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
					'HTTP-Referer': 'https://github.com/troym/IssueTriage',
					'X-Title': 'IssueTriage VS Code Extension'
				},
				body: JSON.stringify({
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
				})
			});

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
			}

			const json = await response.json() as any;
			const content = json?.choices?.[0]?.message?.content;
			const tokensUsed = json?.usage?.total_tokens ?? 0;

			if (typeof content !== 'string') {
				throw new Error('OpenRouter response missing message content.');
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
		} catch (error) {
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
