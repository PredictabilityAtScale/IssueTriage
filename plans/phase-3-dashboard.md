# Phase 3 Plan – Interactive Assessment Dashboard

## Objectives
- Deliver the rich dashboard experience defined in `feature-assessment-dashboard.md`.
- Expose aggregated readiness insights, risk context, and actionable next steps directly in the VS Code panel.
- Lay groundwork for future analytics (UsageTap) without blocking the MVP schedule.

## Scope Summary
- Replace the existing single-issue detail panel with a modular dashboard containing overview KPIs, issue listings, and enriched detail view.
- Implement interactive filters (labels, assignees, readiness tiers) with live updates.
- Provide export options (Markdown/JSON) for sharing assessment results.
- Capture telemetry for dashboard engagement.

## Major Workstreams

### 1. Dashboard Data & State Management
- Extend `IssueManager` to surface aggregated assessment metrics (counts, readiness distribution, throughput).
- Add `AssessmentHistoryService` (new) to fetch assessment history per issue for trend display.
- Define webview state contract for KPIs, filtered issue lists, and history timelines.
- Implement incremental updates when new assessments complete or risk summaries refresh.

### 2. Webview UI Redesign
- Introduce componentized front-end (lightweight framework or modular vanilla JS) for Overview, Issue List, and Detail panes.
- Build KPI cards (total assessed, readiness distribution, assessments/week).
- Add filters panel with readiness chips, label selector, search, and saved view stubs.
- Enrich detail view with score breakdown visual (bars or radial), recommendations grouped by dimension, and risk driver list.
- Ensure responsive layout for narrow vs. wide panels; provide basic keyboard navigation/high-contrast styling.

### 3. History & Export Features
- Surface assessment history timeline: previous composite scores, risk level changes, notable comments.
- Implement export actions:
  - Markdown summary (issue metadata, latest assessment, risk insights, recommendations).
  - JSON export of raw assessment + risk data (for automation pipelines).
- Persist last-selected filters and active tab via `StateService`.

### 4. Telemetry & Observability
- Instrument dashboard interactions (filter changes, export usage, tab switches) via `TelemetryService`.
- Track render timings and error states for troubleshooting.
- Add debug logging when state payloads exceed thresholds to guard against performance issues.

## Deliverables & Milestones
1. ✅ **Data Layer Complete** – services expose necessary aggregates and history APIs; unit tests cover aggregation logic.
2. ✅ **UI Shell Implemented** – new dashboard layout renders with placeholder data, navigation works.
3. ✅ **Interactive Filters & Overview KPIs** – live wired data, readiness distribution chart operational.
4. ✅ **Detail pane with History** – timeline functioning with trend indicators and visual markers; export actions pending.
5. **Accessibility & Quality Pass** – keyboard navigation, focus management, color contrast, snapshot tests/visual regression check.

## Risks & Mitigations
- **Complexity of webview state**: adopt typed interfaces and central store to avoid inconsistent updates.
- **Performance with large issue counts**: paginate or lazy-load issue list; throttle telemetry.
- **Bundle size growth**: prefer lightweight charting (e.g., chartist, echarts-lite) or custom visuals.
- **Export accuracy**: include unit tests validating Markdown/JSON output schemas.

## Next Steps
- Review plan with stakeholders; align on priorities (KPI set, export formats).
- Draft technical design for `AssessmentHistoryService` and webview state store.
- Create implementation tickets grouped by workstream and milestone.
- Begin with data services and state contract to unblock UI work.
