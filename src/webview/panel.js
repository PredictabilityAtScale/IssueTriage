// @ts-check
(function() {
	const vscodeApi = (/** @type {any} */ (window)).acquireVsCodeApi();

	/**
	 * @template {HTMLElement} T
	 * @param {string} id
	 * @returns {T}
	 */
	function requireElement(id) {
		const element = document.getElementById(id);
		if (!element) {
			throw new Error('Missing expected element #' + id);
		}
		return /** @type {T} */ (element);
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
	const overviewMetrics = /** @type {HTMLElement} */ (requireElement('overviewMetrics'));
	const openTab = /** @type {HTMLButtonElement} */ (requireElement('openTab'));
	const closedTab = /** @type {HTMLButtonElement} */ (requireElement('closedTab'));
	const unlinkedTab = /** @type {HTMLButtonElement} */ (requireElement('unlinkedTab'));
	const mlTrainingTab = /** @type {HTMLButtonElement} */ (requireElement('mlTrainingTab'));
	const backfillPanel = /** @type {HTMLElement} */ (requireElement('backfillPanel'));
	const backfillBody = /** @type {HTMLElement} */ (requireElement('backfillBody'));
	const refreshBackfillButton = /** @type {HTMLButtonElement} */ (requireElement('refreshBackfill'));
	const analysisActions = /** @type {HTMLElement} */ (requireElement('analysisActions'));
	const runAnalysisButton = /** @type {HTMLButtonElement} */ (requireElement('runAnalysisButton'));
	const mlTrainingPanel = /** @type {HTMLElement} */ (requireElement('mlTrainingPanel'));
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

	function updateStateTabs() {
		const openSelected = currentTab === 'open';
		const closedSelected = currentTab === 'closed';
		const unlinkedSelected = currentTab === 'unlinked';
		const mlTrainingSelected = currentTab === 'mlTraining';
		openTab.classList.toggle('active', openSelected);
		openTab.setAttribute('aria-pressed', openSelected ? 'true' : 'false');
		closedTab.classList.toggle('active', closedSelected);
		closedTab.setAttribute('aria-pressed', closedSelected ? 'true' : 'false');
		unlinkedTab.classList.toggle('active', unlinkedSelected);
		unlinkedTab.setAttribute('aria-pressed', unlinkedSelected ? 'true' : 'false');
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
		} else if (action === 'sendToAI') {
			if (typeof selectedIssueNumber === 'number') {
				vscodeApi.postMessage({ type: 'webview.sendToAI', issueNumber: selectedIssueNumber });
			}
		} else if (action === 'exportMarkdown') {
			if (typeof selectedIssueNumber === 'number') {
				vscodeApi.postMessage({ type: 'webview.exportAssessment', issueNumber: selectedIssueNumber, format: 'markdown' });
			}
		} else if (action === 'exportJson') {
			if (typeof selectedIssueNumber === 'number') {
				vscodeApi.postMessage({ type: 'webview.exportAssessment', issueNumber: selectedIssueNumber, format: 'json' });
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
		connectButton.textContent = session ? 'Sign Out' : 'Connect';
		refreshButton.disabled = loading || !selectedRepository;

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
		if (currentTab !== 'unlinked' && currentTab !== 'mlTraining') {
			currentTab = nextStateFilter;
		}
		updateStateTabs();

		searchInput.value = filters.search || '';

		repositorySelect.innerHTML = '';
		const defaultOption = document.createElement('option');
		defaultOption.value = '';
		defaultOption.textContent = repositories.length ? 'Select repository' : 'No repositories available';
		repositorySelect.appendChild(defaultOption);
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

		const showIssues = currentTab !== 'unlinked' && currentTab !== 'mlTraining';

		if (loadingState) {
			loadingState.hidden = !showIssues || !loading;
		}
		if (showIssues && loading) {
			issueList.setAttribute('aria-busy', 'true');
		} else {
			issueList.removeAttribute('aria-busy');
		}

		overviewMetrics.hidden = !showIssues;
		issueList.hidden = !showIssues;
		issuesPanel.hidden = !showIssues;

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
		}

		refreshRunAnalysisControls();
		renderBackfillPanel(state);
		renderMLTrainingPanel();
		enforceSelection();
		renderRiskDisplay(selectedIssueNumber);
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
		const pullSection = renderBackfillSection('Pull requests', work.pullRequests?.length ?? 0, renderBackfillPullRequests(work.pullRequests ?? []));
		const commitSection = renderBackfillSection('Commits', work.commits?.length ?? 0, renderBackfillCommits(work.commits ?? []));
		backfillBody.innerHTML = updatedText + '<div class="backfill-columns">' + pullSection + commitSection + '</div>';
	}

	/**
	 * @param {string} title
	 * @param {number} count
	 * @param {string} contentHtml
	 */
	function renderBackfillSection(title, count, contentHtml) {
		const countLabel = count === 1 ? '1 unlinked item' : count + ' unlinked items';
		return '<section class="backfill-section"><header><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(countLabel) + '</p></header>' + contentHtml + '</section>';
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
	function getReadiness(score) {
		const key = readinessKeyFromScore(score);
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
		const readiness = getReadiness(data.compositeScore);
		const updatedAt = new Date(data.createdAt).toLocaleString();
		const issueUrl = getIssueUrl(data.issueNumber);
		const recommendations = (data.recommendations && data.recommendations.length ? data.recommendations : ['No open questions identified.']).map(/** @param {any} item */ item => '<li>' + item + '</li>').join('');
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
			'<ul class="recommendations-list">' + recommendations + '</ul>',
			'</div>',
			'<div class="assessment-actions">'
		];
			lines.push('<button class="button-link" type="button" data-action="copyForAI">📋 Copy for AI</button>');
			lines.push('<button class="button-link" type="button" data-action="sendToAI">🤖 Send to AI Assistant</button>');
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
			const readiness = getReadiness(record.compositeScore);
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
})();
