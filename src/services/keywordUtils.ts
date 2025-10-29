export const GENERIC_KEYWORDS = ['feature', 'change', 'update', 'improvement', 'task'] as const;

const STOP_WORDS = new Set<string>([
	...GENERIC_KEYWORDS,
	'the',
	'and',
	'for',
	'with',
	'from',
	'this',
	'that',
	'into',
	'issue',
	'pull',
	'commit',
	'request',
	'adds',
	'adding',
	'added',
	'fix',
	'fixes',
	'update',
	'updates',
	'changing',
	'change',
	'feature',
	'task',
	'refresh',
	'add',
	'control',
	'button',
	'enhancement',
	'files',
	'focus',
	'areas',
	'recent',
	'work',
	'summary',
	'source',
	'repository',
	'lines',
	'changed',
	'touched',
	'volume',
	'direct',
	'merged',
	'history'
]);

const COMMON_PATH_SEGMENTS = new Set<string>([
	'src',
	'source',
	'lib',
	'app',
	'apps',
	'package',
	'packages',
	'pkg',
	'node_modules',
	'scripts',
	'config',
	'configs',
	'docs',
	'doc',
	'build',
	'dist',
	'out',
	'public',
	'assets',
	'test',
	'tests',
	'spec',
	'specs',
	'__tests__',
	'plans',
	'extension'
]);

const MAX_KEYWORDS = 8;

export interface KeywordContext {
	issueTitle: string;
	issueBody?: string;
	labels?: string[];
	evidenceSummaries?: string[];
	filePaths?: string[];
	changeSummary?: string;
	repository?: string;
}

export function normalizeKeywords(input: Iterable<string>): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (!raw) {
			continue;
		}
		const cleaned = raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\-_/ ]+/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		if (!cleaned || cleaned.length < 3) {
			continue;
		}
		if (STOP_WORDS.has(cleaned)) {
			continue;
		}
		if (seen.has(cleaned)) {
			continue;
		}
		seen.add(cleaned);
		normalized.push(cleaned);
	}
	return normalized.slice(0, MAX_KEYWORDS);
}

export function isGenericKeywordSet(keywords: string[]): boolean {
	if (!keywords.length) {
		return false;
	}
	const generic = new Set<string>(GENERIC_KEYWORDS);
	return keywords.every(keyword => generic.has(keyword));
}

export function ensureKeywordCoverage(
	initial: string[] | undefined,
	context: KeywordContext,
	minCount = 5,
	maxCount = MAX_KEYWORDS
): string[] {
	let keywords = normalizeKeywords(initial ?? []);
	const needsHeuristics = keywords.length < minCount || isGenericKeywordSet(keywords);
	if (needsHeuristics) {
		const heuristics = buildHeuristicKeywords(context, maxCount);
		keywords = normalizeKeywords([...keywords, ...heuristics]);
	}
	if (keywords.length < minCount) {
		for (const fallback of GENERIC_KEYWORDS) {
			if (!keywords.includes(fallback)) {
				keywords.push(fallback);
			}
			if (keywords.length >= minCount) {
				break;
			}
		}
	}
	return keywords.slice(0, maxCount);
}

export function buildHeuristicKeywords(context: KeywordContext, desiredCount = MAX_KEYWORDS): string[] {
	const extraStopWords = new Set<string>();
	if (context.repository) {
		for (const token of splitIdentifier(context.repository)) {
			extraStopWords.add(token);
		}
	}

	const tokenWeights = new Map<string, number>();
	const phraseWeights = new Map<string, number>();

	const recordTokens = (tokens: string[], weight: number) => {
		const filtered = tokens.filter(token => token.length >= 3 && !extraStopWords.has(token));
		if (!filtered.length) {
			return;
		}
		for (const token of filtered) {
			tokenWeights.set(token, (tokenWeights.get(token) ?? 0) + weight);
		}
		const maxPhraseLength = Math.min(3, filtered.length);
		for (let size = maxPhraseLength; size >= 2; size--) {
			for (let index = 0; index <= filtered.length - size; index++) {
				const phraseTokens = filtered.slice(index, index + size);
				const phrase = phraseTokens.join('-');
				if (phrase.length < 5) {
					continue;
				}
				phraseWeights.set(phrase, (phraseWeights.get(phrase) ?? 0) + weight * size);
			}
		}
	};

	const recordText = (text: string | undefined, weight: number) => {
		if (!text) {
			return;
		}
		const tokens = splitIdentifier(text, extraStopWords);
		recordTokens(tokens, weight);
	};

	const recordLabel = (label: string, weight: number) => {
		const normalized = label.replace(/\s+/g, '-');
		const tokens = splitIdentifier(normalized, extraStopWords);
		recordTokens(tokens, weight);
	};

	recordText(context.issueTitle, 5);
	recordText(truncate(context.issueBody, 600), 3);
	recordText(context.changeSummary, 3);
	if (context.labels) {
		for (const label of context.labels) {
			recordLabel(label, 4);
		}
	}
	if (context.evidenceSummaries) {
		for (const summary of context.evidenceSummaries) {
			recordText(summary, 4);
		}
	}
	if (context.filePaths) {
		for (const filePath of context.filePaths) {
			const segments = filePath
				.split(/[\\/]+/)
				.filter(Boolean)
				.map(segment => segment.replace(/\.[^.]+$/, ''));
			const allTokens: string[] = [];
			for (const segment of segments) {
				const base = segment.toLowerCase();
				if (COMMON_PATH_SEGMENTS.has(base)) {
					continue;
				}
				const segmentTokens = splitIdentifier(segment, extraStopWords);
				if (segmentTokens.length > 0) {
					allTokens.push(...segmentTokens);
				}
			}
			recordTokens(allTokens, 3);
		}
	}

	const sortedPhrases = Array.from(phraseWeights.entries())
		.sort((a, b) => {
			const weightDelta = b[1] - a[1];
			if (weightDelta !== 0) {
				return weightDelta;
			}
			return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
		})
		.map(([phrase]) => phrase);

	const sortedTokens = Array.from(tokenWeights.entries())
		.sort((a, b) => {
			const weightDelta = b[1] - a[1];
			if (weightDelta !== 0) {
				return weightDelta;
			}
			return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
		})
		.map(([token]) => token);

	const combined: string[] = [];
	for (const phrase of sortedPhrases) {
		if (!combined.includes(phrase)) {
			combined.push(phrase);
		}
		if (combined.length >= desiredCount) {
			return combined.slice(0, desiredCount);
		}
	}
	for (const token of sortedTokens) {
		if (!combined.includes(token)) {
			combined.push(token);
		}
		if (combined.length >= desiredCount) {
			break;
		}
	}

	return combined.slice(0, desiredCount);
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
	if (!value) {
		return undefined;
	}
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function splitIdentifier(value: string | undefined, extraStopWords?: Set<string>): string[] {
	if (!value) {
		return [];
	}
	const lowered = value.toLowerCase();
	const replaced = lowered
		.replace(/[^a-z0-9]+/gi, ' ')
		.replace(/([a-z])([0-9])/gi, '$1 $2')
		.replace(/([0-9])([a-z])/gi, '$1 $2');
	return replaced
		.split(/\s+/)
		.map(token => token.trim())
		.filter(token => token.length >= 3 && !STOP_WORDS.has(token) && !(extraStopWords?.has(token) ?? false));
}

