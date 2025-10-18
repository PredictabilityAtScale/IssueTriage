# Feature: Interactive Assessment Dashboard

## Objective
Create a rich webview panel that visualizes assessment outcomes, surfacing readiness scores, trends, and recommended actions directly within VS Code.

## User Value
- Gives teams a fast, shared understanding of automation readiness without exporting to external tools.
- Highlights priority issues and blockers at a glance through visual cues.
- Encourages continuous monitoring by tracking assessment history over time.

## Experience Overview
1. **Overview Tab**
   - KPI cards for total assessed issues, readiness distribution (RAG status), and assessment throughput.
   - Top priority issues list with quick navigation back to the backlog.
2. **Issue Detail Pane**
   - Detailed score breakdown with weighting visualization.
   - Expandable AI recommendations grouped by dimension.
   - Change log showing previous assessments and manual annotations.
3. **Filters & Segments**
   - Filter by labels, owners, score ranges, or readiness level.
   - Saved views per user to support different triage workflows.
4. **Analytics Hooks**
   - UsageTap events for dashboard interactions and feature adoption metrics.

## Functional Requirements
- Webview must update in real time when new assessments complete.
- Support deep linking from VS Code notifications and issue list entries.
- Provide export options (JSON, Markdown summary) for external sharing.
- Offer accessibility baseline (keyboard navigation, high-contrast compliance).
- Persist UI state (active tab, filters) between sessions.

## Technical Notes
- Leverage existing webview framework with modular front-end components (React or lightweight equivalent depending on bundle size).
- Use message passing API to sync data between extension host and webview.
- Implement event-driven state updates via the assessment engine's event emitter.
- Ensure charting components degrade gracefully when UsageTap tier limits hide certain metrics.

## Dependencies
- Stable assessment data schema with historical entries.
- Issue discovery metadata for linking back to backlog context.
- Telemetry service for capturing dashboard usage.

## Open Questions
- Do we need offline snapshots for compliance exports? (Deferred pending enterprise requirements.)
- Should dashboard support collaborative annotations? (Collect customer demand first.)

## MVP Acceptance Criteria
- Dashboard displays latest assessment results for selected issue.
- Users can filter by readiness level and observe list updates instantly.
- Export produces markdown summary aligning with IssueTriage scoring model.

## Post-MVP Enhancements
- Trend charts across time windows with predictive insights.
- Real-time shared presence indicators for collaborative triage sessions.
- Automated insights (e.g., "Top blockers this week") powered by UsageTap analytics.
