# Dashboard Telemetry Instrumentation

## Overview
Completed the Phase 3 telemetry workstream by wiring dashboard interactions into the existing `TelemetryService`. The extension now tracks repository selection, filter adjustments, issue focus changes, and export usage to help understand engagement with the IssueTriage dashboard.

## Implementation Date
October 19, 2025

## Interaction Events

| Event ID | Trigger | Properties | Measurements |
| --- | --- | --- | --- |
| `dashboard.repositorySelected` | User selects a repository in the dashboard | `repository`, `visibility` | — |
| `dashboard.filtersChanged` | Filters update via readiness dropdown, search, label/assignee/milestone pickers, or open/closed tabs | `repository`, `state`, `readiness`, `label`, `assignee`, `milestone`, `search` (`entered`/`empty`) | `searchLength`, `visibleIssues` |
| `dashboard.issueSelected` | Issue card selected in the list | `repository`, `issue` | — |
| `assessment.export` *(existing)* | Assessment exported via Markdown or JSON buttons | `repository`, `issue`, `format` | — |

## Code Changes

### Extension Host (`src/extension.ts`)
- Normalized readiness values inside `ensureFilterPayload()` to ensure telemetry and filtering stay aligned.
- Tracked filter updates in the `webview.filtersChanged` case, including search state, readiness tier, and visible issue counts.
- Logged issue selections before fetching assessment data to correlate detail pane usage.

### Issue Manager (`src/issueManager.ts`)
- Recorded repository selection events within `selectRepository()` along with visibility metadata (public/private).
- Left filter tracking centralized in the extension to avoid duplicate events.

## Operational Notes
- Telemetry never captures raw search text. Instead it logs whether a query is present and its length.
- Readiness defaults to `all` when unspecified to maintain consistent reporting.
- Export telemetry already existed; instrumentation now rounds out the full set of dashboard touchpoints.

## Quality Assurance
- `npm run compile` – ✅
- `npm test` – ✅ (10 tests)

## Follow-up Work
- Confirmed keyboard accessibility telemetry during the October 19, 2025 accessibility pass; continue monitoring for regressions in future UI updates.
- Build telemetry dashboards (outside this repo) to visualize adoption of readiness filters and export usage.
