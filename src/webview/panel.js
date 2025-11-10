// @ts-check
(function() {
	// Wrap everything in a try-catch to prevent silent failures
	try {
		const vscodeApi = (/** @type {any} */ (window)).acquireVsCodeApi();

		(function syncThemeSurface() {
			try {
				const computed = getComputedStyle(document.documentElement);
				const editorBg = (computed.getPropertyValue('--vscode-editor-background') || '').trim();
				if (editorBg) {
					document.body.style.background = editorBg;
				} else {
					document.body.style.background = '#1e1e1e';
				}
				const fg = (computed.getPropertyValue('--vscode-editor-foreground')
					|| computed.getPropertyValue('--vscode-foreground')
					|| '').trim();
				if (fg) {
					document.body.style.color = fg;
				}
			} catch (error) {
				console.warn('[IssueTriage] Failed to sync webview theme surface', error);
				document.body.style.background = '#1e1e1e';
			}
		}());

		/**
		 * @template {HTMLElement} T
		 * @param {string} id
		 * @returns {T}
		 */
		function requireElement(id) {
			const element = document.getElementById(id);
			if (!element) {
				console.error('[IssueTriage] Missing expected element #' + id);
				throw new Error('Missing expected element #' + id);
			}
			return /** @type {T} */ (element);
		}

	/**
	 * @param {string} id
	 * @returns {SVGSVGElement}
	 */
	function requireSvgElement(id) {
		const element = document.getElementById(id);
		if (!(element instanceof SVGSVGElement)) {
			throw new Error('Missing expected SVG element #' + id);
		}
		return element;
	}

	const connectButton = /** @type {HTMLButtonElement} */ (requireElement('connect'));
	const refreshButton = /** @type {HTMLButtonElement} */ (requireElement('refresh'));
	const repositorySelect = /** @type {HTMLSelectElement} */ (requireElement('repositorySelect'));
	const searchInput = /** @type {HTMLInputElement} */ (requireElement('searchInput'));
	const labelFilter = /** @type {HTMLSelectElement} */ (requireElement('labelFilter'));
	const assigneeFilter = /** @type {HTMLSelectElement} */ (requireElement('assigneeFilter'));
	const milestoneFilter = /** @type {HTMLSelectElement} */ (requireElement('milestoneFilter'));
	const readinessFilter = /** @type {HTMLSelectElement} */ (requireElement('readinessFilter'));
	const issueList = /** @type {HTMLElement} */ (requireElement('issueList'));
	issueList.setAttribute('aria-multiselectable', 'false');
	const issuesPanel = /** @type {HTMLElement} */ (requireElement('issuesPanel'));
	const mainContainer = /** @type {HTMLElement} */ (requireElement('mainContainer'));
	const emptyState = /** @type {HTMLElement} */ (requireElement('emptyState'));
	const issueSummary = /** @type {HTMLElement} */ (requireElement('issueSummary'));
	const loadingState = /** @type {HTMLElement} */ (requireElement('loadingState'));
	const accountLabel = /** @type {HTMLElement} */ (requireElement('accountLabel'));
	const automationBadge = /** @type {HTMLElement} */ (requireElement('automationBadge'));
	const assessmentPanel = /** @type {HTMLElement} */ (requireElement('assessmentPanel'));
	const detailPanel = /** @type {HTMLElement} */ (requireElement('detailPanel'));
	const overviewMetrics = /** @type {HTMLElement} */ (requireElement('overviewMetrics'));
	const openTab = /** @type {HTMLButtonElement} */ (requireElement('openTab'));
	const closedTab = /** @type {HTMLButtonElement} */ (requireElement('closedTab'));
	const unlinkedTab = /** @type {HTMLButtonElement} */ (requireElement('unlinkedTab'));
	const mlTrainingTab = /** @type {HTMLButtonElement} */ (requireElement('mlTrainingTab'));
	const matrixTab = /** @type {HTMLButtonElement} */ (requireElement('matrixTab'));
	const llmUsageTab = /** @type {HTMLButtonElement} */ (requireElement('llmUsageTab'));
	console.log('[IssueTriage] llmUsageTab element:', llmUsageTab, 'disabled:', llmUsageTab.disabled, 'hidden:', llmUsageTab.hidden);
	const backfillPanel = /** @type {HTMLElement} */ (requireElement('backfillPanel'));
	const backfillBody = /** @type {HTMLElement} */ (requireElement('backfillBody'));
	const refreshBackfillButton = /** @type {HTMLButtonElement} */ (requireElement('refreshBackfill'));
	
	// Unlinked filter state
	let unlinkedPrLimit = 50;
	let unlinkedCommitLimit = 50;
	let unlinkedDateFilter = 'all';
	const analysisActions = /** @type {HTMLElement} */ (requireElement('analysisActions'));
	const runAnalysisButton = /** @type {HTMLButtonElement} */ (requireElement('runAnalysisButton'));
	const mlTrainingPanel = /** @type {HTMLElement} */ (requireElement('mlTrainingPanel'));
	mlTrainingTab.hidden = true;
	mlTrainingTab.setAttribute('aria-hidden', 'true');
	mlTrainingTab.setAttribute('disabled', 'true');
	mlTrainingPanel.hidden = true;
	mlTrainingPanel.style.display = 'none';
	const matrixPanel = /** @type {HTMLElement} */ (requireElement('matrixPanel'));
	const llmUsagePanel = /** @type {HTMLElement} */ (requireElement('llmUsagePanel'));
	const readinessMatrixMain = requireSvgElement('readinessMatrixMain');
	const readinessMatrixTooltip = /** @type {HTMLElement} */ (requireElement('readinessMatrixTooltip'));
	const readinessMatrixEmpty = /** @type {HTMLElement} */ (requireElement('readinessMatrixEmpty'));
	const readinessMatrixLegend = /** @type {HTMLElement} */ (requireElement('readinessMatrixLegend'));
	const backfillMissingButton = /** @type {HTMLButtonElement} */ (requireElement('backfillMissingButton'));
	const backfillAllButton = /** @type {HTMLButtonElement} */ (requireElement('backfillAllButton'));
	const cancelBackfillButton = /** @type {HTMLButtonElement} */ (requireElement('cancelBackfillButton'));
	const exportDatasetButton = /** @type {HTMLButtonElement} */ (requireElement('exportDatasetButton'));
	const downloadDatasetButton = /** @type {HTMLButtonElement} */ (requireElement('downloadDatasetButton'));
	const backfillProgress = /** @type {HTMLElement} */ (requireElement('backfillProgress'));
	const backfillProgressBar = /** @type {HTMLElement} */ (requireElement('backfillProgressBar'));
	const backfillStatus = /** @type {HTMLElement} */ (requireElement('backfillStatus'));
	const backfillResults = /** @type {HTMLElement} */ (requireElement('backfillResults'));
	const exportResults = /** @type {HTMLElement} */ (requireElement('exportResults'));
	const downloadResults = /** @type {HTMLElement} */ (requireElement('downloadResults'));
	const totalIssuesCount = /** @type {HTMLElement} */ (requireElement('totalIssuesCount'));
	const keywordCoverageCount = /** @type {HTMLElement} */ (requireElement('keywordCoverageCount'));
	const keywordCoveragePct = /** @type {HTMLElement} */ (requireElement('keywordCoveragePct'));
	const lastExport = /** @type {HTMLElement} */ (requireElement('lastExport'));
	const openNewIssueButton = /** @type {HTMLButtonElement} */ (requireElement('openNewIssue'));
	const newIssueOverlay = /** @type {HTMLElement} */ (requireElement('newIssueOverlay'));
	const newIssueForm = /** @type {HTMLFormElement} */ (requireElement('newIssueForm'));
	const newIssueTitleInput = /** @type {HTMLInputElement} */ (requireElement('newIssueTitle'));
	const newIssueSummaryInput = /** @type {HTMLTextAreaElement} */ (requireElement('newIssueSummary'));
	const newIssueLabelsInput = /** @type {HTMLInputElement} */ (requireElement('newIssueLabels'));
	const newIssueAssigneesInput = /** @type {HTMLInputElement} */ (requireElement('newIssueAssignees'));
	const newIssuePriorityInput = /** @type {HTMLInputElement} */ (requireElement('newIssuePriority'));
	const analyzeNewIssueButton = /** @type {HTMLButtonElement} */ (requireElement('analyzeNewIssueButton'));
	const createNewIssueButton = /** @type {HTMLButtonElement} */ (requireElement('createNewIssueButton'));
	const resetNewIssueButton = /** @type {HTMLButtonElement} */ (requireElement('resetNewIssueButton'));
	const closeNewIssueButton = /** @type {HTMLButtonElement} */ (requireElement('closeNewIssueButton'));
	const newIssueStatus = /** @type {HTMLElement} */ (requireElement('newIssueStatus'));
	const newIssueAnalysisSection = /** @type {HTMLElement} */ (requireElement('newIssueAnalysisSection'));
	const newIssueAnalysisResults = /** @type {HTMLElement} */ (requireElement('newIssueAnalysisResults'));
	const newIssueTokenUsage = /** @type {HTMLElement} */ (requireElement('newIssueTokenUsage'));
	const newIssueMatchContainer = /** @type {HTMLElement} */ (requireElement('newIssueMatchContainer'));
	const newIssueMatchList = /** @type {HTMLElement} */ (requireElement('newIssueMatchList'));
	const newIssueKeywordSummary = /** @type {HTMLElement} */ (requireElement('newIssueKeywordSummary'));
	const newIssueCreateResult = /** @type {HTMLElement} */ (requireElement('newIssueCreateResult'));
	const labelSuggestions = /** @type {HTMLDataListElement} */ (requireElement('labelSuggestions'));
	const assigneeSuggestions = /** @type {HTMLDataListElement} */ (requireElement('assigneeSuggestions'));
	const newIssueSubheading = /** @type {HTMLElement} */ (requireElement('newIssueSubheading'));
	const defaultNewIssueSubheading = newIssueSubheading.textContent || 'Draft a summary, run similarity, and create a GitHub issue without leaving VS Code.';


	const READINESS_OPTIONS = [
		{ value: 'all', label: 'All readiness states' },
		{ value: 'ready', label: 'Automation Ready' },
		{ value: 'prepare', label: 'Prep Required' },
		{ value: 'review', label: 'Needs Review' },
		{ value: 'manual', label: 'Manual Only' }
	];

	const READINESS_DEFINITIONS = {
		ready: {
			label: 'Automation Ready',
			className: 'readiness-ready',
			description: 'Safe to hand off to automation.'
		},
		prepare: {
			label: 'Prep Required',
			className: 'readiness-prepare',
			description: 'Add missing context then reassess.'
		},
		review: {
			label: 'Needs Review',
			className: 'readiness-review',
			description: 'Human review recommended before automation.'
		},
		manual: {
			label: 'Manual Only',
			className: 'readiness-manual',
			description: 'Keep this issue manual for now.'
		}
	};

	const READINESS_ORDER = ['ready', 'prepare', 'review', 'manual'];

	/**
	 * @typedef {Object} MatrixPoint
	 * @property {number} issueNumber
	 * @property {string} title
	 * @property {number} readinessScore
	 * @property {number} businessScore
	 * @property {keyof typeof READINESS_DEFINITIONS} readinessKey
	 * @property {string} readinessLabel
	 * @property {string} url
	 */

	const MATRIX_MIDPOINT = 50;

	/** @type {any} */
	let latestState = null;
	/** @type {number | undefined} */
	let selectedIssueNumber = undefined;
	/** @type {any} */
	let latestAssessment = null;
	/** @type {any[]} */
	let assessmentHistory = [];
	let currentTab = 'open';
	let issueStateFilter = 'open';
	/** @type {number | undefined} */
	let searchDebounceHandle = undefined;
	let bulkAssessmentPending = false;
	const pendingAnswers = new Set();
	/** @type {any | undefined} */
	let latestNewIssueAnalysis = undefined;
	/** @type {number | undefined} */
	let currentAnalysisRequestId = undefined;
	/** @type {number | undefined} */
	let currentCreateRequestId = undefined;
	let requestIdCounter = 1;
	/** @type {MatrixPoint[]} */
	let readinessMatrixData = [];
	/** @type {Map<number, MatrixPoint>} */
	const readinessMatrixLookup = new Map();
	/** @type {SVGCircleElement | null} */
	let readinessMatrixHoverCircle = null;

	/**
	 * @param {string} question
	 */
	function normalizeQuestionKey(question) {
		return typeof question === 'string' ? question.trim() : '';
	}

	/**
	 * @param {string} value
	 */
	function encodeValue(value) {
		return encodeURIComponent(value);
	}

	/**
	 * @param {string | null} value
	 */
	function decodeValue(value) {
		if (typeof value !== 'string') {
			return '';
		}
		try {
			return decodeURIComponent(value);
		} catch (error) {
			console.warn('[IssueTriage] Failed to decode value', error);
			return value;
		}
	}

	/**
	 * @param {number} issueNumber
	 * @param {string} question
	 */
	function buildAnswerKey(issueNumber, question) {
		return `${issueNumber}::${normalizeQuestionKey(question)}`;
	}

	function nextRequestId() {
		const id = requestIdCounter;
		requestIdCounter += 1;
		return id;
	}

	function isNewIssueOverlayVisible() {
		return !newIssueOverlay.hasAttribute('hidden');
	}

	function focusNewIssueTitle() {
		try {
			newIssueTitleInput.focus({ preventScroll: true });
		} catch (error) {
			newIssueTitleInput.focus();
		}
	}

	function getDefaultNewIssueStatusMessage() {
		const repositoryName = latestState?.selectedRepository?.fullName;
		if (repositoryName) {
			return 'Provide a title and summary, then analyze similar issues in ' + repositoryName + '.';
		}
		return 'Provide a title and summary, then analyze similar issues.';
	}

	function resetNewIssueFormState(focusTitle = false) {
		newIssueForm.reset();
		latestNewIssueAnalysis = undefined;
		currentAnalysisRequestId = undefined;
		currentCreateRequestId = undefined;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
		updateNewIssueStatus(getDefaultNewIssueStatusMessage(), 'info');
		newIssueAnalysisResults.hidden = true;
		newIssueMatchList.innerHTML = '';
		newIssueTokenUsage.textContent = 'Tokens used: —';
		renderNewIssueKeywordSummary([]);
		newIssueCreateResult.hidden = true;
		newIssueCreateResult.innerHTML = '';
		if (focusTitle) {
			focusNewIssueTitle();
		}
	}

	function openNewIssueOverlay() {
		if (isNewIssueOverlayVisible()) {
			focusNewIssueTitle();
			return;
		}
		resetNewIssueFormState(true);
		newIssueOverlay.hidden = false;
		newIssueOverlay.classList.add('visible');
		document.body.classList.add('new-issue-open');
		openNewIssueButton.setAttribute('aria-expanded', 'true');
		vscodeApi.postMessage({ type: 'webview.newIssue.opened' });
	}

	function closeNewIssueOverlay() {
		if (!isNewIssueOverlayVisible()) {
			return;
		}
		newIssueOverlay.classList.remove('visible');
		newIssueOverlay.hidden = true;
		document.body.classList.remove('new-issue-open');
		openNewIssueButton.setAttribute('aria-expanded', 'false');
		currentAnalysisRequestId = undefined;
		currentCreateRequestId = undefined;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
	}

	/**
	 * @param {string} message
	 * @param {'info' | 'success' | 'error'} [tone='info']
	 */
	function updateNewIssueStatus(message, tone = 'info') {
		newIssueStatus.textContent = message;
		newIssueStatus.classList.remove('success', 'error', 'muted');
		if (tone === 'success') {
			newIssueStatus.classList.add('success');
		} else if (tone === 'error') {
			newIssueStatus.classList.add('error');
		} else {
			newIssueStatus.classList.add('muted');
		}
	}

	/**
	 * @param {string} value
	 * @returns {string[]}
	 */
	function splitInputList(value) {
		if (typeof value !== 'string' || !value.trim()) {
			return [];
		}
		return value.split(/[,;]/).map(item => item.trim()).filter(Boolean);
	}

	function collectNewIssueDraft() {
		const title = newIssueTitleInput.value.trim();
		const summary = newIssueSummaryInput.value.trim();
		const labels = splitInputList(newIssueLabelsInput.value);
		const assignees = splitInputList(newIssueAssigneesInput.value);
		const priority = newIssuePriorityInput.value.trim();
		/** @type {{ title: string; summary: string; labels?: string[]; assignees?: string[]; priority?: string }} */
		const draft = {
			title,
			summary
		};
		if (labels.length) {
			draft.labels = labels;
		}
		if (assignees.length) {
			draft.assignees = assignees;
		}
		if (priority) {
			draft.priority = priority;
		}
		return draft;
	}

	function refreshNewIssueButtons() {
		const analyzing = typeof currentAnalysisRequestId === 'number';
		const creating = typeof currentCreateRequestId === 'number';
		const busy = analyzing || creating;
		analyzeNewIssueButton.disabled = busy;
		analyzeNewIssueButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
		analyzeNewIssueButton.textContent = analyzing ? 'Analyzing…' : 'Analyze Similar Issues';
		createNewIssueButton.disabled = busy;
		createNewIssueButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
		createNewIssueButton.textContent = creating ? 'Creating…' : 'Create Issue';
		resetNewIssueButton.disabled = busy;
	}

	function refreshNewIssueBusyState() {
		const busy = typeof currentAnalysisRequestId === 'number' || typeof currentCreateRequestId === 'number';
		newIssueAnalysisSection.setAttribute('aria-busy', busy ? 'true' : 'false');
	}

	/**
	 * @param {string[]} keywords
	 */
	function renderNewIssueKeywordSummary(keywords) {
		if (!Array.isArray(keywords) || !keywords.length) {
			newIssueKeywordSummary.innerHTML = '<span class="muted">No keywords extracted yet.</span>';
			return;
		}
		const chips = keywords.map(keyword => '<span class="new-issue-chip">' + escapeHtml(keyword) + '</span>').join('');
		newIssueKeywordSummary.innerHTML = chips;
	}

	/**
	 * @param {Array<any>} matches
	 * @returns {string}
	 */
	function renderNewIssueMatches(matches) {
		if (!Array.isArray(matches) || matches.length === 0) {
			return '<li class="new-issue-match muted" role="listitem">No similar issues detected.</li>';
		}
		const items = matches.map(renderNewIssueMatch).filter(Boolean);
		if (!items.length) {
			return '<li class="new-issue-match muted" role="listitem">No similar issues detected.</li>';
		}
		return items.join('');
	}

	/**
	 * @param {any} match
	 * @returns {string}
	 */
	function renderNewIssueMatch(match) {
		if (!match || typeof match !== 'object') {
			return '';
		}
		const issueNumberRaw = Number(match.issueNumber);
		const issueNumber = Number.isFinite(issueNumberRaw) ? issueNumberRaw : undefined;
		const title = typeof match.title === 'string' && match.title.trim()
			? match.title.trim()
			: (issueNumber ? 'Issue #' + issueNumber : 'Related issue');
		const labelParts = [];
		if (issueNumber) {
			labelParts.push('#' + issueNumber);
		}
		labelParts.push(title);
		const headerLabel = labelParts.join(' · ');
		const url = typeof match.url === 'string' ? match.url : '';
		const confidenceLabel = typeof match.confidenceLabel === 'string' ? match.confidenceLabel : 'Similarity match';
		const overlapRaw = typeof match.overlapScore === 'number' ? match.overlapScore : Number(match.overlapScore);
		const scorePercent = Number.isFinite(overlapRaw) ? Math.round(Math.max(0, Math.min(1, overlapRaw)) * 100) : 0;
		const stateLabel = match.state === 'open' ? 'Open' : 'Closed';
		const riskLevelRaw = typeof match.riskLevel === 'string' ? match.riskLevel : 'low';
		const riskLevel = riskLevelRaw.charAt(0).toUpperCase() + riskLevelRaw.slice(1);
		const riskScoreRaw = typeof match.riskScore === 'number' ? match.riskScore : Number(match.riskScore);
		const riskSegment = Number.isFinite(riskScoreRaw) && riskScoreRaw > 0
			? riskLevel + ' risk · ' + Math.round(riskScoreRaw)
			: riskLevel + ' risk';
		let calculatedAt;
		if (typeof match.calculatedAt === 'string' && match.calculatedAt) {
			const calculatedTime = Date.parse(match.calculatedAt);
			if (Number.isFinite(calculatedTime)) {
				calculatedAt = new Date(calculatedTime).toLocaleString();
			}
		}
		const summary = typeof match.summary === 'string' ? match.summary : '';
		const sharedKeywords = Array.isArray(match.sharedKeywords) ? match.sharedKeywords : [];
		const labels = Array.isArray(match.labels) ? match.labels : [];
		const metaSegments = [
			'Overlap ' + scorePercent + '%',
			stateLabel,
			riskSegment
		];
		if (calculatedAt) {
			metaSegments.push('Calculated ' + calculatedAt);
		}
		const metaHtml = '<div class="new-issue-match-meta">' + metaSegments.map(segment => escapeHtml(segment)).join(' · ') + '</div>';
		const summaryHtml = summary ? '<p class="new-issue-match-meta">' + escapeHtml(summary) + '</p>' : '';
		const sharedHtml = sharedKeywords.length
			? '<div class="new-issue-match-meta">Shared keywords: ' + escapeHtml(sharedKeywords.join(', ')) + '</div>'
			: '';
		const labelsHtml = labels.length
			? '<div class="new-issue-match-meta">Labels: ' + escapeHtml(labels.join(', ')) + '</div>'
			: '';
		const actionHtml = url
			? '<button type="button" data-action="openMatch" data-url="' + escapeHtml(url) + '">' + escapeHtml(headerLabel) + '</button>'
			: '<span>' + escapeHtml(headerLabel) + '</span>';
		return '<li class="new-issue-match" role="listitem">' +
			'<div class="new-issue-match-header">' +
				actionHtml +
				'<span class="new-issue-match-confidence">' + escapeHtml(confidenceLabel) + '</span>' +
			'</div>' +
			metaHtml +
			summaryHtml +
			sharedHtml +
			labelsHtml +
		'</li>';
	}

	/**
	 * @param {number | string | undefined} tokens
	 * @returns {string}
	 */
	function formatNewIssueTokens(tokens) {
		const tokensValue = typeof tokens === 'number' ? tokens : Number(tokens);
		if (!Number.isFinite(tokensValue) || tokensValue <= 0) {
			return 'Tokens used: —';
		}
		return 'Tokens used: ' + tokensValue.toLocaleString();
	}

	/**
	 * @param {any} analysis
	 * @returns {void}
	 */
	function renderNewIssueAnalysis(analysis) {
		if (!analysis || typeof analysis !== 'object') {
			renderNewIssueKeywordSummary([]);
			newIssueAnalysisResults.hidden = true;
			updateNewIssueStatus('No analysis data returned.', 'error');
			return;
		}
		latestNewIssueAnalysis = analysis;
		newIssueCreateResult.hidden = true;
		newIssueCreateResult.innerHTML = '';
		const matches = Array.isArray(analysis.matches) ? analysis.matches : [];
		const keywords = Array.isArray(analysis.keywords) ? analysis.keywords : [];
		newIssueAnalysisResults.hidden = false;
		newIssueMatchList.innerHTML = renderNewIssueMatches(matches);
		renderNewIssueKeywordSummary(keywords);
		newIssueTokenUsage.textContent = formatNewIssueTokens(analysis.tokensUsed);
		const matchCount = matches.length;
		if (matchCount > 0) {
			updateNewIssueStatus('Found ' + matchCount + (matchCount === 1 ? ' similar issue.' : ' similar issues.'), 'info');
		} else {
			updateNewIssueStatus('No closely related issues detected. Ready to create a new issue.', 'success');
		}
	}

	/**
	 * @param {any} [state]
	 */
	function refreshNewIssueDatalists(state) {
		const source = state ?? latestState;
		const labels = source?.issueMetadata?.labels ?? [];
		const assignees = source?.issueMetadata?.assignees ?? [];
		updateDatalistOptions(labelSuggestions, labels);
		updateDatalistOptions(assigneeSuggestions, assignees);
	}

	/**
	 * @param {HTMLDataListElement} listElement
	 * @param {string[]} values
	 */
	function updateDatalistOptions(listElement, values) {
		/** @type {string[]} */
		const uniqueValues = [];
		if (Array.isArray(values)) {
			for (const value of values) {
				if (typeof value !== 'string') {
					continue;
				}
				const trimmed = value.trim();
				if (!trimmed || uniqueValues.includes(trimmed)) {
					continue;
				}
				uniqueValues.push(trimmed);
			}
		}
		listElement.innerHTML = uniqueValues.map(item => '<option value="' + escapeHtml(item) + '"></option>').join('');
	}

	function startNewIssueAnalysis() {
		if (!isNewIssueOverlayVisible()) {
			openNewIssueOverlay();
			return;
		}
		if (!newIssueForm.reportValidity()) {
			return;
		}
		if (!latestState || !latestState.selectedRepository) {
			updateNewIssueStatus('Select a repository before analyzing similar issues.', 'error');
			return;
		}
		const draft = collectNewIssueDraft();
		if (!draft.title || !draft.summary) {
			updateNewIssueStatus('Title and summary are required for analysis.', 'error');
			return;
		}
		const requestId = nextRequestId();
		currentAnalysisRequestId = requestId;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
		latestNewIssueAnalysis = undefined;
		newIssueAnalysisResults.hidden = true;
		newIssueMatchList.innerHTML = '';
		newIssueTokenUsage.textContent = 'Tokens used: —';
		renderNewIssueKeywordSummary([]);
		newIssueCreateResult.hidden = true;
		newIssueCreateResult.innerHTML = '';
		updateNewIssueStatus('Analyzing similar issues…', 'info');
		vscodeApi.postMessage({
			type: 'webview.newIssue.analyze',
			requestId,
			draft
		});
	}

	function startCreateNewIssue() {
		if (!newIssueForm.reportValidity()) {
			return;
		}
		if (!latestState || !latestState.selectedRepository) {
			updateNewIssueStatus('Select a repository before creating an issue.', 'error');
			return;
		}
		const draft = collectNewIssueDraft();
		if (!draft.title || !draft.summary) {
			updateNewIssueStatus('Title and summary are required before creating an issue.', 'error');
			return;
		}
		const requestId = nextRequestId();
		currentCreateRequestId = requestId;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
		newIssueCreateResult.hidden = true;
		newIssueCreateResult.innerHTML = '';
		updateNewIssueStatus('Creating GitHub issue…', 'info');
		/** @type {{ type: string; requestId: number; draft: { title: string; summary: string; labels?: string[]; assignees?: string[]; priority?: string }; analysis?: any }} */
		const payload = {
			type: 'webview.newIssue.create',
			requestId,
			draft
		};
		if (latestNewIssueAnalysis && typeof latestNewIssueAnalysis === 'object') {
			payload.analysis = latestNewIssueAnalysis;
		}
		vscodeApi.postMessage(payload);
	}

	/**
	 * @param {{ requestId?: number | string; analysis?: any }} message
	 */
	function handleNewIssueAnalysisMessage(message) {
		const requestId = Number(message.requestId);
		if (!Number.isFinite(requestId) || requestId !== currentAnalysisRequestId) {
			return;
		}
		currentAnalysisRequestId = undefined;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
		renderNewIssueAnalysis(message.analysis);
	}

	/**
	 * @param {{ requestId?: number | string; error?: string }} message
	 */
	function handleNewIssueAnalysisError(message) {
		const requestId = Number(message.requestId);
		if (!Number.isFinite(requestId) || requestId !== currentAnalysisRequestId) {
			return;
		}
		currentAnalysisRequestId = undefined;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
		const description = typeof message.error === 'string' && message.error
			? message.error
			: 'Unable to analyze similar issues.';
		updateNewIssueStatus(description, 'error');
		newIssueAnalysisResults.hidden = true;
		newIssueMatchList.innerHTML = '';
		newIssueTokenUsage.textContent = 'Tokens used: —';
		renderNewIssueKeywordSummary([]);
	}

	/**
	 * @param {{ requestId?: number | string; issueNumber?: number | string; title?: string; url?: string }} message
	 */
	function handleNewIssueCreated(message) {
		const requestId = Number(message.requestId);
		if (!Number.isFinite(requestId) || requestId !== currentCreateRequestId) {
			return;
		}
		currentCreateRequestId = undefined;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
		newIssueForm.reset();
		latestNewIssueAnalysis = undefined;
		newIssueAnalysisResults.hidden = true;
		newIssueMatchList.innerHTML = '';
		newIssueTokenUsage.textContent = 'Tokens used: —';
		renderNewIssueKeywordSummary([]);
		const issueNumber = Number(message.issueNumber);
		const issueLabel = Number.isFinite(issueNumber) && issueNumber > 0 ? '#' + issueNumber : 'Issue';
		const title = typeof message.title === 'string' ? message.title : '';
		updateNewIssueStatus('Created ' + issueLabel + '.', 'success');
		const url = typeof message.url === 'string' ? message.url : '';
		const openButton = url
			? '<button type="button" class="button-link" data-action="openCreatedIssue" data-url="' + escapeHtml(url) + '">Open in GitHub</button>'
			: '';
		newIssueCreateResult.hidden = false;
		newIssueCreateResult.innerHTML =
			'<div class="success-message">' +
				'<p><strong>' + escapeHtml(issueLabel) + '</strong> ' + escapeHtml(title) + '</p>' +
				(openButton ? '<p>' + openButton + '</p>' : '') +
			'</div>';
	}

	/**
	 * @param {{ requestId?: number | string; error?: string }} message
	 */
	function handleNewIssueCreateError(message) {
		const requestId = Number(message.requestId);
		if (!Number.isFinite(requestId) || requestId !== currentCreateRequestId) {
			return;
		}
		currentCreateRequestId = undefined;
		refreshNewIssueButtons();
		refreshNewIssueBusyState();
		const description = typeof message.error === 'string' && message.error
			? message.error
			: 'Unable to create the issue.';
		updateNewIssueStatus(description, 'error');
		newIssueCreateResult.hidden = false;
		newIssueCreateResult.innerHTML =
			'<div class="error-message">' +
				'<p><strong>Issue creation failed</strong></p>' +
				'<p>' + escapeHtml(description) + '</p>' +
			'</div>';
	}

	refreshNewIssueButtons();
	refreshNewIssueBusyState();
	renderNewIssueKeywordSummary([]);
	updateNewIssueStatus(getDefaultNewIssueStatusMessage(), 'info');
	openNewIssueButton.setAttribute('aria-expanded', 'false');

	window.addEventListener('message', event => {
		const message = event.data;
		if (!message) {
			return;
		}
		switch (message.type) {
			case 'stateUpdate':
				latestState = message.state;
				renderState(latestState);
				break;
			case 'assessment.loading':
				if (message.issueNumber === selectedIssueNumber) {
					renderAssessmentLoading();
				}
				break;
			case 'assessment.result':
				if (message.issueNumber === selectedIssueNumber) {
					if (message.assessment) {
						renderAssessmentResult(message.assessment);
					} else {
						renderAssessmentEmpty('Run an IssueTriage assessment to populate this panel.');
					}
				}
				break;
			case 'assessment.error':
				if (message.issueNumber === selectedIssueNumber) {
					renderAssessmentError(typeof message.message === 'string' ? message.message : 'Unable to load assessment.');
				}
				break;
			case 'assessment.history':
				if (message.issueNumber === selectedIssueNumber) {
					assessmentHistory = Array.isArray(message.history) ? message.history : [];
					renderAssessmentHistory();
				}
				break;
			case 'assessment.historyError':
				console.warn('[IssueTriage] Failed to load assessment history:', message.message);
				break;
			case 'assessment.questionAnswered':
				handleQuestionAnswered(message);
				break;
			case 'assessment.questionAnswerError':
				handleQuestionAnswerError(message);
				break;
			case 'assessment.bulkComplete':
				bulkAssessmentPending = false;
				refreshRunAnalysisControls();
				break;
			case 'ml.keywordStats':
				if (message.stats) {
					updateKeywordStats(message.stats);
				}
				break;
			case 'ml.backfillProgress':
				if (message.progress) {
					updateBackfillProgress(message.progress);
				}
				break;
			case 'ml.backfillComplete':
				handleBackfillComplete(message);
				break;
			case 'ml.lastExport':
				renderLastExport(message.record);
				break;
			case 'ml.exportComplete':
				handleExportComplete(message);
				break;
			case 'ml.downloadComplete':
				handleDownloadComplete(message);
				break;
			case 'newIssue.analysis':
				handleNewIssueAnalysisMessage(message);
				break;
			case 'newIssue.analysisError':
				handleNewIssueAnalysisError(message);
				break;
			case 'newIssue.created':
				handleNewIssueCreated(message);
				break;
			case 'newIssue.createError':
				handleNewIssueCreateError(message);
				break;
			default:
				break;
		}
	});

	connectButton.addEventListener('click', () => {
		const currentState = latestState;
		if (currentState && currentState.session) {
			vscodeApi.postMessage({ type: 'webview.signOut' });
		} else {
			vscodeApi.postMessage({ type: 'webview.connect' });
		}
	});

	refreshButton.addEventListener('click', () => {
		vscodeApi.postMessage({ type: 'webview.refresh' });
	});

	repositorySelect.addEventListener('change', () => {
		const value = repositorySelect.value;
		vscodeApi.postMessage({ type: 'webview.selectRepository', repository: value });
	});

	function onFilterChanged() {
		const stateFilter = issueStateFilter || 'open';
		const readinessValue = readinessFilter.value || 'all';
		const filters = {
			search: searchInput.value || undefined,
			label: labelFilter.value || undefined,
			assignee: assigneeFilter.value || undefined,
			milestone: milestoneFilter.value || undefined,
			readiness: readinessValue,
			state: stateFilter
		};
		console.log('[IssueTriage] Filters changed:', filters);
		vscodeApi.postMessage({ type: 'webview.filtersChanged', filters });
	}

	labelFilter.addEventListener('change', onFilterChanged);
	assigneeFilter.addEventListener('change', onFilterChanged);
	milestoneFilter.addEventListener('change', onFilterChanged);
	readinessFilter.addEventListener('change', onFilterChanged);
	searchInput.addEventListener('input', () => {
		// Debounce lightly to avoid flooding the extension with messages on each keystroke.
		if (typeof searchDebounceHandle === 'number') {
			window.clearTimeout(searchDebounceHandle);
		}
		searchDebounceHandle = window.setTimeout(() => {
			onFilterChanged();
		}, 150);
	});

	openTab.addEventListener('click', () => {
		if (currentTab === 'open' && issueStateFilter === 'open') {
			return;
		}
		console.log('[IssueTriage] Switching to open tab');
		currentTab = 'open';
		issueStateFilter = 'open';
		updateStateTabs();
		if (latestState) {
			latestState = {
				...latestState,
				filters: {
					...(latestState.filters ?? {}),
					state: 'open'
				}
			};
			renderState(latestState);
		}
		onFilterChanged();
	});

	closedTab.addEventListener('click', () => {
		if (currentTab === 'closed' && issueStateFilter === 'closed') {
			return;
		}
		console.log('[IssueTriage] Switching to closed tab');
		currentTab = 'closed';
		issueStateFilter = 'closed';
		updateStateTabs();
		if (latestState) {
			latestState = {
				...latestState,
				filters: {
					...(latestState.filters ?? {}),
					state: 'closed'
				}
			};
			renderState(latestState);
		}
		onFilterChanged();
	});

	unlinkedTab.addEventListener('click', () => {
		if (currentTab === 'unlinked') {
			return;
		}
		console.log('[IssueTriage] Switching to unlinked tab');
		currentTab = 'unlinked';
		updateStateTabs();
		if (latestState) {
			renderState(latestState);
		}
	});

	matrixTab.addEventListener('click', () => {
		if (currentTab === 'matrix') {
			return;
		}
		console.log('[IssueTriage] Switching to matrix tab');
		currentTab = 'matrix';
		issueStateFilter = 'open';
		updateStateTabs();
		if (latestState) {
			latestState = {
				...latestState,
				filters: {
					...(latestState.filters ?? {}),
					state: 'open'
				}
			};
			renderState(latestState);
		}
		onFilterChanged();
	});

	llmUsageTab.addEventListener('click', (event) => {
		console.log('[IssueTriage] LLM Usage tab clicked!', event);
		if (currentTab === 'llmUsage') {
			console.log('[IssueTriage] Already on LLM Usage tab');
			return;
		}
		console.log('[IssueTriage] Switching to LLM Usage tab');
		currentTab = 'llmUsage';
		updateStateTabs();
		if (latestState) {
			renderState(latestState);
		}
	});

	mlTrainingTab.addEventListener('click', () => {
		if (currentTab === 'mlTraining') {
			return;
		}
		console.log('[IssueTriage] Switching to ML Training tab');
		currentTab = 'mlTraining';
		updateStateTabs();
		if (latestState) {
			renderState(latestState);
		}
		loadKeywordStats();
		loadLastExport();
	});

	runAnalysisButton.addEventListener('click', () => {
		if (!latestState) {
			return;
		}
		const candidates = getUnanalyzedOpenIssues(5);
		const issueNumbers = candidates.map(candidate => candidate.number);
		if (!issueNumbers.length) {
			vscodeApi.postMessage({ type: 'webview.runBulkAssessment', issueNumbers: [] });
			return;
		}
		bulkAssessmentPending = true;
		refreshRunAnalysisControls();
		vscodeApi.postMessage({ type: 'webview.runBulkAssessment', issueNumbers });
	});

	openNewIssueButton.addEventListener('click', event => {
		event.preventDefault();
		if (openNewIssueButton.disabled) {
			return;
		}
		openNewIssueOverlay();
	});

	closeNewIssueButton.addEventListener('click', event => {
		event.preventDefault();
		closeNewIssueOverlay();
	});

	newIssueOverlay.addEventListener('click', event => {
		if (event.target === newIssueOverlay) {
			closeNewIssueOverlay();
		}
	});

	resetNewIssueButton.addEventListener('click', event => {
		event.preventDefault();
		if (resetNewIssueButton.disabled) {
			return;
		}
		resetNewIssueFormState(true);
	});

	analyzeNewIssueButton.addEventListener('click', event => {
		event.preventDefault();
		if (analyzeNewIssueButton.disabled) {
			return;
		}
		startNewIssueAnalysis();
	});

	newIssueForm.addEventListener('submit', event => {
		event.preventDefault();
		if (createNewIssueButton.disabled) {
			return;
		}
		startCreateNewIssue();
	});

	newIssueMatchList.addEventListener('click', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const button = event.target.closest('button[data-action="openMatch"]');
		if (!(button instanceof HTMLButtonElement)) {
			return;
		}
		const url = button.getAttribute('data-url');
		if (url) {
			vscodeApi.postMessage({ type: 'webview.openIssue', url });
		}
	});

	newIssueCreateResult.addEventListener('click', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const button = event.target.closest('button[data-action="openCreatedIssue"]');
		if (!(button instanceof HTMLButtonElement)) {
			return;
		}
		const url = button.getAttribute('data-url');
		if (url) {
			vscodeApi.postMessage({ type: 'webview.openIssue', url });
		}
	});

	window.addEventListener('keydown', event => {
		if (event.defaultPrevented) {
			return;
		}
		if (event.key === 'Escape' && isNewIssueOverlayVisible()) {
			event.preventDefault();
			closeNewIssueOverlay();
		}
	});

	function updateStateTabs() {
		const openSelected = currentTab === 'open';
		const closedSelected = currentTab === 'closed';
		const unlinkedSelected = currentTab === 'unlinked';
		const matrixSelected = currentTab === 'matrix';
		const llmUsageSelected = currentTab === 'llmUsage';
		const mlTrainingSelected = currentTab === 'mlTraining';
		openTab.classList.toggle('active', openSelected);
		openTab.setAttribute('aria-pressed', openSelected ? 'true' : 'false');
		closedTab.classList.toggle('active', closedSelected);
		closedTab.setAttribute('aria-pressed', closedSelected ? 'true' : 'false');
		unlinkedTab.classList.toggle('active', unlinkedSelected);
		unlinkedTab.setAttribute('aria-pressed', unlinkedSelected ? 'true' : 'false');
		matrixTab.classList.toggle('active', matrixSelected);
		matrixTab.setAttribute('aria-pressed', matrixSelected ? 'true' : 'false');
		llmUsageTab.classList.toggle('active', llmUsageSelected);
		llmUsageTab.setAttribute('aria-pressed', llmUsageSelected ? 'true' : 'false');
		mlTrainingTab.classList.toggle('active', mlTrainingSelected);
		mlTrainingTab.setAttribute('aria-pressed', mlTrainingSelected ? 'true' : 'false');
	}

	/**
	 * @param {number} [limit]
	 * @returns {Array<{ number: number }>}
	 */
	function getUnanalyzedOpenIssues(limit = 5) {
		if (!latestState) {
			return [];
		}
		const issues = Array.isArray(latestState.issues) ? latestState.issues : [];
		const summaries = latestState.assessmentSummaries ?? {};
		const result = [];
		for (const issue of issues) {
			if (issue.state === 'closed') {
				continue;
			}
			if (summaries[issue.number]) {
				continue;
			}
			result.push(issue);
			if (result.length >= limit) {
				break;
			}
		}
		return result;
	}

	function refreshRunAnalysisControls() {
		const hidden = currentTab !== 'open';
		analysisActions.hidden = hidden;
		if (hidden) {
			runAnalysisButton.disabled = false;
			runAnalysisButton.setAttribute('aria-disabled', 'false');
			runAnalysisButton.textContent = 'Run Analysis';
			runAnalysisButton.title = 'Run IssueTriage analysis for the first five unanalyzed open issues.';
			return;
		}
		const hasRepository = Boolean(latestState && latestState.selectedRepository);
		const loading = Boolean(latestState && latestState.loading);
		const eligibleCount = getUnanalyzedOpenIssues(5).length;
		const shouldDisable = bulkAssessmentPending || loading || !hasRepository || eligibleCount === 0;
		runAnalysisButton.disabled = shouldDisable;
		runAnalysisButton.setAttribute('aria-disabled', shouldDisable ? 'true' : 'false');
		runAnalysisButton.textContent = bulkAssessmentPending ? 'Running…' : 'Run Analysis';
		if (!hasRepository) {
			runAnalysisButton.title = 'Connect a repository to run analysis.';
		} else if (eligibleCount === 0) {
			runAnalysisButton.title = 'No unanalyzed open issues are ready for analysis.';
		} else if (bulkAssessmentPending) {
			runAnalysisButton.title = 'Running IssueTriage analysis…';
		} else {
			runAnalysisButton.title = 'Run IssueTriage analysis for the first five unanalyzed open issues.';
		}
	}

	issueList.addEventListener('click', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const actionButton = event.target.closest('button[data-action]');
		if (actionButton && issueList.contains(actionButton)) {
			const action = actionButton.getAttribute('data-action');
			const issueAttr = actionButton.getAttribute('data-issue-number');
			const issueNumber = Number(issueAttr);
			if (action === 'runAssessment' && Number.isFinite(issueNumber)) {
				event.preventDefault();
				event.stopPropagation();
				selectIssue(issueNumber, false);
				vscodeApi.postMessage({ type: 'webview.runAssessment', issueNumber });
			}
			return;
		}
		const card = event.target.closest('.issue-card');
		if (!card) {
			return;
		}
		const issueNumber = Number(card.getAttribute('data-issue-number'));
		if (Number.isNaN(issueNumber)) {
			return;
		}
		selectIssue(issueNumber, true);
	});

	issueList.addEventListener('keydown', handleIssueListKeydown);

	issueList.addEventListener('dblclick', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const actionButton = event.target.closest('button[data-action]');
		if (actionButton) {
			event.preventDefault();
			return;
		}
		const card = event.target.closest('.issue-card');
		if (!card) {
			return;
		}
		const url = card.getAttribute('data-url');
		if (url) {
			vscodeApi.postMessage({ type: 'webview.openIssue', url });
		}
	});

	/**
	 * @param {KeyboardEvent} event
	 */
	function handleIssueListKeydown(event) {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const card = event.target.closest('.issue-card');
		if (!card) {
			return;
		}
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				moveSelection(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				moveSelection(-1);
				break;
			case 'Home':
				event.preventDefault();
				selectIssueAtIndex(0, true);
				break;
			case 'End':
				event.preventDefault();
				selectIssueAtIndex(getIssueCards().length - 1, true);
				break;
			case 'Enter':
			case ' ': {
				event.preventDefault();
				const issueNumber = Number(card.getAttribute('data-issue-number'));
				if (!Number.isNaN(issueNumber)) {
					selectIssue(issueNumber, true);
				}
				break;
			}
			default:
				break;
		}
	}

	/**
	 * @returns {HTMLElement[]}
	 */
	function getIssueCards() {
		return /** @type {HTMLElement[]} */ (Array.from(issueList.querySelectorAll('.issue-card')));
	}

	/**
	 * @param {number} index
	 * @param {boolean} focusCard
	 */
	function selectIssueAtIndex(index, focusCard) {
		const cards = getIssueCards();
		if (!cards.length) {
			return;
		}
		const boundedIndex = Math.max(0, Math.min(index, cards.length - 1));
		const targetCard = cards[boundedIndex];
		const issueNumber = Number(targetCard.getAttribute('data-issue-number'));
		if (!Number.isNaN(issueNumber)) {
			selectIssue(issueNumber, focusCard);
		}
	}

	/**
	 * @param {number} offset
	 */
	function moveSelection(offset) {
		const cards = getIssueCards();
		if (!cards.length) {
			return;
		}
		const currentIndex = cards.findIndex(card => Number(card.getAttribute('data-issue-number')) === selectedIssueNumber);
		const nextIndex = currentIndex === -1
			? (offset > 0 ? 0 : cards.length - 1)
			: Math.max(0, Math.min(currentIndex + offset, cards.length - 1));
		selectIssueAtIndex(nextIndex, true);
	}

	assessmentPanel.addEventListener('click', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const button = event.target.closest('button[data-action]');
		if (!button) {
			return;
		}
		const action = button.getAttribute('data-action');
		if (action === 'openIssue') {
			const issueUrl = getIssueUrl(selectedIssueNumber);
			if (issueUrl) {
				vscodeApi.postMessage({ type: 'webview.openIssue', url: issueUrl });
			}
		} else if (action === 'openComment') {
			const commentUrl = button.getAttribute('data-url');
			if (commentUrl) {
				vscodeApi.postMessage({ type: 'webview.openUrl', url: commentUrl });
			}
		} else if (action === 'copyForAI') {
			if (typeof selectedIssueNumber === 'number') {
				vscodeApi.postMessage({ type: 'webview.copyIssueForAI', issueNumber: selectedIssueNumber });
			}
		} else if (action === 'exportMarkdown') {
			if (typeof selectedIssueNumber === 'number') {
				vscodeApi.postMessage({ type: 'webview.exportAssessment', issueNumber: selectedIssueNumber, format: 'markdown' });
			}
		} else if (action === 'exportJson') {
			if (typeof selectedIssueNumber === 'number') {
				vscodeApi.postMessage({ type: 'webview.exportAssessment', issueNumber: selectedIssueNumber, format: 'json' });
			}
		} else if (action === 'submitAnswer') {
			if (typeof selectedIssueNumber !== 'number') {
				return;
			}
			const item = button.closest('.assessment-question');
			if (!(item instanceof HTMLElement)) {
				return;
			}
			const encodedOriginal = item.getAttribute('data-question-original');
			const question = decodeValue(encodedOriginal).trim();
			const textarea = item.querySelector('textarea');
			if (!(textarea instanceof HTMLTextAreaElement)) {
				return;
			}
			const answer = textarea.value.trim();
			if (!answer) {
				item.classList.add('question-error');
				const errorEl = item.querySelector('.question-error-message');
				if (errorEl) {
					errorEl.textContent = 'Enter an answer before submitting.';
				}
				try {
					textarea.focus({ preventScroll: true });
				} catch (error) {
					textarea.focus();
				}
				return;
			}
			const answerKey = buildAnswerKey(selectedIssueNumber, question);
			if (pendingAnswers.has(answerKey)) {
				return;
			}
			pendingAnswers.add(answerKey);
			item.classList.remove('question-error');
			const errorEl = item.querySelector('.question-error-message');
			if (errorEl) {
				errorEl.textContent = '';
			}
			const submitButton = /** @type {HTMLButtonElement} */ (button);
			submitButton.disabled = true;
			submitButton.textContent = 'Posting…';
			textarea.disabled = true;
			vscodeApi.postMessage({
				type: 'webview.answerAssessmentQuestion',
				issueNumber: selectedIssueNumber,
				question,
				answer
			});
		} else if (action === 'rerunAssessment') {
			if (typeof selectedIssueNumber === 'number') {
				vscodeApi.postMessage({ type: 'webview.runAssessment', issueNumber: selectedIssueNumber });
			}
		}
	});

	refreshBackfillButton.addEventListener('click', () => {
		vscodeApi.postMessage({ type: 'webview.refreshUnlinked' });
	});

	/**
	 * @param {boolean} disabled
	 */
	function setBackfillButtonsDisabled(disabled) {
		backfillMissingButton.disabled = disabled;
		backfillAllButton.disabled = disabled;
	}

	backfillMissingButton.addEventListener('click', () => {
		setBackfillButtonsDisabled(true);
		cancelBackfillButton.disabled = false;
		backfillProgress.hidden = false;
		backfillProgressBar.style.width = '0%';
		backfillStatus.textContent = 'Preparing keyword backfill...';
		backfillResults.innerHTML = '';
		vscodeApi.postMessage({ type: 'webview.backfillKeywords', mode: 'missing' });
	});

	backfillAllButton.addEventListener('click', () => {
		setBackfillButtonsDisabled(true);
		cancelBackfillButton.disabled = false;
		backfillProgress.hidden = false;
		backfillProgressBar.style.width = '0%';
		backfillStatus.textContent = 'Preparing keyword backfill...';
		backfillResults.innerHTML = '';
		vscodeApi.postMessage({ type: 'webview.backfillKeywords', mode: 'all' });
	});

	cancelBackfillButton.addEventListener('click', () => {
		cancelBackfillButton.disabled = true;
		vscodeApi.postMessage({ type: 'webview.cancelBackfill' });
	});

	exportDatasetButton.addEventListener('click', () => {
		exportDatasetButton.disabled = true;
		exportResults.innerHTML = '<p class="info">Exporting dataset...</p>';
		vscodeApi.postMessage({ type: 'webview.exportDataset' });
	});

	downloadDatasetButton.addEventListener('click', () => {
		downloadDatasetButton.disabled = true;
		downloadResults.innerHTML = '<p class="info">Preparing download...</p>';
		vscodeApi.postMessage({ type: 'webview.downloadDataset' });
	});

	lastExport.addEventListener('click', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const button = event.target.closest('button[data-action]');
		if (!button) {
			return;
		}
		const action = button.getAttribute('data-action');
		const path = button.getAttribute('data-path');
		if (action === 'openDataset' && path) {
			vscodeApi.postMessage({ type: 'webview.openFolder', path });
		} else if (action === 'openManifest' && path) {
			vscodeApi.postMessage({ type: 'webview.openFile', path });
		}
	});

	downloadResults.addEventListener('click', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const button = event.target.closest('button[data-action]');
		if (!button) {
			return;
		}
		const action = button.getAttribute('data-action');
		const path = button.getAttribute('data-path');
		if (action === 'openFile' && path) {
			vscodeApi.postMessage({ type: 'webview.openFile', path });
		}
	});

	backfillPanel.addEventListener('click', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		
		// Handle bulk create buttons
		const bulkButton = event.target.closest('button[data-bulk-create]');
		if (bulkButton && backfillPanel.contains(bulkButton)) {
			event.preventDefault();
			const type = bulkButton.getAttribute('data-bulk-create');
			if (type === 'pull' || type === 'commit') {
				// Get the current filtered items from latestState
				if (!latestState || !latestState.unlinkedWork) {
					return;
				}
				const work = latestState.unlinkedWork;
				const allItems = type === 'pull' ? work.pullRequests : work.commits;
				const filteredItems = filterUnlinkedItems(
					allItems ?? [],
					type === 'pull' ? unlinkedPrLimit : unlinkedCommitLimit,
					unlinkedDateFilter
				);
				
				// Extract just the IDs/SHAs to send
				const itemIds = type === 'pull'
					? filteredItems.map(pr => pr.number)
					: filteredItems.map(commit => commit.sha);
				
				vscodeApi.postMessage({ 
					type: 'webview.bulkCreateIssues', 
					itemType: type,
					items: itemIds
				});
			}
			return;
		}
		
		const button = event.target.closest('button[data-backfill-action]');
		if (!button || !backfillPanel.contains(button)) {
			return;
		}
		event.preventDefault();
		const action = button.getAttribute('data-backfill-action');
		const type = button.getAttribute('data-backfill-type');
		const id = button.getAttribute('data-backfill-id');
		if (!action || !type || !id) {
			return;
		}
		if (action === 'open') {
			const url = button.getAttribute('data-backfill-url');
			if (url) {
				vscodeApi.postMessage({ type: 'webview.openUrl', url });
			}
			return;
		}
		if (type === 'pull') {
			const pullNumber = Number(id);
			if (!Number.isFinite(pullNumber)) {
				return;
			}
			if (action === 'link') {
				vscodeApi.postMessage({ type: 'webview.linkPullRequest', pullNumber });
			} else if (action === 'create-open') {
				vscodeApi.postMessage({ type: 'webview.createIssueFromPullRequest', pullNumber, state: 'open' });
			} else if (action === 'create-closed') {
				vscodeApi.postMessage({ type: 'webview.createIssueFromPullRequest', pullNumber, state: 'closed' });
			}
		} else if (type === 'commit') {
			if (action === 'link') {
				vscodeApi.postMessage({ type: 'webview.linkCommit', sha: id });
			} else if (action === 'create-open') {
				vscodeApi.postMessage({ type: 'webview.createIssueFromCommit', sha: id, state: 'open' });
			} else if (action === 'create-closed') {
				vscodeApi.postMessage({ type: 'webview.createIssueFromCommit', sha: id, state: 'closed' });
			}
		}
	});

	// Handle filter changes for unlinked tab
	backfillPanel.addEventListener('change', event => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}
		const target = /** @type {HTMLSelectElement} */ (event.target);
		if (target.id === 'unlinkedPrLimit') {
			unlinkedPrLimit = Number(target.value) || 50;
			if (latestState) {
				renderBackfillPanel(latestState);
			}
		} else if (target.id === 'unlinkedCommitLimit') {
			unlinkedCommitLimit = Number(target.value) || 50;
			if (latestState) {
				renderBackfillPanel(latestState);
			}
		} else if (target.id === 'unlinkedDateFilter') {
			unlinkedDateFilter = target.value || 'all';
			if (latestState) {
				renderBackfillPanel(latestState);
			}
		}
	});

	/**
	 * @param {any} state
	 */
	function renderState(state) {
		const {
			loading,
			session,
			repositories,
			selectedRepository,
			issues,
			issueMetadata,
			filters,
			lastUpdated,
			automationLaunchEnabled,
			dashboardMetrics,
			unlinkedWork
		} = state;

		connectButton.disabled = loading;
		const connecting = loading && !session;
		const connectLabel = connecting ? 'Connecting…' : (session ? 'Sign Out' : 'Connect to GitHub');
		connectButton.textContent = connectLabel;
		connectButton.setAttribute('aria-label', connectLabel);
		refreshButton.disabled = loading || !selectedRepository;
		openNewIssueButton.disabled = loading || !selectedRepository;
		openNewIssueButton.setAttribute('aria-disabled', openNewIssueButton.disabled ? 'true' : 'false');
		const overlayVisible = isNewIssueOverlayVisible();
		openNewIssueButton.setAttribute('aria-expanded', overlayVisible ? 'true' : 'false');
		if (!selectedRepository && overlayVisible) {
			closeNewIssueOverlay();
		}
		if (selectedRepository && selectedRepository.fullName) {
			openNewIssueButton.title = 'Create a new issue in ' + selectedRepository.fullName;
			newIssueSubheading.textContent = 'Draft a summary, run similarity, and create a GitHub issue in ' + selectedRepository.fullName + '.';
		} else {
			openNewIssueButton.title = 'Select a repository to create a new issue.';
			newIssueSubheading.textContent = defaultNewIssueSubheading;
		}
		if (overlayVisible && !currentAnalysisRequestId && !currentCreateRequestId && !latestNewIssueAnalysis && newIssueCreateResult.hidden) {
			updateNewIssueStatus(getDefaultNewIssueStatusMessage(), 'info');
		}
		refreshNewIssueDatalists(state);

		if (session) {
			accountLabel.textContent = 'Signed in as ' + session.login;
		} else {
			accountLabel.textContent = 'Not signed in';
		}

		if (automationLaunchEnabled) {
			automationBadge.textContent = 'Automation Launch Enabled';
			automationBadge.classList.add('enabled');
			automationBadge.classList.remove('disabled');
		} else {
			automationBadge.textContent = 'Automation Launch Disabled';
			automationBadge.classList.add('disabled');
			automationBadge.classList.remove('enabled');
		}

		const nextStateFilter = filters.state || 'open';
		issueStateFilter = nextStateFilter;
		if (currentTab !== 'unlinked' && currentTab !== 'mlTraining' && currentTab !== 'matrix' && currentTab !== 'llmUsage') {
			currentTab = nextStateFilter;
		}
		updateStateTabs();

		searchInput.value = filters.search || '';

		repositorySelect.innerHTML = '';
		const defaultOption = document.createElement('option');
		defaultOption.value = '';
		const loadingRepositories = loading && (!repositories.length || !selectedRepository);
		if (loadingRepositories) {
			defaultOption.textContent = 'Loading repositories…';
			defaultOption.disabled = true;
		} else {
			defaultOption.textContent = repositories.length ? 'Select repository' : 'No repositories available';
		}
		repositorySelect.appendChild(defaultOption);
		repositorySelect.disabled = loadingRepositories;
		repositories.forEach(/** @param {any} repo */ repo => {
			const option = document.createElement('option');
			option.value = repo.fullName;
			option.textContent = repo.fullName;
			if (selectedRepository && repo.fullName === selectedRepository.fullName) {
				option.selected = true;
			}
			repositorySelect.appendChild(option);
		});

		renderFilterOptions(labelFilter, issueMetadata.labels, filters.label, 'All labels');
		renderFilterOptions(assigneeFilter, issueMetadata.assignees, filters.assignee, 'All assignees');
		renderFilterOptions(milestoneFilter, issueMetadata.milestones, filters.milestone, 'All milestones');
		renderReadinessFilter(filters.readiness);
		renderOverviewMetrics(dashboardMetrics);
		renderReadinessMatrix(state);

		const showIssues = currentTab !== 'unlinked' && currentTab !== 'mlTraining' && currentTab !== 'matrix' && currentTab !== 'llmUsage';
		const showMatrix = currentTab === 'matrix';
		const showUnlinked = currentTab === 'unlinked';
		if (loadingState) {
			loadingState.hidden = !showIssues || !loading;
		}
		if (showIssues && loading) {
			issueList.setAttribute('aria-busy', 'true');
		} else {
			issueList.removeAttribute('aria-busy');
		}

		const showLlmUsage = currentTab === 'llmUsage';
		overviewMetrics.hidden = currentTab !== 'open' && currentTab !== 'closed';
		issueList.hidden = !showIssues;
		issuesPanel.hidden = !showIssues && !showUnlinked;
		matrixPanel.hidden = !showMatrix;
		matrixPanel.classList.toggle('visible', showMatrix);
		matrixPanel.setAttribute('aria-hidden', showMatrix ? 'false' : 'true');
		llmUsagePanel.hidden = !showLlmUsage;
		llmUsagePanel.classList.toggle('visible', showLlmUsage);
		llmUsagePanel.setAttribute('aria-hidden', showLlmUsage ? 'false' : 'true');
		detailPanel.hidden = !(showIssues || showMatrix);
		mainContainer.hidden = currentTab === 'mlTraining';
		if (!showMatrix) {
			readinessMatrixTooltip.hidden = true;
			clearMatrixHover();
		}

		if (showIssues) {
			if (!loading && issues.length === 0) {
				emptyState.hidden = false;
				issueList.innerHTML = '';
				issueList.removeAttribute('aria-activedescendant');
			} else {
				emptyState.hidden = true;
				issueList.innerHTML = issues.map(/** @param {any} issue */ issue => renderIssue(issue)).join('');
			}
		} else {
			emptyState.hidden = true;
			issueList.innerHTML = '';
			issueList.removeAttribute('aria-activedescendant');
		}

		if (showIssues) {
			if (loading) {
				issueSummary.textContent = 'Loading issues...';
			} else if (selectedRepository) {
				const issueStateLabel = nextStateFilter === 'closed' ? 'closed issues' : 'open issues';
				const summaryParts = [issues.length + ' ' + issueStateLabel];
				if (dashboardMetrics && dashboardMetrics.totalIssuesAssessed) {
					const assessmentsText = dashboardMetrics.totalIssuesAssessed + ' assessed';
					const averageText = typeof dashboardMetrics.averageComposite === 'number'
						? 'avg ' + dashboardMetrics.averageComposite.toFixed(1)
						: undefined;
					summaryParts.push(averageText ? assessmentsText + ' (' + averageText + ')' : assessmentsText);
				}
				const readinessMeta = getReadinessByKey(filters.readiness);
				if (readinessMeta && readinessMeta.key !== 'all') {
					summaryParts.push(readinessMeta.label);
				}
				if (lastUpdated) {
					summaryParts.push('Updated ' + new Date(lastUpdated).toLocaleString());
				}
				issueSummary.textContent = summaryParts.join(' · ');
			} else {
				issueSummary.textContent = '';
			}
		} else {
			if (currentTab === 'unlinked') {
				const work = unlinkedWork ?? { loading: false, pullRequests: [], commits: [] };
				if (!selectedRepository) {
					issueSummary.textContent = 'Connect to a repository to review unlinked work.';
				} else if (work.loading) {
					issueSummary.textContent = 'Scanning unlinked work…';
				} else if (work.error) {
					issueSummary.textContent = 'Unable to load unlinked work.';
				} else {
					const prCount = Array.isArray(work.pullRequests) ? work.pullRequests.length : 0;
					const commitCount = Array.isArray(work.commits) ? work.commits.length : 0;
					const summaryParts = [
						prCount + (prCount === 1 ? ' unlinked pull request' : ' unlinked pull requests'),
						commitCount + (commitCount === 1 ? ' unlinked commit' : ' unlinked commits')
					];
					if (work.lastUpdated) {
						summaryParts.push('Updated ' + new Date(work.lastUpdated).toLocaleString());
					}
					issueSummary.textContent = summaryParts.join(' · ');
				}
			} else if (currentTab === 'matrix') {
				if (!selectedRepository) {
					issueSummary.textContent = 'Connect to a repository to plot assessed issues.';
				} else if (loading) {
					issueSummary.textContent = 'Preparing readiness matrix…';
				} else if (readinessMatrixData.length) {
					const assessed = readinessMatrixData.length === 1
						? '1 assessed open issue plotted'
						: readinessMatrixData.length + ' assessed open issues plotted';
					issueSummary.textContent = 'Readiness matrix · ' + assessed;
				} else {
					issueSummary.textContent = 'Run IssueTriage assessments on open issues to populate the matrix.';
				}
			} else if (currentTab === 'llmUsage') {
				issueSummary.textContent = 'Monitor AI model usage and token consumption tracked by UsageTap.';
			} else {
				issueSummary.textContent = '';
			}
		}

		refreshRunAnalysisControls();
		renderBackfillPanel(state);
		renderMLTrainingPanel();
		enforceSelection();
		renderRiskDisplay(selectedIssueNumber);
		if (latestAssessment && latestAssessment.issueNumber === selectedIssueNumber) {
			renderAssessmentResult(latestAssessment);
		}
	}

	/**
	 * @param {any} selectElement
	 * @param {any} values
	 * @param {any} selectedValue
	 * @param {any} placeholder
	 */
	function renderFilterOptions(selectElement, values, selectedValue, placeholder) {
		selectElement.innerHTML = '';
		const option = document.createElement('option');
		option.value = '';
		option.textContent = placeholder;
		selectElement.appendChild(option);
		values.forEach(/** @param {any} value */ value => {
			const optionEl = document.createElement('option');
			optionEl.value = value;
			optionEl.textContent = value;
			if (value === selectedValue) {
				optionEl.selected = true;
			}
			selectElement.appendChild(optionEl);
		});
	}

	/**
	 * @param {any} selectedValue
	 */
	function renderReadinessFilter(selectedValue) {
		const normalized = READINESS_OPTIONS.some(option => option.value === selectedValue)
			? selectedValue
			: 'all';
		if (readinessFilter.options.length !== READINESS_OPTIONS.length) {
			readinessFilter.innerHTML = '';
			READINESS_OPTIONS.forEach(option => {
				const optionEl = document.createElement('option');
				optionEl.value = option.value;
				optionEl.textContent = option.label;
				readinessFilter.appendChild(optionEl);
			});
		}
		readinessFilter.value = normalized;
	}

	/**
	 * @param {any} metrics
	 */
	function renderOverviewMetrics(metrics) {
		if (!overviewMetrics) {
			return;
		}
		const showMetrics = currentTab === 'open' || currentTab === 'closed';
		if (!showMetrics) {
			overviewMetrics.hidden = true;
			overviewMetrics.innerHTML = '';
			return;
		}
		overviewMetrics.hidden = false;
		if (!metrics || metrics.totalIssuesAssessed === 0) {
			overviewMetrics.innerHTML = '<div class="overview-empty">Run an IssueTriage assessment to unlock readiness insights.</div>';
			return;
		}
		const averageText = typeof metrics.averageComposite === 'number'
			? metrics.averageComposite.toFixed(1)
			: '—';
		const readinessItems = READINESS_ORDER.map(key => {
			const info = getReadinessByKey(key);
			const count = metrics.readinessDistribution ? metrics.readinessDistribution[key] ?? 0 : 0;
			return '<li><span class="readiness-dot readiness-' + key + '"></span><span class="readiness-label">' + info.label + '</span><strong>' + count + '</strong></li>';
		}).join('');
		overviewMetrics.innerHTML = '' +
			'<article class="overview-card"><h3>Total assessed</h3><p class="overview-value">' + metrics.totalIssuesAssessed + '</p><p class="overview-subtitle">Issues with at least one IssueTriage run</p></article>' +
			'<article class="overview-card"><h3>Assessments (7 days)</h3><p class="overview-value">' + metrics.assessmentsLastSevenDays + '</p><p class="overview-subtitle">Completed in the past week</p></article>' +
			'<article class="overview-card"><h3>Average composite</h3><p class="overview-value">' + averageText + '</p><p class="overview-subtitle">Across assessed issues</p></article>' +
			'<article class="overview-card overview-readiness"><h3>Readiness distribution</h3><ul class="readiness-distribution">' + readinessItems + '</ul></article>';
	}

	/**
	 * @param {any} state
	 */
	function renderReadinessMatrix(state) {
		updateMatrixLegend();
		if (!state || !state.assessmentSummaries) {
			readinessMatrixData = [];
			readinessMatrixLookup.clear();
			updateMatrixMain([], false);
			return;
		}
		const filtersState = (state.filters?.state ?? 'open');
		let dataset;
		if (filtersState === 'open') {
			dataset = collectMatrixPoints(state);
			readinessMatrixData = dataset.slice();
		} else {
			dataset = readinessMatrixData.slice();
		}
		readinessMatrixLookup.clear();
		for (const point of dataset) {
			readinessMatrixLookup.set(point.issueNumber, point);
		}
		updateMatrixMain(dataset, Boolean(state.loading));
	}

	/**
	 * @param {any} state
	 * @returns {MatrixPoint[]}
	 */
	function collectMatrixPoints(state) {
		const issues = Array.isArray(state.issues) ? state.issues : [];
		const summaries = state.assessmentSummaries ?? {};
		const points = [];
		for (const issue of issues) {
			if (!issue || issue.state !== 'open') {
				continue;
			}
			const summary = summaries[issue.number];
			if (!summary || typeof summary.businessScore !== 'number') {
				continue;
			}
			const readinessScore = clampScore(summary.compositeScore);
			const businessScore = clampScore(summary.businessScore);
			const readinessInfo = getReadinessByKey(summary.readiness);
			points.push({
				issueNumber: issue.number,
				title: typeof issue.title === 'string' ? issue.title : 'Issue #' + issue.number,
				readinessScore,
				businessScore,
				readinessKey: summary.readiness,
				readinessLabel: readinessInfo.label,
				url: typeof issue.url === 'string' ? issue.url : ''
			});
		}
		points.sort((a, b) => {
			if (b.businessScore !== a.businessScore) {
				return b.businessScore - a.businessScore;
			}
			return b.readinessScore - a.readinessScore;
		});
		return points;
	}

	/**
	 * @param {number} value
	 * @returns {number}
	 */
	function clampScore(value) {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) {
			return 0;
		}
		return Math.max(0, Math.min(100, Math.round(numeric * 10) / 10));
	}
	/**
	 * @param {MatrixPoint[]} dataset
	 * @param {boolean} loading
	 */
	function updateMatrixMain(dataset, loading) {
		if (!readinessMatrixMain) {
			return;
		}
	renderMatrixSvg(readinessMatrixMain, dataset);
		matrixPanel.setAttribute('aria-busy', loading ? 'true' : 'false');
		if (readinessMatrixEmpty) {
			readinessMatrixEmpty.hidden = loading || dataset.length > 0;
		}
		if (!dataset.length) {
			hideMatrixTooltip();
		}
	}

	/**
	 * @param {SVGSVGElement} svg
	 * @param {MatrixPoint[]} dataset
	 */
	function renderMatrixSvg(svg, dataset) {
		const radius = 3.6;
		const labelOpacity = 0.52;
		const avoidOpacity = Math.max(0, labelOpacity - 0.1);
		const base = [
			'<line class="matrix-axis" x1="0" y1="100" x2="100" y2="100"></line>',
			'<line class="matrix-axis" x1="0" y1="0" x2="100" y2="0"></line>',
			'<line class="matrix-axis" x1="0" y1="100" x2="0" y2="0"></line>',
			'<line class="matrix-axis" x1="100" y1="100" x2="100" y2="0"></line>',
			'<line class="matrix-axis axis-mid" x1="' + MATRIX_MIDPOINT + '" y1="100" x2="' + MATRIX_MIDPOINT + '" y2="0"></line>',
			'<line class="matrix-axis axis-mid" x1="0" y1="' + MATRIX_MIDPOINT + '" x2="100" y2="' + MATRIX_MIDPOINT + '"></line>',
			'<text class="matrix-label do" x="92" y="20" text-anchor="end" opacity="' + labelOpacity.toFixed(2) + '">Do</text>',
			'<text class="matrix-label avoid" x="12" y="92" opacity="' + avoidOpacity.toFixed(2) + '">Avoid</text>',
			'<text class="matrix-axis-label" x="50" y="104" text-anchor="middle" font-size="6" fill="currentColor" opacity="0.75">Readiness →</text>',
			'<text class="matrix-axis-label" x="-6" y="50" text-anchor="middle" font-size="6" fill="currentColor" opacity="0.75" transform="rotate(-90 -6 50)">Business Value ←</text>'
		];
		const pointsMarkup = dataset.map(point => {
			const cx = clampScore(point.readinessScore);
			const cy = 100 - clampScore(point.businessScore);
			const title = escapeHtml(point.title);
			const readiness = point.readinessScore.toFixed(1);
			const business = point.businessScore.toFixed(1);
			const readinessLabel = escapeHtml(point.readinessLabel);
			const urlAttr = point.url ? ' data-url="' + escapeHtml(point.url) + '"' : '';
			return '<circle class="matrix-point readiness-' + point.readinessKey + '" data-issue="' + point.issueNumber + '" data-readiness="' + readiness + '" data-business="' + business + '" data-title="' + title + '" data-readiness-label="' + readinessLabel + '"' + urlAttr + ' cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + radius + '" tabindex="0" role="button" aria-label="#' + point.issueNumber + ' · ' + title + '"></circle>';
		}).join('');
		svg.innerHTML = '<g class="matrix-grid">' + base.join('') + '</g><g class="matrix-points">' + pointsMarkup + '</g>';
	}

	function updateMatrixLegend() {
		if (!readinessMatrixLegend) {
			return;
		}
		const markup = READINESS_ORDER.map(key => {
			const info = getReadinessByKey(key);
			return '<span class="matrix-legend-item"><span class="matrix-legend-swatch readiness-' + key + '"></span>' + escapeHtml(info.label) + '</span>';
		}).join('');
		readinessMatrixLegend.innerHTML = markup;
	}

	/**
	 * @param {PointerEvent} event
	 */
	function handleMatrixPointerMove(event) {
		if (!(event.target instanceof SVGElement)) {
			return;
		}
		const circle = event.target.closest('.matrix-point');
		if (!(circle instanceof SVGCircleElement)) {
			clearMatrixHover();
			hideMatrixTooltip();
			return;
		}
		if (readinessMatrixHoverCircle !== circle) {
			clearMatrixHover();
			readinessMatrixHoverCircle = circle;
			circle.setAttribute('data-hovered', 'true');
		}
		const issueNumber = Number(circle.getAttribute('data-issue'));
		const point = readinessMatrixLookup.get(issueNumber);
		if (!point) {
			return;
		}
		showMatrixTooltip(point, circle, { clientX: event.clientX, clientY: event.clientY });
	}

	function handleMatrixPointerLeave() {
		clearMatrixHover();
		hideMatrixTooltip();
	}

	/**
	 * @param {MouseEvent} event
	 */
	function handleMatrixClick(event) {
		if (!(event.target instanceof SVGElement)) {
			return;
		}
		const circle = event.target.closest('.matrix-point');
		if (circle instanceof SVGCircleElement) {
			event.preventDefault();
			openMatrixPoint(circle);
		}
	}

	/**
	 * @param {KeyboardEvent} event
	 */
	function handleMatrixKeydown(event) {
		if (!(event.target instanceof SVGCircleElement)) {
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			openMatrixPoint(event.target);
		}
	}

	readinessMatrixMain.addEventListener('focusin', event => {
		if (!(event.target instanceof SVGCircleElement)) {
			return;
		}
		clearMatrixHover();
		readinessMatrixHoverCircle = event.target;
		readinessMatrixHoverCircle.setAttribute('data-hovered', 'true');
		const issueNumber = Number(event.target.getAttribute('data-issue'));
		const point = readinessMatrixLookup.get(issueNumber);
		if (point) {
			showMatrixTooltip(point, event.target, undefined);
		}
	});

	readinessMatrixMain.addEventListener('focusout', event => {
		if (!readinessMatrixMain.contains(/** @type {Node | null} */ (event.relatedTarget))) {
			clearMatrixHover();
			hideMatrixTooltip();
		}
	});

	/**
	 * @param {SVGCircleElement} circle
	 */
	function openMatrixPoint(circle) {
		const issueNumber = Number(circle.getAttribute('data-issue'));
		if (!Number.isFinite(issueNumber)) {
			return;
		}
		selectIssue(issueNumber, true);
	}

	/**
	 * @param {MatrixPoint} point
	 * @param {SVGCircleElement} circle
	 * @param {{ clientX?: number; clientY?: number } | undefined} position
	 */
	function showMatrixTooltip(point, circle, position) {
		if (!readinessMatrixTooltip || !readinessMatrixMain) {
			return;
		}
		const title = '#'+ point.issueNumber + ' · ' + escapeHtml(point.title);
		const readiness = point.readinessScore.toFixed(1);
		const business = point.businessScore.toFixed(1);
		const readinessLabel = escapeHtml(point.readinessLabel);
		readinessMatrixTooltip.innerHTML = '<strong>' + title + '</strong><div>' + readinessLabel + '</div><div>Readiness ' + readiness + ' · Business ' + business + '</div><div class="matrix-footnote">Click to view details</div>';
		readinessMatrixTooltip.hidden = false;
		readinessMatrixTooltip.style.left = '0px';
		readinessMatrixTooltip.style.top = '0px';
		const rect = readinessMatrixMain.getBoundingClientRect();
		let clientX = position && typeof position.clientX === 'number' ? position.clientX : undefined;
		let clientY = position && typeof position.clientY === 'number' ? position.clientY : undefined;
		if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
			const matrix = circle.getScreenCTM();
			if (matrix) {
				const svgPoint = readinessMatrixMain.createSVGPoint();
				svgPoint.x = circle.cx.baseVal.value;
				svgPoint.y = circle.cy.baseVal.value;
				const transformed = svgPoint.matrixTransform(matrix);
				clientX = transformed.x;
				clientY = transformed.y;
			}
		}
		const tooltipRect = readinessMatrixTooltip.getBoundingClientRect();
		const localX = Number.isFinite(clientX) ? /** @type {number} */ (clientX) - rect.left : rect.width / 2;
		const localY = Number.isFinite(clientY) ? /** @type {number} */ (clientY) - rect.top : rect.height / 2;
		let left = localX + 16;
		let top = localY + 16;
		if (left + tooltipRect.width > rect.width) {
			left = rect.width - tooltipRect.width - 12;
		}
		if (top + tooltipRect.height > rect.height) {
			top = rect.height - tooltipRect.height - 12;
		}
		left = Math.max(12, left);
		top = Math.max(12, top);
		readinessMatrixTooltip.style.left = left + 'px';
		readinessMatrixTooltip.style.top = top + 'px';
	}

	function hideMatrixTooltip() {
		if (readinessMatrixTooltip) {
			readinessMatrixTooltip.hidden = true;
		}
	}

	function clearMatrixHover() {
		if (readinessMatrixHoverCircle) {
			readinessMatrixHoverCircle.removeAttribute('data-hovered');
			readinessMatrixHoverCircle = null;
		}
	}

	readinessMatrixMain.addEventListener('pointermove', handleMatrixPointerMove);
	readinessMatrixMain.addEventListener('pointerleave', handleMatrixPointerLeave);
	readinessMatrixMain.addEventListener('click', handleMatrixClick);
	readinessMatrixMain.addEventListener('keydown', handleMatrixKeydown);

	/**
	 * @param {any} issueNumber
	 */
	function getAssessmentSummary(issueNumber) {
		if (!latestState || !latestState.assessmentSummaries) {
			return undefined;
		}
		return latestState.assessmentSummaries[issueNumber];
	}

	/**
	 * @param {any} issueNumber
	 */
	function getRiskSummary(issueNumber) {
		if (!latestState || !latestState.riskSummaries) {
			return undefined;
		}
		return latestState.riskSummaries[issueNumber];
	}

	/**
	 * @param {any} value
	 */
	function escapeHtml(value) {
		if (typeof value !== 'string' || value.length === 0) {
			return '';
		}
		return value.replace(/[&<>"']/g, character => {
			switch (character) {
				case '&':
					return '&amp;';
				case '<':
					return '&lt;';
				case '>':
					return '&gt;';
				case '"':
					return '&quot;';
				case '\'':
					return '&#39;';
				default:
					return character;
			}
		});
	}

	/**
	 * @param {any} summary
	 */
	function renderRiskBadge(summary) {
		if (!summary) {
			return '';
		}
		if (summary.status === 'skipped') {
			return '';
		}
		if (summary.status === 'pending') {
			return '';
		}
		if (summary.status === 'error') {
			return '<span class="badge risk-badge risk-error">Risk Error</span>';
		}
		const level = summary.riskLevel ?? 'low';
		let label = level.charAt(0).toUpperCase() + level.slice(1) + ' Risk';
		const classes = ['badge', 'risk-badge', 'risk-' + level];
		if (summary.stale) {
			classes.push('risk-stale');
			label += ' (refreshing)';
		}
		return '<span class="' + classes.join(' ') + '">' + label + '</span>';
	}

	/**
	 * @param {any} summary
	 */
	function renderRiskSection(summary) {
		const header = '<section class="risk-section"><h3>Risk Intelligence</h3>';
		if (!summary) {
			return header + '<p>No risk signals captured yet.</p></section>';
		}
		if (summary.status === 'pending') {
			return header + '<p>Collecting historical risk signals…</p></section>';
		}
		if (summary.status === 'error') {
			const message = summary.message ? escapeHtml(summary.message) : 'An unexpected error occurred.';
			return header + '<p>Unable to load risk insights: ' + message + '</p></section>';
		}
		if (summary.status === 'skipped') {
			const message = summary.message ? escapeHtml(summary.message) : 'Risk analysis skipped by configuration.';
			return header + '<p>' + message + '</p></section>';
		}
		const level = summary.riskLevel ?? 'low';
		const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
		const scoreText = typeof summary.riskScore === 'number' ? summary.riskScore.toFixed(0) : 'n/a';
		const metricsItems = [];
		if (summary.metrics) {
			const prCount = typeof summary.metrics.prCount === 'number' ? summary.metrics.prCount : 0;
			const commitCount = typeof summary.metrics.directCommitCount === 'number' ? summary.metrics.directCommitCount : 0;
			if (prCount > 0) {
				metricsItems.push(prCount + ' linked pull requests');
			}
			if (commitCount > 0) {
				metricsItems.push(commitCount + ' linked commits');
			}
			metricsItems.push(String(summary.metrics.filesTouched ?? 0) + ' files touched');
			metricsItems.push(String(summary.metrics.changeVolume ?? 0) + ' lines changed');
			const reviewSignals = typeof summary.metrics.reviewCommentCount === 'number' ? summary.metrics.reviewCommentCount : 0;
			const reviewBreakdown = [];
			const prReviewComments = typeof summary.metrics.prReviewCommentCount === 'number' ? summary.metrics.prReviewCommentCount : 0;
			const prDiscussionComments = typeof summary.metrics.prDiscussionCommentCount === 'number' ? summary.metrics.prDiscussionCommentCount : 0;
			const prChangeRequests = typeof summary.metrics.prChangeRequestCount === 'number' ? summary.metrics.prChangeRequestCount : 0;
			if (prReviewComments > 0) {
				reviewBreakdown.push(prReviewComments + ' review comment' + (prReviewComments === 1 ? '' : 's'));
			}
			if (prDiscussionComments > 0) {
				reviewBreakdown.push(prDiscussionComments + ' discussion comment' + (prDiscussionComments === 1 ? '' : 's'));
			}
			if (prChangeRequests > 0) {
				reviewBreakdown.push(prChangeRequests + ' change request' + (prChangeRequests === 1 ? '' : 's'));
			}
			let reviewLabel = reviewSignals + ' review friction signals';
			if (reviewBreakdown.length) {
				reviewLabel += ' (' + reviewBreakdown.join(', ') + ')';
			}
			metricsItems.push(reviewLabel);
		}
		const metricsHtml = metricsItems.length
			? '<ul class="risk-metrics">' + metricsItems.map(/** @param {any} item */ item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
			: '<p class="risk-meta">No metrics available yet.</p>';
		const driversHtml = summary.topDrivers && summary.topDrivers.length
			? summary.topDrivers.map(/** @param {any} item */ item => '<li>' + escapeHtml(item) + '</li>').join('')
			: '<li>No dominant risk drivers detected.</li>';
		const staleNotice = summary.stale ? '<p class="risk-meta">Signals refreshing…</p>' : '';
		const timestamp = summary.calculatedAt ? '<p class="risk-meta">Last updated ' + new Date(summary.calculatedAt).toLocaleString() + '</p>' : '';
		return header +
			'<p class="risk-level risk-' + level + '">' + levelLabel + ' risk · Score ' + scoreText + '</p>' +
			staleNotice +
			timestamp +
			'<div class="risk-columns">' +
				'<div><h4>Key metrics</h4>' + metricsHtml + '</div>' +
				'<div><h4>Top drivers</h4><ul class="risk-drivers">' + driversHtml + '</ul></div>' +
			'</div>' +
		'</section>';
	}

	/**
	 * @param {any} issueNumber
	 */
	function renderRiskDisplay(issueNumber) {
		const container = assessmentPanel.querySelector('#riskSection');
		if (!container) {
			return;
		}
		const summary = typeof issueNumber === 'number' ? getRiskSummary(issueNumber) : undefined;
		container.innerHTML = renderRiskSection(summary);
	}

	/**
	 * @param {number} issueNumber
	 */
	function getQuestionResponsesForIssue(issueNumber) {
		const repositoryResponses = latestState && typeof latestState === 'object'
			? latestState.questionResponses
			: undefined;
		if (!repositoryResponses || typeof repositoryResponses !== 'object') {
			return {};
		}
		const issueKey = String(issueNumber);
		const responses = repositoryResponses[issueKey];
		return responses && typeof responses === 'object' ? responses : {};
	}

	/**
	 * @param {number} issueNumber
	 * @param {any[]} questions
	 */
	function renderAssessmentQuestionList(issueNumber, questions) {
		if (!Array.isArray(questions) || questions.length === 0) {
			return '<p class="question-empty">No open questions identified.</p>';
		}
		const responses = getQuestionResponsesForIssue(issueNumber);
		const items = questions.map((question, index) => renderAssessmentQuestion(issueNumber, question, index, responses)).join('');
		return '<ul class="question-list">' + items + '</ul>';
	}

	/**
	 * @param {number} issueNumber
	 * @param {any} rawQuestion
	 * @param {number} index
	 * @param {Record<string, any>} responses
	 */
	function renderAssessmentQuestion(issueNumber, rawQuestion, index, responses) {
		const fallback = typeof rawQuestion === 'string' ? rawQuestion : String(rawQuestion ?? '');
		const trimmed = fallback.trim();
		const canonicalQuestion = trimmed || fallback;
		const displayText = canonicalQuestion || `Question ${index + 1}`;
		const normalized = normalizeQuestionKey(canonicalQuestion);
		const encodedKey = encodeValue(normalized);
		const encodedOriginal = encodeValue(canonicalQuestion);
		const labelId = `question-${issueNumber}-${index}`;
		const answerId = `${labelId}-answer`;
		const response = responses[normalized];
		if (response) {
			const answeredAtText = typeof response.answeredAt === 'string' && response.answeredAt
				? new Date(response.answeredAt).toLocaleString()
				: undefined;
			const metaSegments = [];
			if (answeredAtText) {
				metaSegments.push('<span>Answered ' + escapeHtml(answeredAtText) + '</span>');
			}
			if (typeof response.commentUrl === 'string' && response.commentUrl.length) {
				metaSegments.push('<button type="button" class="button-link" data-action="openComment" data-url="' + escapeHtml(response.commentUrl) + '">View comment</button>');
			}
			const metaHtml = metaSegments.length ? '<div class="question-meta">' + metaSegments.join(' ') + '</div>' : '';
			return '<li class="assessment-question answered" data-question-key="' + encodedKey + '" data-question-original="' + encodedOriginal + '">' +
				'<p class="question-text" id="' + labelId + '">' + escapeHtml(displayText) + '</p>' +
				metaHtml +
				'<div class="question-answer-display">' + formatAnswerForDisplay(response.answer) + '</div>' +
			'</li>';
		}
		return '<li class="assessment-question pending" data-question-key="' + encodedKey + '" data-question-original="' + encodedOriginal + '">' +
			'<p class="question-text" id="' + labelId + '">' + escapeHtml(displayText) + '</p>' +
			'<div class="question-form">' +
				'<textarea id="' + answerId + '" aria-labelledby="' + labelId + '" rows="3" placeholder="Capture the answer so automation can proceed."></textarea>' +
				'<div class="question-actions">' +
					'<button type="button" class="primary question-submit" data-action="submitAnswer">Submit answer</button>' +
					'<span class="question-error-message" role="status" aria-live="polite"></span>' +
				'</div>' +
			'</div>' +
		'</li>';
	}

	/**
	 * @param {number} issueNumber
	 * @param {any[]} questions
	 */
	function areAllQuestionsAnswered(issueNumber, questions) {
		if (!Array.isArray(questions) || !questions.length) {
			return false;
		}
		const responses = getQuestionResponsesForIssue(issueNumber);
		if (!responses || typeof responses !== 'object') {
			return false;
		}
		return questions.every(question => {
			const fallback = typeof question === 'string' ? question : String(question ?? '');
			const canonicalQuestion = fallback.trim() || fallback;
			if (!canonicalQuestion) {
				return false;
			}
			const normalized = normalizeQuestionKey(canonicalQuestion);
			return Boolean(responses[normalized]);
		});
	}

	/**
	 * @param {any} answer
	 */
	function formatAnswerForDisplay(answer) {
		const fallback = typeof answer === 'string' ? answer : String(answer ?? '');
		return escapeHtml(fallback).replace(/\n/g, '<br>');
	}

	/**
	 * @param {any} state
	 */
	function renderBackfillPanel(state) {
		if (!backfillBody) {
			return;
		}
		const showPanel = currentTab === 'unlinked';
		backfillPanel.hidden = !showPanel;
		backfillPanel.style.display = showPanel ? '' : 'none';
		if (!showPanel) {
			backfillPanel.setAttribute('aria-busy', 'false');
			refreshBackfillButton.disabled = false;
			return;
		}
		const repository = state?.selectedRepository?.fullName;
		const work = state?.unlinkedWork ?? { loading: false, pullRequests: [], commits: [] };
		if (!repository) {
			backfillBody.innerHTML = '<div class="backfill-empty">Connect to a repository to review unlinked pull requests and commits.</div>';
			refreshBackfillButton.disabled = true;
			backfillPanel.setAttribute('aria-busy', 'false');
			return;
		}
		refreshBackfillButton.disabled = Boolean(work.loading);
		if (work.loading) {
			backfillPanel.setAttribute('aria-busy', 'true');
			backfillBody.innerHTML = '<div class="backfill-loading">Scanning pull requests and commits…</div>';
			return;
		}
		backfillPanel.setAttribute('aria-busy', 'false');
		if (work.error) {
			backfillBody.innerHTML = '<div class="backfill-error">' + escapeHtml(work.error) + '</div>';
			return;
		}
		const updatedText = work.lastUpdated
			? '<p class="backfill-item-meta">' + escapeHtml('Updated ' + new Date(work.lastUpdated).toLocaleString()) + '</p>'
			: '';
		if ((!work.pullRequests || work.pullRequests.length === 0) && (!work.commits || work.commits.length === 0)) {
			backfillBody.innerHTML = updatedText + '<div class="backfill-empty">Everything is linked. No pull requests or commits need backfill.</div>';
			return;
		}
		
		// Apply filters
		const filteredPullRequests = filterUnlinkedItems(work.pullRequests ?? [], unlinkedPrLimit, unlinkedDateFilter);
		const filteredCommits = filterUnlinkedItems(work.commits ?? [], unlinkedCommitLimit, unlinkedDateFilter);
		
		// Render filter controls
		const filterHtml = renderUnlinkedFilters(
			work.pullRequests?.length ?? 0,
			work.commits?.length ?? 0,
			filteredPullRequests.length,
			filteredCommits.length
		);
		
		const pullSection = renderBackfillSection('Pull requests', filteredPullRequests.length, renderBackfillPullRequests(filteredPullRequests), 'pull');
		const commitSection = renderBackfillSection('Commits', filteredCommits.length, renderBackfillCommits(filteredCommits), 'commit');
		backfillBody.innerHTML = updatedText + filterHtml + '<div class="backfill-columns">' + pullSection + commitSection + '</div>';
	}
	
	/**
	 * @param {number} totalPrs
	 * @param {number} totalCommits
	 * @param {number} filteredPrs
	 * @param {number} filteredCommits
	 * @returns {string}
	 */
	function renderUnlinkedFilters(totalPrs, totalCommits, filteredPrs, filteredCommits) {
		const limitOptions = [5, 10, 20, 30, 40, 50];
		const prLimitSelect = '<select id="unlinkedPrLimit" aria-label="Pull request limit">' +
			limitOptions.map(limit => '<option value="' + limit + '"' + (limit === unlinkedPrLimit ? ' selected' : '') + '>Last ' + limit + '</option>').join('') +
		'</select>';
		const commitLimitSelect = '<select id="unlinkedCommitLimit" aria-label="Commit limit">' +
			limitOptions.map(limit => '<option value="' + limit + '"' + (limit === unlinkedCommitLimit ? ' selected' : '') + '>Last ' + limit + '</option>').join('') +
		'</select>';
		const dateFilterSelect = '<select id="unlinkedDateFilter" aria-label="Date filter">' +
			'<option value="all"' + (unlinkedDateFilter === 'all' ? ' selected' : '') + '>All time</option>' +
			'<option value="30"' + (unlinkedDateFilter === '30' ? ' selected' : '') + '>Last 30 days</option>' +
			'<option value="60"' + (unlinkedDateFilter === '60' ? ' selected' : '') + '>Last 60 days</option>' +
			'<option value="90"' + (unlinkedDateFilter === '90' ? ' selected' : '') + '>Last 90 days</option>' +
		'</select>';
		
		const prCountText = filteredPrs !== totalPrs ? filteredPrs + ' of ' + totalPrs : filteredPrs + '';
		const commitCountText = filteredCommits !== totalCommits ? filteredCommits + ' of ' + totalCommits : filteredCommits + '';
		
		return '<div class="unlinked-filters">' +
			'<div class="filter-group">' +
				'<label>Pull Requests: ' + prLimitSelect + ' (' + prCountText + ')</label>' +
			'</div>' +
			'<div class="filter-group">' +
				'<label>Commits: ' + commitLimitSelect + ' (' + commitCountText + ')</label>' +
			'</div>' +
			'<div class="filter-group">' +
				'<label>Date: ' + dateFilterSelect + '</label>' +
			'</div>' +
		'</div>';
	}
	
	/**
	 * @param {Array<any>} items
	 * @param {number} limit
	 * @param {string} dateFilter
	 * @returns {Array<any>}
	 */
	function filterUnlinkedItems(items, limit, dateFilter) {
		if (!Array.isArray(items) || items.length === 0) {
			return [];
		}
		
		let filtered = items.slice();
		
		// Apply date filter if not 'all'
		if (dateFilter !== 'all') {
			const days = Number(dateFilter);
			if (Number.isFinite(days) && days > 0) {
				const cutoffDate = new Date();
				cutoffDate.setDate(cutoffDate.getDate() - days);
				filtered = filtered.filter(item => {
					const dateField = item.updatedAt || item.committedDate;
					if (!dateField) {
						return true; // Include items without dates
					}
					const itemDate = new Date(dateField);
					return itemDate >= cutoffDate;
				});
			}
		}
		
		// Apply limit
		return filtered.slice(0, limit);
	}

	/**
	 * @param {string} title
	 * @param {number} count
	 * @param {string} contentHtml
	 * @param {string} type
	 */
	function renderBackfillSection(title, count, contentHtml, type) {
		const countLabel = count === 1 ? '1 unlinked item' : count + ' unlinked items';
		const bulkButton = count > 0
			? '<button type="button" class="compact-button" data-bulk-create="' + type + '">Create issues for each unlinked ' + (type === 'pull' ? 'pull request' : 'commit') + '</button>'
			: '';
		return '<section class="backfill-section"><header><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(countLabel) + '</p>' + bulkButton + '</header>' + contentHtml + '</section>';
	}

	/**
	 * @param {Array<any>} pullRequests
	 */
	function renderBackfillPullRequests(pullRequests) {
		if (!pullRequests.length) {
			return '<div class="backfill-empty">All pull requests are linked to issues.</div>';
		}
		const items = pullRequests.map(pr => {
			const stateLabel = pr.state === 'merged' ? 'Merged' : (pr.state === 'closed' ? 'Closed' : 'Open');
			const badge = '<span class="backfill-badge">' + escapeHtml(stateLabel) + '</span>';
			const metaParts = [];
			if (pr.updatedAt) {
				metaParts.push('Updated ' + new Date(pr.updatedAt).toLocaleString());
			}
			if (pr.author) {
				metaParts.push('@' + pr.author);
			}
			const meta = metaParts.length ? metaParts.map(text => escapeHtml(text)).join(' · ') : '&nbsp;';
			const statsParts = [
				pr.commits + ' commits',
				pr.changedFiles + ' files',
				'+' + pr.additions + ' / -' + pr.deletions
			];
			const stats = statsParts.map(part => escapeHtml(String(part))).join(' · ');
			const branch = pr.headRefName && pr.baseRefName
				? '<div class="backfill-stats">' + escapeHtml(pr.headRefName) + ' → ' + escapeHtml(pr.baseRefName) + '</div>'
				: '';
			const urlAttribute = pr.url ? escapeHtml(pr.url) : '';
			return '<li class="backfill-item" data-backfill-type="pull" data-backfill-id="' + pr.number + '">' +
				'<div class="backfill-item-header">' +
					'<span class="backfill-item-title">' + badge + ' #' + pr.number + ' · ' + escapeHtml(pr.title) + '</span>' +
					'<span class="backfill-item-meta">' + meta + '</span>' +
				'</div>' +
				branch +
				'<div class="backfill-stats">' + stats + '</div>' +
				'<div class="backfill-buttons">' +
					'<button type="button" data-backfill-action="link" data-backfill-type="pull" data-backfill-id="' + pr.number + '">Link to issue</button>' +
					'<button type="button" data-backfill-action="create-open" data-backfill-type="pull" data-backfill-id="' + pr.number + '">Create issue (open)</button>' +
					'<button type="button" data-backfill-action="create-closed" data-backfill-type="pull" data-backfill-id="' + pr.number + '">Create issue (close)</button>' +
					(pr.url ? '<button type="button" data-backfill-action="open" data-backfill-type="pull" data-backfill-id="' + pr.number + '" data-backfill-url="' + urlAttribute + '">Open PR</button>' : '') +
				'</div>' +
			'</li>';
		}).join('');
		return '<ul class="backfill-list">' + items + '</ul>';
	}

	/**
	 * @param {Array<any>} commits
	 */
	function renderBackfillCommits(commits) {
		if (!commits.length) {
			return '<div class="backfill-empty">All commits are associated with pull requests.</div>';
		}
		const items = commits.map(commit => {
			const shortSha = commit.sha ? String(commit.sha).slice(0, 7) : '';
			const metaParts = [];
			if (commit.committedDate) {
				metaParts.push(new Date(commit.committedDate).toLocaleString());
			}
			if (commit.author) {
				metaParts.push('@' + commit.author);
			}
			const meta = metaParts.length ? metaParts.map(text => escapeHtml(text)).join(' · ') : '&nbsp;';
			const statsParts = [
				commit.changedFiles + ' files',
				'+' + commit.additions + ' / -' + commit.deletions
			];
			const stats = statsParts.map(part => escapeHtml(String(part))).join(' · ');
			const shaAttribute = escapeHtml(String(commit.sha));
			const urlButton = commit.url
				? '<button type="button" data-backfill-action="open" data-backfill-type="commit" data-backfill-id="' + shaAttribute + '" data-backfill-url="' + escapeHtml(String(commit.url)) + '">Open commit</button>'
				: '';
			const message = commit.message ? truncateText(commit.message, 90) : shaAttribute;
			return '<li class="backfill-item" data-backfill-type="commit" data-backfill-id="' + shaAttribute + '">' +
				'<div class="backfill-item-header">' +
					'<span class="backfill-item-title">' + escapeHtml(shortSha) + ' · ' + escapeHtml(message) + '</span>' +
					'<span class="backfill-item-meta">' + meta + '</span>' +
				'</div>' +
				'<div class="backfill-stats">' + stats + '</div>' +
				'<div class="backfill-buttons">' +
					'<button type="button" data-backfill-action="link" data-backfill-type="commit" data-backfill-id="' + shaAttribute + '">Link to issue</button>' +
					'<button type="button" data-backfill-action="create-open" data-backfill-type="commit" data-backfill-id="' + shaAttribute + '">Create issue (open)</button>' +
					'<button type="button" data-backfill-action="create-closed" data-backfill-type="commit" data-backfill-id="' + shaAttribute + '">Create issue (close)</button>' +
					urlButton +
				'</div>' +
			'</li>';
		}).join('');
		return '<ul class="backfill-list">' + items + '</ul>';
	}

	/**
	 * Render ML Training panel visibility
	 */
	function renderMLTrainingPanel() {
		const showPanel = currentTab === 'mlTraining';
		mlTrainingPanel.hidden = !showPanel;
		mlTrainingPanel.style.display = showPanel ? 'block' : 'none';
		mainContainer.style.display = showPanel ? 'none' : 'grid';
		if (showPanel) {
			loadKeywordStats();
			loadLastExport();
		}
	}

	/**
	 * Load keyword coverage statistics
	 */
	function loadKeywordStats() {
		vscodeApi.postMessage({ type: 'webview.getKeywordStats' });
	}

	function loadLastExport() {
		vscodeApi.postMessage({ type: 'webview.getLastExport' });
	}

	/**
	 * @param {string} value
	 * @param {number} maxLength
	 */
	function truncateText(value, maxLength) {
		if (typeof value !== 'string') {
			return '';
		}
		if (value.length <= maxLength) {
			return value;
		}
		return value.slice(0, maxLength - 1) + '…';
	}

	/**
	 * @param {any} issue
	 */
	function renderIssue(issue) {
		const labelBadges = issue.labels.map(/** @param {any} label */ label => '<span class="badge">' + escapeHtml(label) + '</span>').join(' ');
		const assigneeText = issue.assignees.length ? '· Assigned to ' + issue.assignees.map(/** @param {any} name */ name => escapeHtml(name)).join(', ') : '';
		const milestoneText = issue.milestone ? '· Milestone ' + escapeHtml(issue.milestone) : '';
		const updatedText = new Date(issue.updatedAt).toLocaleString();
		const riskSummary = getRiskSummary(issue.number);
		const riskBadge = renderRiskBadge(riskSummary);
		const stateClass = issue.state === 'closed' ? 'issue-state-closed' : '';
		const stateBadge = issue.state === 'closed' ? '<span class="badge state-badge">Closed</span>' : '';
		const assessmentSummary = getAssessmentSummary(issue.number);
		const readinessMeta = assessmentSummary ? getReadinessByKey(assessmentSummary.readiness) : undefined;
		const readinessBadge = readinessMeta ? '<span class="readiness-pill ' + readinessMeta.className + '" title="' + readinessMeta.description + '">' + readinessMeta.label + '</span>' : '';
		const compositeBadge = assessmentSummary ? '<span class="badge composite-badge">Composite ' + assessmentSummary.compositeScore.toFixed(1) + '</span>' : '';
		const badgeParts = [readinessBadge, compositeBadge, riskBadge, stateBadge].filter(Boolean);
		const badgeHtml = badgeParts.join('');
		const assessedText = assessmentSummary ? '· Assessed ' + new Date(assessmentSummary.updatedAt).toLocaleString() : '';
		const cardId = 'issue-card-' + issue.number;
		const titleId = 'issue-title-' + issue.number;
		const summaryId = 'issue-summary-' + issue.number;
		const header = '<div class="issue-card-header"><div class="issue-card-title"><h3 id="' + titleId + '">#' + issue.number + ' · ' + escapeHtml(issue.title) + '</h3></div><div class="issue-card-actions">' + badgeHtml + '<button type="button" class="issue-action" data-action="runAssessment" data-issue-number="' + issue.number + '">Run Assessment</button></div></div>';
		const labelRow = labelBadges ? '<div class="meta-row">' + labelBadges + '</div>' : '';
		return '<article class="issue-card ' + stateClass + '" id="' + cardId + '" data-issue-number="' + issue.number + '" data-url="' + issue.url + '" role="option" aria-selected="false" tabindex="-1" aria-labelledby="' + titleId + '" aria-describedby="' + summaryId + '">' +
			header +
			'<div class="meta-row" id="' + summaryId + '">' +
				'<span>Updated ' + updatedText + '</span>' +
				(assigneeText ? '<span>' + assigneeText + '</span>' : '') +
				(milestoneText ? '<span>' + milestoneText + '</span>' : '') +
				(assessedText ? '<span>' + assessedText + '</span>' : '') +
			'</div>' +
			labelRow +
		'</article>';
	}

	function enforceSelection() {
		if (!latestState || !latestState.selectedRepository) {
			selectedIssueNumber = undefined;
			renderAssessmentEmpty('Connect to a repository to view assessments.');
			issueList.removeAttribute('aria-activedescendant');
			return;
		}
		if (currentTab === 'unlinked') {
			issueList.removeAttribute('aria-activedescendant');
			return;
		}
		if (!latestState.issues.length) {
			selectedIssueNumber = undefined;
			renderAssessmentEmpty('No assessments yet. Run an IssueTriage assessment to populate this panel.');
			issueList.removeAttribute('aria-activedescendant');
			return;
		}
		const existingNumbers = latestState.issues.map(/** @param {any} issue */ issue => issue.number);
		if (!selectedIssueNumber || !existingNumbers.includes(selectedIssueNumber)) {
			selectIssue(existingNumbers[0], false);
		} else {
			const shouldRestoreFocus = issueList.contains(document.activeElement);
			highlightSelectedIssue(shouldRestoreFocus);
		}
	}

	/**
	 * @param {any} issueNumber
	 */
	/**
	 * @param {number} issueNumber
	 * @param {boolean} [focusCard]
	 */
	function selectIssue(issueNumber, focusCard = false) {
		const shouldFocus = Boolean(focusCard);
		if (selectedIssueNumber === issueNumber) {
			highlightSelectedIssue(shouldFocus);
			return;
		}
		selectedIssueNumber = issueNumber;
		latestAssessment = null;
		assessmentHistory = [];
		highlightSelectedIssue(shouldFocus);
		renderAssessmentLoading();
		if (latestState && latestState.selectedRepository) {
			vscodeApi.postMessage({ type: 'webview.selectIssue', issueNumber });
			vscodeApi.postMessage({ type: 'webview.getAssessmentHistory', issueNumber });
		}
	}

	/**
	 * @param {boolean} focusCard
	 */
	function highlightSelectedIssue(focusCard) {
		const cards = /** @type {HTMLElement[]} */ (Array.from(issueList.querySelectorAll('.issue-card')));
		let focusTarget = /** @type {HTMLElement | null} */ (null);
		cards.forEach(card => {
			const number = Number(card.getAttribute('data-issue-number'));
			const isSelected = !Number.isNaN(number) && number === selectedIssueNumber;
			card.classList.toggle('selected', isSelected);
			card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
			card.tabIndex = isSelected ? 0 : -1;
			if (isSelected) {
				focusTarget = card;
			}
		});
		if (focusTarget) {
			const targetId = focusTarget.getAttribute('id');
			if (targetId) {
				issueList.setAttribute('aria-activedescendant', targetId);
			}
			if (focusCard) {
				try {
					focusTarget.focus({ preventScroll: true });
				} catch (error) {
					focusTarget.focus();
				}
			}
		} else {
			issueList.removeAttribute('aria-activedescendant');
		}
	}

	/**
	 * @param {any} issueNumber
	 */
	function getIssueUrl(issueNumber) {
		if (!latestState) {
			return undefined;
		}
		const issue = latestState.issues.find(/** @param {any} item */ item => item.number === issueNumber);
		return issue ? issue.url : undefined;
	}

	/**
	 * @param {any} score
	 */
	function readinessKeyFromScore(score) {
		if (score >= 80) {
			return 'ready';
		}
		if (score >= 60) {
			return 'prepare';
		}
		if (score >= 40) {
			return 'review';
		}
		return 'manual';
	}

	/**
	 * @param {any} key
	 */
	function getReadinessByKey(key) {
		if (!key || key === 'all') {
			return {
				key: 'all',
				label: 'All readiness states',
				className: '',
				description: 'Display issues across every automation readiness tier.'
			};
		}
		const readinessKey = typeof key === 'string' ? /** @type {keyof typeof READINESS_DEFINITIONS | undefined} */ (key) : undefined;
		const definition = readinessKey ? READINESS_DEFINITIONS[readinessKey] : undefined;
		if (definition) {
			return {
				key: readinessKey,
				label: definition.label,
				className: definition.className,
				description: definition.description
			};
		}
		return {
			key: 'manual',
			label: READINESS_DEFINITIONS.manual.label,
			className: READINESS_DEFINITIONS.manual.className,
			description: READINESS_DEFINITIONS.manual.description
		};
	}

	/**
	 * @param {any} score
	 */
	function getReadiness(score, keyOverride) {
		const numericScore = typeof score === 'number' && Number.isFinite(score) ? score : 0;
		const key = typeof keyOverride === 'string' && keyOverride
			? keyOverride
			: readinessKeyFromScore(numericScore);
		const info = getReadinessByKey(key);
		return {
			key,
			label: info.label,
			className: info.className,
			description: info.description
		};
	}

	function renderAssessmentLoading() {
		assessmentPanel.innerHTML = '<div class="assessment-loading">Loading latest assessment…</div><div id="riskSection"></div>';
		renderRiskDisplay(selectedIssueNumber);
	}

	/**
	 * @param {any} message
	 */
	function renderAssessmentEmpty(message) {
		latestAssessment = null;
		assessmentPanel.innerHTML = '<div class="assessment-empty">' + message + '</div><div id="riskSection"></div>';
		renderRiskDisplay(selectedIssueNumber);
	}

	/**
	 * @param {any} message
	 */
	function renderAssessmentError(message) {
		latestAssessment = null;
		assessmentPanel.innerHTML = '<div class="assessment-error">' + message + '</div><div id="riskSection"></div>';
		renderRiskDisplay(selectedIssueNumber);
	}

	/**
	 * @param {any} data
	 */
	function renderAssessmentResult(data) {
		latestAssessment = data;
		const readiness = getReadiness(
			typeof data.readinessScore === 'number' ? data.readinessScore : data.compositeScore,
			typeof data.readiness === 'string' ? data.readiness : undefined
		);
		const updatedAt = new Date(data.createdAt).toLocaleString();
		const issueUrl = getIssueUrl(data.issueNumber);
		const questions = Array.isArray(data.recommendations) ? data.recommendations : [];
		const questionListHtml = renderAssessmentQuestionList(data.issueNumber, questions);
		const allQuestionsAnswered = areAllQuestionsAnswered(data.issueNumber, questions);
		const lines = [
			'<div>',
			'<h2>Assessment · #' + data.issueNumber + '</h2>',
			'<p><span class="readiness-pill ' + readiness.className + '">' + readiness.label + '</span></p>',
			'<p>' + readiness.description + '</p>',
			'<p>Composite ' + data.compositeScore.toFixed(1) + ' · Model ' + data.model + ' · Last run ' + updatedAt + '</p>',
			'</div>',
			'<div class="score-grid">',
			'<div class="score-card"><strong>Composite</strong><span>' + data.compositeScore.toFixed(1) + '</span></div>',
			'<div class="score-card"><strong>Requirements</strong><span>' + data.requirementsScore.toFixed(1) + '</span></div>',
			'<div class="score-card"><strong>Complexity</strong><span>' + data.complexityScore.toFixed(1) + '</span></div>',
			'<div class="score-card"><strong>Security</strong><span>' + data.securityScore.toFixed(1) + '</span></div>',
			'<div class="score-card"><strong>Business</strong><span>' + data.businessScore.toFixed(1) + '</span></div>',
			'</div>',
			'<div>',
			'<h3>Summary</h3>',
			'<p>' + data.summary + '</p>',
			'</div>',
			'<div>',
			'<h3>Pre-implementation questions</h3>',
			questionListHtml
		];
		if (questions.length && allQuestionsAnswered) {
			lines.push('<div class="assessment-hint" role="note">'
				+ 'All questions are answered. Re-run IssueTriage analysis to confirm readiness.'
				+ '<button type="button" class="compact-button" data-action="rerunAssessment">Re-run assessment</button>'
				+ '</div>');
		}
		lines.push('</div>',
			'<div class="assessment-actions">'
	);
			lines.push('<button class="button-link" type="button" data-action="copyForAI">📋 Copy for AI</button>');
			lines.push('<button class="button-link" type="button" data-action="exportMarkdown">Export Markdown</button>');
			lines.push('<button class="button-link" type="button" data-action="exportJson">Export JSON</button>');
		if (issueUrl) {
			lines.push('<button class="button-link" type="button" data-action="openIssue">Open Issue</button>');
		}
		if (data.commentUrl) {
			lines.push('<button class="button-link" type="button" data-action="openComment" data-url="' + data.commentUrl + '">View Latest Comment</button>');
		}
		lines.push('</div>');
		assessmentPanel.innerHTML = lines.join('') + '<div id="riskSection"></div><div id="historySection"></div>';
		renderRiskDisplay(data.issueNumber);
		renderAssessmentHistory();
	}

	function renderAssessmentHistory() {
		const container = assessmentPanel.querySelector('#historySection');
		if (!container) {
			return;
		}
		if (!assessmentHistory || assessmentHistory.length === 0) {
			container.innerHTML = '';
			return;
		}
		const items = assessmentHistory.map((/** @param {any} record */ record, /** @param {any} index */ index) => {
			const isLatest = index === 0;
			const readiness = getReadiness(
				typeof record.readinessScore === 'number' ? record.readinessScore : record.compositeScore,
				typeof record.readiness === 'string' ? record.readiness : undefined
			);
			const timestamp = new Date(record.createdAt).toLocaleString();
			const latestClass = isLatest ? ' latest' : '';
			let trendHtml = '';
			if (index < assessmentHistory.length - 1) {
				const previous = assessmentHistory[index + 1];
				const diff = record.compositeScore - previous.compositeScore;
				if (Math.abs(diff) >= 1) {
					const direction = diff > 0 ? 'up' : 'down';
					const symbol = diff > 0 ? '▲' : '▼';
					trendHtml = '<span class="history-trend ' + direction + '">' + symbol + ' ' + Math.abs(diff).toFixed(1) + '</span>';
				}
			}
			return '<li class="history-item' + latestClass + '" role="listitem">' +
				'<div class="history-header">' +
					'<span class="readiness-pill ' + readiness.className + '">' + readiness.label + '</span>' +
					'<span class="history-timestamp">' + timestamp + '</span>' +
				'</div>' +
				'<div class="history-scores">' +
					'<div class="history-score">' +
						'<div class="history-score-label">Composite</div>' +
						'<div class="history-score-value">' + record.compositeScore.toFixed(1) + trendHtml + '</div>' +
					'</div>' +
					'<div class="history-score">' +
						'<div class="history-score-label">Req.</div>' +
						'<div class="history-score-value">' + record.requirementsScore.toFixed(1) + '</div>' +
					'</div>' +
					'<div class="history-score">' +
						'<div class="history-score-label">Complex.</div>' +
						'<div class="history-score-value">' + record.complexityScore.toFixed(1) + '</div>' +
					'</div>' +
					'<div class="history-score">' +
						'<div class="history-score-label">Security</div>' +
						'<div class="history-score-value">' + record.securityScore.toFixed(1) + '</div>' +
					'</div>' +
					'<div class="history-score">' +
						'<div class="history-score-label">Business</div>' +
						'<div class="history-score-value">' + record.businessScore.toFixed(1) + '</div>' +
					'</div>' +
				'</div>' +
			'</li>';
		}).join('');
		container.innerHTML = '<div class="assessment-history"><h4>Assessment History</h4><ol class="history-timeline" role="list">' + items + '</ol></div>';
	}

	/**
	 * @param {{ issueNumber?: number; question?: string; answer?: string; commentUrl?: string; answeredAt?: string }} message
	 */
	function handleQuestionAnswered(message) {
		if (typeof selectedIssueNumber !== 'number' && typeof message.issueNumber !== 'number') {
			return;
		}
		const issueNumber = typeof message.issueNumber === 'number' ? message.issueNumber : selectedIssueNumber;
		if (typeof issueNumber !== 'number') {
			return;
		}
		const question = typeof message.question === 'string' ? message.question : '';
		const key = buildAnswerKey(issueNumber, question);
		pendingAnswers.delete(key);
		if (!latestState || typeof latestState !== 'object') {
			latestState = {};
		}
		if (!latestState.questionResponses || typeof latestState.questionResponses !== 'object') {
			latestState.questionResponses = {};
		}
		const issueKey = String(issueNumber);
		const existing = latestState.questionResponses[issueKey] && typeof latestState.questionResponses[issueKey] === 'object'
			? latestState.questionResponses[issueKey]
			: {};
		const normalized = normalizeQuestionKey(question);
		existing[normalized] = {
			answer: typeof message.answer === 'string' ? message.answer : '',
			answeredAt: typeof message.answeredAt === 'string' ? message.answeredAt : new Date().toISOString(),
			commentUrl: typeof message.commentUrl === 'string' ? message.commentUrl : undefined
		};
		latestState.questionResponses[issueKey] = existing;
		if (latestAssessment && latestAssessment.issueNumber === issueNumber) {
			renderAssessmentResult(latestAssessment);
		}
	}

	/**
	 * @param {{ issueNumber?: number; question?: string; error?: string }} message
	 */
	function handleQuestionAnswerError(message) {
		const targetIssue = typeof message.issueNumber === 'number' ? message.issueNumber : selectedIssueNumber;
		if (typeof targetIssue !== 'number') {
			return;
		}
		const question = typeof message.question === 'string' ? message.question : '';
		const key = buildAnswerKey(targetIssue, question);
		pendingAnswers.delete(key);
		const normalized = normalizeQuestionKey(question);
		const encodedKey = encodeValue(normalized);
		const item = assessmentPanel.querySelector('.assessment-question[data-question-key="' + encodedKey + '"]');
		if (!(item instanceof HTMLElement)) {
			return;
		}
		item.classList.add('question-error');
		const errorMessage = typeof message.error === 'string' && message.error ? message.error : 'Unable to post answer.';
		const errorEl = item.querySelector('.question-error-message');
		if (errorEl) {
			errorEl.textContent = errorMessage;
		}
		const textarea = item.querySelector('textarea');
		if (textarea instanceof HTMLTextAreaElement) {
			textarea.disabled = false;
			try {
				textarea.focus({ preventScroll: true });
			} catch (error) {
				textarea.focus();
			}
		}
		const button = item.querySelector('button[data-action="submitAnswer"]');
		if (button instanceof HTMLButtonElement) {
			button.disabled = false;
			button.textContent = 'Submit answer';
		}
	}

	/**
	 * Update keyword coverage statistics
	 * @param {{ totalIssues: number, withKeywords: number, coverage: number }} stats
	 */
	function updateKeywordStats(stats) {
		totalIssuesCount.textContent = String(stats.totalIssues);
		keywordCoverageCount.textContent = String(stats.withKeywords);
		keywordCoveragePct.textContent = stats.coverage.toFixed(1) + '%';
	}

	/**
	 * Update backfill progress bar
	 * @param {{ completed: number, total: number, current?: string, status?: string, successCount?: number, failureCount?: number, skippedCount?: number, tokensUsed?: number, mode?: 'missing' | 'all' }} progress
	 */
	function updateBackfillProgress(progress) {
		const total = Number(progress.total) || 0;
		const completed = Number(progress.completed) || 0;
		const pct = total > 0 ? (completed / total) * 100 : 0;
		backfillProgress.hidden = false;
		backfillProgressBar.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + '%';
		const status = typeof progress.status === 'string' ? progress.status : 'running';
		const segments = [];
		if (status === 'completed') {
			segments.push('Completed');
		} else if (status === 'cancelled') {
			segments.push('Cancelling...');
		} else {
			segments.push('Processing...');
		}
		if (progress.mode === 'all') {
			segments.push('Refreshing all issues');
		} else if (progress.mode === 'missing') {
			segments.push('Filling gaps');
		}
		if (progress.current) {
			segments.push(`Processing ${progress.current}`);
		}
		if (total > 0) {
			segments.push(`${completed}/${total} issues`);
		} else {
			segments.push(`${completed} issues`);
		}
		const successes = Number(progress.successCount) || 0;
		const failures = Number(progress.failureCount) || 0;
		const skipped = Number(progress.skippedCount) || 0;
		segments.push(`${successes} succeeded`);
		if (failures > 0) {
			segments.push(`${failures} failed`);
		}
		if (skipped > 0) {
			segments.push(`${skipped} skipped`);
		}
		const tokens = Number(progress.tokensUsed) || 0;
		if (tokens > 0) {
			segments.push(`${tokens} tokens`);
		}
		backfillStatus.textContent = segments.join(' • ');
		cancelBackfillButton.disabled = status !== 'running';
	}

	/**
	 * Convert a millisecond duration to a human-readable label
	 * @param {number | undefined} durationMs
	 * @returns {string | undefined}
	 */
	function formatDurationMs(durationMs) {
		if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
			return undefined;
		}
		if (durationMs < 1000) {
			return `${Math.round(durationMs)} ms`;
		}
		const totalSeconds = Math.floor(durationMs / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		const remainingMs = Math.round(durationMs % 1000);
		if (minutes > 0) {
			const secondsPart = seconds > 0 ? `${seconds}s` : '';
			return `${minutes}m${secondsPart ? ' ' + secondsPart : ''}`;
		}
		if (remainingMs > 0) {
			return `${seconds}s ${remainingMs}ms`;
		}
		return `${seconds}s`;
	}

	/**
	 * Handle backfill completion
	 * @param {any} message
	 */
	function handleBackfillComplete(message) {
		setBackfillButtonsDisabled(false);
		cancelBackfillButton.disabled = true;
		backfillProgress.hidden = true;
		const result = message?.result ?? {};
		const mode = result.mode === 'all' ? 'all' : (result.mode === 'missing' ? 'missing' : undefined);
		const processed = Number(result.processedIssues) || 0;
		const successCount = Number(result.successCount) || 0;
		const failureCount = Number(result.failureCount) || 0;
		const skippedCount = Number(result.skippedCount) || 0;
		const tokensUsed = Number(result.tokensUsed) || 0;
		let durationMs = typeof message?.durationMs === 'number' ? message.durationMs : undefined;
		if (durationMs === undefined && typeof result.startedAt === 'string' && typeof result.completedAt === 'string') {
			const started = Date.parse(result.startedAt);
			const completed = Date.parse(result.completedAt);
			if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
				durationMs = completed - started;
			}
		}
		const durationLabel = formatDurationMs(durationMs);
		if (message.success) {
			const countsLine = `Success: ${successCount}, Failed: ${failureCount}, Skipped: ${skippedCount}`;
			const modeLine = mode === 'all'
				? '<p>Mode: refreshed all stored issues.</p>'
				: (mode === 'missing' ? '<p>Mode: filled missing keywords only.</p>' : '');
			backfillResults.innerHTML =
				'<div class="success-message">' +
				'<p><strong>Backfill Complete</strong></p>' +
				'<p>Processed: ' + processed + ' issues</p>' +
				'<p>' + countsLine + '</p>' +
				'<p>Tokens used: ' + tokensUsed + '</p>' +
				(durationLabel ? '<p>Duration: ' + durationLabel + '</p>' : '') +
				modeLine +
				'</div>';
			loadKeywordStats();
			return;
		}

		const status = typeof result.status === 'string' ? result.status : undefined;
		if (status === 'cancelled') {
			backfillResults.innerHTML =
				'<p class="info">Backfill cancelled after processing ' + processed + ' issues.</p>';
			return;
		}
		if (!status && typeof message?.error === 'string' && /cancel/i.test(message.error)) {
			backfillResults.innerHTML = '<p class="info">' + escapeHtml(message.error) + '</p>';
			return;
		}

		const fallbackError = Array.isArray(result.errors) && result.errors.length
			? result.errors[0]?.message
			: undefined;
		const errorMessage = message?.error || fallbackError || 'Unknown error';
		backfillResults.innerHTML =
			'<div class="error-message">' +
			'<p><strong>Backfill Failed</strong></p>' +
			'<p>' + escapeHtml(errorMessage) + '</p>' +
			'</div>';
	}

		/**
		 * Render last export summary
		 * @param {{ success?: boolean; manifest?: any; manifestPath?: string; datasetPath?: string; storedAt?: string } | undefined} record
		 */
		function renderLastExport(record) {
			if (!record || !record.success || typeof record.manifest !== 'object' || record.manifest === null) {
				lastExport.innerHTML = '<p class="muted">No exports yet</p>';
				return;
			}
			const manifest = record.manifest || {};
			const snapshots = Number(manifest.snapshotsExported) || 0;
			const coverage = typeof manifest.keywordCoveragePct === 'number'
				? manifest.keywordCoveragePct.toFixed(1)
				: '0.0';
			const rawWarnings = Array.isArray(manifest.validationReport?.warnings)
				? manifest.validationReport.warnings
				: [];
			const warnings = /** @type {string[]} */ (rawWarnings.filter(
				/** @type {(warning: string) => boolean} */ (warning => typeof warning === 'string' && warning.length > 0)
			));
			const completedAtIso = typeof manifest.exportCompletedAt === 'string' && manifest.exportCompletedAt
				? manifest.exportCompletedAt
				: (typeof record.storedAt === 'string' ? record.storedAt : undefined);
			const completedAtLabel = completedAtIso ? new Date(completedAtIso).toLocaleString() : undefined;
			const datasetPath = typeof record.datasetPath === 'string' ? record.datasetPath : '';
			const manifestPath = typeof record.manifestPath === 'string' ? record.manifestPath : '';
			const warningHtml = warnings.length
				? '<p>Warnings:</p><ul>' + warnings.map(warning => '<li>' + escapeHtml(warning) + '</li>').join('') + '</ul>'
				: '';
			const buttons = [
				datasetPath ? '<button class="compact-button" data-action="openDataset" data-path="' + escapeHtml(datasetPath) + '">Open Dataset Folder</button>' : '',
				manifestPath ? '<button class="compact-button" data-action="openManifest" data-path="' + escapeHtml(manifestPath) + '">View Manifest</button>' : ''
			].filter(Boolean);
			const actionsRow = buttons.length
				? '<div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">' + buttons.join('') + '</div>'
				: '';
			lastExport.innerHTML =
				(completedAtLabel ? '<p><strong>Last Export:</strong> ' + escapeHtml(completedAtLabel) + '</p>' : '<p><strong>Last Export:</strong> Complete</p>') +
				'<p>Snapshots: ' + snapshots + '</p>' +
				'<p>Coverage: ' + coverage + '%</p>' +
				warningHtml +
				actionsRow;
		}

	/**
	 * Handle export completion
	 * @param {any} message
	 */
	function handleExportComplete(message) {
		console.log('[IssueTriage] exportComplete message', message);
		exportDatasetButton.disabled = false;
		if (message.success) {
			const manifest = message.manifest || {};
			const snapshots = Number(manifest.snapshotsExported) || 0;
			const coverage = typeof manifest.keywordCoveragePct === 'number'
				? manifest.keywordCoveragePct.toFixed(1)
				: '0.0';
			const rawWarnings = Array.isArray(manifest.validationReport?.warnings)
				? manifest.validationReport.warnings
				: [];
			const warnings = /** @type {string[]} */ (rawWarnings.filter(
				/** @type {(warning: string) => boolean} */ (warning => typeof warning === 'string' && warning.length > 0)
			));
			exportResults.innerHTML =
				'<div class="success-message">' +
				'<p><strong>Export Complete</strong></p>' +
				'<p>Snapshots: ' + snapshots + '</p>' +
				'<p>Coverage: ' + coverage + '%</p>' +
				(warnings.length ? '<p>Warnings:</p><ul>' + warnings.map(
					/** @type {(warning: string) => string} */ (warning => '<li>' + escapeHtml(warning) + '</li>')
				).join('') + '</ul>' : '') +
				'</div>';
			const exportRecord = {
				success: true,
				manifest,
				manifestPath: typeof message.manifestPath === 'string' ? message.manifestPath : '',
				datasetPath: typeof message.datasetPath === 'string' ? message.datasetPath : '',
				storedAt: new Date().toISOString()
			};
			renderLastExport(exportRecord);
			loadKeywordStats();
		} else {
			exportResults.innerHTML = 
				'<div class="error-message">' +
				'<p><strong>Export Failed</strong></p>' +
				'<p>' + escapeHtml(message.error || 'Unknown error') + '</p>' +
				'</div>';
		}
	}

	/**
	 * Handle dataset download completion
	 * @param {any} message
	 */
	function handleDownloadComplete(message) {
		console.log('[IssueTriage] downloadComplete message', message);
		downloadDatasetButton.disabled = false;
		if (message.cancelled) {
			downloadResults.innerHTML = '<p class="muted">Download cancelled.</p>';
			return;
		}
		if (message.success) {
			const count = Number(message.count) || 0;
			const coverage = typeof message.coverage === 'number'
				? message.coverage.toFixed(1)
				: '0.0';
			const filePath = typeof message.filePath === 'string' ? message.filePath : '';
			const pathHtml = filePath ? escapeHtml(filePath) : '';
			const buttons = filePath
				? '<div style="margin-top: 8px;"><button class="compact-button" data-action="openFile" data-path="' + pathHtml + '">Open File</button></div>'
				: '';
			downloadResults.innerHTML =
				'<div class="success-message">' +
				'<p><strong>Download Ready</strong></p>' +
				'<p>Saved ' + count + ' profiles (' + coverage + '% coverage)</p>' +
				(filePath ? '<p class="muted">' + pathHtml + '</p>' : '') +
				buttons +
				'</div>';
		} else {
			downloadResults.innerHTML =
				'<div class="error-message">' +
				'<p><strong>Download Failed</strong></p>' +
				'<p>' + escapeHtml(message.error || 'Unknown error') + '</p>' +
				'</div>';
		}
	}

		vscodeApi.postMessage({ type: 'webview.ready' });
	} catch (error) {
		console.error('[IssueTriage] Fatal error initializing webview:', error);
		const err = /** @type {Error} */ (error);
		console.error('[IssueTriage] Error stack:', err && err.stack ? err.stack : 'No stack trace');
		// Display error in the UI
		const errorMessage = err && err.message ? err.message : String(error);
		document.body.innerHTML = '<div style="padding: 20px; color: var(--vscode-errorForeground, #f48771);"><h2>Issue Triage Panel Error</h2><p>Failed to initialize the Issue Triage panel. Check the developer console for details.</p><p><strong>Error:</strong> ' + errorMessage + '</p></div>';
	}
})();
