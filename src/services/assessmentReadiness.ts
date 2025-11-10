import type { AssessmentRecord } from './assessmentStorage';

export type AssessmentReadiness = 'ready' | 'prepare' | 'review' | 'manual';

export interface AssessmentReadinessInput {
	compositeScore: number;
	requirementsScore: number;
	complexityScore: number;
	securityScore: number;
	businessScore: number;
	recommendationCount: number;
}

export interface AssessmentReadinessEvaluation {
	readiness: AssessmentReadiness;
	blendedScore: number;
}

const READINESS_ORDER: AssessmentReadiness[] = ['ready', 'prepare', 'review', 'manual'];
const READY_THRESHOLD = 80;
const PREPARE_THRESHOLD = 60;
const REVIEW_THRESHOLD = 40;

function clampScore(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(100, Number.parseFloat(value.toFixed(1))));
}

function downgrade(level: AssessmentReadiness, steps = 1): AssessmentReadiness {
	const index = READINESS_ORDER.indexOf(level);
	if (index === -1) {
		return 'manual';
	}
	const next = Math.min(READINESS_ORDER.length - 1, index + steps);
	return READINESS_ORDER[next];
}

export function classifyReadinessFromScore(score: number): AssessmentReadiness {
	if (score >= READY_THRESHOLD) {
		return 'ready';
	}
	if (score >= PREPARE_THRESHOLD) {
		return 'prepare';
	}
	if (score >= REVIEW_THRESHOLD) {
		return 'review';
	}
	return 'manual';
}

export function evaluateAssessmentReadiness(input: AssessmentReadinessInput): AssessmentReadinessEvaluation {
	const composite = clampScore(input.compositeScore);
	const requirements = clampScore(input.requirementsScore);
	const complexity = clampScore(input.complexityScore);
	const security = clampScore(input.securityScore);
	const business = clampScore(input.businessScore);
	const questions = Math.max(0, Math.trunc(input.recommendationCount));

	let blended = composite;

	// Reward clear, question-free issues by boosting the blended score.
	if (questions === 0 && requirements >= 75) {
		blended += 8;
	}
	if (questions === 0 && requirements >= 85 && security >= 70) {
		blended += 6;
	}

	// Penalise open questions to avoid premature automation.
	if (questions === 1) {
		blended -= 6;
	} else if (questions >= 2) {
		blended -= 10;
	}

	// Adjust for requirements clarity.
	if (requirements >= 90) {
		blended += 4;
	} else if (requirements >= 80) {
		blended += 2;
	} else if (requirements >= 65) {
		// neutral
	} else if (requirements >= 50) {
		blended -= 6;
	} else {
		blended -= 12;
	}

	// Adjust for security concerns.
	if (security >= 85) {
		blended += 3;
	} else if (security >= 70) {
		blended += 1;
	} else if (security >= 55) {
		blended -= 6;
	} else {
		blended -= 14;
	}

	// Adjust for implementation complexity (lower numbers are easier).
	if (complexity >= 90) {
		blended -= 10;
	} else if (complexity >= 80) {
		blended -= 6;
	} else if (complexity <= 40) {
		blended += 3;
	} else if (complexity <= 55) {
		blended += 1;
	}

	// Business impact has a mild effect on launch readiness.
	if (business >= 80) {
		blended += 2;
	} else if (business < 35) {
		blended -= 5;
	}

	const clamped = clampScore(blended);
	let readiness = classifyReadinessFromScore(clamped);

	// Guardrails: block automation when clear risks remain.
	if (security < 30) {
		readiness = 'manual';
	} else if (security < 45) {
		readiness = downgrade(readiness);
	}

	if (questions > 0) {
		if (readiness === 'ready') {
			readiness = 'prepare';
		} else if (readiness === 'prepare' && questions > 1) {
			readiness = 'review';
		}
	}

	return {
		readiness,
		blendedScore: clamped
	};
}

export function evaluateRecordReadiness(record: Pick<AssessmentRecord, 'compositeScore' | 'requirementsScore' | 'complexityScore' | 'securityScore' | 'businessScore' | 'recommendations'>): AssessmentReadinessEvaluation {
	return evaluateAssessmentReadiness({
		compositeScore: record.compositeScore,
		requirementsScore: record.requirementsScore,
		complexityScore: record.complexityScore,
		securityScore: record.securityScore,
		businessScore: record.businessScore,
		recommendationCount: Array.isArray(record.recommendations) ? record.recommendations.length : 0
	});
}
