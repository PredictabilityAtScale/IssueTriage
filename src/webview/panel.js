// @ts-check
(function() {
	const vscodeApi = acquireVsCodeApi();
	const connectButton = document.getElementById('connect');
	const refreshButton = document.getElementById('refresh');
	const repositorySelect = document.getElementById('repositorySelect');
	const searchInput = document.getElementById('searchInput');
	const labelFilter = document.getElementById('labelFilter');
	const assigneeFilter = document.getElementById('assigneeFilter');
	const milestoneFilter = document.getElementById('milestoneFilter');
	const issueList = document.getElementById('issueList');
	const emptyState = document.getElementById('emptyState');
	const issueSummary = document.getElementById('issueSummary');
	const loadingState = document.getElementById('loadingState');
	const accountLabel = document.getElementById('accountLabel');
	const automationBadge = document.getElementById('automationBadge');
	const assessmentPanel = document.getElementById('assessmentPanel');
	const openTab = document.getElementById('openTab');
	const closedTab = document.getElementById('closedTab');

	let latestState = null;
	let selectedIssueNumber = undefined;
	let latestAssessment = null;
	let currentStateFilter = 'open';

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

	repositorySelect.addEventListener('change', event => {
		const value = event.target.value;
		vscodeApi.postMessage({ type: 'webview.selectRepository', repository: value });
	});

	function onFilterChanged() {
		const filters = {
			search: searchInput.value || undefined,
			label: labelFilter.value || undefined,
			assignee: assigneeFilter.value || undefined,
			milestone: milestoneFilter.value || undefined,
			state: currentStateFilter
		};
		console.log('[IssueTriage] Filters changed:', filters);
		vscodeApi.postMessage({ type: 'webview.filtersChanged', filters });
	}

	labelFilter.addEventListener('change', onFilterChanged);
	assigneeFilter.addEventListener('change', onFilterChanged);
	milestoneFilter.addEventListener('change', onFilterChanged);

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

	function renderState(state) {
		const { loading, session, repositories, selectedRepository, issues, issueMetadata, filters, error, lastUpdated, automationLaunchEnabled } = state;

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

		// Only sync state from backend on initial load or if we don't have a current state
		// Don't overwrite user's tab selection with backend state during updates
		if (currentStateFilter === null || currentStateFilter === undefined) {
			currentStateFilter = filters.state || 'open';
			updateStateTabs();
		}

		repositorySelect.innerHTML = '';
		const defaultOption = document.createElement('option');
		defaultOption.value = '';
		defaultOption.textContent = repositories.length ? 'Select repository' : 'No repositories available';
		repositorySelect.appendChild(defaultOption);
		repositories.forEach(repo => {
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

		if (!loading && issues.length === 0) {
			emptyState.hidden = false;
			issueList.innerHTML = '';
		} else {
			emptyState.hidden = true;
			issueList.innerHTML = issues.map(issue => renderIssue(issue)).join('');
		}


		if (loading) {
			issueSummary.textContent = 'Loading issues...';
		} else if (selectedRepository) {
			const filterState = filters.state || 'open';
			const issueLabel = filterState === 'closed' ? 'closed issues' : 'open issues';
			const summaryBase = issues.length + ' ' + issueLabel;
			const updatedText = lastUpdated ? ' · Updated ' + new Date(lastUpdated).toLocaleString() : '';
			issueSummary.textContent = summaryBase + updatedText;
		} else {
			issueSummary.textContent = '';
		}

		enforceSelection();
		renderRiskDisplay(selectedIssueNumber);
	}

	function renderFilterOptions(selectElement, values, selectedValue, placeholder) {
		selectElement.innerHTML = '';
		const option = document.createElement('option');
		option.value = '';
		option.textContent = placeholder;
		selectElement.appendChild(option);
		values.forEach(value => {
			const optionEl = document.createElement('option');
			optionEl.value = value;
			optionEl.textContent = value;
			if (value === selectedValue) {
				optionEl.selected = true;
			}
			selectElement.appendChild(optionEl);
		});
	}

	function getRiskSummary(issueNumber) {
		if (!latestState || !latestState.riskSummaries) {
			return undefined;
		}
		return latestState.riskSummaries[issueNumber];
	}

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
			? '<ul class="risk-metrics">' + metricsItems.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
			: '<p class="risk-meta">No metrics available yet.</p>';
		const driversHtml = summary.topDrivers && summary.topDrivers.length
			? summary.topDrivers.map(item => '<li>' + escapeHtml(item) + '</li>').join('')
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

	function renderRiskDisplay(issueNumber) {
		const container = assessmentPanel.querySelector('#riskSection');
		if (!container) {
			return;
		}
		const summary = typeof issueNumber === 'number' ? getRiskSummary(issueNumber) : undefined;
		container.innerHTML = renderRiskSection(summary);
	}

	function renderIssue(issue) {
		const labelBadges = issue.labels.map(label => '<span class="badge">' + escapeHtml(label) + '</span>').join(' ');
		const assigneeText = issue.assignees.length ? '· Assigned to ' + issue.assignees.map(name => escapeHtml(name)).join(', ') : '';
		const milestoneText = issue.milestone ? '· Milestone ' + escapeHtml(issue.milestone) : '';
		const updatedText = new Date(issue.updatedAt).toLocaleString();
		const riskSummary = getRiskSummary(issue.number);
		const riskBadge = renderRiskBadge(riskSummary);
		const stateClass = issue.state === 'closed' ? 'issue-state-closed' : '';
		const stateBadge = issue.state === 'closed' ? '<span class="badge state-badge">Closed</span>' : '';
		const header = '<div class="issue-card-header"><div class="issue-card-title"><h3>#' + issue.number + ' · ' + escapeHtml(issue.title) + '</h3></div><div class="issue-card-actions">' + (stateBadge || '') + (riskBadge || '') + '<button type="button" class="issue-action" data-action="runAssessment" data-issue-number="' + issue.number + '">Run Assessment</button></div></div>';
		const labelRow = labelBadges ? '<div class="meta-row">' + labelBadges + '</div>' : '';
		return '<article class="issue-card ' + stateClass + '" data-issue-number="' + issue.number + '" data-url="' + issue.url + '">' +
			header +
			'<div class="meta-row">' +
				'<span>Updated ' + updatedText + '</span>' +
				(assigneeText ? '<span>' + assigneeText + '</span>' : '') +
				(milestoneText ? '<span>' + milestoneText + '</span>' : '') +
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
		const existingNumbers = latestState.issues.map(issue => issue.number);
		if (!selectedIssueNumber || !existingNumbers.includes(selectedIssueNumber)) {
			selectIssue(existingNumbers[0]);
		} else {
			highlightSelectedIssue();
		}
	}

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

	function getIssueUrl(issueNumber) {
		if (!latestState) {
			return undefined;
		}
		const issue = latestState.issues.find(item => item.number === issueNumber);
		return issue ? issue.url : undefined;
	}

	function getReadiness(score) {
		if (score >= 80) {
			return { label: 'Automation Ready', className: 'readiness-ready', description: 'Safe to hand off to automation.' };
		}
		if (score >= 60) {
			return { label: 'Prep Required', className: 'readiness-prepare', description: 'Add missing context then reassess.' };
		}
		if (score >= 40) {
			return { label: 'Needs Review', className: 'readiness-review', description: 'Human review recommended before automation.' };
		}
		return { label: 'Manual Only', className: 'readiness-manual', description: 'Keep this issue manual for now.' };
	}

	function renderAssessmentLoading() {
		assessmentPanel.innerHTML = '<div class="assessment-loading">Loading latest assessment…</div><div id="riskSection"></div>';
		renderRiskDisplay(selectedIssueNumber);
	}

	function renderAssessmentEmpty(message) {
		latestAssessment = null;
		assessmentPanel.innerHTML = '<div class="assessment-empty">' + message + '</div><div id="riskSection"></div>';
		renderRiskDisplay(selectedIssueNumber);
	}

	function renderAssessmentError(message) {
		latestAssessment = null;
		assessmentPanel.innerHTML = '<div class="assessment-error">' + message + '</div><div id="riskSection"></div>';
		renderRiskDisplay(selectedIssueNumber);
	}

	function renderAssessmentResult(data) {
		latestAssessment = data;
		const readiness = getReadiness(data.compositeScore);
		const updatedAt = new Date(data.createdAt).toLocaleString();
		const issueUrl = getIssueUrl(data.issueNumber);
		const recommendations = (data.recommendations && data.recommendations.length ? data.recommendations : ['No immediate actions recommended.']).map(item => '<li>' + item + '</li>').join('');
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
