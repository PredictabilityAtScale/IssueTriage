# Feature: AI-Powered Assessment Engine

## Objective
Deliver an orchestrated assessment pipeline that scores GitHub issues for automation readiness across requirements clarity, code complexity, security sensitivity, and business impact.

## User Value
- Provides a quantified readiness score so maintainers can prioritize automation work confidently.
- Surfaces actionable recommendations to close gaps before handing work to AI agents.
- Builds the historical dataset necessary for continuous improvement and tiered analytics.

## Assessment Workflow
1. **Context Assembly**
   - Gather issue metadata, linked pull requests, and relevant code snippets.
   - Retrieve repository heuristics (file ownership, test coverage) from cached analysis services.
2. **AI Invocation**
   - Compose prompt packets for each scoring dimension leveraging OpenRouter with flexible model selection.
   - Apply retry and fallback policies to maintain reliability across providers.
3. **Scoring & Recommendations**
   - Combine dimension scores using weighted average (0.30 / 0.25 / 0.25 / 0.20).
   - Emit qualitative guidance and risk flags per dimension.
4. **Persistence & History**
   - Store assessment outputs locally first, then sync to UsageTap analytics when available.
   - Track deltas between successive assessments for trend analysis.

## Functional Requirements
- Expose a VS Code command `IssueTriage: Assess Issue` transitioning the selected issue through the pipeline.
- Support batch assessment triggered from the issue list when multiple issues are marked.
- Allow model override per workspace (default vs premium tiers).
- Capture latency, token usage, and cost data for telemetry reporting.
- Provide structured errors with remediation hints (e.g., missing repo context, rate limits).

## Technical Notes
- Define a domain schema for assessment requests/responses to decouple UI from AI providers.
- Encapsulate OpenRouter access behind a service that handles authentication, routing, and provider health checks.
- Persist assessment history in a local SQLite DB (via `better-sqlite3`) or lightweight file store for MVP; plan for cloud sync later.
- Integrate linting of prompts to ensure tokens stay within tier-specific budgets.

## Dependencies
- Completed issue discovery data model.
- OpenRouter API key and workspace configuration management.
- Telemetry layer compatible with UsageTap ingestion.

## Open Questions
- How do we merge human overrides into historical scoring? (Needs product input.)
- What is the retention policy for assessment history stored locally? (MVP default 90 days.)
- Do we require gated approvals before automation launch on low-confidence scores? (Align with automation feature.)

## MVP Acceptance Criteria
- Single-issue assessment produces four dimension scores plus a composite value.
- Assessment results render in the webview with human-readable recommendations.
- Errors are handled gracefully with user feedback and logging.

## Post-MVP Enhancements
- Adaptive model selection that learns preferred providers per repository.
- Continuous improvement loop ingesting automation outcomes to adjust weights.
- Custom dimension authoring for enterprise tenants.
