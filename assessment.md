# IssueTriage Assessment & Risk Analysis Overview

## Assessment Pipeline

### Trigger & Inputs
- The assessment flow runs through `AssessmentService.assessIssue(repository, issueNumber)`.
- Requires an OpenRouter API key resolved from `issuetriage.assessment.apiKey` setting or `ISSUETRIAGE_OPENROUTER_API_KEY` env var.
- CLI context is prepared ahead of the API call by invoking `CliToolService.ensureAutoRunResults()`, ensuring recent command outputs are captured for prompting.

### GitHub Retrieval
- Uses `GitHubClient.getIssueDetails` with REST call `GET /repos/{owner}/{repo}/issues/{issue_number}` to gather metadata: title, body, labels, milestone, assignees, author, timestamps.
- Previous assessment metadata is pulled from `AssessmentStorage.getLatestAssessment` (SQLite-backed) to reuse an existing GitHub comment if present.

### Prompt Construction
- **System prompt** (hard-coded in `AssessmentService.generateAssessment`):
  ```text
  You are IssueTriage, an assistant that evaluates GitHub issues for project readiness, risk, and impact. Always respond with JSON matching the requested schema.
  ```
- `AssessmentService.buildModelPayload` assembles the user prompt sent to OpenRouter:
  - Repository, issue number/title, author, labels, assignees, milestone, URL, body.
  - If CLI tools produced output, adds a "CLI tool context" section with the most recent runs (`CliToolService.getPromptContext`).
  - Appends explicit JSON schema instructions requiring the model to return:
    ```json
    {
      "summary": string,
      "scores": {
        "composite": number,
        "requirements": number,
        "complexity": number,
        "security": number,
        "business": number
      },
      "recommendations": string[]
    }
    ```
  - Additional guidance constrains scores to 0–100 with one decimal and limits summary length/recommendations count.
- **User prompt template** (simplified view with placeholders):
  ```text
  Repository: <owner>/<repo>
  Issue: #<number> <title>
  Created by: <author>
  Labels: <label list or "None">
  Assignees: <assignee list or "None">
  Milestone: <milestone or "None">
  URL: <issue url>

  Issue body:
  <issue body or "(empty)">

  [Optional CLI tool context block]

  Return a JSON object with the following shape: {
    "summary": string,
    "scores": {
      "composite": number,
      "requirements": number,
      "complexity": number,
      "security": number,
      "business": number
    },
    "recommendations": string[]
  }
  - Scores must be 0-100 numbers with one decimal precision. Base composite on the other four dimensions. Provide concise summary (max 4 sentences). Include up to five actionable recommendations.
  ```

### OpenRouter Request
- Endpoint: `POST https://openrouter.ai/api/v1/chat/completions` with headers `Content-Type`, `Authorization: Bearer <key>`, `HTTP-Referer`, `X-Title`.
- Body fields:
  - `model`: selected via `issuetriage.assessment.preferredModel`, `assessment.usePremiumModel`, `assessment.premiumModel`, and `assessment.standardModel` settings (normalized by stripping `openrouter/` prefix).
  - `messages`: system prompt + user payload.
  - `temperature`: 0.25.
- Response parsing:
  - Extracts `choices[0].message.content` and strips ```json fenced blocks if present.
  - Validates numeric ranges, trims recommendation entries, preserves raw JSON payload for storage.

### Risk-Aware Score Adjustment
- `RiskIntelligenceService.getSummary` provides cached risk info.
- If status `ready`:
  - `riskLevel = high` → composite & complexity multiplied by 0.8.
  - `riskLevel = medium` → same scores multiplied by 0.9.
  - Other dimensions remain unchanged.
- Adjustment triggers `assessment.riskAdjusted` telemetry when risk level is not low.

### GitHub Comment Publication
- Controlled by `issuetriage.assessment.publishComments` (default true).
- Generates markdown comment tagged with `<!-- IssueTriage Assessment -->`, includes score table, summary, recommendations, timestamp.
- Upserts via `GitHubClient.upsertIssueComment` using:
  - `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` if reusing comment.
  - Fallback `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` when needed.

### Persistence & Telemetry
- Assessment records stored in `assessments.db` (`AssessmentStorage`, via sql.js) with recommendations, scores, summary, model id, timestamps, GitHub comment id, raw provider response.
- Telemetry events emitted via `TelemetryService` (e.g., `assessment.completed`, `assessment.failed`, `assessment.storage.*`).
- History APIs: `getLatestAssessment`, `getAssessmentHistory(limit=20)`.

## Risk Analysis Pipeline

### Prime & Caching Workflow
- Entry point: `RiskIntelligenceService.primeIssues(repository, issues)` invoked when loading issue lists.
- Retrieves prior risk profiles from `RiskStorage` (`risk-profiles.db`), maps to current issues, and decides whether to skip, reuse, or hydrate.
- Summaries cached in-memory (`summaryCache`), profiles in `profileCache`, keyed by normalized repo name.

### Skip & Pending Logic
- `shouldSkip` returns message when:
  - Issue updated outside configured lookback window (`issuetriage.risk.lookbackDays`, default 180, min 30, max 365).
  - Issue labels fail configured filters (`issuetriage.risk.labelFilters`, case-insensitive substring match).
- Without stored data, summary marked `pending` and hydration enqueued.
- Staleness triggers hydration when lookback or label filters change, issue updated after `calculatedAt`, or cache TTL (6 hours) expires.

### Hydration Queue
- Background queue processed sequentially with 750 ms delay between tasks; respects service disposal and timeout guard (`waitForIdle` helper).
- Emits interim `pending` summary events via `onDidUpdate` event emitter for UI updates.

### GitHub Data Collection
- For each enqueued issue:
  1. `GitHubClient.getIssueRiskSnapshot` fetches relevant pull requests and direct commits.
     - REST sequence:
       - `GET /repos/{owner}/{repo}/issues/{issue_number}/events` (paginated, 100 per page) to find linked PR numbers.
       - For each PR number:
         - `GET /repos/{owner}/{repo}/pulls/{pull_number}` to obtain statistics (additions, deletions, changed files, commits, comments).
         - `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` to aggregate review states.
      - Commit references (evaluated when no PRs are present):
        - `GET /repos/{owner}/{repo}/commits/{ref}` for up to 30 unique commit SHAs referenced by the issue.
  2. Missing change history ⇒ summary `skipped` with message "No linked pull requests or commits found. Risk analysis requires recent change history." and telemetry `risk.skippedNoHistory`.

### Risk Profile Construction
- `buildProfile` composes:
  - Metrics from PR history (`computeMetrics`): counts of PRs, files, additions, deletions, combined change volume, review friction.
  - Risk score: prCount (×15, capped 40) + filesTouched/5 (×5, capped 20) + changeVolume/200 (×5, capped 20) + reviewCommentCount/5 (×5, capped 20); clamped 0–100.
  - Risk level: `high ≥70`, `medium ≥40`, else `low`.
  - Drivers: textual explanations for notable metrics (multiple PRs, ≥25 files touched, ≥1000 churn, ≥15 review comments).
  - Evidence: up to five PR summaries with links and change stats.
- Persisted via `RiskStorage.saveProfile` (UPSERT), stored with lookback/filter metadata for staleness checks.

### Output & Telemetry
- Summaries published: status, riskLevel, riskScore, top drivers, core metrics, stale flag.
- Telemetry events: `risk.hydrationComplete`, `risk.hydrationFailed`, `risk.queue.processFailed`, etc.
- Consumers (e.g., assessment adjustments, UI) call `getSummary`, `getProfile`; wait for queue completion via `waitForIdle` if required.

## Settings & Environment Controls
- `issuetriage.assessment.apiKey` / `ISSUETRIAGE_OPENROUTER_API_KEY` – OpenRouter authentication.
- `issuetriage.assessment.publishComments` – toggles automatic comment posting.
- `issuetriage.assessment.preferredModel`, `assessment.usePremiumModel`, `assessment.premiumModel`, `assessment.standardModel` – model selection logic.
- `issuetriage.automation.launchEnabled` – exposes automation launch features via `AssessmentService.isAutomationLaunchEnabled()`.
- `issuetriage.risk.lookbackDays`, `issuetriage.risk.labelFilters` – risk hydration filters.
- CLI tool configuration under `issuetriage.cliTools` influences prompt context via auto-run definitions.

## Data Stores & Lifecycle
- Assessment data persists in `assessments.db` (SQLite via sql.js); disposes flush data and closes database.
- Risk profiles persist in `risk-profiles.db`; hydration updates existing rows (unique on repository + issue).
- Both services call `dispose()` to persist state and release resources when extension deactivates.

## Telemetry & Error Handling Highlights
- Failures in provider calls, storage, GitHub operations emit telemetry with repository/issue context for observability.
- Assessment errors categorized (`missingApiKey`, `providerError`, `invalidResponse`, `storageError`) and rethrown as `AssessmentError` for UI feedback.
- Risk service gracefully downgrades to `error` summaries on exceptions and continues queue processing.

## Interaction Summary
- Assessment integrates risk output by adjusting scores, ensuring high-risk history tempers optimism.
- Risk service depends on GitHub linked PR history; absence halts adjustments but still surfaces informative summaries.
- Combined, IssueTriage leverages local CLI insights, GitHub metadata, OpenRouter analysis, and PR history to deliver actionable triage guidance.
