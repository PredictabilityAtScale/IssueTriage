import { AssessmentStorage, AssessmentRecord } from './assessmentStorage';
import { SettingsService } from './settingsService';
import { TelemetryService } from './telemetryService';
import { GitHubClient, IssueDetail } from './githubClient';
import { CliToolService } from './cliToolService';
import { RiskIntelligenceService } from './riskIntelligenceService';
import type { RiskSummary } from '../types/risk';

const COMMENT_TAG = '<!-- IssueTriage Assessment -->';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface AssessmentModelPayload {
	summary: string;
	scores: {
		composite: number;
		requirements: number;
		complexity: number;
		security: number;
		business: number;
	};
	recommendations: string[];
}

export type AssessmentErrorCode = 'missingApiKey' | 'providerError' | 'invalidResponse' | 'storageError';

export class AssessmentError extends Error {
	public readonly code: AssessmentErrorCode;

	constructor(code: AssessmentErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'AssessmentError';
		this.code = code;
	}
}

export class AssessmentService {
	constructor(
		private readonly storage: AssessmentStorage,
		private readonly settings: SettingsService,
		private readonly telemetry: TelemetryService,
		private readonly github: GitHubClient,
		private readonly cliTools: CliToolService,
		private readonly risk: RiskIntelligenceService
	) {}

	public dispose(): void {
		void this.storage.dispose();
	}

	public async assessIssue(repository: string, issueNumber: number): Promise<AssessmentRecord> {
		const apiKey = this.settings.getWithEnvFallback('assessment.apiKey', 'ISSUETRIAGE_OPENROUTER_API_KEY');
		if (!apiKey) {
			throw new AssessmentError('missingApiKey', 'OpenRouter API key not configured. Update settings or set ISSUETRIAGE_OPENROUTER_API_KEY.');
		}

		const model = this.resolveModel();
		const publishComments = this.settings.get<boolean>('assessment.publishComments', true) ?? true;
		const previousAssessment = await this.storage.getLatestAssessment(repository, issueNumber);

		await this.cliTools.ensureAutoRunResults();

		const issue = await this.github.getIssueDetails(repository, issueNumber);
		const requestStartedAt = Date.now();
		try {
			const assessment = await this.generateAssessment(issue, apiKey, model);
			const riskSummary = this.risk.getSummary(repository, issueNumber);
			const adjustedScores = this.applyRiskModifiers(assessment.scores, riskSummary);
			const adjustedAssessment: AssessmentModelPayload & { rawResponse: string } = {
				...assessment,
				scores: adjustedScores
			};
			let commentId = previousAssessment?.commentId;
			if (publishComments) {
				try {
					const markdown = this.buildAssessmentComment(issue, adjustedAssessment, model);
					const updatedCommentId = await this.github.upsertIssueComment(repository, issueNumber, markdown, commentId);
					commentId = updatedCommentId;
				} catch (commentError) {
					this.telemetry.trackEvent('assessment.commentFailed', {
						repository,
						issue: String(issueNumber),
						message: commentError instanceof Error ? commentError.message : String(commentError)
					});
				}
			}

			const record = await this.storage.saveAssessment({
				repository,
				issueNumber,
				compositeScore: adjustedAssessment.scores.composite,
				requirementsScore: adjustedAssessment.scores.requirements,
				complexityScore: adjustedAssessment.scores.complexity,
				securityScore: adjustedAssessment.scores.security,
				businessScore: adjustedAssessment.scores.business,
				recommendations: adjustedAssessment.recommendations,
				summary: adjustedAssessment.summary,
				model,
				commentId,
				createdAt: new Date().toISOString(),
				rawResponse: adjustedAssessment.rawResponse
			});

			if (riskSummary && riskSummary.status === 'ready' && riskSummary.riskLevel && riskSummary.riskLevel !== 'low') {
				this.telemetry.trackEvent('assessment.riskAdjusted', {
					repository,
					issue: String(issueNumber),
					riskLevel: riskSummary.riskLevel
				});
			}

			this.telemetry.trackEvent('assessment.completed', {
				repository,
				issue: String(issueNumber),
				model
			}, {
				latencyMs: Date.now() - requestStartedAt
			});

			return record;
		} catch (error) {
			this.telemetry.trackEvent('assessment.failed', {
				repository,
				issue: String(issueNumber),
				model,
				message: error instanceof Error ? error.message : String(error)
			});
			if (error instanceof AssessmentError) {
				throw error;
			}
			throw new AssessmentError('providerError', error instanceof Error ? error.message : 'Assessment failed unexpectedly.', { cause: error instanceof Error ? error : undefined });
		}
	}

	public async getLatestAssessment(repository: string, issueNumber: number): Promise<AssessmentRecord | undefined> {
		try {
			return await this.storage.getLatestAssessment(repository, issueNumber);
		} catch (error) {
			this.telemetry.trackEvent('assessment.storage.latestFailed', {
				repository,
				issue: String(issueNumber),
				message: error instanceof Error ? error.message : String(error)
			});
			throw new AssessmentError('storageError', 'Unable to read previous assessments from local storage.', { cause: error instanceof Error ? error : undefined });
		}
	}

	public async getAssessmentHistory(repository: string, issueNumber: number, limit = 20): Promise<AssessmentRecord[]> {
		try {
			return await this.storage.getAssessments(repository, issueNumber, limit);
		} catch (error) {
			this.telemetry.trackEvent('assessment.storage.historyFailed', {
				repository,
				issue: String(issueNumber),
				message: error instanceof Error ? error.message : String(error)
			});
			throw new AssessmentError('storageError', 'Unable to read assessment history from local storage.', { cause: error instanceof Error ? error : undefined });
		}
	}

	public isAutomationLaunchEnabled(): boolean {
		return this.settings.get<boolean>('automation.launchEnabled', false) ?? false;
	}

	private applyRiskModifiers(scores: AssessmentModelPayload['scores'], riskSummary: RiskSummary | undefined): AssessmentModelPayload['scores'] {
		if (!riskSummary || riskSummary.status !== 'ready' || !riskSummary.riskLevel) {
			return scores;
		}
		const modifier = riskSummary.riskLevel === 'high'
			? 0.8
			: riskSummary.riskLevel === 'medium'
				? 0.9
				: 1;
		if (modifier === 1) {
			return scores;
		}
		const adjust = (value: number) => Math.min(100, Math.max(0, Number((value * modifier).toFixed(1))));
		return {
			composite: adjust(scores.composite),
			requirements: scores.requirements,
			complexity: adjust(scores.complexity),
			security: scores.security,
			business: scores.business
		};
	}

	private resolveModel(): string {
		const preferred = this.normalizeModelId(this.settings.get<string>('assessment.preferredModel'));
		const usePremium = this.settings.get<boolean>('assessment.usePremiumModel');
		const premium = this.normalizeModelId(this.settings.get<string>('assessment.premiumModel', 'openai/gpt-5'));
		const standard = this.normalizeModelId(this.settings.get<string>('assessment.standardModel', 'openai/gpt-5-mini'));
		const fallbackStandard = standard ?? 'openai/gpt-5-mini';
		if (preferred) {
			return preferred;
		}
		if (usePremium) {
			return premium ?? 'openai/gpt-5';
		}
		return fallbackStandard;
	}

	private normalizeModelId(model: string | undefined): string | undefined {
		if (!model) {
			return undefined;
		}
		const trimmed = model.trim();
		if (!trimmed) {
			return undefined;
		}
		return trimmed.replace(/^openrouter\//i, '');
	}

	private buildAssessmentComment(issue: IssueDetail, assessment: AssessmentModelPayload, model: string): string {
		const rows: Array<[string, number]> = [
			['Composite', assessment.scores.composite],
			['Requirements', assessment.scores.requirements],
			['Complexity', assessment.scores.complexity],
			['Security', assessment.scores.security],
			['Business Impact', assessment.scores.business]
		];
		const tableLines = [
			'| Dimension | Score |',
			'| --- | --- |',
			...rows.map(([label, score]) => `| ${label} | ${score.toFixed(1)} |`)
		];

		const recommendationLines = assessment.recommendations.length
			? assessment.recommendations.map((item: string) => `- ${item}`)
			: ['- No open questions identified.'];

		return [
			COMMENT_TAG,
			'### IssueTriage Assessment',
			`_Model_: ${model}`,
			`_Issue_: ${issue.repository} #${issue.number}`,
			`[View issue](${issue.url})`,
			'',
			...tableLines,
			'',
			`**Summary:** ${assessment.summary}`,
			'',
			'**Pre-implementation questions:**',
			...recommendationLines,
			'',
			`_Last updated: ${new Date().toLocaleString()}_`
		].join('\n');
	}

	private async generateAssessment(issue: IssueDetail, apiKey: string, model: string): Promise<AssessmentModelPayload & { rawResponse: string }> {
		const payload = this.buildModelPayload(issue);
		type FetchResponse = Awaited<ReturnType<typeof fetch>>;
		let response: FetchResponse;
		try {
			response = await fetch(OPENROUTER_ENDPOINT, {
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
							content: 'You are IssueTriage, an assistant that evaluates GitHub issues for automation readiness, risk, and impact. Focus on enabling an autonomous AI coding agent to implement or complete the work. Diagnose missing context, requirements, validation, or safeguards that block automation and prescribe actions that increase automation success. Always respond with JSON matching the requested schema.'
						},
						{
							role: 'user',
							content: payload
						}
					],
					temperature: 0.25
				})
			});
		} catch (error) {
			throw new AssessmentError('providerError', 'Failed to contact OpenRouter. Check your network connection and try again.', { cause: error instanceof Error ? error : undefined });
		}

		if (!response.ok) {
			const text = await response.text();
			throw new AssessmentError('providerError', `OpenRouter request failed (${response.status}): ${text}`);
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (error) {
			throw new AssessmentError('invalidResponse', 'OpenRouter returned an unreadable response.', { cause: error instanceof Error ? error : undefined });
		}
		const content = this.extractContent(json);
		const parsed = this.parseAssessment(content);
		return {
			...parsed,
			rawResponse: JSON.stringify(json)
		};
	}

	private buildModelPayload(issue: IssueDetail): string {
		const details = [
			`Repository: ${issue.repository}`,
			`Issue: #${issue.number} ${issue.title}`,
			`Created by: ${issue.author}`,
			`Labels: ${issue.labels.length ? issue.labels.join(', ') : 'None'}`,
			`Assignees: ${issue.assignees.length ? issue.assignees.join(', ') : 'None'}`,
			`Milestone: ${issue.milestone ?? 'None'}`,
			`URL: ${issue.url}`,
			'',
			'Issue body:',
			issue.body || '(empty)'
		];
		
		const cliContext = this.cliTools.getPromptContext();
		if (cliContext) {
			details.push('', 'CLI tool context captured by IssueTriage:', cliContext.trim());
		}

		return `${details.join('\n')}\n\nReturn a JSON object with the following shape: {
  "summary": string,
  "scores": {
    "composite": number,
    "requirements": number,
    "complexity": number,
    "security": number,
    "business": number
  },
  "recommendations": string[]
}
 Scores must be 0-100 numbers with one decimal precision. Base composite on the other four dimensions. Provide concise summary (max 4 sentences).
 Recommendations must instead be the minimum set of high-leverage questions that must be answered before an autonomous AI coding agent should begin implementation. Each question should highlight missing context, validation expectations, safety requirements, or deployment guardrails the agent needs resolved first. Keep the list focused (max five questions).
`;
	}

	private extractContent(response: any): string {
		const content = response?.choices?.[0]?.message?.content;
		if (typeof content !== 'string' || content.trim().length === 0) {
			throw new AssessmentError('invalidResponse', 'OpenRouter response missing message content.');
		}
		return content.trim();
	}

	private parseAssessment(content: string): AssessmentModelPayload {
		const jsonText = this.extractJsonBlock(content);
		let parsed: any;
		try {
			parsed = JSON.parse(jsonText);
		} catch (error) {
			throw new AssessmentError('invalidResponse', 'Failed to parse assessment JSON from model response.', { cause: error instanceof Error ? error : undefined });
		}

		if (!parsed || typeof parsed !== 'object') {
			throw new AssessmentError('invalidResponse', 'Assessment response not in expected object form.');
		}

		const scores = parsed.scores ?? {};
		const recommendationsRaw = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
		const recommendations = recommendationsRaw
			.filter((item: unknown): item is string => typeof item === 'string')
			.map((item: string) => item.trim())
			.filter((item: string) => item.length > 0);

		return {
			summary: String(parsed.summary ?? '').trim(),
			scores: {
				composite: this.sanitizeScore(scores.composite),
				requirements: this.sanitizeScore(scores.requirements),
				complexity: this.sanitizeScore(scores.complexity),
				security: this.sanitizeScore(scores.security),
				business: this.sanitizeScore(scores.business)
			},
			recommendations
		};
	}

	private extractJsonBlock(content: string): string {
		const trimmed = content.trim();
		if (trimmed.startsWith('```')) {
			const jsonBlock = trimmed.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
			return jsonBlock;
		}
		return trimmed;
	}

	private sanitizeScore(value: unknown): number {
		const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'));
		if (Number.isNaN(numeric)) {
			return 0;
		}
		return Math.min(100, Math.max(0, Number.parseFloat(numeric.toFixed(1))));
	}
}
