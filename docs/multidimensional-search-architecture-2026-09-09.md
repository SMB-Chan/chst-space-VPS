# Multi-dimensional Search Architecture

Date: 2026-09-09

## Goal

Evolve Chat-Space from a single ranked-list search pipeline into a bounded, task-aware retrieval system that can separate evidence needs, search them through different lanes, detect which dimensions remain weak, and retry only the missing dimensions.

The central rule is: **do not collapse all retrieval quality into one score too early**. Freshness, primary-source authority, topical relevance, independence, counterevidence, academic evidence, technical evidence, and comparison coverage have different meanings. A source can be excellent on one dimension and weak on another.

## Research signals used

The implementation direction follows recent retrieval and deep-research findings, including 2026 work:

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
  -> Evidence matrix
  -> Gap detector
       only missing dimensions
  -> bounded targeted recovery
  -> answer generation
  -> claim audit + task-success audit
```

## Phase 1 implemented in this branch

`SearchTaskProfile` introduces a shared deterministic representation for:

- dominant task class;
- temporal requirement (`realtime`, `current`, `historical`, `timeless`);
- evidence dimensions that must remain separately observable;
- ordered retrieval lanes;
- a bounded query budget (3 for ordinary tasks, 4 for complex fact-check/comparison/research/technical tasks).

`planSearchQueries` consumes this profile. It now spends the query budget on the highest-priority evidence lanes rather than adding generic variants in a fixed order. Counterevidence and comparison use distinct roles so their contribution can be measured independently. Historical queries explicitly skip freshness lanes.

The planned-provider executor keeps the cheap early-stop path for routine lookups, but does **not** stop merely because the primary query returned many pages when the task profile still has a required evidence lane. Weather, fact-check, comparison, research, and technical tasks can therefore execute their required source dimensions even when raw result-count coverage is already high.

The existing news circuit remains specialized and continues to own strict news freshness/relevance behavior. The new profile is the common foundation for general search and future vertical circuits.

## Next implementation stages

1. **Evidence-vector propagation**
   - attach dimension scores to retrieved sources without converting them immediately into one scalar;
   - preserve publisher independence and source lineage.

2. **Gap-directed recovery**
   - convert evidence-matrix gaps into a small recovery plan;
   - retry only the missing dimension;
   - cap total additional provider/search work.

3. **Task-specific hard requirements**
   - latest/news: freshness + independent domains;
   - fact-check: primary source + counterevidence when available;
   - comparison: symmetric evidence for both sides;
   - research: original papers / official datasets;
   - technical: official docs / source repository / version-aware evidence;
   - weather: structured observation/forecast data before ordinary web pages.

4. **Adaptive retrieval gate**
   - avoid retrieval expansion when the first pass already satisfies required dimensions;
   - spend additional latency only on observable evidence gaps;
   - do not apply expensive reflection uniformly when a deterministic quality gate is already sufficient.

5. **Evaluation harness**
   - fixed regression prompts for news, weather, fact-check, comparison, technical, academic, local and historical tasks;
   - add a rotating fresh-news set inspired by LiveNewsBench so current-information failures cannot hide behind static fixtures;
   - track task success, source quality, evidence coverage, contradiction detection, search count, latency, and tokens separately.

## Safety constraints

- Every generated query passes the existing secret-like query sanitizer.
- The total query count remains hard-capped.
- Historical tasks are not forced through a current-news freshness gate.
- Independence is a source-selection property; the planner does not fabricate a vague "independent" query merely to fill a lane.
- Search failure remains fail-open for the primary response path, while claims that require unavailable fresh evidence must not be presented as verified.
- Agentic recovery is finite-horizon and task-gated; no unbounded self-reflection or recursive search loop is introduced.
