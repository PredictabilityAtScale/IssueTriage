// @ts-check
(function() {
	const vscode = (/** @type {any} */ (window)).acquireVsCodeApi();
	const svg = requireSvgElement('sidebarMatrixSvg');
	const wrapper = requireElement('sidebarMatrixWrapper');
	const emptyState = requireElement('sidebarMatrixEmpty');
	const legendContainer = requireElement('sidebarMatrixLegend');
	const infoPanel = requireElement('sidebarMatrixInfo');
	const MATRIX_MIDPOINT = 50;
	/** @type {Map<number, any>} */
	const pointLookup = new Map();

	window.addEventListener('message', event => {
		const message = event.data;
		if (!message || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'sidebarMatrix.update':
				renderLegend(Array.isArray(message.legend) ? message.legend : []);
				renderMatrix(Array.isArray(message.dataset) ? message.dataset : []);
				break;
		}
	});

	svg.addEventListener('click', event => {
		const circle = event.target instanceof SVGElement ? event.target.closest('.matrix-point') : null;
		if (!(circle instanceof SVGCircleElement)) {
			return;
		}
		event.preventDefault();
		openMatrixPoint(circle);
	});

	svg.addEventListener('keydown', event => {
		if (!(event.target instanceof SVGCircleElement)) {
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			openMatrixPoint(event.target);
		}
	});

	svg.addEventListener('mouseover', event => {
		const circle = event.target instanceof SVGElement ? event.target.closest('.matrix-point') : null;
		if (!(circle instanceof SVGCircleElement)) {
			return;
		}
		showInfo(circle);
	});

	svg.addEventListener('mouseout', event => {
		const circle = event.target instanceof SVGElement ? event.target.closest('.matrix-point') : null;
		if (!(circle instanceof SVGCircleElement)) {
			return;
		}
		hideInfo();
	});

	/**
	 * @param {Array<{ key: string; label: string }>} legend
	 */
	function renderLegend(legend) {
		if (!legendContainer) {
			return;
		}
		if (!Array.isArray(legend) || legend.length === 0) {
			legendContainer.innerHTML = '';
			legendContainer.setAttribute('aria-hidden', 'true');
			return;
		}
		const markup = legend.map(entry => {
			const key = typeof entry.key === 'string' ? entry.key : 'ready';
			const label = typeof entry.label === 'string' ? entry.label : key;
			return '<span class="matrix-legend-item"><span class="matrix-legend-swatch readiness-' + key + '"></span>' + escapeHtml(label) + '</span>';
		}).join('');
		legendContainer.innerHTML = markup;
		legendContainer.setAttribute('aria-hidden', 'false');
	}

	/**
	 * @param {Array<any>} dataset
	 */
	function renderMatrix(dataset) {
		const hasData = Array.isArray(dataset) && dataset.length > 0;
		wrapper.setAttribute('data-has-data', hasData ? 'true' : 'false');
		emptyState.style.display = hasData ? 'none' : '';
		pointLookup.clear();

		// Show/hide info panel based on data
		if (hasData) {
			infoPanel.innerHTML = '<div class="matrix-info-empty">Hover over a point to see details</div>';
			infoPanel.hidden = false;
		} else {
			infoPanel.hidden = true;
		}

		const labelOpacity = 0.4;
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
			'<text class="matrix-axis-label" x="50" y="97" text-anchor="middle" font-size="4.5" fill="currentColor" opacity="0.6">Readiness →</text>',
			'<text class="matrix-axis-label" x="-50" y="4" text-anchor="middle" font-size="4.5" fill="currentColor" opacity="0.6" transform="rotate(-90)">← Business Value</text>'
		];

		const radius = 2.8;
		const pointsMarkup = hasData
			? dataset.map(point => renderMatrixPoint(point, radius)).join('')
			: '';

		svg.innerHTML = '<g class="matrix-grid">' + base.join('') + '</g><g class="matrix-points">' + pointsMarkup + '</g>';
	}

	/**
	 * @param {any} point
	 * @param {number} radius
	 */
	function renderMatrixPoint(point, radius) {
		const issueNumber = Number(point.issueNumber);
		if (!Number.isFinite(issueNumber)) {
			return '';
		}
		const cx = clampScore(point.readinessScore);
		const cy = 100 - clampScore(point.businessScore);
		const title = typeof point.title === 'string' ? point.title : 'Issue #' + issueNumber;
		const readiness = typeof point.readinessScore === 'number' ? point.readinessScore.toFixed(1) : '';
		const business = typeof point.businessScore === 'number' ? point.businessScore.toFixed(1) : '';
		const readinessLabel = typeof point.readinessLabel === 'string' ? point.readinessLabel : '';
		const readinessKey = typeof point.readinessKey === 'string' ? point.readinessKey : 'ready';
		const url = typeof point.url === 'string' ? point.url : '';
		pointLookup.set(issueNumber, {
			issueNumber,
			title,
			readiness,
			business,
			readinessLabel,
			url
		});
		const safeTitle = escapeHtml(title);
		const urlAttr = url ? ' data-url="' + escapeHtml(url) + '"' : '';
		return '<circle class="matrix-point readiness-' + readinessKey + '" data-issue="' + issueNumber + '" cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + radius + '" tabindex="0" role="button" aria-label="#' + issueNumber + ' · ' + safeTitle + '"' + urlAttr + '></circle>';
	}

	/**
	 * @param {SVGCircleElement} circle
	 */
	function showInfo(circle) {
		const issueNumber = Number(circle.getAttribute('data-issue'));
		const point = pointLookup.get(issueNumber);
		if (!point) {
			return;
		}
		const title = escapeHtml(point.title || `Issue #${issueNumber}`);
		const readinessLabel = escapeHtml(point.readinessLabel || '');
		const readiness = point.readiness || '';
		const business = point.business || '';

		infoPanel.innerHTML = `
			<div class="matrix-info-title">#${issueNumber}: ${title}</div>
			<div class="matrix-info-meta">${readinessLabel}</div>
			<div class="matrix-info-meta">Readiness ${readiness} · Business ${business}</div>
		`;
		infoPanel.hidden = false;
	}

	function hideInfo() {
		infoPanel.innerHTML = '<div class="matrix-info-empty">Hover over a point to see details</div>';
		infoPanel.hidden = false;
	}

	/**
	 * @param {string} id
	 * @returns {HTMLElement}
	 */
	function requireElement(id) {
		const element = document.getElementById(id);
		if (!(element instanceof HTMLElement)) {
			throw new Error('Missing expected element #' + id);
		}
		return element;
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

	/**
	 * @param {SVGCircleElement} circle
	 */
	function openMatrixPoint(circle) {
		const issueNumber = Number(circle.getAttribute('data-issue'));
		const point = pointLookup.get(issueNumber);
		if (!point) {
			return;
		}
		if (point.url) {
			vscode.postMessage({ type: 'sidebarMatrix.openIssue', url: point.url });
		}
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
	 * @param {string} value
	 * @returns {string}
	 */
	function escapeHtml(value) {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}
})();
