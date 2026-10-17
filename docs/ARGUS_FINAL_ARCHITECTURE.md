# ARGUS — Final Architecture (Canonical Implementation Specification)

> **"Find the outage before it happens. Find the smallest change that prevents it."**

| | |
|---|---|
| **Status** | Canonical build specification. Not yet implemented. |
| **Source of truth** | Arena run `run-20261007-002101-s128618`, champion **a032** (card: Expert panel + Iterative deepening + Speed). Complete text: `.arena/run-20261007-002101-s128618/r5/r5-m01.a032.solution.md` (952 lines, read in full). |
| **Tournament record** | 32 agents, 5 rounds, a032 won every match: 83.5–79.5, 89–72.5, 89–83.5, 89.5–76.5, 87–80. In every round the judges ran a032's Appendix A reference simulator and reproduced its stage numbers. |
| **Target** | WeMakeDevs × FalkorDB "Graph Hacks: Give Your AI Agents Real Context", **Track 01: Agents That Act on Connected Data**. |

### How to read this document

The tags below appear throughout and mark where each piece of content comes from:

- Unmarked content, and content tagged **[a032]**, is taken from the winning solution. Numbers, names, Cypher and equations are preserved exactly.
- **[IMPL-INTERPRETATION]** marks content that a032 implies but does not write out, such as a Cypher statement derived from a032's tables or a JSON schema derived from a032's tool description. Each one is labelled and can be revised.
- **[IMPL-NOTE]** marks an adaptation that the real FalkorDB or Node implementation may need. The a032 original is kept next to it.
- **TO BE DECIDED DURING IMPLEMENTATION** (TBD) marks something a032 genuinely does not specify. Nothing has been invented in its place.

### Changelog

| Date | Change |
|---|---|
| 2026-10-07 | **Three p10–p90 bands corrected:** F5 `2–3` → **`1–3`**, G1 `30–33` → **`20–33`**, G2 `30–32` → **`19–32`**. a032 computed its bands with an undocumented off-by-one percentile convention (`v[ceil(q·n)]`, 0-based). That drops the two lowest rollouts for "p10" and takes the maximum for "p90". The canonical implementation now uses the explicitly defined nearest-rank percentile (§10.6), and the corrected bands were re-derived by running the verbatim Appendix A simulator (M1, `argus/sim/reference/reproduce.py`). **Nothing else changed:** no simulator code, decision rule, rollout value, median, recovery count or world result. F4 (14–14) and G3 (0–0) are identical under both conventions. |
| 2026-10-07 | **Audit bound documented (§13.2.1, IMPL-INTERPRETATION):** `bound = max(cost(proposal), cost(cheapest qualifying evaluated future))`, which equals the proposal's cost whenever the proposal qualifies. `NO_SAFE_ACTION` audits the whole scope. The canonical decision rule is unchanged. |
| 2026-10-07 | **Trigger-set hop count corrected (§6.4):** `min(length(q)) AS hops` → **`min(length(q)) - 1 AS hops`**. The path `q` ends in one `APPLIES_TO` edge (Fault → Service), so a032's verbatim query counted that edge as a hop. It returned `degrade:payments@1, degrade:ledger-db@2`, contradicting a032's own stated output and the "3 hops from entry / 1 hop below the amplifier" claim. The corrected query returns the canonical **`degrade:payments@0, degrade:ledger-db@1`** (verified on FalkorDB 6.0.1 by `argus/scripts/falkordb-probe.sh`). The offset is constant, so trigger order and the B5 `(hops, id)` order are unchanged. No simulator or fault-model change. |

All numbers in this document come from a032's reference simulator (Appendix A of a032, reproduced in full in [Appendix A](#appendix-a-reference-simulator-verbatim-from-a032) here). Under a032's rules, **a number is never edited by hand**. If tuning changes, the numbers are re-derived from code, and every stage verdict must still pass the 20-seed-set robustness gate.

---

## Table of contents

1. [Executive architecture](#1-executive-architecture)
2. [Demo-first design](#2-demo-first-design)
3. [WORLD / TWIN architecture](#3-world--twin-architecture)
4. [FalkorDB architecture](#4-falkordb-architecture)
5. [Complete graph schema](#5-complete-graph-schema)
6. [Complete Cypher](#6-complete-cypher)
7. [Simulator](#7-simulator)
8. [Reference numbers](#8-reference-numbers)
9. [RED](#9-red)
10. [BLUE](#10-blue)
11. [MCP](#11-mcp)
12. [Graph algorithms](#12-graph-algorithms)
13. [Decision engine](#13-decision-engine)
14. [Fallback / reliability](#14-fallback--reliability)
15. [UI](#15-ui)
16. [Project structure](#16-project-structure)
17. [Four-day build plan](#17-four-day-build-plan)
18. [Cut list](#18-cut-list)
19. [Research extension](#19-research-extension)
20. [Final-year project extension](#20-final-year-project-extension)
21. [Threats / failure modes](#21-threats--failure-modes)
22. [Implementation acceptance checklist](#22-implementation-acceptance-checklist)
23. [Register of unspecified items (TBD)](#23-register-of-unspecified-items-tbd)
- [Appendix A. Reference simulator (verbatim from a032)](#appendix-a-reference-simulator-verbatim-from-a032)
- [Appendix B. Answers to the 16 critical questions (a032)](#appendix-b-answers-to-the-16-critical-questions-a032)
- [Appendix C. a032's brutally honest scorecard](#appendix-c-a032s-brutally-honest-scorecard)

---

## 1. Executive architecture

### 1.1 Purpose

ARGUS maintains a graph model of an operational microservice system in FalkorDB. Before any incident happens, it searches for failure scenarios that would become a self-sustaining outage. It proves each one in simulation, tests counterfactual interventions on forked copies of the graph, applies the cheapest safe intervention, checks its prediction against a separate ground-truth world, and then attacks the hardened system again. This loop is called **iterative hardening**, not co-evolution.

| IncidentMind asks | ARGUS asks |
|---|---|
| "What happened, and how should we recover?" | "How could this system fail, and what is the smallest intervention that prevents it?" |

### 1.2 The exact problem being solved

The target is the **metastable failure** (Bronson et al., HotOS '21; Huang et al., OSDI '22). A transient **trigger**, here a slowdown in a database three hops below the entry point, ignites an **amplifier**: retry configuration along a multi-hop call path. The retries become the load. Once ignited, **the outage continues after every cause has been removed.** Scaling the visibly saturated service does not fix it, and neither does fixing the root-cause database.

The core inequality, which judges can check:

```
λ · Π(1 + r_i) > μ
300 rps × 3 × 4 = 3,600 rps   ≫   704 rps real capacity of payments
```

The trigger is **3 hops from the entry point and 1 hop below the amplifier**. That is why a graph finds it and a dashboard would not.

### 1.3 The winning architectural concept (a032 §0)

> Keep the RED → BLUE → harden loop. Rebuild it around one sharp idea that judges can check: **a cascade that keeps going after every cause is removed (a metastable failure), predicted from the graph before it happens.**

- **Two processes.** `argus-app` (orchestrator, UI server, agent runtime, WORLD owner) and `argus-mcp`, which is spawned once per role.
- **Two FalkorDB graphs.** `twin` is what ARGUS believes. `world` is the hidden ground truth, which the agent's database user cannot read. Counterfactual forks are `fork:<round>:<future>`.
- **One small simulator** that runs on whatever graph it is given. Every system parameter (topology, capacities, retry config), every fault and intervention magnitude, and every policy constant (SLO, error budget, horizons) is a graph property. **Only the model's equations are code.**
- **RED** is a budgeted LLM agent. A multi-hop retry-amplification query finds the amplifier (gateway→checkout→payments, 4.5× capacity). A downstream-closure query finds where to pull the trigger: a slowdown in `ledger-db`. The twin predicts it becomes self-sustaining in **15/16** rollouts. ARGUS injects it into `world`. The outage starts, **the database is restored, and the outage continues.**
- **BLUE** snapshots the live state into the twin. It gets candidates that Cypher derives from **every entry-to-fault path, computed by the server, not claimed by the agent**. It runs `GRAPH.COPY` on the twin once per candidate, applies the candidate, and runs 16 seeded rollouts from the snapshot. A **server rule** commits to the cheapest future that recovers **and** stays within a **10-tick error budget**. A **server audit** then checks every untested in-scope option at the same or lower cost.
- **Round-1 outcome.** Waiting fails, +50% payments capacity fails, fixing the database fails, turning retries off on one layer fails, and a breaker recovers but blows the budget. **Turning retries off on both layers recovers in 2 ticks.** The fix is applied to `world`, where the twin predicted a median of 2 (p10–p90 1–3) and the world observes 3. The twin learns payments' true capacity: 800 → 709 (truth 704).
- **Round 2.** The amplification query now returns nothing, so RED **switches tools**. PageRank points to `ledger-db`, which leads to a pending deploy, **CE-42**. BLUE finds that blocking CE-42 stops the permanent outage but still costs 32 bad ticks, which is over budget, so it buys `ledger-db` capacity. The slowdown is injected **and** CE-42 is allowed to land, and **the world stays green.**

### 1.4 Why it can win Track 01

| Track 01 requirement | How ARGUS meets it |
|---|---|
| Multi-hop reasoning | The amplifier query (variable-length path + `reduce` over retries/fanout/capacity) and the downstream-closure trigger query find a trigger 3 hops from the entry point. |
| Graph queries and algorithms as agent tools | `amplification_paths`, `rank_nodes` (PageRank), `blast_radius` and `query_graph` are MCP tools. Every retained algorithm changes an action (§12). |
| Tool selection through MCP | Tool choice visibly depends on graph state. In round 2, the **empty** `amplification_paths` result is what makes RED call `rank_nodes`. |
| Actions based on what the graph shows | Both action spaces (`Fault`, `Intervention`) are generated by Cypher rules over the topology. Hardening changes the graph, which changes what each side may do. |
| Explainable results | The Cypher behind every tool call, a persisted `Step` trace, the evidence path, the inequality shown in the futures panel, predicted vs observed, and the "Why?" path. |
| FalkorDB as the primary graph DB | The graph is the model, the state, both action spaces, the safety constraint, the fork substrate, the algorithm engine, the access boundary and the trace (§4.9). |
| The graph shapes what the agent does | Remove the graph and there is nothing to simulate, nothing to choose from, and nothing to fork. |

### 1.5 Core design principles (a032 §1)

Three expert lenses were reconciled:

| Lens | Strongest idea taken | Disagreement | Decision |
|---|---|---|---|
| **Staff SRE / chaos engineer** | Make the cascade a *metastable failure*. Model only real config knobs. Separate the **trigger** (a transient slowdown) from the **amplifier** (retry config along a path). Output a **config PR**, not a paragraph. | Wanted 15+ services and a queueing-accurate simulator. | **8 services and a fluid (rate-based) model.** Metastability comes from a mechanism, not from topology size. |
| **Hackathon judge / demo director** | One screen, three acts, one "wait, what?" moment: *"We fixed the database. It's still down."* Overlay predicted vs observed. Show the Cypher behind every tool call. Make everything replayable, with a run sheet whose arithmetic adds up. | Wanted to cut WORLD/TWIN as "too subtle". | **Keep WORLD/TWIN as one visual:** the predicted band against the observed line, plus a calibration counter. |
| **Graph/agents researcher** | Every algorithm must change an action, and a skeptic must be able to verify it live. Selection must be deterministic and *provably* minimal within scope. Ship the **non-LLM baseline (B5) as the fallback agent**. | Wanted B0–B6 and an oracle before the hackathon. | **Build B0, B5 and the scoped oracle now.** The oracle is tiny at 8 services and doubles as the minimality audit. |

**Binding rules.** a032 calls these "three rules" but lists four; all four are binding:

1. **A component stays only if it shows up on the demo screen, changes an agent's action, or protects the demo from failing.**
2. **Every claim made on stage must be reproducible by running the query or the simulator, and must survive a change of seeds.**
3. **Every parameter the simulator uses lives in the graph.** Code holds only the model's equations and their shape constants, such as the sigmoid width. A WORLD/TWIN mismatch is therefore always a difference in graph data, never in code.
4. **The agent's work is reported separately from the server's verification.** Budgets count what the agent spent. The audit's extra simulations are counted and shown separately, never hidden inside the agent's numbers.

And the division of labour: **"The LLM chooses what to look at and what to test, within a budget. The server decides what is true, what is allowed, and whether a cheaper answer was missed."**

### 1.6 What changed from the original ARGUS architecture, and why

| Original ARGUS proposal | a032 final | Why |
|---|---|---|
| RED/BLUE loop, "iterative hardening" | **Kept** | Already the right story. |
| Generic "find a dangerous failure combination" | **Focused on one failure class: the metastable retry storm** that persists after the trigger is removed | Gives a single checkable "wait, what?" moment and a published failure class. |
| Retry storm as an emergent mechanism, not a fault type | **Kept and made central.** Faults are `cap_degrade`, `surge` and `deploy` only. | As the brief required. |
| WORLD/TWIN as a concept | **Two separate FalkorDB graphs, with a database-enforced boundary** (Redis ACL user `agent` cannot read `world`) | Makes "prediction" claims honest. |
| Schema: Service, Fault, Scenario, Intervention, Future, Outcome, Decision, ChangeEvent | `Outcome` **cut** (the summary lives inline on `Future`). **Added** `Round`, `Charge`, `Snapshot`, `Observation`, `Step`. | `Round` holds budgets and safety constants as graph data; `Charge` gives idempotent budgets; `Snapshot` lets futures start from live state; `Observation` records predicted vs observed; `Step` is the decision trace. |
| Tool list: query, traverse, rank_nodes, list_interventions, simulate, compare_futures, record_decision | 8 tools: `query_graph`, `amplification_paths`, `rank_nodes`, `blast_radius`, `list_candidates`, `simulate`, `fork_and_simulate`, `commit` | Comparison and recording move into the server-enforced `commit` (rule plus audit). Traversal is split into the two queries that actually change actions. |
| Algorithms: BFS, betweenness, PageRank, MaxFlow, shortest path, WCC, CDLP, MSF | Kept: amplifier path, downstream closure, PageRank, blast-radius BFS, shortest path. **Cut: betweenness, MaxFlow, WCC, CDLP, MSF** | Betweenness scores `ledger-db` 0.0 and would point RED away from the real trigger. The rest are decorative on a connected 8-node graph. |
| "Select the minimum-cost intervention satisfying an explicit safety constraint" | **Server-enforced rule**: p_recover ≥ 15/16, median violation ticks ≤ error budget 10, not harmful on any entry, argmin cost, plus a rule-complete audit | The LLM cannot override it. Minimality within scope is provable. |
| Connection-pool pressure (potential mechanism) | **Not modelled** | Cut to fit 4 days. Listed as FYP work. |
| Baselines B0–B6 as research | **B0, B5 and the scoped oracle built now.** B5 doubles as the demo fallback. | Reliability and research in one component. |
| Reuse IncidentMind | **IncidentMind modules (RCA, RAG/Chroma, business impact) are not reused.** The current repo has no FalkorDB client, so the graph layer starts from zero. | a032 assumption, confirmed by grep in this repo. |

---

## 2. Demo-first design

### 2.1 The 4-minute demo: three acts (a032 §10)

**Act 1: "There is no incident." (0:00–1:10)**

| # | What happens | What the judge sees |
|---|---|---|
| 1 | Everything is green. Narration: "8 services, real mesh-style retry, timeout and breaker config in FalkorDB. Nothing is wrong." | LIVE GRAPH all green; header `Round 1/2`. |
| 2 | **Run RED.** `amplification_paths(2)` lights the amplifier gateway→checkout→payments ("worst case 4.5× payments' capacity") and lists what lies beneath it: triggers `[degrade:payments@0, degrade:ledger-db@1]`. | The amplifier path glows; the AGENT TRACE shows the tool call with its expandable Cypher. |
| 2a | `simulate([degrade:payments])` gives **0/16 sustained**: a payments slowdown heals by itself. | A trace line with the result. Budget meter 5/6. |
| 2b | `simulate([degrade:ledger-db])` gives **15/16 sustained**: a slowdown in **ledger-db, three hops from the user**, does not heal. | The trigger node pulses. Budget 4/6. |
| 2c | `commit` (submit_scenario). The server re-runs the simulation with the same seeds. Cost 1 is the floor, so the strictly-cheaper audit has nothing to run: **`proven: no cheaper attack`**, with 0 audit simulations. | Audit badge. "agent: 2 simulations · audit: 0". |
| 3 | **Inject** `degrade:ledger-db` into `world` at ticks 0–29. | The world goes red **from the bottom up**, along exactly the predicted path. |

**Act 2: "We fixed the database. It's still down." (1:10–2:40). This is the spectacular moment.**

| # | What happens | What the judge sees |
|---|---|---|
| 4 | At tick 30: `TRIGGER REMOVED: ledger-db capacity restored`. The orchestrator holds for **4 s** (labelled "held"), then runs ticks 30–39. **The world stays red.** | Banner; world still red; goodput 0.0. |
| 5 | Narration: "This is a metastable failure. The retries are now the load: 300 requests become 3,600 attempts against 704 of capacity." | The inequality on screen. |
| 6 | **SNAP** at tick 40: a noisy estimate of the live world state is written onto `twin` as `(:Snapshot)`. **BLUE runs.** Six futures fork, and the panel fills: F0 wait, **red**; F1 +50% payments, **red**; F2 fix the database, **red**; F3 retries off on one layer, **red**; F4 circuit breaker, **amber** (recovers but blows the error budget); F5 retries off on both layers, **green in 2 ticks**. | FUTURES small multiples fill in red/amber/green. Counter: "ARGUS: 6 futures tested · in scope: 118 · unscoped: 376". |
| 7 | `commit_decision(F5)`. Narration: "The rule, not the LLM, picks the cheapest future that recovers in at least 15 of 16 *and* stays inside the error budget, and the server checks every option at the same or lower cost, so nothing better was missed." Audit: 10 untested candidates at cost ≤ 2, none better, so `proven-in-scope`. **Applied to the world: it recovers in 3 ticks against a predicted 2.** | Audit badge "10 options at cost ≤ 2 checked, none better". "agent: 6 futures · audit: 10". PREDICTED vs OBSERVED: twin band (p10–p90) against the solid world line. |
| 8 | **Open hardening PR**: a YAML diff (`retries: 0` on two edges, labelled *emergency mitigation*). Calibration updates payments from 800 to 709 (true 704). | PR diff; calibration counter "payments μ: 800 → 709 (true 704)". |

**Act 3: "Attack the hardened system." (2:40–4:00)**

| # | What happens | What the judge sees |
|---|---|---|
| 9 | RED runs again, **live** (badge `LIVE · LLM`). `amplification_paths(2)` now returns **nothing** (top 0.55×). The trace pivots to `rank_nodes('pagerank')` → **ledger-db** (0.220), then `query_graph` for pending deploys into ledger-db → **CE-42**. `simulate([degrade:ledger-db])` gives 0/16 (on the hardened graph the slowdown now heals). `simulate([degrade:ledger-db, deploy:CE-42])` gives **16/16**. Narration: "this 'resilience' PR turns the same database slowdown into a permanent outage." The audit runs the 10 cost-1 singles, all 0/16: **proven: no cheaper attack** (10 audit ensembles, shown). | Round-1 and round-2 traces side by side. The empty result is visible, and so is the tool switch. |
| 10 | BLUE runs **before injection** (pre-emptive). Blocking CE-42 is cheap and stops the permanent outage but is **amber**: the slowdown alone still costs 32 bad ticks, over budget. The rule buys ledger-db capacity instead (green, 0 ticks). Then the slowdown is injected **and CE-42 merges anyway. The world stays green.** Next to it, the do-nothing future shows a flat red line. Narration: "That's the outage that never happened, and not even a blip." | Futures G0 red, G1 amber, G2 amber, G3 green. World green next to a flat red do-nothing line. |
| 11 | Close: "Everything you saw is in FalkorDB." Open FalkorDB Browser on the `Decision → Step → Service` trace, and show that the agent's database user gets `NOPERM` on `world`. | FalkorDB Browser; `NOPERM`. |

### 2.2 The exact sequence: queries, agent decisions, simulations, actions

```
RESET   npm run reset → delete all graphs, load seed.cypher, run action-space rules, run count test
ROUND 1
  RED   turn 1 ∥ amplification_paths(2)           → amplifier gw→co→pay 4.5×, triggers [degrade:payments@0, degrade:ledger-db@1]
             ∥ list_candidates()                 → 10 fault ids
        turn 2  simulate([degrade:payments])      → 0/16 sustained              (sim_budget 6→5)
        turn 3  simulate([degrade:ledger-db])     → 15/16 sustained             (sim_budget 5→4)
        turn 4  commit(submit_scenario)           → server re-run, audit: cost 1 floor → proven: no cheaper attack
                server computes Scenario.scope_ids (15 interventions, 118 futures)
  ACT   world ticks 0–29 with degrade:ledger-db (seed 7); t_off=30 → ALL faults removed; ticks 30–39 (seed 8) → still down
  SNAP  tick 40: orchestrator writes noisy q_est/p_est/hot_est/open_ticks_est onto twin + (:Snapshot)
  BLUE  turn 1  list_candidates(scope=scenario)  → 15 in-scope intervention ids
        turn 2 ∥ fork_and_simulate F0, F1, F2     (3 futures)
        turn 3 ∥ fork_and_simulate F3, F4, F5     (3 futures)
        turn 4  commit_decision(F5)               → rule + per-entry harm + error budget + audit (10 ensembles) → proven-in-scope
  APPLY orchestrator applies retries_off gateway>checkout + checkout>payments to WORLD and TWIN
  OBSERVE 60 ticks (seed 99) → (:Observation) observed 3 vs predicted 2 → calibrate payments 800 → 708.9
          → hardening persisted → action-space rules regenerated
ROUND 2
  RED   turn 1  amplification_paths(2)            → EMPTY (top 0.55×)
        turn 2 ∥ rank_nodes('pagerank')           → ledger-db 0.220
             ∥ list_candidates()
        turn 3  query_graph(pending deploys into ledger-db) → CE-42
        turn 4  simulate([degrade:ledger-db])     → 0/16
        turn 5  simulate([degrade:ledger-db, deploy:CE-42]) → 16/16
        turn 6  commit(submit_scenario)           → audit: 10 singles all 0/16 → proven: no cheaper attack
                scope: 12 interventions, 78 futures
  BLUE  (pre-emptive: before injection; forks start healthy and replay the scenario, horizon 90, tag 202)
        turn 1  list_candidates(scope=scenario)
        turn 2 ∥ fork_and_simulate G1 block_deploy CE-42, G2 breaker orders>ledger-db, G3 scale_out ledger-db
                (G0 do-nothing evaluated by the server as reference)
        turn 3  commit_decision(G3)               → audit 12 candidates at cost ≤ 3 → proven-in-scope
  APPLY scale_out ledger-db to WORLD and TWIN
  INJECT+OBSERVE degrade:ledger-db + CE-42 lands, 90 ticks (seed 77) → 0 violation ticks; world stays green
```

LLM turn counts per phase (a032 §10). Independent calls are issued in parallel within one turn:

| Phase | LLM turns | Tool calls |
|---|---|---|
| RED round 1 | 4 (amplification + list ∥, simulate, simulate, submit) | 5 |
| BLUE round 1 | 4 (list, 3 futures ∥, 3 futures ∥, commit) | 8 |
| RED round 2 | 6 (amplification, rank + list ∥, query CEs, simulate, simulate, submit) | 7 |
| BLUE round 2 | 3 (list, 3 futures ∥, commit) | 5 |
| **Total** | **17** | **25** |

### 2.3 Timed run sheet (a032 §10)

**Pacing.** The world clock runs at **5 ticks/s**, only during ACT and OBSERVE. It is **frozen while an agent decides**, and the UI says so ("world paused · ARGUS deciding · 6.1 s"). Freezing changes nothing in the outcome, because the state being decided on is metastable. Trace steps are emitted at least **1.5 s** apart. At tick 30 the orchestrator holds for **4 s** on the `TRIGGER REMOVED` banner, then runs 10 more ticks.

**Timing rule.** Replay paces each LLM turn at 1.5 s. In live mode the LLM's latency replaces that pacing. Every live turn has a hard ceiling of **6 s** by default, and turns measured at rehearsal take 2–6 s, so each live turn adds 0.5–4.5 s over replay. **[IMPL-NOTE, 15 Oct 2026]** The free-tier reasoning models actually available (§14.5) take 4–15 s per turn, so a live presentation may raise the ceiling with `npm run demo -- --mode live --ceiling-ms 20000`; the table below then stretches by up to ~14 s per LLM turn.

| Segment | LLM turns | Replay | Fully live (replay + 0.5n … 4.5n) | Content |
|---|---|---|---|---|
| RED round 1 | 4 | 8 s | 10–26 s | amplification, list, 2× simulate, submit + audit |
| Inject ticks 0–29 | – | 6 s | 6 s | world goes red along the path, from the database up |
| Hold + ticks 30–39 | – | 6 s | 6 s | banner; still red |
| BLUE round 1 | 4 | 12 s | 14–30 s | snapshot, list, 6 futures, commit + audit |
| Observe 60 ticks | – | 12 s | 12 s | recovery; overlay 2 vs 3 |
| RED round 2 | 6 | 12 s | 15–39 s | the pivot and the audit |
| BLUE round 2 | 3 | 7 s | 8.5–20.5 s | list, 3 futures, commit + audit |
| Inject + observe 90 ticks | – | 18 s | 18 s | stays green next to the flat red do-nothing line |
| **Total** | **17** | **81 s** | **89.5–157.5 s** | |

### 2.4 Live vs replayed

- **Stage plan ("live where it matters").** Acts 1–2 run in **replay**. **Act 3's RED pivot runs live** (6 turns), because that is where the autonomy claim is made. Machine time is 81 s + (3 to 27 s) = **84–108 s**, which leaves at least **2 min 12 s** of the 4-minute slot for narration (the narration is written for 2 min 10 s).
- **If the venue network is good** (pre-demo check: p95 turn under 3 s), the **whole run goes live**: 81 + 17 × 1.5 = **≤ 106.5 s**. If the check fails, only the 6-turn pivot is live.
- **What replay means, said on stage:** "the LLM's choices are replayed; every query, simulation and audit you see is executing now."
- **Replay mode** replays only the LLM's decisions, from a cassette. Every tool call, simulation, audit and graph write executes live, and no numbers are replayed.

### 2.5 How the second RED attack works

After round 1, both amplifier edges (`gateway>checkout`, `checkout>payments`) have `retries = 0` in twin and world, and payments' twin capacity is calibrated to 708.9 (`cap_sd` 0.03). The amplification query's worst path becomes mobile-gw→orders→ledger-db at **0.55×**, below `min_risk = 2`, so it returns **empty**. The query reads *current* retries only. A pending ChangeEvent is not yet config, which is exactly why round 2 needs a different tool. RED calls `rank_nodes('pagerank')`, gets top **ledger-db (0.220)**, queries pending ChangeEvents that modify an edge into ledger-db, and finds **CE-42** (orders→ledger-db retries 0→3). `degrade:ledger-db` alone gives 0/16; `degrade:ledger-db + deploy:CE-42` gives **16/16**. Submission text: "CE-42 turns a routine database slowdown into a permanent outage: 150 rps × fanout 2 × 4 attempts = 1,200 rps against 550 (2.2×), and the deploy does not go away when the slowdown does."

### 2.6 How the demo resets

`npm run reset`: **delete all graphs, load `seed.cypher`, regenerate the action-space rules, re-run the count test.** It takes **under 2 s** and is also available as a UI button. `reset` also deletes `fork:*`. Tool outputs are deterministic after `reset`, so a replayed run's cassette keys match the recorded ones exactly.

### 2.7 How determinism and reliable replay are guaranteed

- **PRNG:** mulberry32 + Box-Muller. JS and Python integer streams are bit-identical (seed 1001 gives 606341916, 1148489751, 477154826, 1429770400 in both).
- **Specified seeds and common random numbers** (§7.7). Every candidate future sees the same capacity draws.
- **Robustness gate:** every stage verdict must hold for seed-set tags 1–20.
- **LLM at temperature 0**, plus a canonically keyed **cassette** (§14.3).
- **Deterministic ids,** `ORDER BY` everywhere, fixed graph coordinates.
- **Charge-once budgets** and **delete-then-copy forks** (§4.4), so retries and crashes cannot change state.
- **B5 deterministic autopilot** with a takeover rule (§14.1), so the demo **never depends on one successful LLM response**.
- **Pinned Docker** FalkorDB, a recorded backup video, and a second laptop.

---

## 3. WORLD / TWIN architecture

### 3.1 The exact distinction

| | `world` | `twin` |
|---|---|---|
| Meaning | Hidden ground truth | What ARGUS believes |
| Graph name | `world` | `twin` |
| Who can access it | `argus-app` orchestrator only (FalkorDB user **admin**) | Orchestrator (admin) and `argus-mcp` (ACL user **agent**) |
| Payments capacity | `cap_mean` **704**, `cap_sd` **0** | `cap_mean` **800**, `cap_sd` **15%** |
| Other services `cap_sd` | 0 | 5% |
| Live dynamic state | Advanced tick by tick by the orchestrator's world clock (in memory; ticks are **not** written to the graph) | Only a noisy **snapshot** written at decision time (`q_est`, `p_est`, `hot_est`, `open_ticks_est`) |
| Used for | ACT (injection), APPLY, OBSERVE, world checks | RED simulations, BLUE forks, all agent reads |

**[IMPL-INTERPRETATION]** a032 says the orchestrator "owns WORLD", "Do NOT write every simulation tick", and that `sim.js` runs on whatever graph it is given. The world's live tick state (`q`, `p`, `hot`, `open`) is therefore held in orchestrator memory and produced by the same `sim.js` step function run on `loadModel('world')`. The `world` graph holds the true configuration and receives applied interventions and landed deploys.

### 3.2 Hidden WORLD state

Everything in `world` is hidden from the agent: the true payments capacity (704), `cap_sd = 0`, and the live per-tick state. The stretch-goal hidden dependency `inventory→ledger-db` (§3.5) would also exist only in `world`.

### 3.3 TWIN state

The seed topology (§8.1) with payments at 800 and `cap_sd` 15%; all `Fault`, `Intervention`, `Round`, `Scenario`, `Future`, `Decision`, `Observation`, `Step`, `Charge` and `Snapshot` nodes; snapshot estimates written at decision time; and calibrated values after OBSERVE.

### 3.4 Permissions and ACL separation

```
FalkorDB (Docker, pinned):  `world` (admin only)   `twin`   `fork:<round>:<future>`
Redis ACL:  user agent  →  ~twin ~fork:* ~argus:*  +GRAPH.RO_QUERY +GRAPH.QUERY +GRAPH.COPY …
```

- The MCP server connects as Redis ACL user **`agent`**, with key patterns `~twin ~fork:* ~argus:*`. `GRAPH.RO_QUERY world …` gets `NOPERM` from FalkorDB itself.
- A **graph-name allowlist** in the MCP server is a second layer, and the fallback if ACL key patterns don't cover `GRAPH.*` on the pinned version. The agent process never receives the admin password.
- **The database user separates the agent from the world, not RED from BLUE.** Both role processes use the one `agent` user. RED/BLUE separation is by process, argv and server checks. Per-role ACL users are a hardening step, not claimed.
- **TBD:** the full ACL command list (a032 writes `…` after `+GRAPH.COPY`), and the purpose of the `argus:*` key pattern (a032 allows it but never says what is stored there).

### 3.5 How ARGUS accesses each graph

| Actor | `world` | `twin` | `fork:*` |
|---|---|---|---|
| Orchestrator (`argus-app`, admin) | Read config via `loadModel('world')`; write applied interventions and landed deploys; runs the world clock | Writes `Snapshot`, applies interventions, writes `Observation`/`CALIBRATED`, regenerates action spaces | Deletes all on `reset` |
| `argus-mcp` (agent) | **No access (`NOPERM`)** | `GRAPH.RO_QUERY` for reads; server-template writes (`Charge`, `Scenario`, `Future`, `Decision`, `Step`) | `GRAPH.COPY twin fork:…`, template writes, `loadModel('fork:…')` |
| LLM | Never directly; only through MCP tools | Through tools; `query_graph` is read-only | Never names a graph; tools take ids |

### 3.6 How mismatch is created (every mismatch is a difference in graph data)

| Mismatch | WORLD graph (hidden) | TWIN graph (believed) | Where it shows |
|---|---|---|---|
| Capacity error | payments `cap_mean` 704, `cap_sd` 0 | 800, `cap_sd` 15% | Pred-vs-obs on the fix (median 2 vs observed 3); calibration 800 → 709 |
| Observation noise | true metrics | observed × (1 + obs_noise·N), obs_noise = 0.05 | The snapshot is an *estimate*; R1.11 shows the decision is robust to it |
| Hidden dependency (**stretch**) | `inventory→ledger-db` exists | edge absent | Round-2 stretch: ledger load above prediction → `SUSPECTED` edge. **Not validated yet; re-run the gates if added.** |

An earlier breaker-cooldown mismatch was **cut**: once the breaker stopped being the selected fix, it never influenced a decision or a screen.

**Snapshot estimate:** `q_est = q·(1+obs_noise·N)`, `p_est = clip(p·(1+obs_noise·N), 0, 1)`. Breaker timers (`hot`, `open`) are copied exactly, since a mesh exposes breaker state. **TBD:** the PRNG seed for snapshot noise. a032 specifies seed `5000 + i` only for calibration noise.

### 3.7 How predictions are compared with reality

- The selected future's twin band (p10–p90) and median violation ticks are overlaid on WORLD's observed curve during OBSERVE.
- An `(:Observation {observed_viol_ticks, observed_ttr, pred_error})-[:VERIFIES]->(:Decision)` is written.
- Round 1: predicted median **2** (p10–p90 1–3), observed **3**. Round 2: predicted 0 (0–0), observed **0**.
- "Is that number fake?" Click a future, then "show rollouts": the 16 raw curves with their seeds. Re-run one live; the same seed gives the same curve.

### 3.8 Calibration mechanism (a032 §4, about 30 lines; code in Appendix A `calibrate`)

- **Window:** every world tick of the round (ACT and OBSERVE) on which the service had a non-empty queue (`q > 0`, so served = μ) **and no fault was applied to it** (a degraded tick measures 0.6μ, not μ).
- **Sample:** observed served = true served × (1 + obs_noise·N), with a noise seed of `5000 + i` for service *i* (i = index in `ORDER`). One draw per tick, used or not.
- **Update, only if n ≥ 10:** `cap_mean ← mean`, `cap_sd ← max(SE, 0.03·cap_mean)`, where SE = stdev/√n.
- **Round 1:** payments qualifies on **41** ticks (ticks 2–39 of ACT, plus the first ticks of OBSERVE): mean **708.9**, SE **5.3**, so 800 → **708.9** with `cap_sd` **21.3** (the 3% floor). ledger-db qualifies on only **6** ticks (it was degraded during ACT), so it is **left unchanged**.
- **Write:** `(:Observation)-[:CALIBRATED {before:800, after:708.9, n:41, se:5.3}]->(:Service {name:'payments'})`.
- On stage: "true value 704, 0.7% error, and the twin keeps ±3% uncertainty."

**[IMPL-NOTE] Units of `cap_sd`.** §3 of a032 states `cap_sd` as a percentage (5%, 15%). The rollout formula is `μ = max(1, cap_mean + N·cap_sd·cap_mean) × degrade`, so `cap_sd` is a **fraction of `cap_mean`**. Appendix A's `calibrate` returns `cap_sd = max(se, 0.03·mean)/mean` (a fraction, 0.03), while §4's prose gives "cap_sd → 21.3" (the absolute value, 0.03 × 708.9). **Store `cap_sd` as a fraction** (0.05, 0.15, 0.03) and display the absolute value. The round-2 twin is "payments `cap 708.9`, `sd 0.03`".

---

## 4. FalkorDB architecture

### 4.1 Graph names

| Graph | Created by | Contents |
|---|---|---|
| `world` | `npm run reset` (seed, world variant) | True topology and config; applied interventions; landed deploys |
| `twin` | `npm run reset` (seed, twin variant) | Believed topology, action spaces, rounds, scenarios, futures, decisions, observations, trace, charges, snapshots |
| `fork:<round>:<future>` e.g. `fork:R1:F5` | `fork_and_simulate`, via `GRAPH.COPY twin …` | Twin copy (config **and** snapshot state) with one candidate applied |
| scratch fork for RED `simulate` | `simulate` ("`loadModel` on a scratch fork") | **TBD:** exact naming. **[IMPL-INTERPRETATION]** `fork:<round>:red:<call_id>`, inside the `fork:*` ACL pattern. |

### 4.2 Graph lifecycle

```
reset  → GRAPH.DELETE world, twin, fork:*  → load seed.cypher into world and twin
       → run action-space rules on twin → count test (10/27/376; scopes 15→118, 12→78)
round  → RED reads twin, simulates on scratch forks → Scenario on twin
       → (reactive) orchestrator writes Snapshot on twin
       → BLUE: GRAPH.COPY twin fork:R<n>:<F> per candidate → apply template → loadModel(fork) → 16 rollouts
       → Future summary written on twin; the fork is KEPT (inspectable in FalkorDB Browser during Q&A)
       → commit → Decision on twin
       → orchestrator applies the Intervention to world AND twin → OBSERVE → Observation + calibration on twin
       → action-space rules regenerated on twin
next round → same graphs carry the hardening (graph memory)
```

### 4.3 `GRAPH.COPY` usage and fork naming

- One `GRAPH.COPY` per candidate future. Forks are named after the round and future: `fork:R1:F5`, and `future_id` is derived from `call_id` (e.g. `fork:R1:F5`).
- **Delete-then-copy:** `DEL fork:R1:F5` (a no-op if absent), then `GRAPH.COPY twin fork:R1:F5`, so a half-finished earlier attempt can never make the copy fail or leave a stale fork.
- The copy includes config **and** snapshot state, so a reactive future starts from the live state at the moment of decision.
- **[IMPL-NOTE]** a032 writes `DEL fork:R1:F5`. A FalkorDB graph is a Redis key, so `DEL` works, but `GRAPH.DELETE fork:R1:F5` is the module-native equivalent. Check on Day 1 which one the `agent` ACL user is permitted to run.
- **Fallback if `GRAPH.COPY` is missing:** `forkGraph()` reads the nodes and edges and bulk-`CREATE`s them. Trivial at 8 nodes.

### 4.4 Crash safety (a032 §9)

The `Future` node is written last, in one query, and it is the **commit point**. A crash before it leaves at most a stale fork, which the delete-then-copy step removes, and a `Charge`, which stops a second charge. A crash after it makes the retry return the stored Future. In every case the re-run produces the same graph state and charges the budget once. `Scenario`, `Decision` and `Step` use `MERGE` on deterministic ids.

### 4.5 Graph persistence

FalkorDB runs locally in **Docker, with a pinned version**, through a pinned docker compose. Every demo starts from `npm run reset`, so no state needs to survive between demos. **TBD:** whether a persistent volume (RDB/AOF) is configured. a032 does not specify one.

### 4.6 Graph mutations (who changes what)

| Mutation | Graph | Writer |
|---|---|---|
| Seed ingest, explicit defaults | world, twin | `ingest.js` via reset |
| Action-space rules (Fault, Intervention) | twin (**[IMPL-INTERPRETATION]** also world, harmlessly; a032 says only "the rules run at ingest and again after every hardening") | ingest / orchestrator |
| Budget charges (`Charge`, `Round` counters) | twin | MCP server |
| `Scenario`, `EVIDENCED_BY`, `scope_ids` | twin | MCP server (`commit`, RED) |
| `Snapshot` + `q_est`, `p_est`, `hot_est`, `open_ticks_est` | twin | orchestrator |
| Intervention templates | `fork:*` | MCP server (`fork_and_simulate`) |
| `Future` + `TESTS`/`FROM`/`PRODUCES` | twin | MCP server |
| `Decision` + `SELECTS`/`ADDRESSES`/`BASED_ON` | twin | MCP server (`commit`, BLUE) |
| Applied intervention | world **and** twin | orchestrator (APPLY) |
| Deploy landing (`status:'landed'`, retries changed) | world (round-2 injection) | orchestrator |
| `Observation` + `VERIFIES`, `CALIBRATED`; calibrated `cap_mean`/`cap_sd` | twin | orchestrator |
| `Step` + `NEXT`, `TOUCHED` | twin | MCP server, on every MCP call |

### 4.7 Graph memory

Hardening persists in the graph: edited CALLS retries, capacity, breaker flags and ChangeEvent status. It changes the next round's evidence and regenerates the action spaces. For example, once retries are 0, `retries_off`/`cap_retries` on that edge are no longer generated. Calibrated capacities persist. Scenarios, Futures, Decisions, Observations and Steps accumulate across rounds as the audit trail.

### 4.8 Decision traces

Every MCP call is persisted as `(:Step {i, role, tool, args, cypher, summary, ms})`, chained by `(:Step)-[:NEXT]->(:Step)` and linked by `(:Step)-[:TOUCHED]->(:Service)`. A Decision links to its Steps through `(:Decision)-[:BASED_ON]->(:Step)`. The demo's close opens FalkorDB Browser on `Decision → Step → Service`.

### 4.9 Why FalkorDB is indispensable (a032 §15.2, honest version)

> Any database could be forced to do each job. The defensible claim is that **one graph is at once the model, the action space, the fork substrate, the algorithm engine, the shared state and the trace.** Postgres would need recursive CTEs for the amplifier and the downstream closure, schema cloning for forks, and hand-written PageRank; that amounts to rebuilding a graph database.

### 4.10 Exactly what breaks if FalkorDB is removed ("Remove FalkorDB" slide)

| Removed | Consequence |
|---|---|
| The model | `sim.js` has no topology or constants of its own; `loadModel(graph)` is its only input. **Nothing to simulate.** |
| The action space | Faults and Interventions are generated by Cypher rules over the topology. **RED and BLUE have nothing valid to choose; every tool id fails validation.** |
| Forks and snapshot | Counterfactual futures are `GRAPH.COPY` forks carrying live snapshot state. **No futures.** |
| The safety constraint | `error_budget`, `rec_threshold`, SLO and horizons live on `(:Round)`. **No selection rule.** |
| The evidence | Amplifier path, downstream closure, PageRank, blast radius. **No multi-hop reasoning.** |
| The memory | Hardening, calibration and the round history live in the graph. **No iterative hardening.** |
| The access boundary | WORLD/TWIN separation is enforced by FalkorDB ACL (`NOPERM`). **No honest prediction claim.** |
| Shared state | Budgets, rounds, scenarios and futures cross processes only through FalkorDB. **MCP processes cannot coordinate or recover after a crash.** |
| The trace | Steps and Decisions. **No explainability.** |

---

## 5. Complete graph schema

### 5.1 Global constraints

- **Ingest writes every property explicitly**, including `entry:false`, `breaker:false`, `shed:0`, `status:'pending'` and `q_est:0`. No property may be null, because in Cypher `NOT null` is null and a `WHERE` would silently drop the row. Rules still use `coalesce(…)` defensively.
- **The seed CALLS graph is a DAG, checked at ingest** (Day-1 test: zero lagged edges).
- All ids are deterministic. `ORDER BY` is used in every list-returning query.
- **[IMPL-INTERPRETATION]** Uniqueness of `id`/`name` per label is required by a032's `MERGE` semantics. Whether to create FalkorDB indices or constraints is **TBD**.

### 5.2 Nodes

#### `Service`
| Property | Type | Example (twin seed) | Meaning |
|---|---|---|---|
| `name` | string, unique | `'payments'` | Service id |
| `entry` | bool | `false` | Entry point (gateway, mobile-gw) |
| `ext_rps` | float | `0` (gateway `300`) | External arrival rate |
| `cap_mean` | float | `800` (world `704`) | Mean capacity, rps |
| `cap_sd` | float (fraction, see §3.8) | `0.15` (world `0`) | Twin's capacity uncertainty |
| `base_ms` | float | `80` | Base latency |
| `queue_s` | float | `2.0` | Queue bound in seconds of capacity (`queue_max = queue_s·μ`) |
| `shed` | float | `0` | Fraction of entry traffic shed |
| `q_est` | float | `0` (snapshot: noisy `q`) | Snapshot queue estimate |
| `pagerank` | float | **[IMPL-NOTE]** only if the JS-PageRank fallback is used | Fallback-stored PageRank |

- **Purpose:** the system model. `cap_sd` holds the twin's uncertainty.
- **Read by:** `loadModel`, every RED/BLUE query, the UI. **Written by:** ingest; the orchestrator (snapshot `q_est`, calibration, scale_out, shed on APPLY); MCP fork templates (on forks only).
- **Relationships:** `CALLS` (out/in), the target of `APPLIES_TO`, `MODIFIES`, `EVIDENCED_BY`, `CALIBRATED`, `TOUCHED`.

#### `ChangeEvent`
| Property | Example | Meaning |
|---|---|---|
| `id` | `'CE-42'` | Deploy id |
| `field` | `'retries'` | Config field edited |
| `new_value` | `3` | New value |
| `status` | `'pending'` ∈ {pending, landed, blocked} | State |

- **Purpose:** a pending deploy. It is a source of faults (`deploy:CE-42`), and blocking it is an intervention (`block_deploy`).
- **Seed:** **CE-42** sets `orders→ledger-db` retries 0→3 (a "resilience" PR): `(CE-42)-[:MODIFIES {callee:'ledger-db'}]->(orders)`. **CE-17** sets `checkout→inventory` retries 1→3: `(CE-17)-[:MODIFIES {callee:'inventory'}]->(checkout)`.
- **Written by:** ingest; the `block_deploy` template (`status='blocked'`); deploy landing (`status='landed'`).

#### `Fault`
| Property | Example | Meaning |
|---|---|---|
| `id` | `'degrade:ledger-db'`, `'surge:gateway'`, `'deploy:CE-42'` | Deterministic id |
| `kind` | `'cap_degrade'` ∈ {cap_degrade, surge, deploy} | Kind |
| `magnitude` | `0.6` (degrade), `1.4` (surge); none for deploy | **What the simulator applies** |
| `persistence` | `'transient'` (degrade, surge) / `'persistent'` (deploy) | Removed at `t_off` or not |
| `cost_to_attacker` | `1` | Scenario cost component |

- **Purpose:** **RED's entire action space**, generated by rules (§6.3). 10 on the seed: 6 `degrade`, 2 `surge`, 2 `deploy`.
- **Relationships:** `(:Fault)-[:APPLIES_TO]->(:Service)`; `(:Fault {kind:'deploy'})-[:LANDS]->(:ChangeEvent)`. A deploy fault applies to the **caller**, whose config the deploy edits.
- **Constraint:** a Day-1 test edits `Fault.magnitude` on a scratch fork and asserts the simulated outcome changes.

#### `Intervention`
| Property | Example | Meaning |
|---|---|---|
| `id` | `'retries_off:gateway>checkout'`, `'scale_out:ledger-db'`, `'block_deploy:CE-42'` | Deterministic id |
| `kind` | ∈ {retries_off, cap_retries, breaker, scale_out, shed, block_deploy} | Kind |
| `caller`, `callee` | `'checkout'`, `'payments'` | Edge endpoints (edge kinds) |
| `factor` | scale_out `1.5`, shed `0.10`, cap_retries `1` | **What the simulator applies** |
| `cost` | retries_off 1, cap_retries 1, breaker 2, scale_out 3, shed 4, block_deploy 1 | Selection cost |

- **Purpose:** **BLUE's entire action space**, generated by rules. 27 on the seed: 6 retries_off, 2 cap_retries, 9 breaker, 6 scale_out, 2 shed, 2 block_deploy.
- **Relationships:** `(:Intervention)-[:APPLIES_TO]->(:Service)` (edge kinds apply to the caller); `(:Intervention {kind:'block_deploy'})-[:BLOCKS]->(:ChangeEvent)`.
- **Constraint:** a pair may not put both `retries_off` and `cap_retries` on the same edge (removes 2 pairs, leaving **376** futures of at most 2).
- **[IMPL-INTERPRETATION] id formats** for `scale_out`, `shed` and `block_deploy` follow Appendix A's `kind:target` convention (`scale_out:ledger-db`, `shed:gateway`, `block_deploy:CE-42`). a032 shows only the edge-kind id formats in Cypher.

#### `Round`
| Property | Value (stage) | Meaning |
|---|---|---|
| `n` | 1, 2 | Round number |
| `sim_budget` | 6 | RED simulate calls |
| `fork_budget` | 6 | BLUE futures |
| `tool_budget` | 14 | Tool calls per role per round |
| `autopilot_reserve` | 3 | B5-only reserve after takeover |
| `audit_sims` | uncapped counter | Server verification ensembles (shown separately) |
| `mode` | `'stage'` ∈ {stage, research} | Audit behaviour |
| `error_budget` | 10 | Max median violation ticks per horizon |
| `rec_threshold` | 15 | Of 16 rollouts |
| `t_off` | 30 | Transient-fault removal tick |
| `horizon_reactive` | 60 | Reactive future horizon |
| `horizon_preemptive` | 90 | Pre-emptive / RED horizon |
| `slo_goodput` | 0.99 | SLO goodput |
| `slo_latency_ms` | 800 | SLO latency midpoint |
| `slo_width_ms` | 80 | SLO sigmoid width |
| `arrival_noise` | 0.05 | Arrival noise |
| `obs_noise` | 0.05 | Observation noise |

- **Purpose:** budgets, the explicit safety constraint and the SLO definition, held as shared state. `loadModel` reads it.
- **Written by:** ingest (**[IMPL-INTERPRETATION]** one `Round` per round, created at round start by the orchestrator); budget charges (MCP server); `audit_sims` (MCP server).
- **TBD:** whether budgets are per role on separate properties. a032 says `tool_budget` is "14 per role per round" but stores one `tool_budget` on `(:Round)`. **[IMPL-INTERPRETATION]** Use `red_tool_budget`/`blue_tool_budget` or a per-role Round.

#### `Scenario`
| Property | Example | Meaning |
|---|---|---|
| `id` | **TBD** format (**[IMPL-INTERPRETATION]** `S:R1`) | Id |
| `round` | 1 | Round |
| `sustained_k` | 15 | Rollouts (of 16) where the SLO stays violated |
| `minimality` | `'proven: no cheaper attack'` | Audit result |
| `evidence_path` | `['gateway','checkout','payments','ledger-db']` | **For display only** |
| `scope_ids` | 15 intervention ids | **Computed by the server** (§10.3), never taken from the agent |
| `proposed_by` | `'llm'` ∈ {llm, b5} | Who proposed it |

- **Relationships:** `(:Scenario)-[:CONTAINS]->(:Fault)`, `(:Scenario)-[:EVIDENCED_BY {order}]->(:Service)`, `(:Scenario)-[:PRODUCES]->(:Future)`.
- **Written by:** the MCP server at RED `commit`.

#### `Charge`
| Property | Example | Meaning |
|---|---|---|
| `id` | `sha256(round, role, tool, canonical args)` | `call_id`, the idempotency key |
| `tool` | `'simulate'` | Tool |
| `round` | 1 | Round |
| `counter` | `'sim_budget'` | Which counter was charged |

- **Purpose:** charge-once budgets. A repeated or retried identical call is free.

#### `Snapshot`
| Property | Example | Meaning |
|---|---|---|
| `id` | **TBD** format (**[IMPL-INTERPRETATION]** `SNAP:R1:40`) | Id |
| `tick` | 40 | World tick |
| `round` | 1 | Round |
| `mode` | `'reactive'` | Only reactive rounds snapshot |

- **Purpose:** marks the live state that futures start from. The state itself lives on `Service.q_est` and on CALLS `p_est`, `hot_est`, `open_ticks_est` (about 35 numbers). Written once per decision by the orchestrator.

#### `Future`
| Property | Example (F5) | Meaning |
|---|---|---|
| `id` | `'fork:R1:F5'` | Derived from `call_id` |
| `graph` | `'fork:R1:F5'` | Fork graph name |
| `p_recover` | 16/16 | Recovered rollouts |
| `viol_ticks_p50` | 2 | Median violation ticks |
| `p10`, `p90` | 1, 3 | Band |
| `viol_by_entry` | json: per-rollout ticks per entry | Feeds the harm test |
| `cost` | 2 | Sum of intervention costs |
| `verdict` | `'green'` ∈ {green, amber, red} | Rendering |
| `bands` | json | Per-tick band for the UI overlay |
| `audit` | bool | Evaluated by the audit (not the agent) |

- **Relationships:** `(:Future)-[:TESTS]->(:Intervention)`, `(:Future)-[:FROM]->(:Snapshot)`, `(:Scenario)-[:PRODUCES]->(:Future)`.
- **Constraint:** written **last**, in one query. It is the commit point.

#### `Decision`
| Property | Example | Meaning |
|---|---|---|
| `id` | **TBD** format | Id |
| `round` | 1 | Round |
| `rule` | the selection rule applied | **TBD** exact encoding |
| `minimality` | `'proven-in-scope'` | Audit result |
| `rationale` | LLM text | Agent's stated reason |
| `proposed_future` | `'fork:R1:F5'` | What the agent first proposed (kept even if the audit corrects it) |
| `proposed_by` | `'llm'` ∈ {llm, b5} | Who proposed it |
| `audit_sims` | 10 | Audit cost |

- **Relationships:** `(:Decision)-[:ADDRESSES]->(:Scenario)`, `(:Decision)-[:SELECTS]->(:Intervention)`, `(:Decision)-[:BASED_ON]->(:Step)`.
- **A valid outcome** is `NO_SAFE_ACTION`. **TBD:** how it is encoded (**[IMPL-INTERPRETATION]** `minimality:'NO_SAFE_ACTION'` and no `SELECTS` edge).

#### `Observation`
| Property | Example (round 1) | Meaning |
|---|---|---|
| `id` | **TBD** format | Id |
| `observed_viol_ticks` | 3 | World result |
| `observed_ttr` | **TBD** (time to recovery; not given numerically) | |
| `pred_error` | **TBD** definition (**[IMPL-INTERPRETATION]** observed − predicted median = 1) | |

- **Relationships:** `(:Observation)-[:VERIFIES]->(:Decision)`, `(:Observation)-[:CALIBRATED {before, after, n, se}]->(:Service)`.

#### `Step`
| Property | Example | Meaning |
|---|---|---|
| `i` | 3 | Sequence index |
| `role` | `'red'` | Role |
| `tool` | `'simulate'` | Tool |
| `args` | `{fault_ids:['degrade:ledger-db']}` | Arguments |
| `cypher` | the Cypher executed | Shown under each trace line |
| `summary` | `'15/16 sustained'` | One-line result |
| `ms` | 140 | Duration |

- **Relationships:** `(:Step)-[:NEXT]->(:Step)`, `(:Step)-[:TOUCHED]->(:Service)`.
- **Purpose:** the decision trace. Every MCP call is persisted.

### 5.3 Relationships

| Type | From → To | Properties | Purpose | Written by |
|---|---|---|---|---|
| `CALLS` | Service → Service | `fanout, retries, timeout_ms, breaker, trip_p, trip_ticks, cooldown, p_est, hot_est, open_ticks_est` | Call graph + resilience config + snapshot state | ingest; APPLY; templates; snapshot |
| `APPLIES_TO` | Fault → Service; Intervention → Service | – | Where a fault/intervention acts (edge kinds and deploys → caller) | rules |
| `MODIFIES` | ChangeEvent → Service (**the caller**) | `callee` | The CALLS edge a deploy edits is `(caller)-[:CALLS]->(callee)` | ingest |
| `LANDS` | Fault{deploy} → ChangeEvent | – | The deploy fault lands this CE | rules |
| `BLOCKS` | Intervention{block_deploy} → ChangeEvent | – | The intervention blocks this CE | rules |
| `CONTAINS` | Scenario → Fault | – | Scenario's faults (≤ 2) | MCP commit |
| `EVIDENCED_BY` | Scenario → Service | `order` | Display evidence path | MCP commit |
| `PRODUCES` | Scenario → Future | – | Futures for this scenario | MCP fork |
| `TESTS` | Future → Intervention | – | Interventions tested (≤ 2) | MCP fork |
| `FROM` | Future → Snapshot | – | Starting state (reactive) | MCP fork |
| `ADDRESSES` | Decision → Scenario | – | Decision's scenario | MCP commit |
| `SELECTS` | Decision → Intervention | – | Chosen interventions | MCP commit |
| `BASED_ON` | Decision → Step | – | Trace evidence | MCP commit |
| `VERIFIES` | Observation → Decision | – | Reality check | orchestrator |
| `CALIBRATED` | Observation → Service | `before, after, n, se` | Calibration record | orchestrator |
| `NEXT` | Step → Step | – | Trace order | MCP |
| `TOUCHED` | Step → Service | – | Services a step touched | MCP |
| `SUSPECTED` | (stretch) | **TBD** | Hidden-dependency hypothesis | **TBD** |

**CALLS breaker properties on the seed:** `breaker:false, trip_p:0.5, trip_ticks:5, cooldown:10` on every edge.

---

## 6. Complete Cypher

### 6.1 Seed topology ingest — **[IMPL-INTERPRETATION]**

a032 specifies `topology.yaml` (the §3 tables, world and twin), `ingest.js` with explicit defaults, and `seed.cypher`, but does not write the CREATE statements. The following is derived exactly from a032's tables (twin variant; the world variant changes only `payments.cap_mean = 704` and every `cap_sd = 0`).

```cypher
// Services (twin). cap_sd as a fraction (see §3.8 IMPL-NOTE)
CREATE (:Service {name:'gateway',   entry:true,  ext_rps:300, cap_mean:5000, cap_sd:0.05, base_ms:20, queue_s:2.0, shed:0, q_est:0}),
       (:Service {name:'mobile-gw', entry:true,  ext_rps:150, cap_mean:5000, cap_sd:0.05, base_ms:20, queue_s:2.0, shed:0, q_est:0}),
       (:Service {name:'auth',      entry:false, ext_rps:0,   cap_mean:1500, cap_sd:0.05, base_ms:30, queue_s:2.0, shed:0, q_est:0}),
       (:Service {name:'checkout',  entry:false, ext_rps:0,   cap_mean:2000, cap_sd:0.05, base_ms:40, queue_s:2.0, shed:0, q_est:0}),
       (:Service {name:'orders',    entry:false, ext_rps:0,   cap_mean:1000, cap_sd:0.05, base_ms:40, queue_s:2.0, shed:0, q_est:0}),
       (:Service {name:'payments',  entry:false, ext_rps:0,   cap_mean:800,  cap_sd:0.15, base_ms:80, queue_s:2.0, shed:0, q_est:0}),
       (:Service {name:'inventory', entry:false, ext_rps:0,   cap_mean:4000, cap_sd:0.05, base_ms:30, queue_s:2.0, shed:0, q_est:0}),
       (:Service {name:'ledger-db', entry:false, ext_rps:0,   cap_mean:550,  cap_sd:0.05, base_ms:20, queue_s:2.0, shed:0, q_est:0});

// CALLS edges (fanout, retries, timeout_ms); breaker defaults on all
UNWIND [
  ['gateway','auth',1,1,300],      ['gateway','checkout',1,2,1000],
  ['mobile-gw','auth',1,1,300],    ['mobile-gw','orders',1,0,1000],
  ['checkout','payments',1,3,500], ['checkout','inventory',1,1,300],
  ['orders','ledger-db',2,0,300],  ['orders','inventory',1,1,300],
  ['payments','ledger-db',0.2,0,300]
] AS e
MATCH (a:Service {name:e[0]}), (b:Service {name:e[1]})
CREATE (a)-[:CALLS {fanout:e[2], retries:e[3], timeout_ms:e[4], breaker:false,
                    trip_p:0.5, trip_ticks:5, cooldown:10,
                    p_est:0, hot_est:0, open_ticks_est:0}]->(b);

// Pending ChangeEvents (MODIFIES points to the CALLER)
MATCH (o:Service {name:'orders'}), (c:Service {name:'checkout'})
CREATE (:ChangeEvent {id:'CE-42', field:'retries', new_value:3, status:'pending'})-[:MODIFIES {callee:'ledger-db'}]->(o),
       (:ChangeEvent {id:'CE-17', field:'retries', new_value:3, status:'pending'})-[:MODIFIES {callee:'inventory'}]->(c);

// Round 1 constants
CREATE (:Round {n:1, sim_budget:6, fork_budget:6, tool_budget:14, autopilot_reserve:3, audit_sims:0,
                mode:'stage', error_budget:10, rec_threshold:15, t_off:30,
                horizon_reactive:60, horizon_preemptive:90,
                slo_goodput:0.99, slo_latency_ms:800, slo_width_ms:80,
                arrival_noise:0.05, obs_noise:0.05});
```

### 6.2 `loadModel(graph)` — **[IMPL-INTERPRETATION]**

a032: "`loadModel(graphName)`, a single Cypher read that returns services, CALLS edges (with breaker settings), ChangeEvents and snapshot state", plus the `(:Round)` constants, plus Fault magnitudes and Intervention factors. The single-read shape below is an interpretation. If one query proves awkward, several reads inside one function call are acceptable as long as nothing comes from code.

```cypher
MATCH (s:Service)
WITH collect(s {.*}) AS services
MATCH (a:Service)-[c:CALLS]->(b:Service)
WITH services, collect({caller:a.name, callee:b.name, fanout:c.fanout, retries:c.retries,
       timeout_ms:c.timeout_ms, breaker:c.breaker, trip_p:c.trip_p, trip_ticks:c.trip_ticks,
       cooldown:c.cooldown, p_est:c.p_est, hot_est:c.hot_est, open_ticks_est:c.open_ticks_est}) AS edges
OPTIONAL MATCH (ce:ChangeEvent)-[m:MODIFIES]->(caller:Service)
WITH services, edges, collect({id:ce.id, caller:caller.name, callee:m.callee, field:ce.field,
       new_value:ce.new_value, status:ce.status}) AS ces
OPTIONAL MATCH (f:Fault)-[:APPLIES_TO]->(fs:Service)
WITH services, edges, ces, collect({id:f.id, kind:f.kind, magnitude:f.magnitude,
       persistence:f.persistence, target:fs.name}) AS faults
OPTIONAL MATCH (i:Intervention)
WITH services, edges, ces, faults, collect(i {.*}) AS interventions
MATCH (r:Round) WITH services, edges, ces, faults, interventions, r ORDER BY r.n DESC LIMIT 1
OPTIONAL MATCH (snap:Snapshot {round:r.n})
RETURN services, edges, ces, faults, interventions, r {.*} AS round, snap {.*} AS snapshot
```

**[IMPL-NOTE]** `world` contains no `Fault`/`Intervention`/`Round` nodes if rules are run only on the twin. The orchestrator then supplies the fault/intervention magnitudes and Round constants by reading them from `twin` (graph data either way), or the rules and the `Round` node are also written to `world`. **TBD:** which of the two.

### 6.3 Action-space rules (a032 §3, verbatim)

```cypher
// RED: every non-entry service can degrade (capacity ×0.6); every entry can surge (×1.4); every pending deploy can land
MATCH (s:Service) WHERE coalesce(s.entry,false) = false
MERGE (f:Fault {id:'degrade:'+s.name})
  SET f.kind='cap_degrade', f.magnitude=0.6, f.persistence='transient', f.cost_to_attacker=1
MERGE (f)-[:APPLIES_TO]->(s);
MATCH (s:Service) WHERE coalesce(s.entry,false) = true
MERGE (f:Fault {id:'surge:'+s.name})
  SET f.kind='surge', f.magnitude=1.4, f.persistence='transient', f.cost_to_attacker=1
MERGE (f)-[:APPLIES_TO]->(s);
MATCH (c:ChangeEvent {status:'pending'})-[:MODIFIES]->(s:Service)      // s = the caller
MERGE (f:Fault {id:'deploy:'+c.id})
  SET f.kind='deploy', f.persistence='persistent', f.cost_to_attacker=1
MERGE (f)-[:APPLIES_TO]->(s) MERGE (f)-[:LANDS]->(c);

// BLUE: config edits cost 1 per edge, a breaker 2, capacity 3, shedding 4
MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE coalesce(c.retries,0) >= 1
MERGE (i:Intervention {id:'retries_off:'+a.name+'>'+b.name})
  SET i.kind='retries_off', i.caller=a.name, i.callee=b.name, i.cost=1
MERGE (i)-[:APPLIES_TO]->(a);
MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE coalesce(c.retries,0) > 1
MERGE (i:Intervention {id:'cap_retries:'+a.name+'>'+b.name})
  SET i.kind='cap_retries', i.caller=a.name, i.callee=b.name, i.cost=1
MERGE (i)-[:APPLIES_TO]->(a);
MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE coalesce(c.breaker,false) = false
MERGE (i:Intervention {id:'breaker:'+a.name+'>'+b.name})
  SET i.kind='breaker', i.caller=a.name, i.callee=b.name, i.cost=2
MERGE (i)-[:APPLIES_TO]->(a);
// scale_out per non-entry service: factor 1.5, cost 3;  shed per entry: factor 0.10, cost 4;
// cap_retries above also sets factor 1 (the new retry cap);
// block_deploy per pending CE (cost 1, with -[:BLOCKS]->(c))
```

**[IMPL-INTERPRETATION]** The last three rules are described in a032's comment but not written out:

```cypher
MATCH (s:Service) WHERE coalesce(s.entry,false) = false
MERGE (i:Intervention {id:'scale_out:'+s.name})
  SET i.kind='scale_out', i.factor=1.5, i.cost=3
MERGE (i)-[:APPLIES_TO]->(s);
MATCH (s:Service) WHERE coalesce(s.entry,false) = true
MERGE (i:Intervention {id:'shed:'+s.name})
  SET i.kind='shed', i.factor=0.10, i.cost=4
MERGE (i)-[:APPLIES_TO]->(s);
MATCH (i:Intervention {kind:'cap_retries'}) SET i.factor = 1;
MATCH (c:ChangeEvent {status:'pending'})-[:MODIFIES]->(s:Service)
MERGE (i:Intervention {id:'block_deploy:'+c.id})
  SET i.kind='block_deploy', i.cost=1
MERGE (i)-[:APPLIES_TO]->(s) MERGE (i)-[:BLOCKS]->(c);
```

**[IMPL-NOTE] Regeneration after hardening.** a032 says that once retries are 0, `retries_off`/`cap_retries` on that edge "are no longer generated". `MERGE` alone does not delete stale nodes, so regeneration must first delete the `Fault`/`Intervention` nodes that are no longer valid (or delete all and regenerate). Do this only for nodes not referenced by historical `Future`/`Decision` nodes. **TBD:** the exact deletion strategy that preserves history. The round-2 count of 12 in-scope interventions requires that no retry interventions exist on in-scope edges.

**Count test (Day 1):** 10 faults; 55 scenarios of ≤ 2 faults; 27 interventions; **376** futures of ≤ 2 (pairs with both `retries_off` and `cap_retries` on the same edge excluded).

### 6.4 Amplifier-path discovery + trigger set (a032 §6; hop count corrected, see changelog)

```cypher
// (a) amplifier: capacity-bounded, breaker-aware worst-case load along each path
MATCH p = (e:Service {entry:true})-[:CALLS*1..5]->(s:Service)
WITH p, e, s, nodes(p) AS ns, relationships(p) AS rs
WITH p, s, reduce(L = toFloat(e.ext_rps), i IN range(0, size(rs)-1) |
       (CASE WHEN L > ns[i].cap_mean THEN ns[i].cap_mean ELSE L END)
       * rs[i].fanout
       * (CASE WHEN rs[i].breaker THEN 1 ELSE 1 + rs[i].retries END)
     ) AS worst_load
WITH p, s, worst_load / s.cap_mean AS overload
WHERE overload >= $min_risk
// (b) trigger set: failures propagate UP through ok_v and are retried at the amplifier,
//     so any fault on the target or beneath it can light the storm
MATCH q = (s)-[:CALLS*0..4]->(d:Service)<-[:APPLIES_TO]-(f:Fault)
WITH p, s, overload, f, min(length(q)) - 1 AS hops   // q ends in one APPLIES_TO edge; hops counts CALLS only
ORDER BY overload DESC, hops, f.id
RETURN [n IN nodes(p) | n.name] AS amplifier, s.name AS target, overload,
       collect(f.id + '@' + toString(hops)) AS triggers
LIMIT 5
```

**[IMPL-NOTE]** If `*0..` is unsupported on the pinned version, `UNION` the target's own faults with `*1..4`. This is a Day-1, hour-1 check.

**[IMPL-NOTE] (M6/M8, 2026-10-07)** The implementation (`argus/runtime/tools.js`) makes two changes to this query:
1. It adds `WHERE coalesce(f.active, true)` to the trigger match, so that after regeneration (§6.3) only active faults count.
2. It orders **after** the aggregation (`ORDER BY overload DESC, target, amplifier` before `LIMIT 5`). The pre-aggregation `ORDER BY` above leaves the row order unspecified when several amplifiers qualify; FalkorDB 6.0.1 returned a 4.5× row ahead of an 8.7× one. The single-amplifier canonical results are unchanged.

| Round | Result (`min_risk = 2`) |
|---|---|
| 1 (seed) | amplifier gateway→checkout→payments **4.5×** (300 × 3 × 4 / 800); triggers `[degrade:payments@0, degrade:ledger-db@1]`. `deploy:CE-42` applies to orders, which is not beneath payments, so it is correctly absent. |
| 2 (retries 0 on both amplifier edges, payments 709) | top path mobile-gw→orders→ledger-db at 0.55×, so **nothing reaches 2**. The result is empty. |

### 6.5 Downstream traversal

The downstream closure is part (b) of §6.4: `(t)-[:CALLS*0..4]->(x)`. Scope queries (2) and (3) in §6.9 also use downstream closures `(e)-[:CALLS*0..6]->(:Service)`.

### 6.6 Blast radius — partly **[IMPL-INTERPRETATION]**

a032 gives the pattern `(:Service)-[:CALLS*1..6]->(x)`, which returns upstream services and entries that depend on a node, with hop counts. Full query (interpretation):

```cypher
MATCH p = (u:Service)-[:CALLS*1..6]->(x:Service {name:$service})
RETURN u.name AS upstream, u.entry AS is_entry, min(length(p)) AS hops
ORDER BY hops, upstream
```

### 6.7 PageRank — **[IMPL-NOTE]**

a032 specifies `algo.pageRank` but not its call signature. Expected FalkorDB form (verify on the pinned version, Day 1 H1):

```cypher
CALL algo.pageRank('Service', 'CALLS') YIELD node, score
RETURN node.name AS service, score ORDER BY score DESC, service
```

**Fallback:** compute PageRank in JS from CALLS edges, write `s.pagerank`, and have the tool read that. **Reference values (networkx check):** ledger-db 0.220, inventory 0.164, auth 0.137, payments 0.119, checkout 0.106, orders 0.106, gateway 0.074, mobile-gw 0.074. The topology is unchanged by hardening, so the ranking holds in round 2. **TBD:** the damping factor and iteration count. The reference values are a networkx check, whose default damping is 0.85; confirm FalkorDB reproduces the ordering, with ledger-db on top.

### 6.8 Pending deploys into the PageRank target (RED round 2, a032 §7, verbatim)

```cypher
MATCH (c:ChangeEvent {status:'pending'})-[m:MODIFIES]->(a:Service)-[:CALLS]->(b:Service {name:'ledger-db'})
WHERE m.callee = b.name RETURN c.id, a.name, b.name ORDER BY c.id
```

### 6.9 Scope computation (BLUE, server-only; a032 §8, verbatim)

```cypher
// (1) upstream, for every fault: entry → faulted service (zero-length when t is an entry)
MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault)-[:APPLIES_TO]->(t:Service)
MATCH p = (e:Service {entry:true})-[:CALLS*0..6]->(t)
RETURN [n IN nodes(p) | n.name] AS ns, [r IN relationships(p) | startNode(r).name+'>'+endNode(r).name] AS es
// (2) surge: the entry's downstream closure
MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault {kind:'surge'})-[:APPLIES_TO]->(e:Service)
MATCH p = (e)-[:CALLS*0..6]->(:Service)
RETURN [n IN nodes(p) | n.name] AS ns, [r IN relationships(p) | startNode(r).name+'>'+endNode(r).name] AS es
// (3) deploy: the edited edge and everything beneath its callee
MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault {kind:'deploy'})-[:LANDS]->(:ChangeEvent)-[m:MODIFIES]->(a:Service)
MATCH (a)-[:CALLS]->(b:Service) WHERE b.name = m.callee
MATCH p = (b)-[:CALLS*0..6]->(:Service)
RETURN [a.name] + [n IN nodes(p) | n.name] AS ns,
       [a.name+'>'+b.name] + [r IN relationships(p) | startNode(r).name+'>'+endNode(r).name] AS es
```

The server unions `ns` and `es` in JS, selects the interventions whose `caller>callee` is in `es` or whose service is in `ns`, adds the `block_deploy` ids for each ChangeEvent the scenario lands, and writes `Scenario.scope_ids`. **Nothing is `UNWIND`-ed**, so a zero-length path (a surge on an entry) still returns its node. **An empty scope is an error, never "audit satisfied".**

### 6.10 Intervention discovery (`list_candidates`) — **[IMPL-INTERPRETATION]**

```cypher
// RED: all faults
MATCH (f:Fault)-[:APPLIES_TO]->(s:Service)
RETURN f.id, f.kind, s.name AS target, f.cost_to_attacker ORDER BY f.id
// BLUE: interventions in the scenario's server-computed scope
MATCH (sc:Scenario {id:$scenario_id}) MATCH (i:Intervention) WHERE i.id IN sc.scope_ids
RETURN i.id, i.kind, i.caller, i.callee, i.cost ORDER BY i.cost, i.id
```

Output also carries live counts of the scoped and unscoped space (e.g. 118 / 376).

### 6.11 Budget charge (a032 §5, verbatim; `sim_budget` variant)

```cypher
// the sim_budget variant; fork_budget / tool_budget / autopilot_reserve differ only in the property
MATCH (r:Round {n:$n})
OPTIONAL MATCH (c:Charge {id:$call_id})
WITH r, c WHERE c IS NOT NULL OR r.sim_budget > 0       // already paid, or budget left
MERGE (k:Charge {id:$call_id})
  ON CREATE SET k.tool = $tool, k.round = $n, k.counter = 'sim_budget', r.sim_budget = r.sim_budget - 1
RETURN r.sim_budget
```

An empty result means the budget is exhausted. FalkorDB executes queries on one graph serially, so the check-and-charge is atomic. Cypher cannot parameterise a property name, so the server holds **three fixed query strings**, one per counter (`sim_budget`, `fork_budget`, `tool_budget`), plus the `autopilot_reserve` variant.

### 6.12 Id validation (a032 §9) — **[IMPL-INTERPRETATION]** of "MATCH … count = size($ids)"

```cypher
MATCH (f:Fault) WHERE f.id IN $ids RETURN count(f) = size($ids) AS valid
```

### 6.13 Snapshot write (a032 §9, verbatim, abbreviated in source)

```cypher
MATCH (s:Service {name:$n}) SET s.q_est = $q                                   // 8 values
MATCH ()-[c:CALLS]->() ... SET c.p_est = $p, c.hot_est = $h, c.open_ticks_est = $o   // 9 edges
CREATE (:Snapshot {id, tick:T, round, mode:'reactive'})                        // ~35 numbers, once
```

**[IMPL-INTERPRETATION]** of the elided edge match:

```cypher
MATCH (:Service {name:$caller})-[c:CALLS]->(:Service {name:$callee})
SET c.p_est = $p, c.hot_est = $h, c.open_ticks_est = $o
```

### 6.14 Fork creation (a032 §9)

```
DEL fork:R1:F5            (no-op if absent; [IMPL-NOTE] or GRAPH.DELETE)
GRAPH.COPY twin fork:R1:F5
```

### 6.15 Intervention templates: fixed, never LLM-written (a032 §9, verbatim)

```cypher
// retries_off:
MATCH (:Service {name:$caller})-[c:CALLS]->(:Service {name:$callee}) SET c.retries = 0
// cap_retries:
MATCH (:Service {name:$caller})-[c:CALLS]->(:Service {name:$callee})
SET c.retries = CASE WHEN c.retries > 1 THEN 1 ELSE c.retries END
// breaker (the edge's own trip_p, trip_ticks, cooldown apply):
MATCH (:Service {name:$caller})-[c:CALLS]->(:Service {name:$callee}) SET c.breaker = true
// scale_out:
MATCH (s:Service {name:$svc}) SET s.cap_mean = s.cap_mean * 1.5
// shed:
MATCH (s:Service {name:$entry}) SET s.shed = 0.10
// block_deploy:
MATCH (c:ChangeEvent {id:$id}) SET c.status = 'blocked'
```

**[IMPL-NOTE]** a032 §3 rule 3 requires every parameter to come from the graph, and Appendix A applies `fac['scale_out']`, `fac['shed']` and `fac['cap_retries']`. The templates should therefore read `Intervention.factor` (`SET s.cap_mean = s.cap_mean * i.factor`) rather than hard-coding 1.5 / 0.10 / 1. The numbers are identical.

The same templates are used by the orchestrator in **APPLY**, against `world` and `twin` (this is the hardening change).

### 6.16 Deploy landing (fault template, a032 §4) — **[IMPL-INTERPRETATION]** as Cypher

```cypher
MATCH (ce:ChangeEvent {id:$id, status:'pending'})-[m:MODIFIES]->(a:Service)-[c:CALLS]->(b:Service)
WHERE b.name = m.callee
SET c.retries = ce.new_value, ce.status = 'landed'
// if status = 'blocked': no-op (the MATCH on status:'pending' finds nothing)
```

In rollouts, faults are applied in memory by the simulator (Appendix A `set_faults`). This Cypher applies only when a deploy lands in `world` (round-2 injection). **TBD:** whether the landing in `world` is mirrored to `twin`.

### 6.17 Scenario creation — **[IMPL-INTERPRETATION]**

```cypher
MERGE (sc:Scenario {id:$id})
  SET sc.round=$round, sc.sustained_k=$k, sc.minimality=$minimality,
      sc.evidence_path=$evidence, sc.scope_ids=$scope_ids, sc.proposed_by=$proposed_by
WITH sc
MATCH (f:Fault) WHERE f.id IN $fault_ids MERGE (sc)-[:CONTAINS]->(f)
WITH sc
UNWIND range(0, size($evidence)-1) AS i
MATCH (s:Service {name:$evidence[i]}) MERGE (sc)-[:EVIDENCED_BY {order:i}]->(s)
```

### 6.18 Future creation (commit point, one query) — **[IMPL-INTERPRETATION]**

```cypher
MATCH (sc:Scenario {id:$scenario_id})
OPTIONAL MATCH (snap:Snapshot {id:$snapshot_id})
MERGE (fu:Future {id:$future_id})
  SET fu.graph=$graph, fu.p_recover=$p_recover, fu.viol_ticks_p50=$p50, fu.p10=$p10, fu.p90=$p90,
      fu.viol_by_entry=$viol_by_entry_json, fu.cost=$cost, fu.verdict=$verdict,
      fu.bands=$bands_json, fu.audit=$audit
MERGE (sc)-[:PRODUCES]->(fu)
FOREACH (_ IN CASE WHEN snap IS NULL THEN [] ELSE [1] END | MERGE (fu)-[:FROM]->(snap))
WITH fu
MATCH (i:Intervention) WHERE i.id IN $intervention_ids MERGE (fu)-[:TESTS]->(i)
```

**[IMPL-NOTE]** If FalkorDB stores JSON as a string, `viol_by_entry` and `bands` are JSON strings. **TBD:** how the do-nothing future (F0/G0) is represented. It tests no `Intervention`; **[IMPL-INTERPRETATION]** the future has no `TESTS` edge (Appendix A uses `'none:x'`).

### 6.19 Decision recording — **[IMPL-INTERPRETATION]**

```cypher
MATCH (sc:Scenario {id:$scenario_id})
MERGE (d:Decision {id:$id})
  SET d.round=$round, d.rule=$rule, d.minimality=$minimality, d.rationale=$rationale,
      d.proposed_future=$proposed_future, d.proposed_by=$proposed_by, d.audit_sims=$audit_sims
MERGE (d)-[:ADDRESSES]->(sc)
WITH d
MATCH (i:Intervention) WHERE i.id IN $selected_ids MERGE (d)-[:SELECTS]->(i)
WITH d
MATCH (st:Step) WHERE st.role = $role AND st.round = $round MERGE (d)-[:BASED_ON]->(st)
```

**[IMPL-NOTE]** `Step` has no `round` property in a032's schema. To scope `BASED_ON`, either add `round` to `Step` or link by Step ids collected during the phase. **TBD.**

### 6.20 Step persistence — **[IMPL-INTERPRETATION]**

```cypher
CREATE (st:Step {i:$i, role:$role, tool:$tool, args:$args_json, cypher:$cypher, summary:$summary, ms:$ms})
WITH st
OPTIONAL MATCH (prev:Step {i:$i - 1}) FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | MERGE (prev)-[:NEXT]->(st))
WITH st
MATCH (s:Service) WHERE s.name IN $touched MERGE (st)-[:TOUCHED]->(s)
```

### 6.21 Observation and calibration — **[IMPL-INTERPRETATION]** (the edge itself is a032 verbatim)

```cypher
MATCH (d:Decision {id:$decision_id})
CREATE (o:Observation {id:$id, observed_viol_ticks:$viol, observed_ttr:$ttr, pred_error:$err})-[:VERIFIES]->(d)
WITH o
MATCH (s:Service {name:'payments'})
CREATE (o)-[:CALIBRATED {before:800, after:708.9, n:41, se:5.3}]->(s)
SET s.cap_mean = 708.9, s.cap_sd = 0.03
```

### 6.22 Shortest path / "Why?" explanation — **TBD; [IMPL-INTERPRETATION]**

a032: "A 'Why?' click renders trigger → … → entry SLO" with shortest path, kept because it is cheap. It is also the 4th item on the cut list, falling back to the stored `EVIDENCED_BY` path. The query is not given. Interpretation:

```cypher
MATCH (e:Service {entry:true}), (t:Service {name:$trigger})
MATCH p = shortestPath((e)-[:CALLS*]->(t))
RETURN [n IN nodes(p) | n.name] AS path ORDER BY length(p) LIMIT 1
```

**[IMPL-NOTE]** Verify `shortestPath` support and syntax on the pinned FalkorDB. Fallback: the `EVIDENCED_BY {order}` path.

### 6.23 Reset — **[IMPL-INTERPRETATION]**

```
GRAPH.DELETE world ; GRAPH.DELETE twin ; for each key matching fork:* → GRAPH.DELETE
load seed.cypher into world (world variant) and twin (twin variant)
run §6.3 rules ; run count test
```

---

## 7. Simulator

### 7.1 Overview

A **fluid (rate-based), discrete-time** model, about **150 lines of JS** (`sim.js`, pure functions), ported from the Python reference in Appendix A with **an identical PRNG and identical seeds**. It is imported by **both** processes. One tick is **1 simulated second**.

**Hard constraint, enforced in code:** `sim.js` has no topology or constants of its own. Its **only input is `loadModel(graphName)`**. It does not know whether the graph is `world`, `twin` or a fork. Code holds only the equations and their shape constants: the sigmoid width factor 0.1 in `p_timeout`, the 10-tick recovery window, the `max(1, …)` capacity floor, the `0.999999` clamp, the sigmoid overflow guard ±50, and the 1000 ms factor. **A Day-2 test greps `sim.js` for numeric literals outside the equation-shape whitelist.** **TBD:** the exact whitelist.

### 7.2 How `loadModel(graph)` works

1. A single Cypher read (§6.2) against the named graph returns services, CALLS edges (with breaker settings and snapshot estimates), ChangeEvents, fault magnitudes, intervention factors, the `(:Round)` constants, and the snapshot marker.
2. It builds the in-memory model (equivalent to Appendix A's `base_model(kind)`): `svc` (ext, cap, base, sd, qmax_s, surge=1, shed, degrade=1), `edges` (fanout, retries, timeout, breaker, trip_p, trip_ticks, cooldown), `ces` (edge, retries, status), `mag`, `fac` and `rnd`.
3. It computes the processing **order** with a DFS from the entry points and marks every **back edge** as `lagged` (§7.9). On the seed DAG the order equals Appendix A's fixed `ORDER = ['gateway','mobile-gw','checkout','orders','auth','payments','inventory','ledger-db']` and no edge is lagged.
4. It returns the initial state: `init_state` (all zeros), or in reactive mode the snapshot state (`q ← q_est`, `p ← p_est`, `hot ← hot_est`, `open ← open_ticks_est`).

**[IMPL-NOTE]** The topological order must reproduce Appendix A's draw order exactly for PRNG parity. The arrival-noise draws iterate `ORDER`, so the derived order must equal `ORDER` on the seed graph, or the draw order must be fixed separately. Day-1 PRNG parity and assertion tests catch any drift.

### 7.3 State variables

| Variable | Scope | Meaning |
|---|---|---|
| `q_s` | per service | Queue (requests) |
| `p_e` | per edge | Failure probability **from the previous tick** |
| `hot_e` | per edge | Breaker consecutive-hot counter |
| `open_e` | per edge | Breaker open timer (ticks remaining) |
| `μ_s` | per service per rollout | Sampled capacity × degrade |
| `served_s, dropped_s, work_s, arrivals_s` | per service per tick | Flow quantities |
| `lat_s, ok_s` | per service per tick | Latency and success probability |
| `goodput_s`, violation flag | per entry per tick | SLO |

### 7.4 Equations and tick/update sequence (a032 §4, verbatim)

```
FORWARD pass (topological order), using p_e from tick t−1:
  A_e        = 0                               if breaker on e is open (fail fast, no load)
             = (1 − p_e^{r+1}) / (1 − p_e)     else  (expected attempts per call; → r+1 as p_e → 1)
  arrivals_s = ext_s·surge_s·(1−shed_s)·(1+arrival_noise·N(0,1))  +  Σ_{e=(u→s)} served_u · fanout_e · A_e
  work_s     = q_s + arrivals_s
  served_s   = min(work_s, μ_s)                ← timed-out requests are still served (wasted work)
  q_s        = min(work_s − served_s, queue_s·μ_s);   dropped_s = overflow beyond that

REVERSE pass (reverse topological order), same tick:
  for each edge e=(s→v):
     if open_e > 0:  p_e = 1; open_e −= 1; if open_e == 0: p_e = 0, hot_e = 0   (close; half-open probe)
     else:
       p_timeout = σ((lat_v − timeout_e) / (0.1·timeout_e))
       p_drop    = dropped_v / work_v
       p_e       = 1 − (1−p_timeout)(1−p_drop)·ok_v           ← failure propagates UP the tree
       if breaker_e: hot_e = (p_e > trip_p_e) ? hot_e+1 : 0
                     if hot_e ≥ trip_ticks_e: open_e = cooldown_e, p_e = 1
  lat_s      = base_s + 1000·q_s/μ_s + max_{e=(s→v), not open} min(lat_v, timeout_e)
  ok_s       = Π_{e=(s→v)} (1 − p_e^{r_e+1})

GOODPUT and SLO (entry services only; the constants are read from (:Round)):
  goodput_s  = (1 − dropped_s/work_s) · ok_s · (1 − σ((lat_s − slo_latency_ms)/slo_width_ms))
  entry s violated at tick ⇔ goodput_s < slo_goodput              (stored per entry)
  tick violated  ⇔ any entry violated
  recovered      ⇔ no violated tick in the last 10 ticks of the horizon
  viol_ticks     = violated ticks over the horizon (horizon_reactive 60, horizon_preemptive 90)
  viol_by_entry  = per-entry violated ticks, per rollout   (feeds the harm test, §13)
```

The exact executable semantics, including the `min(p, 0.999999)` clamp, the `ok`-only-for-non-open treatment of `down`, and per-tick breaker bookkeeping, are those of Appendix A `step()`.

### 7.5 Mechanism-by-mechanism

| Mechanism | How it is modelled |
|---|---|
| **Load propagation** | Forward pass in topological order: each callee's arrivals = Σ caller `served` × `fanout` × expected attempts `A_e`. |
| **Capacity** | `μ_s = max(1, cap_mean_s + N(0,1)·cap_sd_s·cap_mean_s) × degrade_s`, sampled **once per rollout**. On `world`, `cap_sd = 0`. |
| **Queues** | Bounded: `queue_max = queue_s · μ` (2 s of capacity). Overflow is `dropped`. |
| **Latency** | `base + 1000·q/μ` (queueing delay) + the slowest non-open downstream call, capped at its timeout. |
| **Timeouts** | `p_timeout = σ((lat_v − timeout_e)/(0.1·timeout_e))`. A smooth step at the timeout. |
| **Retry amplification** | `A_e = (1 − p^{r+1})/(1 − p)`: expected attempts per call, → `r+1` as `p → 1`. |
| **Retry limits** | `CALLS.retries`; interventions `retries_off` (→ 0) and `cap_retries` (→ min(1, r)). |
| **Wasted work** | Timed-out requests are still served: `served = min(work, μ)`. This is what lets the storm persist. |
| **Failure propagation** | Reverse pass: `p_e = 1 − (1−p_timeout)(1−p_drop)·ok_v`. A callee's failure propagates **up** through `ok_v`. |
| **Circuit breakers** | Per edge: `hot` counts consecutive ticks with `p > trip_p` (0.5). At `trip_ticks` (5) the breaker opens for `cooldown` (10) ticks: `A = 0` (fail fast, no load), `p = 1`. On close: `p = 0`, `hot = 0` (half-open probe). |
| **Connection pools** | **Deliberately not modelled** (a032). FYP work (§20). |
| **Recovery** | `recovered ⇔ no violated tick in the last 10 ticks of the horizon`. |
| **Shedding / surge** | Entry arrivals × `surge` × `(1 − shed)`. |
| **Metastability** | See §7.6. |

### 7.6 Metastability: the self-sustaining cascade ("say this to the judges")

> ledger-db slows down (550 → 330 rps). Its latency exceeds payments' 300 ms timeout, so payments' calls fail. Failure propagates up, so checkout sees payments failing and **retries 3 times**, and gateway retries checkout **twice**. Payments now receives up to `300 × 3 × 4 = 3,600 rps` against `704 rps` of real capacity. It saturates by tick 2, with its queue full at 1,408. When the database is restored at tick 30, payments' own queueing latency (≈2 s) still exceeds checkout's 500 ms timeout, so every call still fails and is still retried. The inequality to show is `λ·Π(1+r_i) > μ`. It is a checkable inequality, not an animation.

### 7.7 Stochastic behaviour and seeds (fully specified)

- **PRNG:** mulberry32 for integers + Box-Muller for normals (Appendix A `Rng`). Integer streams are bit-identical between JS and Python.
- **Random terms:** per-rollout capacity draws (`cap_sd`) and per-tick per-entry arrival noise (`arrival_noise` 0.05), drawn in fixed `ORDER`. Observation noise applies to snapshots and calibration.
- **Rollout `k`** of an ensemble uses seed **`1000·tag + k`**, k = 0..15.
- **RED simulations:** `tag = 100·round + 1` (round 1 → 101; round 2 → 201).
- **All futures of a round:** `tag = 100·round + 2` (102, 202). These are **common random numbers**: every candidate sees the same capacity draws, so differences come from the intervention, not luck.
- **World runs (fixed seeds):** round 1 ACT ticks 0–29 **seed 7**, ticks 30–39 **seed 8**, OBSERVE **seed 99**; round 2 **seed 77**.
- **Observation noise** for service *i*: seed **`5000 + i`**.
- **Robustness gate:** every stage verdict repeated for tags **1–20**.

### 7.8 Rollout count, horizons and termination

| Run | Rollouts | Initial state | Faults | `t_off` | Horizon |
|---|---|---|---|---|---|
| RED `simulate` | 16 | healthy | scenario | 30 | 90 |
| Reactive future (round 1) | 16 | snapshot (tick 40) | none (already removed) | 0 | **60** |
| Pre-emptive future (round 2) | 16 | healthy | scenario replayed | 30 | **90** |
| World round 1 | 1 | healthy | `degrade:ledger-db` | removed at 30 | ACT 30 + 10; OBSERVE 60 |
| World round 2 | 1 | healthy (hardened) | `degrade:ledger-db` + CE-42 | 30 for transient | 90 |

A rollout terminates at the horizon; there is no early stop. **RED's criterion:** sustained = 16 − recovered; a scenario qualifies at **≥ 8/16** sustained.

**Fault templates (fixed code; the magnitude comes from the `Fault` node):**

| Fault kind | Applied at tick 0 | At the removal tick (`t_off` = 30) |
|---|---|---|
| `cap_degrade` (transient) | `degrade_s = Fault.magnitude` (0.6) | `degrade_s = 1.0` (capacity restored) |
| `surge` (transient) | `surge_s = Fault.magnitude` (1.4) | `surge_s = 1.0` |
| `deploy` (persistent) | if `status = 'pending'`: CALLS `retries = new_value`, `status = 'landed'`; if `'blocked'`: no-op | **unchanged.** A merged config change stays. |

### 7.9 Cyclic call graphs (defined, not assumed away)

`loadModel` computes the order with a DFS from the entry points. Any edge that closes a cycle (a back edge) is marked **`lagged`**. A lagged edge feeds its caller with the callee's `served`, `lat` and `ok` **from tick t−1** (a one-tick propagation delay). Every other edge is processed as above. On a DAG no edge is lagged. A Day-1 test asserts zero lagged edges on the seed, and a unit test runs a 3-node cycle for 200 ticks without error.

### 7.10 Deliberately not modelled

Per-request events, CPU/GC, partitions, autoscaler lag, **connection pools**, and **independent transient errors**. The last one matters: because the model has no random per-call failures, **it cannot price the resilience lost by turning retries off** (§10.8).

---

## 8. Reference numbers

All values are from a032 and are reproduced by Appendix A. **Do not replace them.**

### 8.1 Seed topology (8 services)

| Service | entry | ext_rps | cap_mean (rps) | twin cap_sd | base_ms | queue_s |
|---|---|---|---|---|---|---|
| gateway | true | 300 | 5000 | 5% | 20 | 2.0 |
| mobile-gw | true | 150 | 5000 | 5% | 20 | 2.0 |
| auth | false | 0 | 1500 | 5% | 30 | 2.0 |
| checkout | false | 0 | 2000 | 5% | 40 | 2.0 |
| orders | false | 0 | 1000 | 5% | 40 | 2.0 |
| payments | false | 0 | **800** (world: **704**) | **15%** | 80 | 2.0 |
| inventory | false | 0 | 4000 | 5% | 30 | 2.0 |
| ledger-db | false | 0 | 550 | 5% | 20 | 2.0 |

`shed` = 0 everywhere. The world graph has `cap_sd = 0`.

| CALLS edge | fanout | retries | timeout ms | breaker | trip_p | trip_ticks | cooldown |
|---|---|---|---|---|---|---|---|
| gateway→auth | 1 | 1 | 300 | false | 0.5 | 5 | 10 |
| gateway→checkout | 1 | 2 | 1000 | false | 0.5 | 5 | 10 |
| mobile-gw→auth | 1 | 1 | 300 | false | 0.5 | 5 | 10 |
| mobile-gw→orders | 1 | 0 | 1000 | false | 0.5 | 5 | 10 |
| checkout→payments | 1 | 3 | 500 | false | 0.5 | 5 | 10 |
| checkout→inventory | 1 | 1 | 300 | false | 0.5 | 5 | 10 |
| orders→ledger-db | 2 | 0 | 300 | false | 0.5 | 5 | 10 |
| orders→inventory | 1 | 1 | 300 | false | 0.5 | 5 | 10 |
| payments→ledger-db | 0.2 | 0 | 300 | false | 0.5 | 5 | 10 |

Pending: **CE-42** orders→ledger-db retries 0→3; **CE-17** checkout→inventory retries 1→3.

### 8.2 Key quantities

| Quantity | Value |
|---|---|
| Services | 8 |
| Amplifier | gateway → checkout → payments, **4.5×** (300 × 3 × 4 / 800) |
| Entry load | **300 rps** (gateway), 150 rps (mobile-gw) |
| Amplified load | **300 × 3 × 4 = 3,600 rps** |
| Real payments capacity | **704 rps** (twin believes 800) |
| Payments queue full | 1,408 (by tick 2) |
| Trigger | `degrade:ledger-db` (550 → 330 rps), 3 hops from the entry point, 1 hop below the amplifier |
| Trigger result | **15/16** sustained (robust 14–16/16) |
| Error budget | **10** violation ticks per horizon |
| Recovery threshold | **15/16** rollouts |
| Futures per round | budget **6** (round 1 uses all 6; round 2 uses 3 + server-evaluated G0) |
| Rollouts per ensemble | **16** |
| RED simulation budget | **6** |
| Tool budget | **14** per role per round |
| Autopilot reserve | **3** |
| Fault/intervention spaces | **10** faults, **55** scenarios, **27** interventions, **376** futures |
| Round-1 scope | **15** interventions, **118** futures (5 edges, 6 nodes) |
| Round-2 scope | **12** interventions, **78** futures |
| Panel inequality | 300 × 3 × 4 = 3,600 ≫ 704; 300 × 1 × 1 = 300 < 704; one layer off 300 × 3 = 900 > 704; +50% capacity 1,056 < 3,600 |
| Round-2 inequality | 150 rps × fanout 2 × 4 attempts = 1,200 rps against 550 (**2.2×**) |
| Single-layer option | 300 × 2 = 600 < 704 |
| Predicted vs observed (R1 fix) | predicted median **2** (p10–p90 1–3) vs observed **3** |
| Calibration | payments 800 → **708.9** (n = 41, SE 5.3, cap_sd 21.3 = 3% floor); "800 → 709 (true 704), 0.7% error" |
| PageRank | ledger-db 0.220, inventory 0.164, auth 0.137, payments 0.119, checkout 0.106, orders 0.106, gateway 0.074, mobile-gw 0.074 |
| Round-2 amplifier top | 0.55× (mobile-gw→orders→ledger-db) |
| Clock | 5 ticks/s; frozen while deciding; 4 s hold at tick 30 |
| Live ceiling | 6 s per LLM turn by default (`--ceiling-ms`, §14.5) |
| Run sheet | replay 81 s; fully live 89.5–157.5 s; stage plan 84–108 s |
| Reset | < 2 s |

### 8.3 Reference-run assertions (all are gate tests; "robust" = holds for tags 1–20)

| # | Assertion | Result |
|---|---|---|
| R1.1 | Healthy world stays healthy for 150 ticks | min goodput 0.9997 |
| R1.2 | twin: every single fault except `degrade:ledger-db` is not sustained (≥ 8/16) | all 0/16 at tag 101; **robust max 1/16** (`surge:mobile-gw`, tags 1–20). At the old 1.6× surge this was 3–10/16 and failed the gate. |
| R1.3 | twin: `degrade:ledger-db` sustained | **15/16**; robust 14–16/16 |
| R1.4 | world: same fault breaks the SLO | goodput 0.0 from tick 2; payments pinned at 704 |
| R1.5 | **world, fault removed at tick 30**: still down | goodput 0.0 for ticks 30–39, and for 60 more ticks with no intervention |
| R1.6 | From the tick-40 snapshot (tag 102): do nothing; +50% payments; +50% ledger-db | 0/16 each, robust |
| R1.7 | `retries_off:checkout>payments` alone | 2/16 (robust range 0–5) → fails |
| R1.8 | `breaker:checkout>payments` | 16/16, median 14 → **over error budget**; world 14 |
| R1.9 | `retries_off` on gateway>checkout + checkout>payments | **16/16, median 2 (p10–p90 1–3)**; world 3; robust 16/16, median 2–2.5 |
| R1.10 | Scoped oracle (all 15 singles + 103 pairs in the server-computed scope) | argmin = R1.9 **on all 21 seed sets** (tag 102 and tags 1–20); no cost-1 action qualifies on any |
| R1.11 | Futures verdicts unchanged with a 5%-noisy snapshot | identical counts and medians |
| R1.12 | Calibration of payments | 800 → **708.9** (true 704; n = 41, SE 5.3; cap_sd → 21.3 = 3% floor); ledger-db n = 6 < 10 → unchanged |
| R1.13 | Single-layer option (`cap_retries:gateway>checkout + retries_off:checkout>payments`, cost 2) | tag 102: 16/16, median 4.5, world 10. **Robust: 12–16/16, median 4–8.** Qualifies at the stage tag and loses to R1.9 only on the median tie-break. |
| R2.1 | Hardened twin: amplification query empty at `min_risk = 2` | top 0.55× |
| R2.2 | PageRank top is ledger-db | 0.220 |
| R2.3 | Hardened twin: all 10 single faults | 0/16 sustained each (tag 201) |
| R2.4 | Hardened twin: `degrade:ledger-db + deploy:CE-42` | **16/16**, robust 14–16. **Every other one of the 45 pairs stays below 4/16 on every seed set, tags 1–20.** |
| R2.5 | Pre-emptive futures (tag 202) | do nothing 0/16 recover; block CE-42 16/16 but median 32.5; breaker orders>ledger 16/16 but 30.5; **scale_out ledger-db 16/16, median 0** |
| R2.6 | World checks (seed 77) | do nothing 89 violation ticks; block 32; breaker 31; **scale_out 0** |
| R2.7 | Scoped oracle round 2 (12 singles + 66 pairs) | argmin = scale_out:ledger-db **on all 21 seed sets**; the only qualifying action at cost ≤ 3 |
| R2.8 | World, trigger alone, no deploy, no fix | 32 violation ticks, heals (the slowdown's own cost) |
| H.1 | Per-entry harm (gateway / mobile-gw median violation ticks) | R1: do nothing 60 / 0, breaker 14 / 0, **F5 2 / 0**, +50% payments 60 / 0. R2: do nothing 89.5 / 89, block 32.5 / 32, breaker 16.5 / 28, **G3 0 / 0**. No selected future is harmful on any entry. |
| P.1 | PRNG parity | JS and Python integer streams identical; verdicts and medians identical; traces within 1e-9 |

**History:** the gate has already fired once. At a 1.6× surge, `surge:mobile-gw` was a sustained attack on 8 of 20 seed sets, and `surge:mobile-gw + deploy:CE-42` competed with the staged round-2 scenario (5–11/16). The surge template is now **1.4×**, and every number was re-run.

### 8.4 Futures panels

**Round 1** (from the tick-40 snapshot, 60-tick horizon, tag 102):

| Future | Interventions | Cost | Twin p_recover | Twin median viol. (p10–p90) | Verdict | World check |
|---|---|---|---|---|---|---|
| F0 | do nothing (B0) | 0 | 0/16 | 60 | red | stays down |
| F1 | scale_out payments ×1.5 (runbook) | 3 | 0/16 | 60 | red | stays down |
| F2 | scale_out ledger-db ("fix the root cause") | 3 | 0/16 | 60 | red | stays down |
| F3 | retries_off checkout>payments | 1 | 2/16 | 60 | red | stays down |
| F4 | breaker checkout>payments | 2 | 16/16 | 14 (14–14) | **amber** (over budget) | recovers, 14 |
| F5 | **retries_off gateway>checkout + checkout>payments** | **2** | **16/16** | **2 (1–3)** | **green → selected** | **recovers, 3** |

**Round 2** (pre-emptive, from a healthy start, scenario replayed, 90-tick horizon, tag 202):

| Future | Interventions | Cost | Twin p_recover | Twin median viol. (p10–p90) | Verdict | World check (seed 77) |
|---|---|---|---|---|---|---|
| G0 | do nothing | 0 | 0/16 | 89.5 | red | 89 ticks, stays down |
| G1 | block_deploy CE-42 | 1 | 16/16 | 32.5 (20–33) | **amber** | 32 ticks, heals |
| G2 | breaker orders>ledger-db | 2 | 16/16 | 30.5 (19–32) | **amber** | 31 ticks, heals |
| G3 | **scale_out ledger-db** | **3** | **16/16** | **0 (0–0)** | **green → selected** | **0 ticks** |

---

## 9. RED

### 9.1 Initial graph state

Round 1: the seed twin (§8.1), 10 faults, `Round {n:1, sim_budget:6, tool_budget:14}`. Round 2: the hardened twin (both amplifier edges at retries 0, payments 708.9 / sd 0.03), with regenerated action spaces.

### 9.2 Objective (system prompt, a032 §7, verbatim)

> "Find the cheapest combination of at most 2 faults that, per `simulate`, leaves the entry SLO violated in the last 10 ticks of a 90-tick horizon (transient faults removed at tick 30) in at least 8 of 16 rollouts. You have 6 simulations. Every fault must come from `list_candidates`. Submit it with its multi-hop evidence path. The server will check that no cheaper scenario works."

### 9.3 Tools available

`query_graph`, `amplification_paths`, `rank_nodes`, `blast_radius`, `list_candidates` (faults), `simulate`, `commit` (submit_scenario). RED **never sees** `fork_and_simulate`: `listTools` is role-filtered, and an unlisted call is rejected server-side.

### 9.4 Budget

`sim_budget` 6, `tool_budget` 14 (identical repeated calls are free; invalid-id calls **are** charged), `autopilot_reserve` 3 (B5 only, after takeover).

### 9.5 Candidate generation

Faults come only from the Cypher rules (§6.3): `degrade:<every non-entry service>`, `surge:<every entry>`, `deploy:<every pending CE>`. That gives 10 faults and 55 scenarios of ≤ 2. An unknown id returns `{error:"Fault 'degrade:redis' not in graph"}`.

### 9.6 Round-1 loop

1. `amplification_paths(2)` ∥ `list_candidates()` → amplifier gateway→checkout→payments 4.5×, triggers `[degrade:payments@0, degrade:ledger-db@1]`.
2. `simulate([degrade:payments])` → **0/16** sustained (payments slows, but nothing beneath it fails, so the retries never ignite).
3. `simulate([degrade:ledger-db])` → **15/16** sustained.
4. `commit` (submit_scenario) with evidence path gateway → checkout → payments → ledger-db. The server re-runs it with the same seeds; cost 1 is the floor, so the strictly-cheaper audit runs 0 simulations: **`proven: no cheaper attack`**. That the other 8 single faults stay ≤ 1/16 on every seed set is a **Day-1 gate fact** (R1.2), not a runtime search.

### 9.7 Decision criteria

A scenario qualifies at **≥ 8/16** sustained. Its cost is the sum of `cost_to_attacker` (**[IMPL-INTERPRETATION]**, consistent with "cost 1 is the floor" and round 2 at cost 2). Find the cheapest. The audit certifies only that **nothing strictly cheaper** works.

### 9.8 Strategy change after hardening, and how PageRank enters

1. `amplification_paths(2)` → **empty** (top 0.55×).
2. `rank_nodes('pagerank')` ∥ `list_candidates()` → **ledger-db** (0.220).
3. `query_graph` (§6.8) → **CE-42** (orders→ledger-db retries 0→3).
4. `simulate([degrade:ledger-db])` → 0/16 (on the hardened graph the slowdown now heals).
5. `simulate([degrade:ledger-db, deploy:CE-42])` → **16/16**.
6. `commit`. The audit runs the 10 single faults (cost 1, strictly cheaper): all 0/16 (R2.3), so **proven: no cheaper attack**, at a cost of 10 audit ensembles, shown on screen. The agent spent 2 of its 6 simulations. That this pair is the only one reaching 8/16 is a Day-1 gate fact (R2.4); the server does not re-derive it.

### 9.9 How genuine autonomy is demonstrated, and its honest limits

- 55 candidate scenarios against a budget of 6 simulations: RED **must rank before it simulates**, and graph tools are how it ranks.
- **Tool choice visibly depends on graph state:** the empty amplifier result causes the PageRank pivot. The round-1 and round-2 traces are shown side by side.
- Act 3's pivot runs **live** (`LIVE · LLM`).
- **Honest limits:** RED is autonomous within a graph-bounded space. The audit never finds the attack for RED; RED's budget is real. If the LLM wanders, the takeover rule hands the phase to B5 with an `AUTOPILOT` badge. B5 reproduces both traces exactly. **Whether the LLM adds value over B5 is the research question, not a stage claim.**

### 9.10 Deterministic vs LLM-selected

| LLM selects | Deterministic (server or code) |
|---|---|
| Which tools to call and in what order; which faults to simulate; when to submit; the evidence path to display | Fault generation, id validation, budgets, simulation results (seeded), re-verification, strictly-cheaper audit, scope computation, takeover rule |

---

## 10. BLUE

### 10.1 Trigger

- **Round 1 (reactive):** after ACT, at **tick 40** (fault removed at tick 30, world still down), the orchestrator writes the `Snapshot` and BLUE runs. Forks start from the snapshot; horizon 60.
- **Round ≥ 2 (pre-emptive):** BLUE runs **before injection**. Forks start healthy and replay the scenario; horizon 90. The orchestrator then injects the scenario into world anyway, as a test.

### 10.2 Objective (a032 §8, verbatim)

> "Restore (round 1) or protect (round 2) the entry SLO. Get candidates from `list_candidates(scope=scenario)`. You have 6 futures, each with at most 2 interventions. Commit to one."

### 10.3 Graph queries and intervention candidates

The scope is **computed by the server** (§6.9) from every entry-to-fault path, following the propagation direction of each fault kind. It is never supplied by the agent:

| Fault kind | Propagates | Scope paths |
|---|---|---|
| `cap_degrade` on t | failure goes **up** (through `ok_v`) | every entry → t path |
| `surge` on entry e | load goes **down** | every path from e downward (e's downstream closure) |
| `deploy` landing on edge a→b (the fault `APPLIES_TO` a) | load goes **down** the edited edge; failure of a goes **up** | every entry → a path, plus the edge a→b and b's downstream closure |

- **Round 1** (fault on ledger-db): paths gateway→checkout→payments→ledger-db and mobile-gw→orders→ledger-db; 5 edges, 6 nodes; **15 interventions, 118 futures** (against 376 unscoped).
- **Round 2** (ledger-db degrade + CE-42 editing orders→ledger-db): the same 5 edges and 6 nodes plus block_deploy CE-42; retries are already 0 on every in-scope edge; **12 interventions, 78 futures**.
- Day-1 tests: `{surge:gateway}` gives a scope containing `checkout>payments`; `{deploy:CE-17}` gives one containing `checkout>inventory` and `inventory`; `{degrade:ledger-db}` gives the round-1 counts. An empty scope raises an error.
- The agent's `evidence_path` is only what the UI draws. **It cannot shrink the scope.**

### 10.4 The six futures

Round 1: F0–F5 (§8.4), forked in two parallel turns of 3. Round 2: G1–G3 forked by the agent; G0 evaluated by the server as the reference.

### 10.5 Rollout procedure

`fork_and_simulate(scenario_id, intervention_ids[≤2])`: charge once → delete-then-copy fork → apply fixed templates → `loadModel(fork)` → 16 rollouts with tag `100·round+2` → write `Future` (§11, §4.4).

### 10.6 Intervention scoring

Per future: `p_recover` (rollouts with no violated tick in the last 10), `viol_ticks_p50`, `p10`, `p90`, `viol_by_entry`, `cost` (the sum of intervention costs), and `verdict`:

**Percentile definition (canonical, changelog 2026-10-07).** `viol_ticks_p50` is the ordinary median of the 16 per-rollout violation-tick counts (`statistics.median`). `p10` and `p90` use **nearest-rank** on the sorted counts `v` (n = 16): `pq = v[ceil(q·n) − 1]` (0-based), so p10 = `v[1]` and p90 = `v[14]`. The reference implementation is `band()` in `argus/sim/reference/reproduce.py`.
- **green:** passes the rule (recovers ≥ 15/16 **and** median ≤ error budget, and not harmful);
- **amber:** recovers but is over the error budget;
- **red:** does not recover.

### 10.7 Safety constraints, minimum-cost rule, audit

See §13 (Decision engine).

### 10.8 The honest SRE objection

"Turning retries off entirely is bad practice." This is correct in general. The model has no independent per-call transient errors, so it cannot price the resilience retries buy. Two honest answers: (1) the hardening PR is labelled **emergency mitigation**, with a follow-up to restore one retry layer with a budget; (2) a team policy such as "every path keeps ≥ 1 retry" is **one extra `WHERE`** in the intervention rule. With it, the oracle picks the single-layer combination (300 × 2 = 600 < 704): 16/16, median 4.5 and 10 world bad ticks at the stage seeds, but **12–16/16 across seed sets**, so it is **not a stage claim**. It is a Q&A answer.

### 10.9 Round-2 lesson

Blocking the deploy prevents the *permanent* outage, but the slowdown alone still costs 32 bad ticks (R2.8). With a 10-tick budget, the rule pays for capacity. **With `error_budget = 35`, the same rule selects G1 at cost 1.** This is a Q&A moment: the constraint is a number on a graph node, not a prompt. The PR also attaches the CE-42 scenario evidence as a review comment on the ChangeEvent (information only, no cost).

### 10.10 Intervention application and hardening persistence

APPLY: the orchestrator applies the committed Intervention(s) to **world and twin** using the §6.15 templates, observes (60 ticks in round 1, 90 in round 2), writes the `Observation`, calibrates the twin, persists the hardening, and regenerates the action spaces. The hardening PR is a YAML diff generated from the graph (`js-yaml`); round 1 is `retries: 0` on two edges, labelled *emergency mitigation*. **TBD:** the exact YAML schema.

### 10.11 Why this is counterfactual and not "optimisation over fixed simulations"

1. Each future is a do()-intervention on the structural model. The fork is a modified copy of the graph **including the live state at the moment of decision**. Nothing is precomputed.
2. The candidate set is generated from the scenario's graph neighbourhood. A different scenario produces different futures.
3. The LLM **composes** pairs and chooses which to test, under a budget.
4. The claim is **tested against reality** (predicted vs observed), and the error is stored as an `Observation`.

**Honest note:** at this scale, an exhaustive search over the 118 scoped futures finds the same answer. The defensible claim is: *the agent proposes, the graph bounds, the simulator measures, and the server proves minimality in scope.* F0 ("do nothing from here") is the proof of metastability.

---

## 11. MCP

### 11.1 Process layout (a032 §2, verbatim)

```
┌──────────────── process 1: argus-app (Node.js) ─────────────────┐   ┌── process 2: argus-mcp (Node.js) ──┐
│ React UI ◄─ Socket.IO ─ Orchestrator (round state machine,      │   │ spawned per role:                  │
│ (graph | trace | futures |  world clock, replay, B5 autopilot)  │   │   argus-mcp --role red   (stdio)   │
│  pred-vs-obs)              │ owns WORLD (FalkorDB user: admin)  │   │   argus-mcp --role blue  (stdio)   │
│                            ▼                                    │   │ role read from argv, NOT from the  │
│ Agent runtime (one loop, RED/BLUE objectives)                   │   │ client; listTools shows only that  │
│   LLM via OpenRouter (temp 0) + cassette ── MCP client ─stdio──►│──►│ role's tools; budget on (:Round);  │
│                                                                 │   │ minimality audit at commit         │
│ sim.js (pure functions) — imported by BOTH processes            │   │ sim.js ◄─ loadModel(graph) only    │
└─────────────────────────────────────────────────────────────────┘   └────────────────────────────────────┘
                                   ▼                                                  ▼
             FalkorDB (Docker, pinned):  `world` (admin only)   `twin`   `fork:<round>:<future>`
             Redis ACL:  user agent  →  ~twin ~fork:* ~argus:*  +GRAPH.RO_QUERY +GRAPH.QUERY +GRAPH.COPY …
```

- **Role enforcement:** the runtime spawns `argus-mcp --role red` and `argus-mcp --role blue` (stdio). The server reads its role from its own argv; no tool argument can change it. `listTools` returns only that role's tools, and calls to unlisted tools are rejected server-side.
- **Shared state crosses processes only through FalkorDB.** A crashed MCP process can be respawned without losing state.
- **Interop cameo (30 s, stretch):** point Claude Desktop at `argus-mcp --role red` and ask "what's the riskiest path?".

### 11.2 Tool definitions

The I/O JSON schemas below are **[IMPL-INTERPRETATION]**, derived from a032's tool table and behaviour descriptions. a032 does not give formal schemas. Role, read/write, graph operation and budget are a032. Every call is persisted as a `Step`.

#### 1. `query_graph`
- **Purpose:** read-only Cypher on `twin`; write clauses are rejected.
- **Role:** both. **R/W:** read. **FalkorDB op:** `GRAPH.RO_QUERY twin`. **Budget:** `tool_budget`.
- **Input:** `{ "cypher": string, "params"?: object }`
- **Output:** `{ "columns": string[], "rows": any[][], "cypher": string }` or `{ "error": string }`
- **Ids accepted:** none (free Cypher, read-only, twin only).
- **Track 01:** the agent can explore connected data directly (e.g. pending deploys into ledger-db).
- **Example:** `query_graph({cypher:"MATCH (c:ChangeEvent {status:'pending'})-[m:MODIFIES]->(a:Service)-[:CALLS]->(b:Service {name:'ledger-db'}) WHERE m.callee = b.name RETURN c.id, a.name, b.name ORDER BY c.id"})` → `[["CE-42","orders","ledger-db"]]`

#### 2. `amplification_paths`
- **Purpose:** worst-case retry load per multi-hop path, **plus the trigger set beneath each amplifier**.
- **Role:** both. **R/W:** read. **Op:** variable-length path + `reduce` + downstream closure (§6.4). **Budget:** `tool_budget`.
- **Input:** `{ "min_risk": number }`
- **Output:** `{ "rows": [{ "amplifier": string[], "target": string, "overload": number, "triggers": string[] /* "faultId@hops" */ }] }` (≤ 5)
- **Track 01:** multi-hop reasoning; a graph algorithm as a tool.
- **Example:** `amplification_paths({min_risk:2})` → `[{amplifier:["gateway","checkout","payments"], target:"payments", overload:4.5, triggers:["degrade:payments@0","degrade:ledger-db@1"]}]`; in round 2 → `[]`.

#### 3. `rank_nodes`
- **Purpose:** rank services by `pagerank` or `in_degree`.
- **Role:** both. **R/W:** read. **Op:** `algo.pageRank` (fallback: stored `s.pagerank`). **Budget:** `tool_budget`.
- **Input:** `{ "metric": "pagerank" | "in_degree" }`
- **Output:** `{ "rows": [{ "service": string, "score": number }] }` ordered descending.
- **Track 01:** a graph algorithm as a tool; drives the round-2 pivot.
- **Example:** `rank_nodes({metric:"pagerank"})` → `[{service:"ledger-db",score:0.220},{service:"inventory",score:0.164},…]`
- **TBD:** the `in_degree` definition (it is not used in the stage script).

#### 4. `blast_radius`
- **Purpose:** upstream services and entries that depend on a node, with hop counts.
- **Role:** both. **R/W:** read. **Op:** `(:Service)-[:CALLS*1..6]->(x)` (§6.6). **Budget:** `tool_budget`.
- **Input:** `{ "service": string }` (must be a `Service.name`)
- **Output:** `{ "rows": [{ "upstream": string, "is_entry": boolean, "hops": number }] }`
- **Track 01:** multi-hop traversal; highlights the cascade; bounds the evidence path.
- **Example:** `blast_radius({service:"ledger-db"})` → payments 1, orders 1, checkout 2, mobile-gw 2, gateway 3 (**[IMPL-INTERPRETATION]** derived from the topology).

#### 5. `list_candidates`
- **Purpose:** RED: all faults. BLUE: the interventions in the scenario's **server-computed** scope. Valid ids only, plus live counts of the scoped and unscoped space.
- **Role:** both (role-dependent result). **R/W:** read. **Op:** pattern match. **Budget:** `tool_budget`.
- **Input:** RED `{}`; BLUE `{ "scope": scenario_id }`
- **Output:** `{ "ids": [{ "id": string, "kind": string, "target"?: string, "caller"?: string, "callee"?: string, "cost": number }], "in_scope_futures"?: number, "unscoped_futures": number }`
- **Track 01:** the action space comes from the graph; ids prevent hallucinated actions.
- **Example (BLUE R1):** → 15 ids, `in_scope_futures:118`, `unscoped_futures:376`.

#### 6. `simulate`
- **Purpose:** validate ids, then run 16 rollouts (tag `100·r+1`); transient faults off at tick 30; 90-tick horizon.
- **Role:** **RED only**. **R/W:** writes a scratch fork plus `Charge`/`Step`. **Op:** `loadModel` on a scratch fork. **Budget:** `sim_budget` + `tool_budget`, charged once per `call_id`.
- **Input:** `{ "fault_ids": string[] /* 1..2, Fault ids */ }`
- **Output:** `{ "fault_ids": string[], "sustained": number /* of 16 */, "recovered": number, "median_viol_ticks": number, "tag": number, "sim_budget_left": number }` or `{ "error": "Fault 'degrade:redis' not in graph" }`
- **Track 01:** an action grounded in graph ids; the simulator executes the graph.
- **Example:** `simulate({fault_ids:["degrade:ledger-db"]})` → `{sustained:15, recovered:1, tag:101, sim_budget_left:4}`

#### 7. `fork_and_simulate`
- **Purpose:** `GRAPH.COPY` twin, apply template(s), run 16 rollouts (tag `100·r+2`), write a `Future` with its verdict.
- **Role:** **BLUE only**. **R/W:** writes the fork plus `Future`/`Charge`/`Step` on twin. **Op:** `GRAPH.COPY` + fork writes + summary. **Budget:** `fork_budget` + `tool_budget`, charged once; an already existing Future is returned free.
- **Input:** `{ "scenario_id": string, "intervention_ids": string[] /* 0..2, must be in Scenario.scope_ids */ }`
- **Output:** `{ "future_id": string, "graph": string, "p_recover": number, "viol_ticks_p50": number, "p10": number, "p90": number, "cost": number, "verdict": "green"|"amber"|"red", "fork_budget_left": number }`
- **Track 01:** counterfactual action on a forked graph.
- **Example:** `fork_and_simulate({scenario_id:"S:R1", intervention_ids:["retries_off:gateway>checkout","retries_off:checkout>payments"]})` → `{future_id:"fork:R1:F5", p_recover:16, viol_ticks_p50:2, p10:1, p90:3, cost:2, verdict:"green"}`
- **TBD:** whether an empty `intervention_ids` (do nothing) is an agent-callable future or server-only. a032 says F0/G0 "is always evaluated by the server as the reference, free of the agent's budget … if the agent did not test it", which implies an agent may also test it.

#### 8. `commit`
- **Purpose:** RED → `submit_scenario`; BLUE → `commit_decision`. Re-verifies, enforces the rule, **runs the minimality audit**, writes `Scenario`/`Decision`.
- **Role:** both (role-dependent payload). **R/W:** writes on twin. **Budget:** not charged to `tool_budget`; audit ensembles go to `audit_sims`.
- **Input (RED):** `{ "fault_ids": string[], "evidence_path": string[] }`
- **Input (BLUE):** `{ "future_id": string, "rationale": string }`
- **Output:** `{ "accepted": boolean, "id": string, "minimality": "proven: no cheaper attack" | "proven-in-scope" | "NO_SAFE_ACTION", "audit_sims": number, "rule_winner"?: string /* if rejected, which candidate wins */ }`
- **Track 01:** an explainable, verified, auditable commitment; budgets and the safety constraint live in the graph.
- **Example:** BLUE `commit({future_id:"fork:R1:F5", rationale:"…"})` → `{accepted:true, minimality:"proven-in-scope", audit_sims:10}`

### 11.3 Budgets: three counters, one charge rule

| Counter on `(:Round)` | Charged by | Notes |
|---|---|---|
| `tool_budget` (14 per role per round) | every tool call except `commit` | identical repeated calls are free (same `call_id`); invalid-id calls **are** charged, so wandering costs budget |
| `sim_budget` (6, RED) | `simulate` | also charges `tool_budget` |
| `fork_budget` (6, BLUE) | `fork_and_simulate` | also charges `tool_budget` |
| `autopilot_reserve` (3) | B5 only, after a takeover | shown on screen as reserve, never hidden |
| `audit_sims` (uncapped counter) | the server's audit | never charged to the agent; displayed separately |

`call_id = sha256(round, role, tool, canonical args)`. The `Charge` node is the idempotency key.

### 11.4 Why the MCP layer is real and not a checkbox (a032 §5)

1. **The protocol makes hallucinated actions impossible.** Tools take ids; an unknown id returns an error and the agent has to recover.
2. **Budgets and the safety constraint live in the graph.** The UI shows the meter draining and the error-budget line.
3. **Roles are separated by process and argv; the world is separated from the agent by the database user.**
4. **Tool choice visibly depends on graph state** (the round-2 pivot).
5. **Interop** with any MCP client (Claude Desktop cameo).

**TBD:** the MCP SDK and version. a032 says only "Node.js", "stdio" and "MCP client".

---

## 12. Graph algorithms

### 12.1 Retained (each changes an action, each verifiable live)

| Algorithm | Used by | The action it changes | Status |
|---|---|---|---|
| **Variable-length path + `reduce` (amplification)** | RED, BLUE-B5 | Finds the amplifier path; B5 derives its "path fix" from it | **Core** |
| **Downstream closure** (`(t)-[:CALLS*0..4]->(x)`) | RED | Finds where a trigger must be: anything beneath the amplifier | **Core** |
| **PageRank** | RED | Fallback target when no amplifier exists (round 2) | **Core** |
| **BFS / upstream traversal** (`blast_radius`) | BLUE + UI | Highlights the cascade; bounds the evidence path | **Core** |
| **Shortest path** | Explanation | A "Why?" click renders trigger → … → entry SLO | Keep (cheap) |

- **Amplifier path query (§6.4a):** for every entry→service path of 1–5 hops, fold the worst-case load hop by hop. At each node the incoming load is capped at that node's `cap_mean`, multiplied by `fanout` and by `1 + retries` (or 1 if a breaker is on). It reports paths whose load at the target exceeds `min_risk × cap_mean`. It reads **current** retries only.
- **Downstream query (§6.4b):** from the amplifier's target, every service 0–4 hops beneath it that a `Fault` applies to, with the minimum hop count. Failures propagate **up** through `ok_v` and are retried at the amplifier, so any fault on the target or beneath it can light the storm.
- **PageRank (§6.7):** ranks services by dependency importance; ledger-db is top (0.220) because it is a sink fed by two paths. Used only when no amplifier exists.
- **Blast radius (§6.6):** upstream dependents with hop counts; drives UI highlighting and bounds the evidence path.
- **Shortest path (§6.22):** the "Why?" explanation. 4th on the cut-if-behind list (fallback: the stored `EVIDENCED_BY` path).

### 12.2 Rejected

| Algorithm | Why rejected (a032) |
|---|---|
| **Betweenness** | On this directed graph `ledger-db` scores **0.0** (a sink is never an intermediate). It would point RED **away from the real trigger**. |
| **MaxFlow** | Decorative on a connected 8-node graph; changes no action. |
| **WCC** | Decorative: the graph is one connected component. |
| **CDLP** (community detection) | Decorative on a connected 8-node graph. |
| **MSF** (minimum spanning forest) | Decorative on a connected 8-node graph. |

---

## 13. Decision engine

### 13.1 The selection rule (server-enforced; the LLM cannot override it)

The safety constraint is explicit and lives on `(:Round)`:

```
argmin cost over evaluated futures where
    p_recover ≥ rec_threshold (15/16)
AND median violation ticks ≤ error_budget (10)
AND not harmful
followed by the rule-complete minimality audit
Ties: lower median violation ticks, then lexical id.
```

- **`harmful`:** for **some entry**, the future's median violation ticks **on that entry** exceed do-nothing's median on that entry. It is computed from `Future.viol_by_entry`; common random numbers make the comparison paired. Example: a breaker on mobile-gw→orders that helps gateway but costs mobile-gw ticks is rejected as harmful. On the stage scenarios no selected future is harmful (H.1).
- **The do-nothing future F0/G0 is always evaluated by the server** as the reference, free of the agent's budget, and counted in `audit_sims` if the agent did not test it.
- **If nothing qualifies,** BLUE spends more budget or commits **`NO_SAFE_ACTION`**, which is a valid outcome.

### 13.2 The audit (verification, counted as verification)

The audit runs at `commit`, outside the agent's budget. Every ensemble it runs increments `audit_sims`. The screen shows both numbers: "agent: 2 simulations · audit: 0" and "agent: 6 futures · audit: 10".

- **`stage` mode, BLUE: rule-complete.** The server evaluates **every untested in-scope candidate with cost ≤ the committed cost**, with the same seeds, and applies the full selection rule (tie-break included) to the union. If the rule's winner differs, **the commit is rejected**, the agent is told which candidate wins, and `Decision.proposed_future` keeps what the agent first proposed. So the *committed* decision equals the scoped oracle's argmin; the *proposal* is the agent's own. Round 1: 10 audit ensembles, about 0.1 s ("3 cost-1 singles, 4 other breakers, and 3 cost-2 retry pairs including the single-layer option at 16/16, median 4.5"). Round 2: 12 candidates at cost ≤ 3.
- **`stage` mode, RED: strictly cheaper only.** It proves "no cheaper attack exists" and nothing more. Round 1 (cost 1) needs 0 audit simulations; round 2 (cost 2) needs the 10 singles. The audit never searches the 45 pairs, so RED's budget is real.
- **`research` mode:** the audit is off for every policy. The commit is whatever the policy proposed (§19).

The stage claim is therefore narrow and true: **"the agent found this within its budget; the server then spent N more ensembles proving nothing cheaper qualifies."**

#### 13.2.1 Audit bound — **[IMPL-INTERPRETATION]** (M5, 2026-10-07)

This section does **not** change the canonical decision rule (§13.1) or the canonical audit statement above. It records how the implementation (`argus/graph/decision.js`, `commitDecision`) determines "the committed cost", because the spec does not define it when the proposal does not itself qualify.

- **The audit evaluates every untested in-scope candidate with cost ≤ the bound**, as real forked futures (`audit: true`). It counts them in `Round.audit_sims` and never charges them to the agent.
- **How the bound is determined (BLUE, stage mode):**
  `bound = max(cost(proposal), cost(cheapest qualifying future among those already evaluated))`.
  Here "qualifying" means the §13.1 rule, including the per-entry harm test against the do-nothing reference. If no evaluated future qualifies, the second term is ignored and `bound = cost(proposal)`.
  - When the proposal qualifies, it is itself a qualifying evaluated future, so the rule's evaluated winner costs no more than the proposal and **`bound = cost(proposal)`**. This is exactly the canonical "cost ≤ the committed cost". The canonical round 1 (proposal F5, cost 2) is this case: 10 audit futures, all at cost ≤ 2.
  - When the proposal does not qualify (red or amber) and a costlier evaluated future does, the bound rises to that future's cost.
- **`NO_SAFE_ACTION` differs:** it carries no cost, and its claim is "no candidate in scope qualifies". **The bound is therefore unlimited: every untested in-scope candidate is evaluated**, and `NO_SAFE_ACTION` is accepted only if none qualifies. Otherwise the commit is rejected with the rule's winner.
- **Why this is consistent with the specification.** §13.2 requires the committed decision to equal the scoped oracle's argmin. With a bound equal to an unqualified proposal's cost alone, that can fail.
  - **Example (round 1):** the agent has evaluated F0, F3 (cost 1, red) and `{retries_off:checkout>payments, scale_out:payments}` (cost 4, green), and proposes F3.
  - With a bound of 1, nothing qualifies at cost ≤ 1, so the evaluated winner would be the cost-4 future, and F5 (cost 2, untested) would be missed.
  - With a bound of `max(1, 4) = 4`, F5 is audited and reported as the rule's winner.
  - In other words, the bound is the cost of the cheapest decision the rule could currently reach. Auditing everything at or below it is what makes the committed decision the scoped argmin. When the proposal qualifies, it reduces to the canonical wording.
- **Unchanged:** RED's audit (strictly cheaper only); `research` mode (no audit).
- **Boundary test:** `argus/tests/m5-decision.test.js`, test 10.

### 13.3 Why the LLM does not directly decide the final intervention

- Selection must be deterministic and **provably minimal within scope**, so it is a rule over measured numbers.
- The LLM must never state a probability. Every number comes from the simulator.
- The constraint is a number on a graph node, not a prompt, so changing `error_budget` from 10 to 35 changes the decision (G3 → G1) with no prompt engineering.
- The LLM's value is in **choosing what to test** under a budget and composing pairs. The server's value is in **deciding what is true, what is allowed, and whether a cheaper answer was missed.**

---

## 14. Fallback / reliability

### 14.1 Three agent modes (all drive the same MCP tools against the same graph)

- **`live`:** the LLM decides (OpenRouter, temperature 0).
- **`replay`:** the LLM's decisions come from a cassette, but **every tool call, simulation, audit and graph write executes live**. Only the LLM's choices are replayed; no numbers are.
- **`autopilot`:** B5, a deterministic policy.

Mode hotkeys take effect only at tool-call boundaries.

### 14.2 The takeover rule (covers misses, timeouts *and* wandering)

The orchestrator hands the rest of a phase to B5, at the next tool-call boundary, with an **`AUTOPILOT`** badge, when **any** of these holds:

1. a cassette miss (replay mode), or a live turn over the ceiling (**6 s** by default; `--ceiling-ms`, §14.5);
2. RED has spent **4** of its 6 simulations and none reached 8/16, or BLUE has spent **4** of its 6 futures and none is green;
3. turn **8** of the phase arrives without a `commit`;
4. **two** consecutive tool calls were rejected (unknown id, out of scope, budget exhausted);
5. any budget hits 0 without a valid commit.

Condition 2 fires **while budget remains**. B5 then works from the graph: every simulation or future already run is stored under its `call_id`, so re-requesting it is free. Any new call is charged to the remaining agent budget first and then to `autopilot_reserve` (3). **Worst case for the round-2 pivot:** the LLM spends 4 simulations on wrong pairs; B5 needs at most 2 more calls against 2 remaining + 3 reserve, so **the attack is always found and Act 3's finale always runs.** A takeover inside the stage segment replaces the remaining LLM turns with B5 steps paced at 1.5 s, which is faster than a live turn, so it cannot push the total past 108 s.

The screen and the graph record the takeover honestly (`Scenario.proposed_by`, `Decision.proposed_by`). On stage: "the LLM ran out of good ideas, so the deterministic policy finished; you can see where."

### 14.3 Cassette

Key = sha256 of (role, round, turn index, canonical messages). Canonicalisation sorts JSON keys, drops volatile fields, and rounds floats to 3 dp. Tool outputs are deterministic after `reset`, so replayed keys match the recorded ones exactly. The cassette is recorded on Day 3. **TBD:** the cassette file format and location, and the list of "volatile fields".

**[IMPL-NOTE, 15 Oct 2026] Provenance and late replies.** A live recording (`scripts/demo.js --mode live`, `ui-server --mode live`) carries a `provenance` block: `live`, `provider`, `model`, `ceiling_ms`, `phases` (each phase's `proposedBy` llm | b5 and takeover reason) and `late_decisions`. A reply that arrives **after** the ceiling cut its turn was never used by the run (B5 had taken over): the recorder counts it in `late_decisions` and never writes it as an entry, so replaying that cassette misses at the same turn and takes over too. Replay is always labelled as a cassette; it is never presented as live. Cassettes recorded before this note (`recorded-live.json`, `recorded-lightning-live.json`) do contain late replies and carry no provenance; they are evidence of the live runs, not replayable re-enactments of them.

### 14.4 B5 policy (exact, deterministic; also the research baseline)

**RED-B5:**
1. `amplification_paths(2)`. If non-empty, take the top row and simulate its triggers singly in (hops, id) order, then `[trigger, surge:entry]` pairs.
2. If empty: `rank_nodes('pagerank')` gives the top service `s`. Find pending ChangeEvents modifying edges into `s` (ordered by id). Simulate `[degrade:s]`, then `[degrade:s, deploy:c]` for each, then `[degrade:s, surge:x]` for each entry.
3. Stop at the first scenario that reaches ≥ 8/16; submit (the audit runs as usual). Any step whose result is already in the graph (same `call_id`) is read, not re-run.

This reproduces the stage traces exactly: round 1 `degrade:payments` → `degrade:ledger-db`; round 2 `degrade:ledger-db` → `+deploy:CE-42`.

**BLUE-B5:** F0. Then, if an amplifier path exists, the **path fix**: `retries_off` on every amplifier edge with retries > 0, as one future, derived from the inequality. Then in-scope singles in ascending cost, testing **one candidate per kind per cost tier: the one whose target is nearest the faulted service** (graph hops from an edge's callee or a node to the faulted service, then id). Stop at the first green future. Commit through the same rule.
- Round 1: F0, then the path fix (green), then commit; the audit clears the **12** untested candidates at cost ≤ 2. That is 2 futures.
- Round 2 (no amplifier): G0, block_deploy (amber), breaker orders>ledger-db (amber), scale_out ledger-db (green). That is 4 futures.

Counting honestly: in round 1 B5 spends 2 futures plus 12 audit ensembles; the LLM spends 6 futures plus 10. With the audit on, committed decisions are equal by construction, so that equality is **not** evidence about B5 vs the LLM. The LLM's run is shown on stage because it tests the *instructive* failures (add capacity, fix the database).

### 14.5 Timeout behaviour

A hard ceiling of **6 s per live LLM turn** by default; a slower turn is cut and the takeover rule fires. Pre-demo check: if p95 turn latency is under 3 s, run fully live; otherwise only the Act 3 pivot is live.

**[IMPL-NOTE, 15 Oct 2026] Configurable ceiling and the measured latency trade-off.** `scripts/demo.js` accepts `--ceiling-ms <n>` (default `TAKEOVER.TURN_CEILING_MS` = 6000; the runtime, the UI server and the tests are unchanged). Measured on 15 Oct 2026 with the free OpenRouter tier and the 6 s default, timed to full response body (headers arrive in 0.3–0.7 s; generation is the cost):

| Model (free tier) | Turn latency, full body | Reasoning tokens/turn | Result under 6 s |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free` | ~1 s on the first `list_candidates` turn; ~8–12 s once a decision is needed (30 s ceiling: 6 turns, LLM commit) | not measured | all 4 phases → B5 (`turn_ceiling`) |
| `nvidia/nemotron-3.5-lightning:free` | 3.7–3.8 s (≤ 270 reasoning tokens), 9.0–14.5 s (≥ 300) | 138–657 | all 4 phases → B5 (`turn_ceiling`) |
| `google/gemma-4-*:free` | n/a | n/a | upstream 429 on every attempt |

Every late reply was still a valid tool call (the recorder keeps them: `cassettes/recorded-live.json`, `recorded-lightning-live.json`); the ceiling, not the model's reasoning, ended each phase. **Trade-off:** a 20 s ceiling covers every turn observed so far and lets the LLM reach `commit` (as the 30 s RED test did), at the cost of up to ~14 s of frozen world clock per LLM turn and a presentation 1–2 min longer than the §2.3 run sheet. **A longer ceiling does not guarantee an LLM commit:** rate limits (429), reasoning longer than the ceiling, wandering (conditions 2–5) and tool rejections still hand the phase to B5, and the `AUTOPILOT` badge and `proposedBy` keep saying so. The default stays 6 s so replay, autopilot and the tests keep the spec's timing.

### 14.6 Failure recovery

- **MCP child crash mid-call:** respawn and retry. Charge-once `call_id`, delete-then-copy fork, and `Future` as the commit point make it safe (§4.4). Tested on Day 2.
- **Demo state corrupted:** `npm run reset`.
- **Laptop/venue failure:** pinned docker compose, recorded video, second laptop.

### 14.7 Reset

**`npm run reset`**: delete all graphs, load `seed.cypher`, regenerate the rules, re-run the count test. **Under 2 s.** Also available as a UI button.

### 14.8 The demo does not depend on one successful LLM response

Replay with live execution, B5 autopilot with a reserve budget, the 6 s ceiling, and the takeover rule together guarantee that every phase completes and every number shown is computed live.

---

## 15. UI

**[IMPL-NOTE, 15 Oct 2026] Live mode in the command center.** `npm run ui -- --mode live [--ceiling-ms <n>] [--record <file>]` runs the real provider and agent adapters behind the same UI (replay, autopilot and the interactive judge demo are unchanged). The engine badge reads `LIVE LLM`, the provenance line names the model id and turn ceiling, every step the model issued is chipped `live LLM` and every B5 step `autopilot`, takeovers appear in the activity list with their reason, and after the run the provenance line lists each phase as `R1 RED llm · R1 BLUE autopilot (turn_ceiling) · …` (from `DEMO_COMPLETED.phases`, also in `hello.phases` and the cassette's provenance, §14.3). The interactive judge demo is labelled `INTERACTIVE (scripted)`; judge configuration and the interactive start are refused in live mode. A run is "AI-driven" only to the extent those phase labels say so: a longer ceiling raises the chance of an LLM commit, it never guarantees one.

### 15.1 Layout: one screen, four panels, dark theme, readable from the back of a room (a032 §10)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ARGUS  Round 1/2  Mode: BLUE ●  Budget ▓▓▓▓▓░ 5/6  Error budget 10  ⏸ 4.2s     │
├───────────────────────────────┬─────────────────────────────────────────────┤
│  LIVE GRAPH (world health)    │  AGENT TRACE (each MCP call, Cypher ▾)       │
│  node colour = utilisation    │  ▸ amplification_paths(2) → gw→co→pay 4.5×   │
│  edge width = live rps        │     triggers: payments@0, ledger-db@1        │
│  amplifier glows; trigger     │  ▸ simulate([degrade:ledger-db]) → 15/16     │
│  pulses; fix gets a shield    │  ▸ commit → audit: cost 1 is the floor ✓     │
├───────────────────────────────┼─────────────────────────────────────────────┤
│  FUTURES (small multiples)    │  PREDICTED vs OBSERVED                       │
│  F0 ▁▁ F1 ▁▁ F2 ▁▁ F3 ▁▁      │  band = twin p10–p90, solid = world          │
│  F4 ▆█ amber  F5 ██✓ green    │  payments μ: 800 → 709 (true 704)            │
│  cost 0 3 3 1 2 2 · audit ✓   │  [Open hardening PR]  [Why? → path]          │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

**Libraries:** Cytoscape **or** `react-force-graph-2d` with **fixed preset coordinates**, plus plain SVG sparklines. **TBD:** which graph library (a032 leaves the choice open).

**Socket.IO events:** `tick`, `step`, `future`, `decision`, `observation`, `clock`. **TBD:** the payload schemas.

### 15.2 What each stage looks like

| Element | Specification |
|---|---|
| **System graph / healthy state** | LIVE GRAPH, 8 nodes at fixed coordinates; node colour = utilisation, edge width = live rps; all green. |
| **RED investigation** | AGENT TRACE lines appear ≥ 1.5 s apart, each with an expandable Cypher (▾). Budget meter drains. |
| **Multi-hop path** | Amplifier path glows (gateway→checkout→payments); the trigger (ledger-db) pulses. |
| **Failure injection / cascade** | The world clock runs at 5 ticks/s; the world goes red from the bottom up along the path. |
| **`TRIGGER REMOVED` banner** | At tick 30, a 4 s hold labelled "held", then 10 more ticks, still red. |
| **Paused indicator** | "world paused · ARGUS deciding · 6.1 s". |
| **The inequality** | 300 × 3 × 4 = 3,600 ≫ 704 shown on screen. |
| **BLUE candidates** | Scope counter "ARGUS: 6 futures tested · in scope: 118 · unscoped: 376". |
| **Counterfactual future cards** | FUTURES small multiples, each with a sparkline, cost, and verdict colour (red / amber / green). |
| **Rollout results** | Click a future → "show rollouts": 16 raw curves with their seeds; re-run one live. |
| **Selected intervention / audit** | Audit badge, e.g. "10 options at cost ≤ 2 checked, none better"; "agent: 6 futures · audit: 10". The fix gets a **shield** on the graph. |
| **Prediction vs observation** | Twin p10–p90 band against the solid world line; calibration "payments μ: 800 → 709 (true 704)". |
| **Decision trace** | AGENT TRACE; closing view in FalkorDB Browser (`Decision → Step → Service`). |
| **Hardening** | [Open hardening PR] → YAML diff (`js-yaml`), labelled *emergency mitigation*. |
| **Second attack** | Round-1 vs round-2 traces **side by side**; `LIVE · LLM` badge; the empty amplifier result and the PageRank pivot are visible; pre-emptive do-nothing future as a flat red line next to the green world. |
| **AUTOPILOT indicator** | `AUTOPILOT` badge when B5 takes over; `autopilot_reserve` shown as "reserve". |
| **Header** | Round, mode (RED/BLUE), budget meter, error budget, pause timer. |
| **Reset / replay controls** | Reset button (`npm run reset`); mode hotkeys live / replay / autopilot (effective at tool-call boundaries). **TBD:** the exact key bindings. |
| **"Why?"** | Click → path trigger → … → entry SLO (shortest path; fallback `EVIDENCED_BY`). |

### 15.3 Judge-impact additions (each under 2 hours, a032 §14)

1. The `TRIGGER REMOVED` banner (4 s hold) while the world stays red.
2. The red/amber/green futures row.
3. The audit badge.
4. The hardening PR as a YAML diff generated from the graph.
5. Cypher under every tool call (expandable).
6. Budget meter, error-budget line, and the live "6 tested / 118 in scope / 376 total" counter.
7. Round-1 vs round-2 traces side by side.
8. A **"Remove FalkorDB" slide**.

---

## 16. Project structure

**[IMPL-INTERPRETATION]** a032 names these artifacts: `topology.yaml`, `ingest.js`, `seed.cypher`, `sim.js`, the `argus-app` and `argus-mcp` processes, the React UI, `npm run reset`, the cassette, docker compose, and the README. It does not specify a directory layout or where ARGUS lives relative to the existing IncidentMind code. The stack is Node.js + Express + Socket.IO + React/Vite + OpenRouter. **TBD:** whether ARGUS is a new top-level folder in this repo or a separate repo. Existing IncidentMind code is **not modified**.

```
argus/                                   (TBD: location)
├── package.json                         scripts: reset, app, mcp, test, gates
├── docker-compose.yml                   pinned FalkorDB image; ACL bootstrap
├── config/
│   ├── topology.yaml                    the §8.1 tables, world and twin variants (source of seed.cypher)
│   └── acl.conf                         Redis ACL: user agent ~twin ~fork:* ~argus:* (+ command list, TBD)
├── graph/
│   ├── seed.cypher                      generated/maintained seed (world + twin)
│   ├── ingest.js                        writes every property explicitly; DAG check
│   ├── rules.cypher                     action-space rules (§6.3)
│   ├── queries/                         fixed query strings: amplification, scope (3), charge (3+1),
│   │                                    templates, pending-deploys, pagerank, blast-radius, why
│   ├── client.js                        FalkorDB connections (admin for app; agent for MCP)
│   └── reset.js                         npm run reset (< 2 s)
├── sim/
│   ├── sim.js                           pure functions: Rng, loadModel, step, rollout, ensemble,
│   │                                    harmful, calibrate, fault templates (no constants)
│   └── reference/sim_reference.py       a032 Appendix A, verbatim (parity oracle)
├── mcp/
│   ├── server.js                        argus-mcp --role red|blue (stdio); role from argv
│   ├── tools/                           query_graph, amplification_paths, rank_nodes, blast_radius,
│   │                                    list_candidates, simulate, fork_and_simulate, commit
│   ├── budget.js                        call_id, charge-once
│   ├── scope.js                         server-computed scope
│   ├── audit.js                         stage/research audit, selection rule, harm test
│   └── steps.js                         Step persistence
├── app/
│   ├── server.js                        argus-app: Express + Socket.IO
│   ├── orchestrator.js                  round state machine; world clock (5 ticks/s, pause/hold)
│   ├── world.js                         WORLD state (admin): ACT, APPLY, OBSERVE, snapshot, calibration
│   ├── agent/runtime.js                 one loop, RED/BLUE objectives; MCP client
│   ├── agent/prompts.js                 RED and BLUE system prompts (§9.2, §10.2)
│   ├── agent/cassette.js                record/replay, canonical keys
│   ├── agent/b5.js                      deterministic autopilot (§14.4)
│   ├── agent/takeover.js                takeover rule (§14.2)
│   └── pr.js                            hardening PR YAML diff (js-yaml)
├── ui/                                  React/Vite: four panels, header, controls
│   └── src/{GraphPanel,TracePanel,FuturesPanel,PredObsPanel,Header}.jsx
├── cassettes/                           recorded LLM decisions (format TBD)
├── tests/
│   ├── day1/                            counts, DAG, PRNG parity, R1.1–R1.13, R2.1–R2.8, H.1,
│   │                                    robustness tags 1–20, scoped oracles (21 seed sets), magnitude test,
│   │                                    3-node cycle
│   ├── day2/                            scope tests, crash test, charge-once, takeover traces, literal grep
│   └── day3/                            replay with zero network; forced cassette miss → B5
└── README.md                            includes the "remove FalkorDB" argument
```

---

## 17. Four-day build plan

Assumptions (a032): a team of 2–3, about 4 × 10 working hours. If you are one person, follow the cut order in §17.6. Stay on the existing stack. **Starting FalkorDB from zero is the main risk.**

### 17.1 Day 1: graph and simulator core

**Gate:** all §8.3 assertions pass, including robustness.

| Hours | Work |
|---|---|
| **H1** | Docker FalkorDB (pinned), `falkordb` npm client. Check `GRAPH.COPY`, `algo.pageRank`, `reduce` with list indexing, `*0..` paths, and the ACL user. |
| **H2–3** | `topology.yaml` (world and twin), `ingest.js` with explicit defaults, the Fault/Intervention rules, `npm run reset`, the count test (10 faults / 27 interventions / 376 futures; scopes 15 → 118 and 12 → 78), and the DAG check (zero lagged edges). |
| **H4–7** | `sim.js`, ported from Appendix A (mulberry32, `loadModel`, `step`, `rollout`, fault templates, calibration). **PRNG parity test first.** |
| **H8–10** | **Assertions as tests:** R1.1–R1.13, R2.1–R2.8, P.1, the 20-tag robustness sweep, and both scoped oracles on all 21 seed sets (well under a minute in JS). If any fails, retune and re-derive; this is how the surge magnitude moved from 1.6 to 1.4. |

### 17.2 Day 2: MCP and agent loop

a032 gives Day 2 as a task list without hour allocations. **Hour allocation: TO BE DECIDED DURING IMPLEMENTATION.** Tasks, in a032's order:

- MCP server: 8 tools, role from argv, filtered `listTools`, budgets and error budget on `(:Round)`, id and scope validation, read-only enforcement, ACL user, minimality audit.
- Snapshot write, server-computed scope, `fork_and_simulate` (reactive and pre-emptive) with charge-once budgets and delete-then-copy forks, `Future` writes with verdicts, `commit` with the rule and the rule-complete audit.
- Crash tests: kill the MCP child mid-fork, respawn, retry, and assert one charge and an identical Future; a repeated call is free.
- Takeover tests: the scripted wandering RED trace (takeover after the 4th simulation, CE-42 scenario submitted by B5, `proposed_by = 'b5'`); a BLUE trace with 4 non-green futures; two rejected calls in a row.
- Scope tests: `{surge:gateway}`, `{deploy:CE-17}`, `{degrade:ledger-db}`; an empty scope raises an error.
- Parameter test: change `Fault.magnitude` on a fork and assert the outcome changes; grep `sim.js` for numeric literals outside the equation-shape whitelist.
- World graph, world clock (5 ticks/s, pause/hold), injection, apply, observation, calibration.
- Agent runtime: OpenRouter tool calling via the MCP client, RED/BLUE prompts, `Step` persistence, B5 autopilot.

**Gate:** the 2-round loop runs headless end to end in `live` and `autopilot`, producing the §8.4 numbers.

### 17.3 Day 3: UI

Hour allocation: **TBD.**
- Socket.IO events (`tick`, `step`, `future`, `decision`, `observation`, `clock`). Four panels, red/amber/green futures, budget and error-budget display, overlay, scope counter, "Why?" path, hardening PR (`js-yaml` diff).
- Record the cassette.

**Gate:** the full demo runs in replay mode with **zero network**, and a forced cassette miss falls back to B5 cleanly.

### 17.4 Day 4: harden and rehearse

Hour allocation: **TBD**, except the stretch deadline.
- Act 3 polish: side-by-side traces, the pre-emptive do-nothing line, run-sheet timings measured with a stopwatch against §2.3.
- **Stretch only if green by noon:** hidden dependency, Claude Desktop cameo, round 3.
- Rehearse 10 times, record the backup video, and write the README with the "remove FalkorDB" argument.

### 17.5 Dependencies, milestones, hard deadlines

| Milestone | Depends on | Hard deadline |
|---|---|---|
| FalkorDB feature checks (fallbacks chosen) | – | Day 1 H1 |
| Counts + reset | seed, rules | Day 1 H3 |
| Simulator parity | Appendix A | Day 1 H7 |
| **Day-1 gate: all assertions + robustness + oracles** | simulator, graph | **end of Day 1** |
| **Day-2 gate: headless 2-round loop, live + autopilot** | MCP, world clock, agent runtime | **end of Day 2** |
| **Day-3 gate: full demo in replay, zero network; cassette miss → B5** | UI, cassette | **end of Day 3** |
| Stretch decision | all gates green | **Day 4 noon** |
| Rehearsal ×10 + backup video | everything | end of Day 4 |

### 17.6 What gets cut first if behind (in this order)

1. hidden dependency;
2. MCP desktop cameo;
3. the ACL user (keep the allowlist);
4. the shortest-path "Why?" (use the stored `EVIDENCED_BY` path);
5. round 3;
6. the audit for RED (keep it for BLUE).

**Never cut:** the self-sustaining cascade after the trigger is removed; snapshot-based futures with the server-enforced rule and error budget; predicted vs observed; RED's round-2 pivot; replay mode with B5 fallback; the robustness gate.

---

## 18. Cut list

**Do NOT build for the hackathon (a032 §13 "cut now"):**

- Chroma / vector RAG
- **All IncidentMind modules** (RCA, RAG/Chroma, business impact)
- The `Outcome` node
- Betweenness, MaxFlow, WCC, CDLP, MSF
- The breaker-cooldown WORLD/TWIN mismatch
- Connection-pool modelling
- Multi-agent frameworks
- Per-request event simulation
- Kubernetes or real infrastructure
- Ticks written to the graph
- Any LLM-stated probability

**Also out of the 4-day MVP:** B1–B4 and B6 research baselines (only B0, B5 and the scoped oracle are built); a procedural topology generator; DES fidelity; OpenTelemetry ingest; per-role ACL users; independent transient errors; round 3 (stretch only).

---

## 19. Research extension

**Do not force any of this into the 4-day MVP.**

- **Question:** under a fixed simulation budget, does LLM tool use over a graph beat non-LLM graph search?
- **Protocol: `(:Round).mode = 'research'`.** The audit is off for every policy, and nothing the oracle computes reaches a policy. Each policy commits its own proposal under the same budgets. Simulations are counted per policy; verification is reported in a separate column. Regret, harmful-intervention rate and simulations-to-discovery are measured on the policy's own commit. Without this, every policy would score regret 0 by construction.
- **Baselines:**

| Id | Policy | Status |
|---|---|---|
| B0 | Do nothing | **Built in the hackathon** |
| B1 | Threshold/runbook ("scale out on error"), which the panel already shows failing on metastable states | To add |
| B2 | LLM-only | To add |
| B3 | LLM + vector RAG | To add |
| B4 | LLM + graph retrieval without `simulate` (without rollouts) | To add |
| B5 | Graph/search without LLM (§14.4) | **Built in the hackathon** |
| B6 | ARGUS (LLM + graph tools + simulate + rule) | **Built in the hackathon** |
| Random | Random search over scoped candidates under the same budget (floor for B5 and the LLM) | Cheap to add |
| Oracle | Scoped oracle (the stage audit run exhaustively), used only as the reference; plus an oracle on the **world** graph, for regret | Scoped built; world oracle to add |

- **Honest starting data point:** on the demo topology, B5 *proposes* the same decisions as the LLM, with fewer agent futures in round 1 (2 vs 6). The research must find where the LLM helps (composing interventions, reasoning about ChangeEvents, larger graphs where B5's heuristics run out), or report that it does not.
- **Model mismatch:** WORLD/TWIN capacity error, observation noise, and the hidden dependency (validated in research); regret is measured against the world oracle.
- **Calibration:** the Brier score on `p_recover`; the calibration window and the 3% uncertainty floor.
- **Search efficiency:** simulations-to-discovery; agent vs audit simulation counts.
- **Benchmark:** a procedural generator of **50–200 topologies** with mesh-realistic retry and timeout distributions, **including cyclic call graphs** (handled by the lagged-edge rule), plus seeded scenario families with persistent and transient triggers. A sensitivity study of the one-tick lag against a fixed-point iteration within each tick.
- **Metrics:** cascade-prevention rate, SLO-violation ticks, regret vs oracle cost, harmful-intervention rate, calibration (Brier), simulations-to-discovery, decision latency in ticks (with the clock **not** frozen), and explanation faithfulness.
- **Paper framing:** "Graph-grounded counterfactual agents for pre-emptive mitigation of metastable failures."

---

## 20. Final-year project extension

All of these extend the core without redesigning it (a032 §17):

1. A discrete-event simulator validated against a real testbed (DeathStarBench, or a docker-compose shop with Toxiproxy).
2. Independent transient errors, so the cost of removing retries is priced (fixes the §10.8 limitation).
3. Topology ingested from OpenTelemetry traces, so the twin is learned rather than hand-written.
4. Automatic twin repair: hidden-dependency discovery from residuals.
5. Wider fault classes: partitions, cache stampede, autoscaler lag, pool exhaustion.
6. An RL or Bayesian-optimisation BLUE baseline.
7. A GitOps loop: hardening PRs and deploy-blocking checks against a real repo, with human approval.

Also: connection-pool modelling, per-role ACL users, and the research benchmark (§19).

---

## 21. Threats / failure modes

| Category | Risk | Fallback / mitigation (a032 unless marked) |
|---|---|---|
| **Technical** | Starting FalkorDB from zero (the main feasibility risk) | Day 1 H1 feature checks with pre-chosen fallbacks; Day-1 gate. |
| Technical | Demo state corrupted | `npm run reset` (< 2 s), UI button. |
| Technical | MCP child process crashes mid-call | Respawn and retry: charge-once `call_id`, delete-then-copy fork, `Future` as commit point. Tested on Day 2. |
| **Simulator** | A verdict that only holds for one seed set | Robustness gate over tags 1–20 (R1.3 14–16/16; R1.9 16/16; R2.4 14–16/16; R2.5 G3 16/16). Borderline options (e.g. single-layer retries, 13–15/16) kept off the script. |
| Simulator | JS port drifts from the reference | PRNG parity test; ensemble counts and medians must match exactly; traces within 1e-9. |
| Simulator | Hand-tuned numbers are fragile (the gate already fired once) | Retune and **re-derive from code**, never edit by hand. |
| Simulator | A cyclic graph crashes the simulator | Lagged-edge rule; 3-node cycle unit test. |
| Simulator | Model cannot price retry resilience | Honest answer: emergency-mitigation label + "keep ≥ 1 retry" policy as one `WHERE` (Q&A only). |
| **FalkorDB compatibility** | `GRAPH.COPY` missing | `forkGraph()`: read nodes and edges, bulk `CREATE`. |
| FalkorDB | `algo.pageRank` signature differs | Compute PageRank in JS, write `s.pagerank`, the tool reads it. |
| FalkorDB | `*0..` paths unsupported | `UNION` of the target's own faults with `*1..4`. |
| FalkorDB | ACL key patterns not enforced on `GRAPH.*` | Server-side graph-name allowlist; the agent process never receives the admin password. |
| FalkorDB | **[IMPL-NOTE]** `shortestPath` unsupported | Stored `EVIDENCED_BY` path (cut-list item 4). |
| **MCP** | LLM calls an unknown id or an out-of-scope candidate | Rejected with an error; charged; two rejected calls in a row trigger takeover. |
| MCP | Client sends a role | The role is read from argv only; unlisted tools are rejected. |
| MCP | Budget exhausted | An empty charge result; takeover (condition 5) with `autopilot_reserve`. |
| **LLM** | Slow, rate-limited, offline | Act 3's RED pivot live, the rest replayed (fully live if p95 < 3 s); 6 s per-turn ceiling; takeover to B5. |
| LLM | Wanders inside its budget (no timeout, no miss) | Takeover after 4 sims/futures with no qualifying result, at turn 8, or after 2 rejected calls; B5 finishes from cached results plus a 3-call reserve. Tested on Day 2. |
| LLM | Picks a different but valid path or order | BLUE: server-computed scope plus the rule-complete audit, so the committed decision equals the scoped oracle. RED: the audit certifies "nothing cheaper"; finding the attack is the agent's job, backed by takeover. |
| LLM | Non-determinism | Temperature 0 + cassette; mulberry32 with specified seeds; common random numbers; `ORDER BY` everywhere; deterministic ids. |
| **UI** | Layout jitter or non-determinism | Fixed preset coordinates. |
| UI | Judges can't read it | Dark theme, readable from the back of a room; one screen; four panels. |
| UI | "Is that number fake?" | "Show rollouts": 16 raw curves with seeds; re-run one live. |
| UI | **TBD** further UI risks (a032 lists none beyond the above) | – |
| **Demo** | Venue network bad | Pre-demo p95 check; replay mode with live execution; only the 6-turn pivot is live. |
| Demo | Laptop/venue failure | Pinned docker compose, recorded video, second laptop. |
| Demo | Overrunning the slot | Stage plan 84–108 s machine time; takeover is faster than a live turn; narration written for 2 min 10 s; stopwatch-checked on Day 4. |
| Demo | A team with a slicker UI | Accepted risk (scorecard). |

---

## 22. Implementation acceptance checklist

ARGUS is complete only when **every** box is checked.

### Track 01 compliance
- [ ] Multi-hop reasoning: `amplification_paths(2)` returns gateway→checkout→payments **4.5×** with triggers `[degrade:payments@0, degrade:ledger-db@1]`.
- [ ] Graph queries and algorithms are exposed as MCP tools and used by the agent.
- [ ] Tool selection through MCP, visibly state-dependent (round-2 pivot).
- [ ] Actions on the world are driven by graph-derived action spaces.
- [ ] Explainable: Cypher under every trace line, persisted `Step`s, evidence path, "Why?".

### FalkorDB centrality
- [ ] `sim.js` contains no topology or policy constants; the literal-grep test passes.
- [ ] Changing `Fault.magnitude` on a fork changes the simulated outcome (test).
- [ ] Both action spaces are generated by Cypher rules; counts 10 / 55 / 27 / 376; scopes 15 → 118 and 12 → 78.
- [ ] Futures are `GRAPH.COPY` forks (or the documented fallback) named `fork:<round>:<future>`.
- [ ] Budgets, error budget, SLO and horizons live on `(:Round)`.
- [ ] The decision trace is browsable in FalkorDB Browser (`Decision → Step → Service`).
- [ ] The "Remove FalkorDB" slide exists and is accurate.

### Graph-native reasoning
- [ ] Downstream closure finds `ledger-db` 3 hops from the entry point and 1 below the amplifier.
- [ ] PageRank top = ledger-db (0.220) on the hardened twin.
- [ ] Round-2 amplifier query is empty (top 0.55×).
- [ ] Betweenness, MaxFlow, WCC, CDLP and MSF are absent.

### MCP
- [ ] `argus-mcp --role red|blue` over stdio; role from argv only; `listTools` role-filtered; unlisted calls rejected.
- [ ] All 8 tools implemented; ids validated; unknown ids return an error.
- [ ] Charge-once budgets (`Charge` node); repeated calls free; invalid calls charged.
- [ ] `audit_sims` counted and displayed separately from agent spend.
- [ ] Agent ACL user gets `NOPERM` on `world` (or the allowlist fallback is in place and documented).

### Autonomous tool selection
- [ ] RED round 1 finds `degrade:ledger-db` within 6 simulations (2 on stage).
- [ ] RED round 2 pivots to PageRank → CE-42 **live** and finds `degrade:ledger-db + deploy:CE-42` (16/16).
- [ ] `proposed_by` recorded on every Scenario/Decision.

### Counterfactual futures
- [ ] Round-1 panel reproduces F0–F5 exactly (§8.4); F5 selected; audit 10; `proven-in-scope`.
- [ ] Round-2 panel reproduces G0–G3 exactly; G3 selected; `proven-in-scope`.
- [ ] Per-entry harm test implemented; H.1 reproduced.
- [ ] With `error_budget = 35`, the rule selects G1 (Q&A check).
- [ ] `NO_SAFE_ACTION` is a reachable, valid outcome.

### WORLD / TWIN
- [ ] Separate `world` and `twin` graphs; payments 704 vs 800; `cap_sd` 0 vs 15%.
- [ ] Snapshot at tick 40 with 5% observation noise; R1.11 holds.
- [ ] Predicted vs observed overlay: R1 predicted 2 (1–3) vs observed 3; R2 0 vs 0.
- [ ] Calibration: payments 800 → 708.9, n = 41, SE 5.3, cap_sd 3% floor; ledger-db unchanged (n = 6); `CALIBRATED` edge written.

### Metastable cascade
- [ ] R1.4: world goodput 0.0 from tick 2, payments pinned at 704.
- [ ] R1.5: after the trigger is removed at tick 30, goodput stays 0.0 for ticks 30–39 and for 60 more ticks with no intervention.
- [ ] R1.6–R1.9 reproduced (capacity and DB fixes fail; one layer fails; breaker amber; both layers green).

### Live demo
- [ ] Three acts as in §2.1, with the `TRIGGER REMOVED` 4 s hold.
- [ ] Run sheet: replay ≈ 81 s; stage plan 84–108 s; stopwatch-verified.
- [ ] Act 3 RED pivot runs live with `LIVE · LLM`.
- [ ] World stays green in round 2 with the slowdown + CE-42 landed; do-nothing flat red line shown.
- [ ] Hardening PR YAML diff generated from the graph.

### Deterministic fallback
- [ ] Replay mode: zero-network full run; numbers computed live.
- [ ] Forced cassette miss → B5 cleanly with `AUTOPILOT`.
- [ ] Scripted wandering RED trace → takeover after the 4th simulation; B5 submits CE-42 scenario with `proposed_by = 'b5'`.
- [ ] BLUE takeover after 4 non-green futures; takeover after two rejected calls; 6 s ceiling enforced.
- [ ] B5 reproduces the stage traces exactly.

### Reset
- [ ] `npm run reset` < 2 s; deletes all graphs including `fork:*`; reloads seed; regenerates rules; count test passes.
- [ ] Reset UI button works.

### Second attack
- [ ] Hardening persisted in world and twin; action spaces regenerated (no retry interventions on hardened edges).
- [ ] Round-1 vs round-2 traces shown side by side.

### Reliability
- [ ] PRNG parity: seed 1001 → 606341916, 1148489751, 477154826, 1429770400; traces within 1e-9.
- [ ] Robustness gate: every stage verdict holds for tags 1–20; scoped oracles agree on all 21 seed sets; R2.4 uniqueness holds for all 45 pairs.
- [ ] Crash test: kill MCP mid-fork → respawn → one charge, identical Future.
- [ ] Healthy world stays healthy for 150 ticks (min goodput 0.9997).
- [ ] Pinned docker compose; recorded backup video; second laptop; 10 rehearsals.

---

## 23. Register of unspecified items (TBD)

These are genuinely unspecified by a032 and must be decided during implementation:

1. Exact MCP tool JSON input/output schemas (§11.2 gives an interpretation); the MCP SDK and version.
2. Exact `loadModel` Cypher, and whether `world` also holds `Fault`/`Intervention`/`Round` nodes (§6.2).
3. Seed CREATE statements (§6.1 derives them from tables); `topology.yaml` format.
4. Shortest-path "Why?" query (§6.22); PageRank call signature, damping and iterations (§6.7).
5. Scenario / Decision / Snapshot / Observation id formats; `Decision.rule` encoding; `Observation.observed_ttr` and `pred_error` definitions; `NO_SAFE_ACTION` encoding.
6. How `Step` is scoped to a round for `BASED_ON` (no `round` property in a032's schema).
7. Per-role `tool_budget` storage (one property on `(:Round)` vs per role).
8. Strategy for deleting stale `Fault`/`Intervention` nodes on regeneration while preserving history.
9. Scratch-fork naming for RED `simulate`.
10. Snapshot observation-noise seed (only the calibration seed `5000 + i` is given).
11. Full Redis ACL command list (a032 writes `…`); purpose of the `~argus:*` key pattern; whether `DEL` or `GRAPH.DELETE` is used for forks.
12. FalkorDB pinned version; whether persistence (RDB/AOF) is enabled.
13. Equation-shape literal whitelist for the `sim.js` grep test.
14. Whether a landed deploy in `world` is mirrored to `twin`.
15. Whether an agent may call `fork_and_simulate` with zero interventions (do nothing).
16. `rank_nodes('in_degree')` definition.
17. Cassette format and location; list of "volatile fields" dropped in canonicalisation.
18. UI graph library (Cytoscape vs `react-force-graph-2d`); Socket.IO payload schemas; mode hotkey bindings; hardening-PR YAML schema.
19. OpenRouter model choice (a032 specifies only OpenRouter, temperature 0).
20. Hour allocations for Days 2–4 (only Day 1 is hour-by-hour in a032).
21. Repository location of ARGUS relative to the IncidentMind code.
22. Hidden-dependency stretch and round 3: specified only as stretch goals, not validated; the gates must be re-run if added.
23. FalkorDB indices/constraints on `id`/`name`.

---

## Appendix A. Reference simulator (verbatim from a032)

> Python; port to `sim.js` with an identical PRNG and identical seeds. `base_model(kind)` stands in for `loadModel(graph)` and holds exactly the §8.1 tables. `kind='world'` differs only in payments capacity (704) and `cap_sd = 0`. In `sim.js` these values come from a Cypher read.

```python
import math, copy, statistics as st

class Rng:                                   # mulberry32 + Box-Muller (bit-identical to JS mulberry32)
    def __init__(self, seed): self.a = seed & 0xFFFFFFFF
    def u32(self):
        self.a = (self.a + 0x6D2B79F5) & 0xFFFFFFFF; t = self.a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return (t ^ (t >> 14)) & 0xFFFFFFFF
    def uni(self): return (self.u32() + 0.5) / 4294967296.0
    def gauss(self):
        u1, u2 = self.uni(), self.uni()
        return math.sqrt(-2.0*math.log(u1)) * math.cos(2*math.pi*u2)

def sig(x): return 1.0 if x > 50 else 0.0 if x < -50 else 1/(1+math.exp(-x))
ORDER = ['gateway','mobile-gw','checkout','orders','auth','payments','inventory','ledger-db']

def base_model(kind):                       # == loadModel(graph)
    svc = {'gateway':dict(ext=300,cap=5000,base=20), 'mobile-gw':dict(ext=150,cap=5000,base=20),
           'auth':dict(ext=0,cap=1500,base=30), 'checkout':dict(ext=0,cap=2000,base=40),
           'orders':dict(ext=0,cap=1000,base=40), 'payments':dict(ext=0,cap=800,base=80),
           'inventory':dict(ext=0,cap=4000,base=30), 'ledger-db':dict(ext=0,cap=550,base=20)}
    for n,s in svc.items():
        s['sd'] = 0.0 if kind=='world' else (0.15 if n=='payments' else 0.05)
        s['qmax_s']=2.0; s['surge']=1.0; s['shed']=0.0; s['degrade']=1.0
    if kind=='world': svc['payments']['cap'] = 704
    E = [('gateway','auth',1,1,300),('gateway','checkout',1,2,1000),('mobile-gw','auth',1,1,300),
         ('mobile-gw','orders',1,0,1000),('checkout','payments',1,3,500),('checkout','inventory',1,1,300),
         ('orders','ledger-db',2,0,300),('orders','inventory',1,1,300),('payments','ledger-db',0.2,0,300)]
    edges = {(a,b):dict(fanout=f,retries=r,timeout=t,breaker=False,trip_p=0.5,trip_ticks=5,cooldown=10)
             for a,b,f,r,t in E}
    ces = {'CE-42':dict(edge=('orders','ledger-db'),retries=3,status='pending'),
           'CE-17':dict(edge=('checkout','inventory'),retries=3,status='pending')}
    mag = {'degrade':0.6, 'surge':1.4}                       # Fault.magnitude (per kind on the seed)
    fac = {'scale_out':1.5, 'shed':0.10, 'cap_retries':1}    # Intervention.factor
    rnd = dict(slo_goodput=0.99, slo_latency_ms=800, slo_width_ms=80, arrival_noise=0.05,
               obs_noise=0.05, t_off=30)                     # (:Round) constants
    return dict(svc=svc, edges=edges, ces=ces, mag=mag, fac=fac, rnd=rnd)

def init_state(m):
    return dict(q={n:0.0 for n in m['svc']}, p={e:0.0 for e in m['edges']},
                hot={e:0 for e in m['edges']}, open={e:0 for e in m['edges']})

def set_faults(m, faults, on):              # transient: degrade, surge. persistent: deploy
    for f in faults:
        k, tgt = f.split(':',1)
        if k=='degrade': m['svc'][tgt]['degrade'] = m['mag']['degrade'] if on else 1.0
        elif k=='surge': m['svc'][tgt]['surge'] = m['mag']['surge'] if on else 1.0
        elif k=='deploy' and on:
            ce = m['ces'][tgt]
            if ce['status']=='pending': m['edges'][ce['edge']]['retries']=ce['retries']; ce['status']='landed'

def apply_iv(m, iv):
    k, tgt = iv.split(':',1)
    if k=='retries_off': a,b=tgt.split('>'); m['edges'][(a,b)]['retries']=0
    elif k=='cap_retries': a,b=tgt.split('>'); m['edges'][(a,b)]['retries']=min(m['fac']['cap_retries'],m['edges'][(a,b)]['retries'])
    elif k=='breaker': a,b=tgt.split('>'); m['edges'][(a,b)]['breaker']=True
    elif k=='scale_out': m['svc'][tgt]['cap'] *= m['fac']['scale_out']
    elif k=='shed': m['svc'][tgt]['shed'] = m['fac']['shed']
    elif k=='block_deploy': m['ces'][tgt]['status']='blocked'
    # 'none:x' (do nothing) falls through

def step(m, s_, mu, rng):
    S, E, q, p, R = m['svc'], m['edges'], s_['q'], s_['p'], m['rnd']
    served, dropped, work, arr = {}, {}, {}, {}
    for n in ORDER:                                            # fixed draw order
        arr[n] = S[n]['ext']*S[n]['surge']*(1-S[n]['shed'])*(1+R['arrival_noise']*rng.gauss()) if S[n]['ext'] else 0.0
    for n in ORDER:                                            # forward pass
        for (a,b),e in E.items():
            if b==n:
                if s_['open'][(a,b)]>0: A=0.0
                else: pe=min(p[(a,b)],0.999999); A=(1-pe**(e['retries']+1))/(1-pe)
                arr[n]+=served[a]*e['fanout']*A
        w=q[n]+arr[n]; sv=min(w,mu[n]); qm=S[n]['qmax_s']*mu[n]
        q[n]=min(w-sv,qm); dropped[n]=max(0.0,w-sv-qm); served[n]=sv; work[n]=w
    lat, ok = {}, {}
    for n in reversed(ORDER):                                  # reverse pass
        down=0.0; okp=1.0
        for (a,b),e in E.items():
            if a!=n: continue
            k=(a,b)
            if s_['open'][k]>0:
                pe=1.0; s_['open'][k]-=1
                if s_['open'][k]==0: pe=0.0; s_['hot'][k]=0
                d=0.0
            else:
                pt=sig((lat[b]-e['timeout'])/(0.1*e['timeout']))
                pd=dropped[b]/work[b] if work[b]>0 else 0.0
                pe=1-(1-pt)*(1-pd)*ok[b]; d=min(lat[b],e['timeout'])
                if e['breaker']:
                    s_['hot'][k]= s_['hot'][k]+1 if pe>e['trip_p'] else 0
                    if s_['hot'][k]>=e['trip_ticks']: s_['open'][k]=e['cooldown']; pe=1.0; s_['hot'][k]=0
            p[k]=pe; okp*=(1-pe**(e['retries']+1)); down=max(down,d)
        lat[n]=S[n]['base']+1000*q[n]/mu[n]+down; ok[n]=okp
    gp={n:(1-dropped[n]/work[n] if work[n] else 1)*ok[n]*(1-sig((lat[n]-R['slo_latency_ms'])/R['slo_width_ms']))
        for n in S if S[n]['ext']}
    ve={n:gp[n]<R['slo_goodput'] for n in gp}                 # per-entry violation (harm test)
    return dict(gp=gp, ve=ve, served=dict(served), q=dict(q))

def rollout(m0, state0, faults, t_off, horizon, seed):
    m=copy.deepcopy(m0); s=copy.deepcopy(state0); rng=Rng(seed)
    base_mu={n:max(1.0,m['svc'][n]['cap']+rng.gauss()*m['svc'][n]['sd']*m['svc'][n]['cap']) for n in ORDER}
    set_faults(m, faults, True); trace=[]
    for t in range(horizon):
        if t==t_off: set_faults(m, faults, False)
        mu={n:base_mu[n]*m['svc'][n]['degrade'] for n in m['svc']}
        o=step(m,s,mu,rng); o['viol']=any(o['ve'].values())
        o['deg']={n:m['svc'][n]['degrade'] for n in m['svc']}; trace.append(o)
    return trace, s

def ensemble(m, state0, faults, t_off, horizon, tag, n=16):   # seeds 1000·tag + k
    trs=[rollout(m,state0,faults,t_off,horizon,1000*tag+k)[0] for k in range(n)]
    rec=sum(not any(o['viol'] for o in tr[-10:]) for tr in trs)
    by_entry={e:[sum(o['ve'][e] for o in tr) for tr in trs] for e in trs[0][0]['ve']}  # Future.viol_by_entry
    return rec, st.median([sum(o['viol'] for o in tr) for tr in trs]), trs, by_entry

def harmful(by_entry_iv, by_entry_none):    # §8: worse than do-nothing on ANY entry (medians)
    return any(st.median(by_entry_iv[e]) > st.median(by_entry_none[e]) for e in by_entry_iv)

def calibrate(world_ticks, svc):           # observation noise + calibration (§4)
    rng=Rng(5000+ORDER.index(svc)); xs=[]; obs_noise=0.05   # = (:Round).obs_noise
    for o in world_ticks:
        g=rng.gauss()                       # one draw per tick, used or not
        if o['q'][svc]>1e-6 and o['deg'][svc]==1.0: xs.append(o['served'][svc]*(1+obs_noise*g))
    if len(xs)<10: return None             # not enough clean saturated ticks: leave twin alone
    mean=st.mean(xs); se=st.stdev(xs)/math.sqrt(len(xs))
    return dict(n=len(xs), cap_mean=mean, se=se, cap_sd=max(se,0.03*mean)/mean)
```

**How the reference-number table is produced (a032, verbatim):**
- RED checks, round r: `ensemble(T, init_state(T), faults, 30, 90, tag=100r+1)`; sustained = 16 − recovered.
- Round-1 world: `rollout(W, init, ['degrade:ledger-db'], ∞, 30, 7)`, then `rollout(W, s, [], 0, 10, 8)`, which gives the tick-40 snapshot.
- Round-1 futures: `ensemble(fork, snapshot, [], 0, 60, tag=102)`; world check `rollout(W+iv, snapshot, [], 0, 60, 99)`.
- Calibration: `calibrate(ACT ticks 0–39 + OBSERVE ticks with the selected fix, svc)`.
- Round 2: twin hardened with `retries_off` on gateway>checkout and checkout>payments, payments `cap 708.9`, `sd 0.03`; world hardened identically. Pre-emptive futures `ensemble(fork, init_state, scenario, 30, 90, tag=202)`; world check seed 77.
- Harm (H.1): `harmful(by_entry(future), by_entry(do-nothing))` on the same tag; all stage-selected futures return False. The parameterised code above (magnitudes, factors, SLO and noise read from the model) reproduces every number unchanged.
- Robustness: repeat every ensemble with tags 1–20. Oracle: every single and pair in the server-computed scope (round 1: 15 interventions, 118 futures; round 2: 12, 78), under the selection rule with the tie-break, for tag 102/202 and tags 1–20. Round-2 RED uniqueness: all 45 hardened-twin pairs for tags 1–20.
- `step()` above assumes a DAG via the fixed `ORDER`. `sim.js` derives the order and the `lagged` edges from `loadModel`; on the seed graph the two are identical.

**[IMPL-NOTE]** In "world check `rollout(W+iv, snapshot, …)`", the world continues from its **true** tick-40 state, not the noisy twin snapshot. The noisy estimate is only what the twin sees. **[IMPL-NOTE]** `rollout(W, init, …, ∞, 30, 7)` means `t_off` is never reached within that 30-tick call; the fault is removed by starting the second call (ticks 30–39) with no faults.

---

## Appendix B. Answers to the 16 critical questions (a032)

1. **"LLM + simulator + graph DB"?** In that pattern the database stores data and the LLM decides. Here the graph *is* the model the simulator executes. It also *defines* both action spaces and the safety constraint, *forks* into counterfactual worlds, *enforces* the information boundary, and *records* every step. The LLM chooses what to test under a budget, and a deterministic rule plus an audit decides.
2. **Is FalkorDB indispensable?** Any database could be forced to do each job. The defensible claim is that one graph is at once the model, the action space, the fork substrate, the algorithm engine, the shared state and the trace. Postgres would need recursive CTEs for the amplifier and the downstream closure, schema cloning for forks, and hand-written PageRank; that amounts to rebuilding a graph database.
3. **Is RED autonomous?** Within a graph-bounded space, yes: 55 scenarios against 6 simulations, tool choice that visibly changes with the graph, and server verification. The audit only certifies that nothing cheaper exists; it does not search for the attack, so the budget is real. It is not open-ended, B5 proposes the same attacks on this topology, and a takeover is shown on screen when it happens.
4. **Is BLUE counterfactual?** Yes, structurally: do()-interventions on a forked graph that carries the live state, then checked against a separate world. Selection is deliberately an optimisation with an explicit constraint, because that makes it trustworthy.
5. **Is WORLD/TWIN strong enough?** Separate graphs, a database-enforced boundary, a capacity mismatch that is purely graph data, noisy snapshots, recorded prediction error, and a calibration with a stated window and uncertainty floor.
6. **Is the simulator convincing?** Every term, parameter and seed is specified, the reference is in Appendix A, the verdicts survive 20 seed sets, and its central behaviour (metastability after the trigger is removed) is a published failure class.
7. **Which algorithms matter?** The amplifier traversal, the downstream-closure trigger query, PageRank, blast-radius BFS, and shortest path for explanations.
8. **Is MCP meaningful?** It enforces the graph-bounded action space, budgets, per-process roles and the audit, persists the trace, and works with any MCP client.
9. **Can a judge understand it quickly?** "It finds an outage that hasn't happened, proves it's real, shows that fixing the cause and adding capacity don't help, tests six futures, applies the cheapest safe one, and the attacker has to find a new way in."
10. **Most spectacular moment?** `TRIGGER REMOVED` and the system stays down, followed by a futures row where every obvious fix is red.
11. **What can break?** The LLM, determinism, FalkorDB features, seed-dependence, the venue. See §21.
12. **Deterministic and replayable?** Specified seeds with common random numbers, a robustness gate, temperature 0, a canonically keyed cassette with live tool execution, B5 fallback with a 6 s per-turn ceiling, pinned Docker, ordered queries, charge-once budgets with delete-then-copy forks, one-click reset.
13. **What to cut?** §18.
14. **What to add for judges?** §15.3.
15. **Production feel?** Mesh-style config, SLOs with an explicit error budget, hardening PRs, `NO_SAFE_ACTION`, a risky "resilience" PR caught before merge, a minimality audit, least-privilege database access, and an auditable trace.
16. **Highest probability of finishing?** Two small processes, one database, a pure-function simulator with a seed-exact reference, assertions as Day-1 tests, and replay by Day 3.

---

## Appendix C. a032's brutally honest scorecard

| Criterion | Score | Why, honestly |
|---|---|---|
| Hackathon winning potential | **8/10** | A clear story, a memorable moment, graph-native on every axis, and numbers that are seed-exact and pass a 20-seed-set gate that has already forced one retune. Risk: a team with a slicker UI. |
| Live demo impact | **8.5/10** | "We fixed the database, it's still down", then "capacity fails, both-layer retries off works", then the world staying green through a slowdown plus a bad deploy. Only Act 3's pivot is guaranteed live; the rest is replayed LLM choices over live execution, which is said on stage. |
| Judge understandability | **8/10** | Three acts on one screen. Metastability needs one sentence and one inequality, and the futures panel *is* that inequality. |
| FalkorDB indispensability | **8/10** | Model, state, both action spaces, the safety constraint, forks, algorithms, access boundary and trace all live there. A 10 is not honestly claimable for any database. |
| Track 01 alignment | **9/10** | Multi-hop amplifier + trigger queries, algorithms as tools, MCP selection, actions on the world, explanations. |
| Graph-native reasoning | **8.5/10** | The trigger is found 3 hops from the symptom by a downstream-closure query. Every algorithm changes an action and is verifiable live. |
| Agent autonomy | **6/10** | Real choices under a budget in a small, bounded space. B5 reproduces the decisions, so the LLM's margin is unproven. Stated, not hidden. |
| MCP quality | **8/10** | Per-process roles (not per-DB-user; stated), graph-held charge-once budgets with three specified counters, server-computed scope that follows each fault's propagation direction, a database-enforced world boundary, an audit whose cost is shown separately, interop. |
| Technical ambition | **8/10** | Twin/world, snapshot-based counterfactual forks, calibration, metastability, error-budgeted selection with proven minimality. |
| 4-day feasibility | **7.5/10** | The simulator is fully specified with a seed-exact reference. Starting FalkorDB from zero remains the main risk. |
| Reliability | **8/10** | Robustness gate (verified at 1.4× surge), specified seeds, cassette with a per-turn ceiling, a takeover rule that also catches an LLM wandering inside its budget (with a reserve so Act 3 always completes), crash-safe forks, reset, video. Down from 8.5 because the first sweep failed until it was retuned: the gate works, and it also shows how fragile hand-tuned numbers are. |
| Research potential | **8/10** | The B5-vs-LLM question is real and publishable either way. The oracle already exists, and the research mode keeps it out of the policies so the comparison can actually differ. |
| FYP potential | **9/10** | Clear growth path into real traces, transient-error modelling, DES fidelity and a testbed. |
