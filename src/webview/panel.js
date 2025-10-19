// @ts-check
(function() {
	const vscodeApi = acquireVsCodeApi();

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
	const emptyState = /** @type {HTMLElement} */ (requireElement('emptyState'));
	const issueSummary = /** @type {HTMLElement} */ (requireElement('issueSummary'));
	const loadingState = /** @type {HTMLElement} */ (requireElement('loadingState'));
	const accountLabel = /** @type {HTMLElement} */ (requireElement('accountLabel'));
	const automationBadge = /** @type {HTMLElement} */ (requireElement('automationBadge'));
	const assessmentPanel = /** @type {HTMLElement} */ (requireElement('assessmentPanel'));
	const overviewMetrics = /** @type {HTMLElement} */ (requireElement('overviewMetrics'));
	const openTab = /** @type {HTMLButtonElement} */ (requireElement('openTab'));
	const closedTab = /** @type {HTMLButtonElement} */ (requireElement('closedTab'));

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
	let currentStateFilter = 'open';
	/** @type {number | undefined} */
	let searchDebounceHandle = undefined;

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
		const stateFilter = currentStateFilter || 'open';
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
		if (currentStateFilter !== 'open') {
			console.log('[IssueTriage] Switching to open tab');
			currentStateFilter = 'open';
			updateStateTabs();
			onFilterChanged();
		}
	});

	closedTab.addEventListener('click', () => {
		if (currentStateFilter !== 'closed') {
			console.log('[IssueTriage] Switching to closed tab');
			currentStateFilter = 'closed';
			updateStateTabs();
			onFilterChanged();
		}
	});

	function updateStateTabs() {
		openTab.classList.toggle('active', currentStateFilter === 'open');
		closedTab.classList.toggle('active', currentStateFilter === 'closed');
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
				selectIssue(issueNumber);
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
		selectIssue(issueNumber);
	});

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
			dashboardMetrics
		} = state;

		connectButton.disabled = loading;
		connectButton.textContent = session ? 'Sign Out' : 'Connect';
		refreshButton.disabled = loading || !selectedRepository;

		if (loadingState) {
			loadingState.hidden = !loading;
		}
		if (loading) {
			issueList.setAttribute('aria-busy', 'true');
		} else {
			issueList.removeAttribute('aria-busy');
		}

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
		if (currentStateFilter !== nextStateFilter) {
			currentStateFilter = nextStateFilter;
			updateStateTabs();
		}

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

		if (!loading && issues.length === 0) {
			emptyState.hidden = false;
			issueList.innerHTML = '';
		} else {
			emptyState.hidden = true;
			issueList.innerHTML = issues.map(/** @param {any} issue */ issue => renderIssue(issue)).join('');
		}

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
			metricsItems.push(String(summary.metrics.prCount) + ' linked pull requests');
			metricsItems.push(String(summary.metrics.filesTouched) + ' files touched');
			metricsItems.push(String(summary.metrics.changeVolume) + ' lines changed');
			metricsItems.push(String(summary.metrics.reviewCommentCount) + ' review friction signals');
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
		const header = '<div class="issue-card-header"><div class="issue-card-title"><h3>#' + issue.number + ' · ' + escapeHtml(issue.title) + '</h3></div><div class="issue-card-actions">' + badgeHtml + '<button type="button" class="issue-action" data-action="runAssessment" data-issue-number="' + issue.number + '">Run Assessment</button></div></div>';
		const labelRow = labelBadges ? '<div class="meta-row">' + labelBadges + '</div>' : '';
		return '<article class="issue-card ' + stateClass + '" data-issue-number="' + issue.number + '" data-url="' + issue.url + '">' +
			header +
			'<div class="meta-row">' +
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
			return;
		}
		if (!latestState.issues.length) {
			selectedIssueNumber = undefined;
			renderAssessmentEmpty('No assessments yet. Run an IssueTriage assessment to populate this panel.');
			return;
		}
		const existingNumbers = latestState.issues.map(/** @param {any} issue */ issue => issue.number);
		if (!selectedIssueNumber || !existingNumbers.includes(selectedIssueNumber)) {
			selectIssue(existingNumbers[0]);
		} else {
			highlightSelectedIssue();
		}
	}

	/**
	 * @param {any} issueNumber
	 */
	function selectIssue(issueNumber) {
		if (selectedIssueNumber === issueNumber) {
			highlightSelectedIssue();
			return;
		}
		selectedIssueNumber = issueNumber;
		latestAssessment = null;
		highlightSelectedIssue();
		renderAssessmentLoading();
		if (latestState && latestState.selectedRepository) {
			vscodeApi.postMessage({ type: 'webview.selectIssue', issueNumber });
		}
	}

	function highlightSelectedIssue() {
		const cards = issueList.querySelectorAll('.issue-card');
		cards.forEach(card => {
			const number = Number(card.getAttribute('data-issue-number'));
			if (!Number.isNaN(number) && number === selectedIssueNumber) {
				card.classList.add('selected');
			} else {
				card.classList.remove('selected');
			}
		});
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
		const definition = READINESS_DEFINITIONS[key];
		if (definition) {
			return {
				key,
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
		const recommendations = (data.recommendations && data.recommendations.length ? data.recommendations : ['No immediate actions recommended.']).map(/** @param {any} item */ item => '<li>' + item + '</li>').join('');
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
			'<h3>Recommendations</h3>',
			'<ul class="recommendations-list">' + recommendations + '</ul>',
			'</div>',
			'<div class="assessment-actions">'
		];
		if (issueUrl) {
			lines.push('<button class="button-link" data-action="openIssue">Open Issue</button>');
		}
		if (data.commentUrl) {
			lines.push('<button class="button-link" data-action="openComment" data-url="' + data.commentUrl + '">View Latest Comment</button>');
		}
		lines.push('</div>');
		assessmentPanel.innerHTML = lines.join('') + '<div id="riskSection"></div>';
		renderRiskDisplay(data.issueNumber);
	}

	vscodeApi.postMessage({ type: 'webview.ready' });
})();
