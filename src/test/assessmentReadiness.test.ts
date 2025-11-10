import * as assert from 'assert';
import { evaluateAssessmentReadiness } from '../services/assessmentReadiness';

suite('Assessment readiness evaluation', () => {
	test('promotes to ready when clarity and safety align with no open questions', () => {
		const result = evaluateAssessmentReadiness({
			compositeScore: 74,
			requirementsScore: 88,
			complexityScore: 58,
			securityScore: 82,
			businessScore: 70,
			recommendationCount: 0
		});

		assert.strictEqual(result.readiness, 'ready');
		assert.ok(result.blendedScore >= 80, 'blended score should cross ready threshold');
	});

	test('keeps automation blocked when security is too low', () => {
		const result = evaluateAssessmentReadiness({
			compositeScore: 86,
			requirementsScore: 92,
			complexityScore: 52,
			securityScore: 28,
			businessScore: 75,
			recommendationCount: 0
		});

		assert.strictEqual(result.readiness, 'manual');
	});

	test('downgrades readiness when unresolved questions remain', () => {
		const result = evaluateAssessmentReadiness({
			compositeScore: 83,
			requirementsScore: 90,
			complexityScore: 60,
			securityScore: 78,
			businessScore: 68,
			recommendationCount: 2
		});

		assert.notStrictEqual(result.readiness, 'ready');
		assert.ok(result.blendedScore < 80, 'open questions should pull blended score below automation threshold');
	});
});
