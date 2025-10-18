# Feature: Historical Risk Intelligence

## Objective
Analyze historical GitHub issues, pull requests, and review conversations to derive risk indicators that refine IssueTriage readiness scoring and highlight complex areas of the codebase.

## User Value
- Quantifies past implementation difficulty so maintainers can prioritize risky automation candidates with greater confidence.
- Surfaces hotspots (files, components, teams) associated with high-friction changes.
- Provides explainable reasoning behind risk flags shown to triage leads and LLM agents.

## Intelligence Workflow
1. **Issue & PR Correlation**
   - Resolve historical issues to their linked pull requests and commits using GitHub APIs.
   - Track scenarios where multiple PRs were required to close a single issue.
2. **Change Footprint Analysis**
   - Measure number of files touched, churn (added/removed lines), and file ownership dispersion.
   - Capture complexity proxies (e.g., cyclomatic deltas via static analysis hooks when available).
3. **Conversation & Review Signals**
   - Parse review comments, labels, and timeline events to identify blockers, security flags, or repeated revision requests.
   - Score tone/severity using lightweight NLP to detect high-risk narratives.
4. **Risk Scoring Synthesis**
   - Combine footprint and conversation signals into categorical risk levels (Low/Medium/High) with supporting evidence snippets.
   - Store derived metrics for reuse in assessments, dashboards, and automation guardrails.

## Functional Requirements
- Background job to hydrate historical datasets for the currently selected repository with pagination and rate-limit awareness.
- Configurable lookback window (default 180 days) and issue label filters.
- Risk profile API returning metrics (files touched, change volume, review friction) and normalized evidence payloads.
- Integration with assessment engine to adjust readiness scoring weights based on risk band.
- Panel UI elements (badges, tooltips) to display top risk drivers for the selected issue.

## Technical Notes
- Extend `GitHubClient` to fetch timeline events, review threads, and commit file lists.
- Persist aggregated metrics in local SQLite (or existing storage) keyed by issue/PR ID for incremental updates.
- Use batched processing queues to avoid blocking UI; surface progress in output channel and dashboard.
- Employ simple sentiment or classification models runnable offline (e.g., VADER or keyword heuristics) to score comment severity; leave LLM-based interpretation for future tiers.
- Cache risk summaries to avoid recomputation when the same issue is revisited within a session.

## Dependencies
- Completed issue discovery models to map issues ↔ PRs.
- Assessment engine integration points for injecting risk modifiers.
- Telemetry pipeline to observe processing time and user interactions with risk insights.

## Open Questions
- Should we allow users to exclude directories or file types from risk calculations? (Gather feedback.)
- How do we merge manual risk overrides from triage leads with automated scores? (Design required.)
- What retention policy should govern locally stored historical data? (Align with privacy guidelines.)

## MVP Acceptance Criteria
- System calculates risk metrics for historical issues within the configured lookback window.
- Assessment output includes risk level and supporting evidence when available.
- Dashboard visualizes risk indicators for the selected issue without noticeable performance degradation.
- Processing respects GitHub rate limits and recovers gracefully from API failures.

## Post-MVP Enhancements
- Predictive modeling that forecasts risk for new issues lacking history.
- Cross-repository analytics to detect global hotspots.
- Deep NLP sentiment analysis leveraging LLMs for nuanced review interpretation.
