# IssueTriage

IssueTriage adds an interactive triage dashboard to Visual Studio Code so product and engineering teams can quickly assess how ready an issue is for implementation.

As of the Phase 1 build, the extension connects directly to GitHub, surfaces repository backlogs, and lets you filter issues before moving into the assessment workflow.

## Features

- Launch the **Issue Triage** panel from the command palette (`Issue Triage: Open Panel`), the Issue Triage status bar button, or the **Issue Triage sidebar** in the Activity Bar.
- Browse issues in the dedicated **Issue Triage sidebar** with:
  - Repository drop-down (click the repository name to switch workspaces)
  - Readiness distribution stats (click to filter, click again or **Clear Readiness Filter** to reset)
  - Issue groups separated by assessment status (Not Assessed, Automation Ready, Prep Required, Needs Review, Manual Only)
  - Quick actions: Open the full panel, refresh, assess individual issues, or send automation-ready issues to the AI agent
  - Inline labels plus color-coded readiness dots that mirror the main panel
- Authenticate with GitHub via device code to load repositories you own or collaborate on.
- Browse open issues, search titles, and filter by label, assignee, or milestone inside VS Code.
- See inline risk badges powered by historical GitHub activity to highlight hotspots before you assess them.
- Track readiness with the weighted checklist focused on problem clarity, impact, dependencies, safeguards, and validation (future phases enrich this with AI scoring).
- See the most recent assessment’s composite score, dimension breakdowns, summary, and recommendations directly inside the panel, with quick links back to the issue or GitHub comment.
- Review a dedicated **Risk Intelligence** section on every issue that surfaces linked pull requests, change volume, review friction, and top risk drivers.
- Run **Issue Triage: Assess Selected Issue** to generate an AI-assisted readiness assessment using OpenRouter, with results stored locally and (optionally) posted back to the GitHub issue.
- Use **Issue Triage: Run Context Tool** to execute curated CLI utilities (like the built-in workspace snapshot) and feed their output into the next assessment run.
- Jump from the list to the GitHub issue in your browser for deeper inspection.
- Monitor whether guarded automation launch is enabled via the panel badge (controlled through `issuetriage.automation.launchEnabled`).

## Getting Started

### 1. Connect GitHub (once per workspace)


1. Open the command palette and run **Issue Triage: Connect Repository** (or click **Connect GitHub** in the side panel).
2. Follow the device-code prompt in the browser to authorize IssueTriage.
3. Return to VS Code—once the worker confirms the authorization, the Issue Triage views will populate with your repositories.

### 2. Configure LLM access (once per developer)

IssueTriage can call OpenRouter directly (**local** mode) or forward requests through the hosted IssueTriage Cloudflare Worker (**remote** mode). Remote mode is now the default.

1. Confirm your desired mode via `ISSUETRIAGE_LLM_MODE` (or **Settings → Extensions → IssueTriage → Assessment: Llm Mode**). Leave it unset for the default **remote** flow.
2. In **remote mode**:
  - Optionally override the worker endpoint by setting `ISSUETRIAGE_LLM_REMOTE_URL` (or **Assessment: Remote Endpoint**); the default points to the hosted worker.
  - No OpenRouter key is required locally because the worker holds it as a secret.
3. In **local mode**:
  - Sign up at [OpenRouter](https://openrouter.ai/) and create an API key.
  - Provide the key via one of the following:
    - Add `ISSUETRIAGE_OPENROUTER_API_KEY=your_api_key` to `.env` (preferred for local development).
    - Or set **Settings → Extensions → IssueTriage → Assessment: Api Key**.
4. Adjust model selections if desired:
  - `issuetriage.assessment.preferredModel` (default `openai/gpt-5-mini`).
  - Toggle premium mode with `issuetriage.assessment.usePremiumModel` to use `issuetriage.assessment.premiumModel`.
5. Reload VS Code after changing environment variables.

### 2a. (Optional) Enable UsageTap logging

IssueTriage can record LLM usage events to [UsageTap](https://usagetap.com/) when you supply the dedicated client API key:

1. Set `ISSUETRIAGE_USAGETAP_KEY` (or **Settings → Extensions → IssueTriage → Telemetry: UsageTap Key**) to the call-logging key provisioned for VS Code clients.
2. The service defaults to `https://api.usagetap.com`; override with `ISSUETRIAGE_USAGETAP_BASE_URL` (or **Telemetry: UsageTap Base Url**) if you are targeting a staging endpoint.
3. UsageTap instrumentation respects the existing `issuetriage.telemetry.enabled` opt-in. Leave the extension setting off if you prefer to disable all telemetry.
4. Turn on **Telemetry: UsageTap Debug** (or set `ISSUETRIAGE_USAGETAP_DEBUG=1`) to stream verbose integration logs to the *IssueTriage UsageTap* output channel while troubleshooting.

> **Automation Launch Guard**: Keep `issuetriage.automation.launchEnabled` at its default `false` while automation workflows are still in development. Enable it only when the downstream automation adapter is configured.

### 3. Open the Issue Triage panel

1. Click the **Issue Triage** icon in the Activity Bar (left sidebar) to see a quick list of issues, or press `F1` / `Ctrl+Shift+P` and run **Issue Triage: Open Panel** to open the full webview *(alternatively click the Issue Triage status bar button).* Use the repository drop-down at the top of the sidebar to change contexts at any time.
2. Use **Connect GitHub** if prompted to complete the device-code flow (copy the displayed code, follow the browser prompt, and authorize the app).

### 4. Explore your backlog

1. Pick a repository from the dropdown (default respects `issuetriage.github.defaultRepository` if configured).
2. Search titles or apply label/assignee/milestone filters to focus on candidates.
3. Click an issue card to load its latest assessment in the panel (double-click to open on GitHub).
4. Use **Refresh** to pull the latest data or **Issue Triage: Refresh Issues** from the command palette.

### 5. Run AI assessments

1. Filter to the issue you want to evaluate.
2. Run **Issue Triage: Assess Selected Issue** and pick the issue from the quick pick list.
3. The extension will call OpenRouter, write the result to a local SQLite database, and (if `issuetriage.assessment.publishComments` is true) upsert a single comment on the GitHub issue tagged with `<!-- IssueTriage Assessment -->`.
4. Composite and dimension scores, a summary, and recommendations now appear in both the panel and the optional GitHub comment for the team to review.

### Optional: Tune risk analysis

1. Adjust `issuetriage.risk.lookbackDays` (default 180) to widen or narrow the historical window that drives risk intelligence.
2. Use `issuetriage.risk.labelFilters` to restrict hydration to issues carrying specific labels (helpful when triage leads focus on certain workstreams).
3. Risk badges and the Risk Intelligence panel will refresh automatically the next time you load or refresh issues.

### 6. Run workspace context tools

1. Run **Issue Triage: Run Context Tool** and pick the built-in **Workspace Snapshot** or a custom tool you've registered under `issuetriage.cliTools`.
2. Review command output in the *IssueTriage CLI Context* output channel; the latest successful runs are automatically attached to future assessments.
3. Add additional tools by updating the `issuetriage.cliTools` setting with objects that specify an `id`, `command`, optional `args`, and whether they should `autoRun` before each assessment.

### 7. Manage sessions

- Run **Issue Triage: Sign Out** to revoke local tokens (secrets are stored via VS Code SecretStorage).
- Re-run **Connect GitHub** any time you rotate OAuth credentials or need to change accounts.

### 8. Machine Learning Training (MVP)

IssueTriage includes an MVP implementation of historical risk learning using keyword-based similarity search. Access the **ML Training** tab in the Issue Triage panel to manage keyword extraction and dataset export.

#### Keyword Extraction
- When risk analysis runs on closed issues, IssueTriage automatically extracts 5-8 keywords representing:
  - Components/subsystems (e.g., "authentication", "database", "ui")
  - Change types (e.g., "refactor", "bugfix", "feature", "migration")
  - Risk signals (e.g., "breaking-change", "security", "performance")
- Keywords are stored in the local SQLite database and indexed using FTS5 for fast searching.

#### Using the ML Training Tab
1. Open the Issue Triage panel and click the **ML Training** tab.
2. View real-time **Keyword Coverage** statistics showing:
   - Total closed issues in the selected repository
   - Issues with extracted keywords
   - Coverage percentage (target: 95%+)
3. Click **Backfill Keywords** to extract keywords for closed issues that don't have them yet:
   - Progress bar shows current issue and completion percentage
   - Token usage is monitored (200k token daily budget by default)
   - Click **Cancel** to stop the process (resumes from checkpoint)
4. Click **Export Training Dataset** to validate and prepare the dataset for ML training:
   - Validates keyword coverage meets minimum threshold (95%)
   - Verifies sufficient historical data
   - Generates manifest with export metadata
5. View **Last Export** information including timestamp and record counts.

#### Command Palette Alternative
- **Issue Triage: Backfill Keywords** - Start keyword extraction from command palette
- **Issue Triage: Export Training Dataset** - Export dataset from command palette

#### Similarity Search
- Keywords enable fast similarity matching using:
  - FTS5 full-text search for initial candidate retrieval
  - Jaccard similarity re-ranking for precision
  - Shared keywords and labels boost relevance
- Similarity results show keyword overlap percentage and shared risk signals.

#### Future Enhancements
See `plans/feature-risk-learning-semantic.md` for planned semantic search with embeddings and hybrid retrieval.

## Requirements

- Visual Studio Code 1.105.0 or later.
- Ability to register a GitHub OAuth App (personal or organization).
- Network access to `github.com` for API calls.

## Release Notes

### 0.0.1

- Initial release with GitHub integration (device-code auth, repo + issue browsing, filterable backlog) and the readiness checklist scaffold.
- Added OpenRouter-powered assessments with local SQLite history and single-comment GitHub publishing.

---

## Troubleshooting

- **"GitHub OAuth client credentials are not configured"**: Ensure `.env` or settings contain valid client ID/secret and reload VS Code.
- **Device-code flow stalls**: Confirm the OAuth app allows the account you’re using and that the verification URL isn’t blocked by network policy.
- **Rate limits**: The UI surfaces warnings when GitHub rate limits are hit; retry later or reduce refresh frequency.

---

Let us know how IssueTriage can better support your triage process!
