# Multi-dimensional Search Architecture

Date: 2026-09-09

## Goal

Evolve Chat-Space from a single ranked-list search pipeline into a bounded, task-aware retrieval system that can separate evidence needs, search them through different lanes, detect which dimensions remain weak, and retry only the missing dimensions.

The central rule is: **do not collapse all retrieval quality into one score too early**. Freshness, primary-source authority, topical relevance, independence, counterevidence, academic evidence, technical evidence, and comparison coverage have different meanings. A source can be excellent on one dimension and weak on another.

## Research signals used

The implementation direction follows recent retrieval and deep-research findings, including 2026 work:

- **APT-RAG: A Tree-based RAG Framework for Evidence-Intensive QA via Adaptive Planning and Topology-Aware Evidence Gathering (2026, arXiv:2609.04981)** uses evidence requirements to adaptively expand a reasoning plan and emphasizes reuse/aggregation of already gathered evidence. This supports preserving evidence state explicitly and repairing only unresolved dimensions rather than restarting retrieval.
- **PAR²-RAG: Planned Active Retrieval and Reasoning for Multi-Hop Question Answering (2026, arXiv:2603.29085)** separates high-recall anchoring from depth-oriented refinement controlled by evidence sufficiency. Chat-Space mirrors that shape with a broad bounded primary pass followed by targeted missing-dimension recovery.
- **How You Ask Matters! Adaptive RAG Robustness to Query Variations (2026, arXiv:2604.10745)** reports that semantically equivalent surface rewrites can change adaptive retrieval behavior. Chat-Space therefore carries a stable deterministic `SearchTaskProfile` into later evidence decisions instead of independently reclassifying each stage from ad-hoc lexical gates.
- **Agent-Orchestrated Adaptive RAG (2026, arXiv:2606.05658)** reports that query decomposition can improve structured retrieval, but can also reduce ranking precision on some multi-hop tasks, while reflection improves citation accuracy at substantial latency cost. This is a strong reason to make decomposition selective, bounded, and task-dependent rather than always-on.
- **SoK: Agentic Retrieval-Augmented Generation (2026, arXiv:2603.07379)** frames agentic RAG as a finite-horizon sequential decision process and highlights retrieval misalignment, compounding hallucinations, cost-aware orchestration, and trajectory evaluation. Chat-Space therefore treats retrieval expansion as a controlled state transition with explicit budgets and observable evidence requirements.
- **LiveNewsBench (2026, arXiv:2602.13543)** evaluates fresh web search with questions that require information beyond training data, multi-hop queries, page visits, and reasoning. This reinforces the existing current-news circuit and motivates continuously refreshed regression prompts for live information retrieval.
- **Search-R1 (2025, arXiv:2503.09516)** demonstrates the value of multi-turn search interactions rather than a single retrieve-then-answer pass. Chat-Space keeps this bounded: the system may open another retrieval lane only when a specific evidence gap remains.
- **RAG-RL (2025, arXiv:2503.12759)** shows that retrieval quality and the reader's ability to identify useful context should be optimized together. Chat-Space therefore keeps richer evidence metadata instead of forcing the retriever to make every decision before generation.
- **Deep Research Bench (2025, arXiv:2506.06287)** evaluates long-horizon web research using tool-use, hallucination, and forgetting dimensions. This motivates explicit task-success auditing and evidence-gap state rather than measuring only whether citations exist.
- **Deep Research Agents: A Systematic Examination and Roadmap (2025, arXiv:2506.18096)** emphasizes dynamic planning, multi-hop retrieval, iterative tool use, and the distinction between static and dynamic workflows. Chat-Space uses deterministic task profiling first, then bounded dynamic recovery.
- **Dynamic and Parametric RAG (2025, arXiv:2506.06704)** describes dynamic retrieval as deciding when and what to retrieve according to evolving information needs. The evidence matrix and gap-directed recovery are the corresponding production mechanism here.
- **TARG (2025, arXiv:2511.09803)** reports that always retrieving can waste latency and tokens; adaptive retrieval gating can preserve quality while reducing unnecessary retrieval. Chat-Space keeps normal queries bounded and increases the query budget only for complex evidence profiles.
- **BRIGHT (2024, arXiv:2407.12883)** shows that reasoning-intensive retrieval is poorly served by surface lexical matching and benefits from reasoning-aware query augmentation. The task profile therefore creates distinct retrieval lanes instead of relying only on keyword expansion.

These papers guide architecture; their reported benchmark gains are not assumed to transfer directly to Chat-Space.

## Architecture

```text
User request
  -> SearchTaskProfile
       task
       temporal need
       evidence dimensions
       bounded query budget
  -> Retrieval lanes
       primary source
       freshness
       academic
       technical
       comparison
       counterevidence
       independent corroboration
  -> Provider scheduler / vertical circuits
  -> Hard safety and quality gates
  -> Vector evidence metadata
       query-lane provenance
       provider provenance
       non-collapsed dimension signals
  -> Retrieval evidence gap detector
       only missing required dimensions
  -> bounded targeted recovery
  -> Deep Research semantic evidence matrix
  -> answer generation
  -> claim audit + task-success audit
```

## Phase 1 merged in PR #135

`SearchTaskProfile` introduces a shared deterministic representation for:

- dominant task class;
- temporal requirement (`realtime`, `current`, `historical`, `timeless`);
- evidence dimensions that must remain separately observable;
- ordered retrieval lanes;
- a bounded query budget (3 for ordinary tasks, 4 for complex fact-check/comparison/research/technical tasks).

`planSearchQueries` consumes this profile. It spends the query budget on the highest-priority evidence lanes rather than adding generic variants in a fixed order. Counterevidence and comparison use distinct roles so their contribution can be measured independently. Historical queries explicitly skip freshness lanes.

The planned-provider executor keeps the cheap early-stop path for routine lookups, but does **not** stop merely because the primary query returned many pages when the task profile still has a required evidence lane. Weather, fact-check, comparison, research, and technical tasks can therefore execute their required source dimensions even when raw result-count coverage is already high.

## Phase 2 implemented in PR #136

The retrieval layer now carries a `SearchEvidenceMetadata` vector on search results. It records query-lane provenance, provider provenance, and separate bounded signals for `primary_source`, `freshness`, `counterevidence`, `comparison`, `academic`, and `technical`. The vector is deliberately **not** a factuality score: it says how evidence was retrieved, not whether a claim is true.

Weighted RRF now unions those vectors when the same URL is found through multiple providers or multiple query lanes. This lets later stages reuse evidence already collected instead of losing lineage during deduplication.

`SearchQueryPlan.primaryEvidenceDimensions` records when a concrete evidence constraint is already present in the primary query itself, such as an explicit current-time constraint or a concrete official-source target. This avoids spending a query slot merely to add a lexical synonym such as `latest`.

`assessSearchRetrievalEvidence` evaluates required retrieval dimensions after the primary pass. Independence is measured at corpus level through distinct source domains rather than assigned to individual pages. When raw primary quantity is sufficient, the executor now runs only supplemental roles mapped to still-missing required dimensions. If independence alone is unresolved, it may spend at most one already-planned alternate lane; it does not invent an unbounded generic independence query.

Deep Research now derives freshness, comparison, and counterevidence matrix requirements from the same `SearchTaskProfile` used by search planning. Causal/background and impact remain semantic matrix-specific facets. This reduces stage-to-stage classifier drift while preserving the LLM evidence matrix as the stronger semantic sufficiency gate.

The result is a two-level gate:

1. **deterministic retrieval coverage** answers “did the required retrieval lane actually contribute evidence?”;
2. **semantic evidence matrix** answers “does the gathered evidence actually support the required claim/facet?”.

Neither level is allowed to silently substitute for the other.

## Next implementation stages

1. **Task-specific hard requirements**
   - latest/news: freshness + independent domains;
   - fact-check: primary source + counterevidence when available;
   - comparison: symmetric evidence for both sides;
   - research: original papers / official datasets;
   - technical: official docs / source repository / version-aware evidence;
   - weather: structured observation/forecast data before ordinary web pages.

2. **Evidence-aware source selection**
   - use provenance during final top-k selection without collapsing all dimensions into one scalar;
   - prevent a highly ranked redundant source from evicting the only source covering a required facet;
   - preserve publisher lineage where feeds expose publisher/article URLs.

3. **Adaptive retrieval gate refinement**
   - avoid retrieval expansion when the first pass already satisfies required dimensions;
   - spend additional latency only on observable evidence gaps;
   - do not apply expensive reflection uniformly when a deterministic quality gate is already sufficient.

4. **Evaluation harness**
   - fixed regression prompts for news, weather, fact-check, comparison, technical, academic, local and historical tasks;
   - add a rotating fresh-news set inspired by LiveNewsBench so current-information failures cannot hide behind static fixtures;
   - add query-paraphrase pairs to measure routing stability rather than only answer accuracy;
   - track task success, source quality, evidence coverage, contradiction detection, search count, latency, and tokens separately.

## Safety constraints

- Every generated query passes the existing secret-like query sanitizer.
- The total query count remains hard-capped.
- Historical tasks are not forced through a current-news freshness gate.
- Independence is a source-selection property; the planner does not fabricate a vague "independent" query merely to fill a lane.
- Search failure remains fail-open for the primary response path, while claims that require unavailable fresh evidence must not be presented as verified.
- Agentic recovery is finite-horizon and task-gated; no unbounded self-reflection or recursive search loop is introduced.
