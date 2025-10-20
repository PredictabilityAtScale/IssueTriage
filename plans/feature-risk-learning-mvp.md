# Feature Plan: Historical Risk Learning (MVP)

## Goal
Enable IssueTriage to quickly identify similar historical work using keyword-based similarity to answer "Has this been successfully automated before?" and build a foundation for risk prediction models.

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

**Model Training:**
- Manual training workflow triggered via "ML Training" tab → `Train Now` button
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
- Quickly identify similar historical issues to answer "Has this been automated successfully before?"
- Extract keywords as categorical features for ML risk prediction
- Build training dataset foundation for future semantic search and advanced models
- Surface actionable historical context to reviewers during triage

## Keyword-Based Similarity

**Goal**: Fast, explainable, cheap similarity matching without embedding models.

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

## Existing Risk Intelligence Signals
- **Risk intelligence comment**: each closed issue captures `riskLevel` (e.g., Low), `riskScore` (e.g., 15), and the `lastUpdated` timestamp from the risk engine. We store each comment in the local SQLite cache and will standardize the markdown block with a dedicated header tag (e.g., `<!-- risk-intelligence -->`) so exports can target the most recent instance unambiguously.
- **Operational metrics**: parsed from the same comment block and include `linkedCommits`, `filesTouched`, `linesChanged`, and `reviewFrictionSignals` (currently integer counts). These metrics become typed columns in the dataset for model consumption without secondary parsing.
- **Composite model assessment**: initial assessment comment contains `compositeScore` (e.g., 62.5), per-dimension scores (`requirements`, `complexity`, `security`, `business`), the `modelId` (e.g., openai/gpt-5-mini), and `runTimestamp`. The block will use a matching tag (e.g., `<!-- assessment-intelligence -->`) and the exporter selects the latest occurrence.
- **Keywords**: extracted 5-8 tokens representing components, change types, and risk signals; displayed in comment and stored for similarity matching.
- **Issue context**: canonical issue title, number, author, milestone, labels, and comment stream provide additional supervised signals and retrieval evidence.

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

Keywords: feature, ui, refactor, low-churn

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
- **Multiple runs**: when updates occur, append a fresh tagged block to the issue comments. The exporter selects the latest `version` and `issued-at` instance, while older blocks remain for audit history.
- **Error handling**: if the JSON subtag is malformed, the exporter falls back to cache data and logs a warning so operators can fix the comment manually.

## Historical Dataset Schema
- **Storage target**: single SQLite bundle co-located with the extension for MVP training runs, with Parquet export hooks for future server-side scaling.
- **Import contract**: exporter normalizes comment-derived metrics into typed columns so downstream ML jobs avoid brittle parsing logic.

| Table | Key Fields | Description |
| --- | --- | --- |
| `issues` | `issue_id` (PK), `repo_slug`, `number`, `title`, `body`, `state`, `author`, `created_at`, `closed_at`, `milestone_id`, `labels` (array/json) | Canonical issue record and categorical features.
| `risk_intelligence_snapshots` | `snapshot_id` (PK), `issue_id` (FK), `risk_level`, `risk_score`, `last_updated`, `linked_commits`, `files_touched`, `lines_changed`, `review_friction_signals`, `keywords` (JSON array), `comment_tag` | Structured view of the "Risk Intelligence" comment payload captured at close with tag provenance and extracted keywords for similarity matching.
| `analysis_scores` | `analysis_id` (PK), `issue_id` (FK), `composite_score`, `requirements_score`, `complexity_score`, `security_score`, `business_score`, `model_id`, `model_run_timestamp`, `analysis_summary`, `comment_tag` | Quantitative and textual outputs from the initial assessment block with tag provenance.
| `activity_metrics` | `issue_id` (PK/FK), `linked_pr_ids`, `time_to_first_response`, `cycle_time`, `comment_count`, `assignee_count`, `hot_file_score` | Aggregated behavioral signals computed during export.
| `comments` | `comment_id` (PK), `issue_id` (FK), `author`, `created_at`, `body`, `is_system_generated` | Free-form context for qualitative supervision.

- **FTS5 virtual table**: `CREATE VIRTUAL TABLE keywords_fts USING fts5(issue_id, keywords, content=risk_intelligence_snapshots)` for fast keyword search
- **Derived views**: materialize `issue_risk_training_view` joining the above tables and flattening categorical features into model-ready columns. Keywords and labels stay as JSON arrays to preserve multi-value signals.
- **Versioning**: add `export_run_id` and `source_comment_hash` columns on snapshot tables to track provenance and enable reprocessing when comment formats change; manual exports track runs through a separate manifest table.

## Import Workflow
- **Initiation**: researcher triggers ML Training tab actions:
  - `Backfill Keywords`: scans closed issues missing keywords, extracts them via batch LLM calls, updates risk intelligence comments and cache
  - `Train Now`: runs export pipeline after keyword backfill completes
- **Extraction**: exporter reads from the local SQLite cache (primary data source) and, if needed, pulls additional GitHub data using the authenticated session associated with the connected repository.
- **Normalization**: parser maps extracted metrics to typed schema fields, applies defaulting for missing values, and stores numeric metrics as integers/floats for ML readiness.
- **Validation**: run contracts that confirm counts (e.g., `risk_score` within 0-100, `linked_commits` >= 0, keyword count 5-8) and emit anomalies for manual review.
- **Serialization**: batch writes normalized rows into the local SQLite dataset, creates/updates FTS5 index, and emits a manifest containing schema version, export timestamp, record counts, keyword coverage, and `export_run_id`.
- **Loading**: ML experiments consume the SQLite file directly for MVP; future pipelines may mirror to Parquet/postgres but the local file remains the authoritative source during manual training cycles.

**Exporter acceptance criteria:**
- Manifest schema includes: `export_run_id`, `repo_slug`, `issues_exported`, `snapshots_exported`, `keyword_coverage_pct`, `export_started_at`, `export_completed_at`, `schema_version`, `token_usage_summary`.
- Validation thresholds: reject export if >5% of closed issues lack risk snapshots or keywords, or if any numeric metric falls outside expected bounds (`risk_score` 0-100, `lines_changed` >=0, `linked_commits` >=0). Provide warning-only for 1-5% gaps.
- Integrity checks: ensure every row in `risk_intelligence_snapshots` has keywords array with 5-8 elements.
- Persist validation report with summary counts and error list in manifest directory for audit.

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

## Modeling Strategy
1. **Baseline Heuristics** (MVP Phase 1)
   - Rule-based scoring using historical averages per label/component
   - Keyword frequency analysis (e.g., "security" + "breaking-change" → higher risk)
   - Serves as benchmark and fallback
2. **Classical ML** (MVP Phase 2)
   - Train gradient boosting or random forest classifiers/regressors on engineered features including one-hot keyword vectors
   - Predict risk level (classification) and risk score (regression)
   - Evaluate with cross-validation, precision/recall for high-risk, MAE for scores
3. **LLM-Assisted** (Optional MVP Enhancement)
   - Prompt LLM with structured historical context (including top-3 similar issues by keywords) plus new issue details to obtain predicted metrics
   - Compare performance vs ML models

## Evaluation Plan
- Split dataset by time (train on past periods, test on future intervals) to mimic real deployment.
- Metrics:
  - Classification: F1, recall on high-risk, ROC-AUC
  - Regression: MAE / RMSE on riskScore
  - Similarity retrieval: precision@k for finding truly related past issues using keyword overlap as ground truth
- Baseline comparison: ensure model outperforms simple heuristics
- Manual review: sample 20 similarity results and validate keyword explanations make sense

## Integration Steps
1. **Keyword Extraction**: modify `RiskIntelligenceService` to append keyword extraction prompt and parse output
2. **Comment Storage**: update comment tagging to include keywords in both human-readable and JSON sections
3. **Cache Schema**: add `keywords` column to local SQLite cache table
4. **Backfill Service**: implement batch keyword extraction for existing closed issues
5. **Export Pipeline**: build exporter that creates FTS5 index and normalized training dataset
6. **Similarity Service**: implement `SimilarityService.findSimilar(keywords[], limit)` using FTS5 + Jaccard
7. **UI Wiring**: add ML Training tab with backfill and train buttons, progress tracking, and similarity search tester
8. **Model Training**: train baseline heuristics on exported dataset, package as ONNX
9. **Prediction Service**: implement `PredictedRiskService` that loads ONNX model and calls `SimilarityService`
10. **UI Display**: surface predictions and similar issues in IssueTriage panel

## Testing Strategy

### MVP Test Plan
- **Unit tests**
   - Keyword extraction prompt wrapper ensures output matches expected format and count (5-8 tokens)
   - FTS5 query builder generates valid SQLite queries for keyword combinations
   - Jaccard similarity calculator produces correct overlap scores
   - Manifest builder enforces required fields and fails when validation thresholds are exceeded
- **Integration tests**
   - End-to-end backfill run extracts keywords for 10 test issues and updates cache
   - Export run creates FTS5 index, validates keyword coverage, and produces manifest
   - Similarity query returns ranked results with keyword overlap explanations
   - `Train Now` command publishes progress events and final status to the UI mock
- **Manual validation**
   - Run backfill on sample closed issues and inspect keyword quality
   - Test similarity search against known related issues and verify top matches make sense
   - Inspect validation report warnings and keyword coverage statistics
   - Smoke test API quotas by triggering consecutive backfills until hitting 80% budget warning
- **Performance spot-check**
   - Measure backfill runtime on 100 closed issues (target <2 minutes)
   - Measure export + FTS5 build on 500 issues (target <5 minutes)
   - Measure similarity query latency (target <100ms for top-5 results)

## Tooling & Infrastructure
- TypeScript implementation in `src/services/` for keyword extraction, backfill, export, and similarity
- Export scripts in `scripts/` leveraging GitHub REST/GraphQL for additional data
- SQLite FTS5 for keyword indexing (built-in, no external dependencies)
- ML stack (Phase 2): scikit-learn/lightGBM for classical models, ONNX for packaging
- VS Code extension storage APIs for manifest and model artifact persistence

## Risks & Mitigations
- **Keyword quality**: keywords may be too generic or miss domain-specific terms → manual review sample + iterative prompt tuning
- **Sparse keyword overlap**: some issues may have unique keywords with no matches → fall back to label similarity, display "No similar issues found"
- **API limits**: backfill on large repos may hit token quotas → implement resumable backfill with progress tracking
- **FTS5 query syntax**: complex keyword combinations may produce unexpected results → provide query preview in UI before execution

## Timeline (MVP)
1. **Week 1**: Implement keyword extraction in `RiskIntelligenceService`, update comment tagging, add cache column
2. **Week 2**: Build backfill service and ML Training tab UI, test on sample issues
3. **Week 3**: Implement export pipeline with FTS5 index creation and validation
4. **Week 4**: Build `SimilarityService` with Jaccard re-ranking, wire into UI display
5. **Week 5**: Train baseline heuristics model, implement `PredictedRiskService` with ONNX
6. **Week 6**: Integration testing, manual validation, documentation, release MVP

## Next Actions
- Add keyword extraction prompt to `RiskIntelligenceService` and test output quality on 10 sample issues
- Design ML Training tab UI mockups and review with stakeholders
- Create FTS5 virtual table schema and test query patterns
- Build backfill service prototype and estimate runtime for target repository
- Document keyword extraction guidelines and common patterns for manual review
