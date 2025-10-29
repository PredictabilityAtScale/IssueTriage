import { AssessmentStorage, AssessmentRecord } from './assessmentStorage';
import { SettingsService } from './settingsService';
import { TelemetryService } from './telemetryService';
import { GitHubClient, IssueDetail } from './githubClient';
import { CliToolService } from './cliToolService';
import { RiskIntelligenceService } from './riskIntelligenceService';
import { LlmGateway, MissingApiKeyError, LOCAL_API_KEY_MISSING_MESSAGE } from './llmGateway';
import type { RiskSummary } from '../types/risk';

const COMMENT_TAG = '<!-- IssueTriage Assessment -->';

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
		private readonly risk: RiskIntelligenceService,
		private readonly llm: LlmGateway
	) {}

	public dispose(): void {
		void this.storage.dispose();
	}
	public async assessIssue(repository: string, issueNumber: number): Promise<AssessmentRecord> {
		if (this.llm.getMode() === 'local' && !this.llm.hasLocalApiKey()) {
			throw new AssessmentError('missingApiKey', LOCAL_API_KEY_MISSING_MESSAGE);
		}

		const model = this.resolveModel();
		const publishComments = this.settings.get<boolean>('assessment.publishComments', true) ?? true;
		const previousAssessment = await this.storage.getLatestAssessment(repository, issueNumber);

		await this.cliTools.ensureAutoRunResults();

		const issue = await this.github.getIssueDetails(repository, issueNumber);
		const requestStartedAt = Date.now();
		try {
			const assessment = await this.generateAssessment(issue, model);
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

	private async generateAssessment(issue: IssueDetail, model: string): Promise<AssessmentModelPayload & { rawResponse: string }> {
		const payload = this.buildModelPayload(issue);
		type FetchResponse = Awaited<ReturnType<typeof fetch>>;
		let response: FetchResponse;
		try {
			response = await this.llm.requestChatCompletion({
				model,
				messages: [
					{
						role: 'system',
						content: 'You are IssueTriage, an assistant that evaluates GitHub issues for AUTOMATION READINESS by an autonomous AI coding agent. Score based on whether a coding agent can produce a working v1 implementation, NOT whether the issue has perfect specifications. The agent will handle implementation details (schemas, types, error handling, etc.). Score high when the issue clearly describes WHAT to build (user intent, problem to solve, success criteria). Score low only when critical information is missing that would prevent the agent from knowing WHAT problem to solve or WHICH of multiple valid approaches to take. Always respond with JSON matching the requested schema.'
					},
					{
						role: 'user',
						content: payload
					}
				],
				temperature: 0.25
			});
		} catch (error) {
			if (error instanceof MissingApiKeyError) {
				throw new AssessmentError('missingApiKey', error.message);
			}
			throw new AssessmentError('providerError', 'Failed to contact the LLM service. Check your network connection and try again.', { cause: error instanceof Error ? error : undefined });
		}

		if (!response.ok) {
			const text = await response.text();
			throw new AssessmentError('providerError', `LLM request failed (${response.status}): ${text}`);
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (error) {
			throw new AssessmentError('invalidResponse', 'The LLM provider returned an unreadable response.', { cause: error instanceof Error ? error : undefined });
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

		if (issue.comments.length) {
			details.push('', '## Conversation History');
			issue.comments.forEach((comment, index) => {
				const timestamp = comment.createdAt ? new Date(comment.createdAt).toISOString() : 'timestamp unknown';
				const author = comment.author || 'unknown';
				const linkSuffix = comment.url ? ` · ${comment.url}` : '';
				details.push(`Comment ${index + 1} by ${author} on ${timestamp}${linkSuffix}`);
				const normalizedBody = (comment.body ?? '').replace(/\r\n/g, '\n');
				details.push(normalizedBody.trim().length ? normalizedBody : '(empty comment)');
				if (index < issue.comments.length - 1) {
					details.push('');
				}
			});
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

 SCORING GUIDANCE (assess for autonomous AI coding agent readiness):
 - requirements (0-100): Does the issue clearly describe WHAT to build? High score (80-100) if user intent, problem statement, and success criteria are clear enough for an agent to attempt a v1. Medium score (40-79) if some ambiguity exists but the agent can make reasonable inferences. Low score (0-39) ONLY if critical "what to build" information is missing or multiple conflicting interpretations exist.
 - complexity (0-100): Technical difficulty for an agent to implement. Consider scope, integration points, edge cases. NOT about whether specs are detailed.
 - security (0-100): Risk of security issues. High score means low risk. Consider auth, data exposure, injection risks.
 - business (0-100): Business value and urgency. High score means high impact/priority.

 Recommendations must be GENUINE BLOCKERS ONLY—questions that clarify what problem to solve, NOT how to implement it. An autonomous coding agent will handle implementation details (schemas, types, file paths, exact SQL, etc.) using its own agent.md rule files. Only ask about:
 - Ambiguous requirements where the agent cannot infer user intent (e.g., "Which of the three mentioned APIs should be used?")
 - Missing critical information the agent cannot discover (e.g., "What external service endpoint should this integrate with?")
 - Unspecified behavior at decision points where multiple valid interpretations exist (e.g., "Should errors retry or fail immediately?")
 DO NOT ASK about implementation artifacts like TypeScript interfaces, migration SQL, file paths, error handling patterns, validation thresholds, or security best practices—the coding agent will draft these. Keep the list minimal (max three questions) and only include questions that would prevent the agent from producing ANY working v1.
`;
	}

	private extractContent(response: any): string {
		const content = response?.choices?.[0]?.message?.content;
		if (typeof content !== 'string' || content.trim().length === 0) {
			throw new AssessmentError('invalidResponse', 'The LLM response is missing message content.');
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

		const sanitizedDimensions = {
			requirements: this.sanitizeScore(scores.requirements),
			complexity: this.sanitizeScore(scores.complexity),
			security: this.sanitizeScore(scores.security),
			business: this.sanitizeScore(scores.business)
		};
		const hasDimensionData = Object.values(sanitizedDimensions).some(value => value > 0);
		const fallbackComposite = this.sanitizeScore(scores.composite);
		const computedComposite = hasDimensionData
			? this.calculateCompositeFromDimensions(sanitizedDimensions)
			: undefined;
		const composite = computedComposite ?? fallbackComposite;

		return {
			summary: String(parsed.summary ?? '').trim(),
			scores: {
				composite,
				...sanitizedDimensions
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

	private calculateCompositeFromDimensions(dimensions: { requirements: number; complexity: number; security: number; business: number }): number {
		const clamp = (value: number) => Math.min(1, Math.max(0, value));
		const normalizedRequirements = clamp(dimensions.requirements / 100);
		const normalizedComplexity = clamp((100 - dimensions.complexity) / 100);
		const normalizedSecurity = clamp(dimensions.security / 100);
		const normalizedBusiness = clamp(dimensions.business / 100);
		const weighted = (normalizedRequirements * 0.4)
			+ (normalizedComplexity * 0.35)
			+ (normalizedSecurity * 0.15)
			+ (normalizedBusiness * 0.1);
		return Number((weighted * 100).toFixed(1));
	}

	private sanitizeScore(value: unknown): number {
		const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'));
		if (Number.isNaN(numeric)) {
			return 0;
		}
		return Math.min(100, Math.max(0, Number.parseFloat(numeric.toFixed(1))));
	}
}
