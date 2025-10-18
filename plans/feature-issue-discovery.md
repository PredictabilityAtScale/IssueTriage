# Feature: Issue Discovery & Management

## Objective
Provide authenticated access to GitHub repositories and surface a curated issue backlog inside VS Code so that users can filter, inspect, and select candidate issues for AI triage directly from the extension.

## User Value
- Give maintainers immediate visibility into automation-ready work without leaving their editor.
- Reduce time spent swapping between GitHub and VS Code when preparing an assessment run.
- Establish the canonical issue data model other features will use.

## Primary Workflows
1. **Repository Connection**
   - Authenticate with GitHub (OAuth device flow for VS Code).
   - Persist credentials securely using VS Code secret storage.
   - Allow users to switch repositories within the same org/account.
2. **Issue Ingestion**
   - Fetch open issues with metadata (labels, assignees, milestones, comments summary).
   - Cache responses locally with refresh controls to limit API calls.
3. **Backlog Management UI**
   - Render issue list within the IssueTriage webview with sort, search, and pagination.
   - Display key attributes (title, labels, age, assignment, last updated).
   - Provide quick actions to mark issues for assessment, open in browser, or copy URL.
4. **Filtering & Segmentation**
   - Client-side filters for labels, assignees, milestones, and automation status.
   - Support saved filter presets tied to the workspace configuration.

## Functional Requirements
- Must support both personal and organization repositories.
- Handle GitHub API rate limiting with automatic back-off and user feedback.
- Expose command palette actions: `IssueTriage: Connect Repository`, `IssueTriage: Refresh Issues`.
- Maintain local state (selected repository, filters, pinned issues) per workspace.
- Provide telemetry hooks for UsageTap (calls volume, repo selection) once tiering is active.

## Technical Notes
- Prefer GitHub REST API v3 for breadth; evaluate GraphQL for batching if rate limits become tight.
- Model layer should normalize issue payloads into a shared TypeScript interface reused by assessment and automation features.
- Adopt incremental fetch strategy (e.g., `since` parameter) to reduce sync cost on refresh.
- UI rendering through existing webview; leverage virtualized list rendering to keep performance acceptable for large backlogs.

## Dependencies
- GitHub authentication scaffolding.
- Persistent storage service for workspace-level settings.
- Telemetry abstraction shared with UsageTap integration roadmap.

## Open Questions
- Do we need multi-repository aggregation in a single view for enterprise tier? (Deferred.)
- Should archived issues be discoverable for historical analysis? (To be validated with stakeholders.)

## MVP Acceptance Criteria
- User can authenticate and select a repository.
- Issue list loads with essential metadata and basic filters.
- Selecting an issue sets the context for downstream assessment.

## Post-MVP Enhancements
- Bulk selection flows for multi-issue assessment runs.
- Smart labeling suggestions informed by previous automation outcomes.
- Offline mode leveraging cached data with stale indicators.
