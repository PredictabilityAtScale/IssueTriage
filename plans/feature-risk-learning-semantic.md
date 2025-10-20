# Feature Plan: Semantic Similarity Search (Post-MVP)

## Goal
Enhance IssueTriage's similarity matching with semantic embeddings to catch conceptual similarity beyond exact keyword matches, enabling deeper historical context discovery and improved risk prediction models.

## When to Deploy
Deploy semantic search when keyword-based MVP shows limitations:
- Users report missing obvious similar issues that don't share keywords
- Keyword Jaccard scores cluster too low (<0.3) to provide confident recommendations
- Teams want to search by natural language descriptions ("issues involving API rate limiting")
- Multi-repository aggregation requires cross-domain similarity without standardized keywords

## Post-MVP Enhancement Strategy
**Foundation**: MVP keyword-based similarity provides fast, explainable matching and builds the training dataset with keyword features. Semantic search layers on top without breaking changes.

**Incremental Migration**:
- Phase 1: Generate embeddings for existing dataset during idle time (batch job)
- Phase 2: Deploy hybrid retrieval (keyword FTS5 + semantic cosine) with feature flag
- Phase 3: Fine-tune embeddings on labeled similarity pairs collected from user feedback
- Phase 4: Enable multi-repository semantic aggregation

## Likeness Summary & Embedding Strategy
- **Objective**: encode each closed issue into a concise, semantically rich summary that drives LLM embeddings and human review of related work.
- **Authoring**: generate the likeness summary with an LLM prompt that incorporates change metadata (labels, touched files, churn metrics, keywords) and risk outcomes. Anchor the prompt to a strict template to keep outputs consistent.
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
      Keywords: {keywords_csv}
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
      Shared attributes: Labels[{shared_labels_csv}] Files[{shared_files_csv}] Keywords[{shared_keywords_csv}]
      ```

- **Embedding pipeline**:
   - Run the LLM to produce the likeness summary when an issue closes or during batch embedding generation.
   - Feed the summary text (or title/body/keywords) into a sentence embedding model and store the resulting vector in the `embeddings` table with `source='likeness_summary'` or `source='title'`, `source='body'`.
   - For MVP transition: generate embeddings for all existing closed issues with keywords in background batch job.

- **Similarity scoring**:
   - Primary score: cosine similarity between summary embeddings.
   - Signal blend: linearly combine the cosine score with structured overlaps (keyword Jaccard from MVP, label overlap, shared file hotspots, delta in risk levels) to avoid purely semantic matches.
   - Re-ranking: for the top-k cosine matches, ask a lightweight LLM prompt to justify similarity, producing an evidence snippet for the UI (e.g., "Both touched auth middleware and involved large refactors").

- **Inference flow**:
   1. For a new issue, create a provisional likeness summary using available metadata + user description.
   2. Compute embedding and query the ANN index (sqlite-vss or Faiss).
   3. Blend with keyword FTS5 results using reciprocal rank fusion or weighted scoring.
   4. Return top-k candidates with blended scores and optional LLM-generated rationales.
   5. Cache results and update as additional context (linked PRs, telemetry) arrives.

- **API guardrails**:
   - Batch likeness summaries during background embedding generation to minimize per-issue request overhead (e.g., 50 summaries per run).
   - Extend daily token budget to account for embedding generation (estimate +100k tokens for summary generation batch).
   - Cache generated summaries and justifications in SQLite with `analysis_run_id` to avoid repeat calls.
   - Provide a "dry run" mode to estimate token spend without calling the LLM, using average tokens per prompt (summary ≈ 300 input, 70 output; justification ≈ 200 input, 40 output).
   - Use cheaper embedding models for query-time (text-embedding-3-small) vs training corpus (text-embedding-3-large).

## Semantic Search Architecture

**Embedding Providers:**
- **Training corpus**: OpenAI `text-embedding-3-large` (1536 dimensions) for maximum semantic fidelity
- **Query-time**: OpenAI `text-embedding-3-small` (512 dimensions) for fast inference with lower cost
- **Fallback**: Hugging Face sentence transformers (`all-mpnet-base-v2`, 768d) for offline mode or API outage
- **Future**: fine-tune embeddings on labeled similarity pairs collected from user "This was helpful" feedback, package via ONNX for self-hosting

**Vector Storage:**
- Deploy `sqlite-vss` extension (0.1.x) for ANN search with HNSW index
- Fallback to brute-force cosine when corpus <200 vectors (typical for small repos)
- Store embeddings for multiple sources: `title` (fast), `body` (comprehensive), `likeness_summary` (balanced)
- Batch index updates in 200-row chunks, vacuum once per export to optimize query performance

**Hybrid Retrieval:**
- **Option 1 - Weighted Average**: combine keyword FTS5 rank score (normalized 0-1) with cosine similarity (0-1) using learnable weights (e.g., 0.4 keyword + 0.6 semantic)
- **Option 2 - Reciprocal Rank Fusion**: merge top-20 from each retriever using RRF formula: `score = sum(1/(k + rank_i))` where k=60
- **Option 3 - Cascade**: use keywords to seed candidates (FTS5 LIMIT 100), then rerank top-20 via embeddings for precision
- Boost matches that align on both keyword Jaccard >0.4 AND cosine >0.7
- Normalize titles (lowercase, strip prefixes like "feat:", "fix:") and run FTS on titles + comment excerpts before vector search

**Schema Extensions:**
- Add `embeddings` table (already defined in MVP schema):
  - `embedding_id` (PK), `issue_id` (FK), `source` (title/body/likeness_summary), `vector` (BLOB), `model` (text-embedding-3-large/small), `dimensions` (1536/512), `created_at`
- Add `similarity_cache` table to store precomputed nearest neighbors and user feedback:
  - `cache_id` (PK), `query_issue_id` (FK), `candidate_issue_id` (FK), `keyword_jaccard`, `cosine_similarity`, `blended_score`, `user_helpful_vote` (boolean, nullable), `cached_at`

## Data Pipeline Extensions

**Likeness Summary Generation:**
- Extend export pipeline to generate likeness summaries for closed issues missing them
- Batch API calls (50 issues per request) using locked summary generation prompts
- Store summaries in `risk_intelligence_snapshots.likeness_summary` column (add to schema)
- Display summaries in risk intelligence comments for human review

**Embedding Generation:**
- Background job triggered from ML Training tab: `Generate Embeddings` button
- For each closed issue: embed title, body excerpt (first 500 words), and likeness summary
- Store vectors in `embeddings` table with source and model metadata
- Progress tracking: "Generating embeddings: 234/500 issues (47%)" with cancellation support
- Estimate token usage and display before starting (e.g., "This will use ~50k tokens")

**Index Building:**
- After embedding generation completes, build sqlite-vss HNSW index on `embeddings.vector`
- Index parameters: `M=16` (connections per node), `ef_construction=200` (build quality)
- Query parameters: `ef_search=50` (accuracy/speed tradeoff)
- Fallback: if sqlite-vss unavailable, compute brute-force cosine in TypeScript for small datasets

**Incremental Updates:**
- When new issues close: generate keywords immediately (MVP), queue embedding generation for next batch run
- Rebuild HNSW index incrementally (insert new vectors without full rebuild) if corpus <1000 vectors
- Full index rebuild weekly or when corpus grows >20% since last rebuild

## UI Enhancements (ML Training Tab)

**New Actions:**
- `Generate Embeddings` button: batch generates embeddings for closed issues, builds ANN index
  - Shows token estimate before starting
  - Displays progress bar and cancel button during generation
  - Enables hybrid search after completion
- `Test Similarity` section: input query keywords or issue number, compare keyword-only vs hybrid results side-by-side

**Settings:**
- **Similarity Mode**: dropdown to select "Keywords Only" (MVP), "Hybrid (Keywords + Semantic)", or "Semantic Only"
- **Embedding Model**: select text-embedding-3-small (fast) or text-embedding-3-large (accurate) for queries
- **Hybrid Blend Weight**: slider to adjust keyword vs semantic weighting (default 0.4/0.6)

**Post-run Info:**
- Show embedding coverage: "456/500 issues (91.2%) have embeddings"
- Display index statistics: "HNSW index size: 2.3 MB, 456 vectors, avg query time: 23ms"
- Link to embedding generation log and token usage report

## Feature Engineering Extensions

Beyond MVP keyword features, semantic embeddings enable:
- **Dense semantic features**: use embeddings as input to downstream ML models (dimensionality reduction via PCA to 64d)
- **Cluster features**: k-means cluster assignments on embedding space (e.g., "auth cluster", "UI cluster") as categorical predictors
- **Similarity aggregates**: average cosine similarity to high-risk historical issues, average similarity to low-risk issues (risk neighborhood features)
- **Topic modeling**: LDA or BERTopic on embeddings to extract latent themes, use topic distributions as features

## Modeling Strategy Extensions

- **Ensemble models**: combine keyword-based heuristics (MVP) with semantic similarity features for meta-learner
- **Transfer learning**: use pre-trained embeddings as frozen features, fine-tune final layers on risk prediction task
- **Active learning**: identify low-confidence predictions and request user labels, retrain embeddings on labeled similarity pairs
- **Multi-task learning**: jointly train on risk prediction and similarity ranking objectives

## Evaluation Plan Extensions

Beyond MVP metrics:
- **Embedding quality**:
  - Manual review: sample 50 issue pairs, judge if top semantic matches are truly similar
  - Benchmark: compare against keyword baseline using precision@5, recall@10, nDCG@10
  - Correlation: measure agreement between keyword Jaccard and cosine similarity (expect moderate correlation)
- **Hybrid retrieval**:
  - A/B test: compare user satisfaction ("Was this helpful?") for keyword-only vs hybrid results
  - Latency: measure p50/p95/p99 query times for hybrid search (target <200ms p95)
- **Cost analysis**:
  - Track embedding API spend per month, compare to keyword extraction overhead
  - Measure storage footprint (vector BLOB sizes) and query memory usage

## Integration Steps

1. **Schema Migration**: add `likeness_summary` column to `risk_intelligence_snapshots`, create `embeddings` and `similarity_cache` tables
2. **Summary Generation Service**: implement `LikenessSummaryService` with locked prompts and batch API logic
3. **Embedding Service**: implement `EmbeddingService` supporting OpenAI and Hugging Face backends with model switching
4. **Vector Storage**: integrate sqlite-vss extension with fallback to brute-force cosine
5. **Hybrid Retrieval**: extend `SimilarityService.findSimilar()` to blend keyword FTS5 + cosine scores
6. **UI Wiring**: add embedding generation button and hybrid search controls to ML Training tab
7. **Background Jobs**: implement resumable batch embedding generation with progress tracking
8. **Similarity Justification**: extend UI to show LLM-generated explanations for top matches
9. **User Feedback Loop**: add "Was this helpful?" thumbs up/down to similarity results, store in `similarity_cache.user_helpful_vote`
10. **Fine-tuning Pipeline**: collect labeled pairs from user feedback, fine-tune embeddings quarterly

## Testing Strategy

### Post-MVP Test Plan
- **Unit tests**
   - Likeness summary generator respects token limit and keyword format
   - Embedding service retries on API failures and falls back to Hugging Face on quota errors
   - Hybrid scoring blends keyword Jaccard + cosine correctly with configurable weights
   - Similarity justification prompt produces explanations matching expected format
- **Integration tests**
   - End-to-end embedding generation processes 100 issues and builds HNSW index
   - Hybrid query returns blended results different from keyword-only baseline
   - Brute-force fallback activates when sqlite-vss disabled, produces identical results
   - User feedback updates similarity_cache and increments helpful/unhelpful counts
- **Performance tests**
   - Measure embedding batch generation throughput (target >10 issues/second with API caching)
   - Benchmark HNSW query latency vs brute-force at 100, 500, 1000, 5000 vectors
   - Profile memory usage during hybrid queries (target <100MB working set)
- **Quality validation**
   - Manual review 50 top semantic matches vs keyword-only matches, calculate preference rate
   - Measure correlation between cosine similarity and keyword Jaccard on sample of 200 pairs
   - A/B test hybrid vs keyword-only search with 10 test users, collect qualitative feedback

## Operational Considerations

**Storage Scaling:**
- Embedding storage per issue: ~6KB for text-embedding-3-large (1536d * 4 bytes), ~2KB for text-embedding-3-small (512d * 4 bytes)
- For 5000 issues with 3 sources each: ~90MB (large) or ~30MB (small)
- HNSW index overhead: ~20% additional space, so ~108MB (large) or ~36MB (small) total
- Mitigation: prune old issue embeddings after 2 years, use small model for queries

**API Cost Estimation:**
- text-embedding-3-large: $0.13 per 1M tokens, ~200 tokens/issue → $0.026 per 1000 issues
- text-embedding-3-small: $0.02 per 1M tokens, ~200 tokens/issue → $0.004 per 1000 issues
- Likeness summary generation: ~370 tokens/issue (300 input + 70 output) → $0.185 per 1000 issues (gpt-4o-mini at $0.50/1M tokens)
- Total for 5000 issues with large embeddings: ~$1.10 (one-time) + monthly query costs negligible (<$0.10/month for 1000 queries)

**Privacy & Compliance:**
- Embeddings capture semantic content of issue titles/bodies; treat as PII if repo contains sensitive data
- Provide setting to disable embedding generation for private repos (default: enabled only for public repos)
- Document data retention policy: embeddings purged when parent issue deleted
- Multi-repo aggregation requires opt-in consent and anonymization of identifiers

**Monitoring & Alerting:**
- Track embedding generation failures and retry exhaustion
- Alert on HNSW query latency exceeding 500ms p95
- Monitor API quota consumption and warn at 80% daily limit
- Log user feedback rates to detect quality regressions

## Rollout Plan

**Phase 1 (Weeks 1-2): Foundation**
- Add schema migrations and implement summary generation service
- Generate embeddings for test repository (100-200 issues) using text-embedding-3-small
- Validate storage, retrieval, and brute-force cosine baseline

**Phase 2 (Weeks 3-4): Hybrid Search**
- Integrate sqlite-vss and implement hybrid retrieval with reciprocal rank fusion
- Add ML Training tab controls for embedding generation
- Deploy feature flag to enable hybrid search for early adopters

**Phase 3 (Week 5): User Feedback**
- Add "Was this helpful?" feedback mechanism to similarity results
- Collect feedback for 2 weeks, analyze agreement rates between keyword and semantic results
- Tune hybrid blend weights based on feedback

**Phase 4 (Weeks 6-8): Fine-tuning**
- Export labeled similarity pairs from user feedback
- Fine-tune text-embedding-3-small on labeled pairs using OpenAI fine-tuning API
- Package fine-tuned model and deploy as optional upgrade

**Phase 5 (Weeks 9+): Multi-repo Aggregation**
- Implement cross-repository embedding index with repo-scoped filtering
- Build privacy controls and opt-in mechanism
- Launch as premium feature for teams with >5 connected repos

## Risks & Mitigations

- **Embedding quality**: pre-trained models may not capture domain-specific semantics → collect labeled pairs and fine-tune quarterly
- **API costs**: large-scale embedding generation expensive for big repos → start with small model, batch aggressively, cache embeddings indefinitely
- **Query latency**: HNSW index slow on large corpus → use smaller embedding model (512d vs 1536d), tune ef_search parameter, consider GPU acceleration
- **Storage bloat**: embeddings grow linearly with corpus → implement pruning policy (archive embeddings for issues >2 years old), compress vectors (quantization)
- **Hybrid tuning**: blend weights may not generalize across repos → make weights per-repo configurable, learn from user feedback
- **Privacy concerns**: embeddings leak semantic content → disable by default for private repos, document retention policy, support embedding deletion

## Success Metrics

**Adoption:**
- % of users who enable hybrid search after trying keyword-only for 1 week
- % of similarity queries using hybrid vs keyword-only mode

**Quality:**
- User feedback: % "helpful" votes on top-3 hybrid results vs keyword results
- Retrieval metrics: precision@5, recall@10 improvement over keyword baseline
- Manual review: expert judgment on 100 sampled matches, % agreement with hybrid ranking

**Performance:**
- Embedding generation time: <10 min for 500 issues
- Hybrid query latency: p95 <200ms, p99 <500ms
- Storage footprint: <100MB per 5000 issues

**Cost:**
- Embedding generation cost: <$2 per 5000 issues (one-time)
- Monthly query costs: <$5 for 10k queries
- User perceived ROI: survey users on value vs cost trade-off

## Next Actions (Post-MVP)
- Monitor MVP keyword similarity quality and collect user pain points
- Prototype likeness summary generation on 50 test issues, review quality
- Benchmark sqlite-vss vs brute-force cosine on sample datasets (100-5000 vectors)
- Design user feedback UI and tracking schema for similarity helpfulness
- Draft privacy policy for embedding generation and retention
- Estimate embedding API costs for target repositories and get budget approval
