# Feature Plan: Historical Risk Learning

## Goal
Enable IssueTriage to forecast risk metrics for new issues or pull requests by learning from historical repository activity and feeding those insights into the assessment workflow.

## MVP Implementation Decisions (Finalized)

**Data & Storage:**
- Use the connected repository's local SQLite cache as the primary data source
- Export to co-located SQLite bundle for training (schema defined below)
- Implement in TypeScript within `src/services/` and export scripts in `scripts/`

**Similarity Search (MVP):**
- Extract 5-8 salient keywords during risk assessment (no separate API call)
- Store keywords in `risk_intelligence_snapshots.keywords` as JSON array
- Use SQLite FTS5 for keyword matching + Jaccard similarity for ranking
- Display top-5 matches with keyword overlap % and shared labels
- *Post-MVP*: add semantic embeddings (OpenAI text-embedding-3) for deeper similarity

**Model Training:**
- Manual training workflow triggered via "ML Training" tab → `Train now` button
- Start with baseline heuristics (historical averages by label/component)
- Package trained models as local ONNX artifacts alongside the extension
- Defer automated retraining and server-side aggregation to post-MVP

**API & Quotas:**
- Daily token budget: 200k tokens (configurable via settings)
- Batch size: 50 summaries per export run
- Warning threshold: 80% of daily budget
- Rate limiting: 50ms jittered delays, exponential backoff on 429/5xx (3 retries max)

**Integration:**
- `SimilarityService` returns top-5 matches with keyword Jaccard scores + label overlap
- `PredictedRiskService` outputs: `{riskLevel, riskScore, confidence, drivers[], similarIssues[]}`
- Surface predictions in IssueTriage panel with keyword overlap explanation
- Feed top-3 similar issues into assessment prompts as historical context
- Keywords serve as categorical features for ML training (change size, complexity predictors)

**Acceptance Criteria:**
- Export <5 minutes for 500 closed issues
- Validation rejects if >5% missing risk snapshots or keywords
- Every closed issue has 5-8 extracted keywords for similarity matching
- Manifest persists with schema version, token usage, keyword coverage, and validation report

## Target Outcomes
- Predict likelihood of high, medium, or low risk for a new triage item before linked work exists.
- Generate estimated drivers (e.g., expected change volume, review friction) to seed readiness guidance.
- Surface similar historical issues/PRs to provide reviewers with evidence for the prediction.

## Keyword-Based Similarity (MVP)

**Goal**: Quickly identify similar historical work using lightweight keyword matching to answer "Has this been successfully automated before?"

**Extraction at Risk Assessment:**
- When `RiskIntelligenceService` analyzes a closed issue, append keyword extraction to the same LLM call (adds ~20 tokens)
- Extract 5-8 keywords representing:
  - **Components**: subsystems touched (e.g., "authentication", "database", "UI")
  - **Change type**: nature of work (e.g., "refactor", "bugfix", "feature", "migration")
  - **Risk signals**: notable characteristics (e.g., "breaking-change", "security", "performance", "dependencies")
- Store in `risk_intelligence_snapshots.keywords` as JSON array: `["auth", "middleware", "refactor", "security", "breaking-change"]`
- Display keywords in the risk intelligence comment for human review

**Keyword Generation Prompt (appended to risk analysis):**
```
Extract 5-8 concise keywords representing components, change type, and risk signals.
Format: Keywords: <comma-separated lowercase tokens>
Example: Keywords: authentication, middleware, refactor, security, breaking-change
```

**Similarity Matching:**
- **Primary**: SQLite FTS5 full-text search on `keywords` column
  - Query: `SELECT issue_id, keywords, risk_level, rank FROM risk_intelligence_snapshots WHERE keywords MATCH 'auth AND refactor' ORDER BY rank LIMIT 10`
- **Re-ranking**: Jaccard similarity on keyword sets
  - Score = |keywords_A ∩ keywords_B| / |keywords_A ∪ keywords_B|
  - Boost matches sharing GitHub labels or same risk level bracket (Low/Medium/High)
- **Output**: Top-5 matches with keyword overlap % and shared labels displayed in UI

**Benefits:**
- **Fast**: Pure SQL, no embedding API calls, sub-second queries
- **Explainable**: Users see exactly why matches surfaced ("Both involved: auth, middleware, refactor")
- **Cheap**: Keyword extraction piggybacks existing risk assessment (~20 tokens per issue)
- **Incremental**: Foundation for semantic search later without schema changes

**Post-MVP Enhancement:**
- Add semantic embeddings for title/body to catch conceptual similarity beyond exact keyword matches
- Blend keyword Jaccard + cosine similarity for hybrid ranking

## Data Requirements
- **Source repositories**: choose one or more public repos with rich history (e.g., `microsoft/vscode`, `numpy/numpy`).
- **Data types**:
  - Issue metadata: titles, bodies, labels, milestones, timestamps, author.
  - Linked PR data: churn metrics, review state counts, merge outcomes, time-to-merge.
  - Post-merge signals: subsequent bug reports, reverts, security advisories (optional but valuable).
  - Assessment + risk records generated by IssueTriage once instrumentation exists.
- Similarity captures: likeness summaries, embedding vectors, structured fingerprints saved when issues close or PRs merge.
- **Collection tooling**: extend `GitHubClient` or create scripts to export historical snapshots, respecting rate limits and caching.
- **Storage**: structured dataset (Parquet/SQLite/Postgres) with normalized tables for issues, PRs, risk outcomes, derived features, plus a similarity index table storing vectors and metadata for retrieval.

## Existing Risk Intelligence Signals
- **Risk intelligence comment**: each closed issue captures `riskLevel` (e.g., Low), `riskScore` (e.g., 15), and the `lastUpdated` timestamp from the risk engine. We store each comment in the local SQLite cache and will standardize the markdown block with a dedicated header tag (e.g., `<!-- risk-intelligence -->`) so exports can target the most recent instance unambiguously.
- **Operational metrics**: parsed from the same comment block and include `linkedCommits`, `filesTouched`, `linesChanged`, and `reviewFrictionSignals` (currently integer counts). These metrics become typed columns in the dataset for model consumption without secondary parsing.
- **Composite model assessment**: initial assessment comment contains `compositeScore` (e.g., 62.5), per-dimension scores (`requirements`, `complexity`, `security`, `business`), the `modelId` (e.g., openai/gpt-5-mini), and `runTimestamp`. The block will use a matching tag (e.g., `<!-- assessment-intelligence -->`) and the exporter selects the latest occurrence.
- **Qualitative guidance**: textual summary (e.g., "Add missing context then reassess."), model provenance statement, and structured question prompts. We retain the raw summary as a `TEXT` column and expose a `summary_embedding` vector in the embeddings table for similarity retrieval.
- **Issue context**: canonical issue title, number, author, milestone, labels, and comment stream provide additional supervised signals and retrieval evidence; comments unrelated to our tagged blocks remain available to the similarity engine.

## Comment Tagging Specification
- **Goals**: keep comments visually friendly while giving exporters deterministic anchors; tags should survive manual edits and support versioning.
- **Wrapper syntax**: each machine-readable block is enclosed by paired HTML comments with required attributes:
   - Risk comment wrapper: `<!-- risk-intel:start version=1 -->` ... `<!-- risk-intel:end -->`
   - Assessment comment wrapper: `<!-- assessment-intel:start version=1 -->` ... `<!-- assessment-intel:end -->`
- **Display payload**: inside the wrapper, keep human-readable headings and bullet lists so reviewers can skim without tooling. Example:

```markdown
<!-- risk-intel:start version=1 issued-at="2025-10-19T20:25:33Z" source="IssueTriage" -->
Risk Intelligence
Low risk · Score 15

Last updated 10/19/2025, 8:25:33 PM

Key metrics
- 1 linked commits
- 3 files touched
- 15 lines changed
- 0 review friction signals

<!-- risk-intel:data
{
   "riskLevel": "Low",
   "riskScore": 15,
   "linkedCommits": 1,
   "filesTouched": 3,
   "linesChanged": 15,
   "reviewFrictionSignals": 0,
   "analysisId": "abc123",
   "keywords": ["feature", "ui", "refactor", "low-churn"]
}
-->
<!-- risk-intel:end -->
```

- **Embedded data node**: the `<!-- risk-intel:data ... -->` tag holds canonical JSON for exporters. Renderers ignore it while parsers read the JSON payload. The wrapper attributes provide quick filters (versioning, timestamps, emit source).
- **Assessment block**: follow the same pattern with fields tailored to composite scoring:

```markdown
<!-- assessment-intel:start version=1 issued-at="2025-10-19T19:51:48Z" source="IssueTriage" -->
Composite Assessment
Composite 62.5 · Model openai/gpt-5-mini

Dimensions
- Requirements: 60.0
- Complexity: 80.0
- Security: 45.0
- Business: 65.0

Summary
Add missing context then reassess.

<!-- assessment-intel:data
{
   "compositeScore": 62.5,
   "modelId": "openai/gpt-5-mini",
   "dimensions": {
      "requirements": 60.0,
      "complexity": 80.0,
      "security": 45.0,
      "business": 65.0
   },
   "summary": "Add missing context then reassess.",
   "analysisRunId": "run-20251019-195148"
}
-->
<!-- assessment-intel:end -->
```

- **Multiple runs**: when updates occur, append a fresh tagged block to the issue comments. The exporter selects the latest `version` and `issued-at` instance, while older blocks remain for audit history.
- **Error handling**: if the JSON subtag is malformed, the exporter falls back to cache data and logs a warning so operators can fix the comment manually.

## Likeness Summary & Similarity Strategy
- **Objective**: encode each closed issue into a concise, semantically rich summary that drives LLM embeddings and human review of related work.
- **Authoring**: generate the likeness summary with an LLM prompt that incorporates change metadata (labels, touched files, churn metrics) and risk outcomes. Anchor the prompt to a strict template to keep outputs consistent.
- **Recommended template**: 2–3 sentences covering problem statement, implementation touchpoints, and notable risk/complexity signals, followed by a bullet list of key keywords. Example prompt sketch:

```
Summarize the closed issue for historical risk learning.
Include:
1. Intent (component + change objective).
2. Implementation footprint (files or subsystems, approx change size).
3. Notable risk drivers (dependencies, security surfaces, coordination).
End with a line 'Keywords: <comma-separated tokens>'. Max 120 tokens.
```

- **Locked prompts**:
   - *Summary generation prompt* (system):

      ```
      You are IssueTriage, producing likeness summaries for closed GitHub issues. Respond in English.
      Output two short sentences (<=120 tokens total) describing intent, implementation footprint, and risk drivers.
      End with a line exactly formatted as 'Keywords: <comma-separated tokens>'.
      Use present-perfect phrasing ("Updated", "Refactored") and avoid markdown headings.
      ```

   - *Summary generation prompt* (user template):

      ```
      Issue title: {title}
      Labels: {labels_csv}
      Files touched: {files_csv}
      Lines changed: {lines_changed}
      Linked commits: {linked_commits}
      Risk level: {risk_level}
      Risk score: {risk_score}
      Description:
      {body_excerpt}
      ```

   - *Similarity justification prompt* (system):

      ```
      You explain why two historical issues are similar for risk assessment. Respond with one sentence <=60 tokens, referencing concrete overlaps.
      ```

   - *Similarity justification prompt* (user template):

      ```
      Candidate issue summary: {candidate_summary}
      Query issue summary: {query_summary}
      Shared attributes: Labels[{shared_labels_csv}] Files[{shared_files_csv}]
      ```

- **Embedding pipeline**:
   - Run the LLM locally or via API to produce the likeness summary when an issue closes or during the export batch.
   - Feed the summary text into a sentence embedding model (OpenAI text-embedding-3, Azure embed, or open-source alternative) and store the resulting vector in the `embeddings` table with `source='likeness_summary'`.
- **Similarity scoring**:
   - Primary score: cosine similarity between summary embeddings.
   - Signal blend: linearly combine the cosine score with structured overlaps (label Jaccard, shared file hotspots, delta in risk levels) to avoid purely semantic matches.
   - Re-ranking: for the top-k cosine matches, ask a lightweight LLM prompt to justify similarity, producing an evidence snippet for the UI (e.g., "Both touched auth middleware and involved large refactors").
- **Inference flow**:
   1. For a new issue, create a provisional likeness summary using available metadata + user description.
   2. Compute embedding and query the ANN index (Faiss/SQLite FTS + vector extension).
   3. Return top-k candidates with blended scores and optional LLM-generated rationales.
   4. Cache results and update as additional context (linked PRs, telemetry) arrives.

- **API guardrails**:
   - Default to batching likeness summaries during manual export runs to minimize per-issue request overhead (e.g., 50 summaries per run).
   - Enforce a daily token budget (e.g., 200k tokens) configurable via settings; surface warnings in the UI when usage approaches 80%.
   - Cache generated summaries and justifications in SQLite with `analysis_run_id` to avoid repeat calls.
   - Provide a "dry run" mode to estimate token spend without calling the LLM, using average tokens per prompt (summary ≈ 300 input, 70 output; justification ≈ 200 input, 40 output).
   - Respect API rate limits by inserting jittered delays between requests (default 50 ms) and retrying with exponential backoff on 429/5xx responses up to 3 attempts.

## Semantic Search (Post-MVP)
**Deferred to later release** to unblock MVP deployment with keyword-based similarity. When keyword matching proves insufficient:

- **Embedding providers**:
   - Use OpenAI `text-embedding-3-large` (1536 dimensions) for batch training exports
   - Use OpenAI `text-embedding-3-small` (512 dimensions) for real-time similarity queries
   - *Fallback*: Hugging Face sentence transformers (`all-mpnet-base-v2`) for offline mode
   - *Future*: fine-tune embeddings on labeled similarity pairs, package via ONNX for self-hosting

- **Vector storage**:
   - Deploy `sqlite-vss` extension for ANN search with fallback to brute-force cosine when <200 vectors
   - Store embeddings for `title`, `body`, and `likeness_summary` in the existing `embeddings` table
   - Batch index updates in 200-row chunks, vacuum once per export

- **Hybrid retrieval**:
   - Blend keyword FTS5 results with cosine similarity scores (weighted average or reciprocal rank fusion)
   - Use keywords to seed candidates, then rerank top-20 via embeddings for precision
   - Normalize titles (lowercase, strip prefixes) and run FTS on titles + comment excerpts before vector search

## Historical Dataset Schema
- **Storage target**: single SQLite bundle co-located with the extension for MVP training runs, with Parquet export hooks for future server-side scaling.
- **Import contract**: exporter normalizes comment-derived metrics into typed columns so downstream ML jobs avoid brittle parsing logic.

| Table | Key Fields | Description |
| --- | --- | --- |
| `issues` | `issue_id` (PK), `repo_slug`, `number`, `title`, `body`, `state`, `author`, `created_at`, `closed_at`, `milestone_id`, `labels` (array/json) | Canonical issue record and categorical features.
| `risk_intelligence_snapshots` | `snapshot_id` (PK), `issue_id` (FK), `risk_level`, `risk_score`, `last_updated`, `linked_commits`, `files_touched`, `lines_changed`, `review_friction_signals`, `keywords` (JSON array), `comment_tag` | Structured view of the "Risk Intelligence" comment payload captured at close with tag provenance and extracted keywords for similarity matching.
| `analysis_scores` | `analysis_id` (PK), `issue_id` (FK), `composite_score`, `requirements_score`, `complexity_score`, `security_score`, `business_score`, `model_id`, `model_run_timestamp`, `analysis_summary`, `comment_tag` | Quantitative and textual outputs from the initial assessment block with tag provenance.
| `activity_metrics` | `issue_id` (PK/FK), `linked_pr_ids`, `time_to_first_response`, `cycle_time`, `comment_count`, `assignee_count`, `hot_file_score` | Aggregated behavioral signals computed during export.
| `comments` | `comment_id` (PK), `issue_id` (FK), `author`, `created_at`, `body`, `is_system_generated` | Free-form context for similarity search and qualitative supervision.
| `embeddings` | `embedding_id` (PK), `issue_id` (FK), `source` (`title`/`body`/`likeness_summary`), `vector`, `model`, `created_at` | Semantic vectors aligned with similarity retrieval strategy.

- **Derived views**: materialize `issue_risk_training_view` joining the above tables and flattening categorical features into model-ready columns. Labels and linked PR IDs stay as JSON arrays to preserve multi-value similarity signals, avoiding extraneous audit metadata.
- **Versioning**: add `export_run_id` and `source_comment_hash` columns on snapshot tables to track provenance and enable reprocessing when comment formats change; manual exports track runs through a separate manifest table.

## Import Workflow
- **Initiation**: researcher triggers a "Analyze closed issues" command inside the extension UI, which prompts the local engine to scan for closed issues lacking tagged analysis/risk comments and backfill them before export.
- **Extraction**: exporter reads from the local SQLite cache (primary data source) and, if needed, pulls additional GitHub data using the authenticated session associated with the connected repository.
- **Normalization**: parser maps extracted metrics to typed schema fields, applies defaulting for missing values, and stores numeric metrics as integers/floats for ML readiness.
- **Validation**: run contracts that confirm counts (e.g., `risk_score` within 0-100, `linked_commits` >= 0) and emit anomalies for manual review.
- **Serialization**: batch writes normalized rows into the local SQLite dataset and emits a manifest containing schema version, export timestamp, record counts, and `export_run_id`.
- **Loading**: ML experiments consume the SQLite file directly for MVP; future pipelines may mirror to Parquet/postgres but the local file remains the authoritative source during manual training cycles.

- **Exporter acceptance criteria**:
   - Manifest schema includes: `export_run_id`, `repo_slug`, `issues_exported`, `snapshots_exported`, `analysis_exported`, `export_started_at`, `export_completed_at`, `schema_version`, `embedding_model`, `token_usage_summary`.
   - Validation thresholds: reject export if >5% of closed issues lack risk snapshots, or if any numeric metric falls outside expected bounds (`risk_score` 0-100, `lines_changed` >=0, `linked_commits` >=0). Provide warning-only for 1-5% gaps.
   - Integrity checks: ensure every row in `risk_intelligence_snapshots` has a matching `analysis_scores` entry (within the same export) unless explicitly flagged `analysis_missing=true`.
   - Verify embeddings count equals number of issues in manifest for sources `title`, `body`, and `likeness_summary`; log discrepancies.
   - Persist validation report with summary counts and error list in manifest directory for audit.

## Operational Scope
- **Repository coverage**: MVP targets the user-selected repository connected through the extension; the export runs on demand rather than on a fixed schedule.
- **Access model**: leverage the existing local SQLite engine and authenticated GitHub client to request batch analyses for any closed issues missing the standardized comment blocks.
- **Refresh cadence**: training remains a manual process for now; operators trigger exports and subsequent model retraining as needed until an automated cadence is justified.
- **Scalability plan**: design schema and manifest format to support eventual migration to a server-side store (e.g., Postgres) once dataset size or multi-repo aggregation requires it, without blocking the local inference prototype.

## UI Additions (ML Training Tab)
- **Navigation**: add an "ML Training" tab to the IssueTriage panel alongside existing assessment views.
- **Primary actions**:
  - `Backfill Keywords` button: scans closed issues missing keywords, extracts them via batch LLM calls, updates risk intelligence comments and cache
  - `Train Now` button: executes the export pipeline and, upon success, kicks off local model training/inference rebuild
- **Secondary info**: show last export timestamp, issues processed (with/without keywords), most recent token usage summary, and keyword coverage percentage; disable buttons with tooltips when no work remains.
- **Progress feedback**: display step-by-step status (Backfill Keywords → Validate → Export → Train) with spinner, turning each step to a checkmark on completion; surface warnings inline with links to the validation report.
- **Post-run**: provide quick links to the generated manifest, keyword coverage report, and allow user to test similarity search against the trained index within the tab.

## Feature Engineering
- **Keyword features**: one-hot encode extracted keywords as categorical predictors for change size, complexity, and risk level (e.g., "refactor" correlates with higher churn, "security" with longer review cycles)
- **Numeric aggregates**: historical churn averages per label/component, team cadence, time-based trend features
- **Graph features**: author collaboration networks, file hot-spots, PR dependency counts
- **Labels for supervised learning**: existing `riskLevel`, `riskScore`, binary outcomes (e.g., high-risk vs non-high-risk)
- *Post-MVP*: text embeddings from issue titles/bodies for semantic features

## Modeling Strategy
1. **Baseline Heuristics**
   - Rule-based scoring using historical averages per label/component.
   - Serves as benchmark and fallback.
2. **Classical ML**
   - Train gradient boosting or random forest classifiers/regressors on engineered features.
   - Predict risk level (classification) and risk score (regression).
   - Evaluate with cross-validation, precision/recall for high-risk, MAE for scores.
3. **LLM-Assisted**
   - Prompt LLM with structured historical context plus new issue details to obtain predicted metrics.
   - Optionally fine-tune small models (LLaMA-family) with instruction data generated from historical pairs.
   - Compare performance vs ML models; consider ensemble (LLM justification + ML probability).

## Evaluation Plan
- Split dataset by time (train on past periods, test on future intervals) to mimic real deployment.
- Metrics:
  - Classification: F1, recall on high-risk, ROC-AUC.
  - Regression: MAE / RMSE on riskScore.
  - Similarity retrieval: precision@k for finding truly related past issues.
- Baseline comparison: ensure model outperforms simple heuristics.
- Statistical significance tests when combining multiple repos.

## Integration Steps
1. **Data Pipeline**: batch exporter to populate historical dataset; schedule periodic refresh.
2. **Model Serving**: package trained model (e.g., ONNX or JSON weights) accessible from VS Code extension via local service or remote API.
3. **Extension Wiring**:
   - Add `PredictedRiskService` to request predictions when issue loads.
   - Merge outputs with existing `RiskIntelligenceService` summaries.
   - Display confidence, key drivers, and similar past items in the IssueTriage panel.
   - Integrate `SimilarityService` to return top-k matches from precomputed embeddings/fingerprints for UI and prompt augmentation.
4. **Prompt Augmentation**: feed predicted metrics and retrieved historical snippets into the assessment payload for OpenRouter.

## Testing Strategy
- Offline unit tests for feature extractors and data loaders.
- Regression tests validating model predictions against a frozen evaluation set.
- Integration tests simulating extension calls against a mock service.
- Manual validation using selected public repo issues to check qualitative usefulness.

### MVP Test Plan
- **Unit tests**
   - Exporter parsers convert tagged comments and SQLite cache rows into schema-compliant DTOs (cover missing field defaults and malformed JSON handling).
   - Manifest builder enforces required fields and fails when validation thresholds are exceeded.
   - Likeness summary prompt wrapper ensures output matches keyword line regex and token limit logic.
   - Embedding pipeline stubs produce deterministic vectors and raise errors if required sources absent.
- **Integration tests**
   - End-to-end export run using a fixture repository snapshot (seed SQLite + mock GitHub) yields manifest, snapshot tables, and embeddings with counts matching expectations.
   - Similarity query against the sqlite-vss index returns blended results, including fallback path when vector extension is disabled.
   - `Train now` command publishes progress events and final status to the UI mock.
- **Manual validation**
   - Run the ML Training tab against a known repo (e.g., sample dataset) and confirm comment tagging, manifest output, and similarity results align with expectations.
   - Inspect validation report warnings, retry with intentionally missing embeddings, and verify fallback behavior.
   - Smoke test API quotas by triggering consecutive exports until hitting 80% budget warning.
- **Performance spot-check**
   - Measure export runtime on ~500 closed issues, ensuring end-to-end process completes within the target (e.g., <5 minutes) and document observed token consumption.

## Tooling & Infrastructure
- Python or TypeScript data pipeline (consider `scripts/` folder) leveraging GitHub REST/GraphQL.
- ML stack: scikit-learn/lightGBM for classical models, Hugging Face transformers or Azure OpenAI for embeddings/LLM prompts.
- Experiment tracking (MLflow, Weights & Biases) to log runs and metrics.
- Versioned model artifacts stored in storage bucket or repository releases.

## Risks & Mitigations
- **Sparse labeled data**: bootstrap with heuristic labels, progressively replace with real assessment outcomes.
- **API limits**: implement caching/backoff, consider GitHub Archival datasets (GH Archive, BigQuery).
- **Model drift**: schedule retraining; monitor telemetry from live predictions.
- **Privacy**: ensure no sensitive repository data stored without consent; default to public repos for initial models.

## Timeline (High-Level)
1. **Weeks 1-2**: Data audit, repository selection, pipeline scaffold.
2. **Weeks 3-5**: Feature engineering, baseline heuristics, initial ML model.
3. **Weeks 6-8**: LLM prompt experiments, similarity retrieval integration.
4. **Weeks 9-10**: Extension integration prototype, UI surfacing, offline evaluation suite.
5. **Week 11+**: Feedback loop, telemetry instrumentation, incremental deployment.

## Next Actions
- Confirm pilot repository list and secure API tokens.
- Define schema for historical dataset and implement initial export script.
- Choose experiment tracking approach and spin up environment (local or cloud notebook).
- Draft specification for `PredictedRiskService` interface inside the extension.
- Design likeness summary generator and similarity index schema; prototype offline ANN lookup against exported data.
