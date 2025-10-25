import * as assert from 'assert';
import { buildHeuristicKeywords, ensureKeywordCoverage } from '../services/keywordUtils';

suite('KeywordUtils', () => {
	test('buildHeuristicKeywords surfaces intent-driven phrases', () => {
		const context = {
			issueTitle: 'Add "Run Analysis" bulk assessment button',
			issueBody: 'Allows triage analysts to trigger run analysis workflows on multiple issues at once.',
			changeSummary:
				'1 direct commit. 2 files touched (+172/-0). Focus areas: src/extension.ts, src/webview/panel.js. Recent work: Add bulk Run Analysis control',
			labels: ['enhancement'],
			evidenceSummaries: ['Add bulk Run Analysis control'],
			filePaths: ['src/extension.ts', 'src/webview/panel.js'],
			repository: 'PredictabilityAtScale/IssueTriage'
		};

		const heuristics = buildHeuristicKeywords(context);

		assert.ok(
			heuristics.some(keyword => keyword.includes('bulk-run-analysis')),
			'Should include descriptive phrase highlighting the bulk run analysis intent'
		);
		assert.ok(
			heuristics.includes('webview-panel') || heuristics.includes('webview'),
			'Should lift relevant component names from file paths'
		);
	});

	test('ensureKeywordCoverage filters repository noise while guaranteeing variety', () => {
		const context = {
			issueTitle: 'Add "Run Analysis" bulk assessment button',
			issueBody: 'Allows triage analysts to trigger run analysis workflows on multiple issues at once.',
			changeSummary:
				'1 direct commit. 2 files touched (+172/-0). Focus areas: src/extension.ts, src/webview/panel.js. Recent work: Add bulk Run Analysis control',
			labels: ['enhancement'],
			evidenceSummaries: ['Add bulk Run Analysis control'],
			filePaths: ['src/extension.ts', 'src/webview/panel.js'],
			repository: 'PredictabilityAtScale/IssueTriage'
		};

		const keywords = ensureKeywordCoverage(undefined, context);

		assert.ok(keywords.length >= 5 && keywords.length <= 8, 'Should clamp keyword count to defaults');
		assert.ok(!keywords.includes('predictabilityatscale'), 'Should remove repository tokens from keyword results');
		assert.ok(
			keywords.some(keyword => keyword.includes('analysis')),
			'Should retain analytical intent in the generated keywords'
		);
	});
});
