# Phase 1 Execution Plan – Issue Discovery & Management

## Goals
- Ship the MVP scope described in `feature-issue-discovery.md`.
- Let users authenticate with GitHub, pick a repository, and view filtered issue backlogs in the IssueTriage panel.
- Capture foundational telemetry and state management that later phases reuse.

## Success Criteria
- End-to-end flow: `Connect Repository` command → successful OAuth device auth → repository selection → issue list renders with basic filters and refresh.
- Local cache reduces GitHub API calls on subsequent refreshes during the same session.
- Smoke tests cover auth failure handling, issue fetch, and panel rendering of issue metadata.

## Workstreams & Tasks

### 1. Authentication & Credential Handling
- Implement GitHub OAuth device-code flow using `@octokit/auth-oauth-device` with VS Code secret storage (`CredentialService`).
- Add `issuetriage.connectRepository` command surfaced in the command palette and from panel CTA.
- Persist account metadata (login, scopes, token expiry) in workspace storage for quick reconnects.
- Handle token refresh/expiration; expose manual sign-out option that clears stored secrets.

### 2. Settings & State Persistence
- Leverage `SettingsService` for new configuration keys:
  - `issuetriage.github.defaultRepository`
  - `issuetriage.github.orgFilter` (new) to limit repository search scope
- Store last-selected repository and filter presets via `vscode.Memento` (global + workspace) to restore state on activation.

### 3. GitHub Data Layer
- Introduce `GitHubClient` wrapper (Octokit REST) with rate-limit awareness and retry backoff.
- Data models:
  - `RepositorySummary` (id, name, owner, permissions)
  - `IssueSummary` (number, title, labels, assignee summary, updatedAt, comments)
- Implement cached fetch with `etag` or `since` support; maintain in-memory cache keyed by repository + filter signature.

### 4. Panel UX Update
- Convert existing checklist-only webview into multi-tab or embedded view with issue list sidebar.
- Components:
  - Repository selector dropdown (recent + search).
  - Search bar and filter chips (label, assignee, milestone, status).
  - Issue list (virtualized) with quick actions: open in browser, mark for assessment.
- Maintain responsive fallback for narrow layouts; ensure keyboard navigation works.

### 5. Telemetry & Logging
- Instrument events for auth attempts, issue fetch success/failure, filter updates.
- Respect telemetry opt-out logic via `TelemetryService`.
- Add structured logging (via output channel) for rate-limit warnings and API errors.

### 6. Testing & Validation
- Unit tests: credential flow wrappers, GitHub client caching logic, filter state reducers.
- Integration/functional tests (using `@vscode/test-electron`): simulate command invocations and validate panel renders mock data (use dependency injection for HTTP layer).
- Manual QA checklist: auth success/failure, repository switching, offline handling, rate-limit messaging.

## Dependencies & Prep
- Register GitHub OAuth app for device flow (client ID, secret) and configure environment variables (Phase 0 notes).
- Decide on Octokit version and add to `package.json`.
- Confirm design for panel layout (basic Figma sketch or quick wireframe).

## Risks & Mitigations
- **Device code flow UX complexity** → Provide step-by-step guidance and deep links in webview.
- **Rate limits** → Implement caching early; display status indicator when limit near exhaustion.
- **Offline/invalid token states** → Show recovery CTA, avoid crashing the panel.

## Milestones
1. **Week 1**: Auth flow functional, secrets stored, telemetry emitting events.
2. **Week 2**: GitHub client + caching complete; stubbed issue list renders sample data.
3. **Week 3**: Live data integration, filters, saved state; end-to-end testing + docs update.

## Deliverables
- Updated `src/` services (`githubClient`, `stateStore`, `panelViewModel`).
- Extended webview front-end bundle with issue list UI.
- Documentation update: README usage section & troubleshooting for auth.
- Release notes entry for Phase 1 MVP.
