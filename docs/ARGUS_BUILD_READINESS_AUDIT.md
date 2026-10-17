# ARGUS — Build Readiness Audit

| | |
|---|---|
| **Date** | 2026-10-07 |
| **Canonical spec** | `docs/ARGUS_FINAL_ARCHITECTURE.md` (24,130 words, 2,242 lines; unchanged since it was written this session) |
| **Repo state** | `main` @ `c298700`; untracked: `.arena/`, `docs/` |
| **Scope of this audit** | Read-only. No source files modified, nothing installed. |

**Tags used in this report**

| Tag | Meaning |
|---|---|
| **[SPEC]** | A fact from the canonical specification |
| **[FOUND]** | Observed in this repository or environment during the audit |
| **[REC]** | My implementation recommendation, not in the spec |
| **SPEC SILENT** | The specification does not address this point |

---

## 1. Repository audit

### 1.1 What exists [FOUND]

The repository holds IncidentMind, a Node.js incident-RCA hackathon app. **None of it is ARGUS.**

| Area | Contents | Notes |
|---|---|---|
| **Backend** | `server.js` (Express 5 + Socket.IO 4.8, CommonJS). Endpoints: `GET /history`, `POST /analyze`. On every socket connect it streams `incident_event`s from `runLiveIncidentEngine` over `datasets/incidents/incident-001.json`. | Single-file server; replays a scripted incident. |
| **Backend modules** (`server/`) | `incident-engine` (411 lines), `blast-radius` (in-memory BFS over a JSON edge list), `business-impact` (INR cost maths), `prediction`, `recovery`, `parallel-universe` (**hard-coded scenario numbers**, e.g. "downtimeMinutes: 42", "peakRisk: 96"), `rag/*` (Chroma + `@xenova/transformers` embeddings), `rca/*` and `ask-incidentmind` (OpenRouter chat completions via axios). | ~2,300 lines total. |
| **Frontend** (`frontend/`) | React 19 + Vite 8 + Tailwind 4 + framer-motion + lucide-react + **@xyflow/react / reactflow** + socket.io-client. `App.jsx` (609 lines) and 7 components: DependencyGraph (React Flow), ReplayEngine, ParallelSimulator, AskIncidentMind, ExecutiveNarrative, LiveFeed, AIConsole. | Tied to IncidentMind's event model. |
| **APIs** | REST `/history`, `/analyze`; Socket.IO event `incident_event`, client emit `operator_action`. | |
| **Dependencies (root)** | `express ^5.2.1`, `socket.io ^4.8.3`, `axios`, `cors`, `dotenv`, `chromadb`, `@xenova/transformers`. `npm ls` also shows several *extraneous* packages (puppeteer remnants). | No FalkorDB, Redis, MCP, YAML or test framework. |
| **Configuration** | `.env` (keys: `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH`; values not read). `frontend/.env.production` (`VITE_API_URL`). `incidentmind-source.yaml` (a jsonl table DSL with **absolute paths to a different folder**). | |
| **Docker** | **None.** No Dockerfile, no compose file. | |
| **Database / storage** | `chroma/` (Chroma vector store: sqlite3 + HNSW bins, gitignored); JSON datasets in `datasets/`, `incidentmind-data/*.jsonl`, `historyData.js`, `rca_audit_output.json`. | **No FalkorDB anywhere** (grep for "falkor" in source: zero hits). |
| **Tests** | Ad-hoc `node` scripts: `server/*/test*.js`, and root `test-*.js`, `test_*.js`, `verify*.js`. No framework; `npm test` is the default stub that exits 1. | |
| **Scripts** | `npm start` → `node server.js`; frontend `dev`/`build`/`lint`/`preview`. | |
| **Scratch / dead** | `scratch_*.js`, `instrument_audit.js`, `deep_rca_audit.js`, `verify_layout.js`, `rca_audit_output.json` (several are gitignored). | Ignore. |
| **Other branches / worktrees** | 11 local branches, several `.claude/worktrees/*`, including `claude/argus-feasibility-2f2443`. **That branch sits at `c298700` (same as main) and its worktrees are clean**, so no prior ARGUS code exists anywhere. | |
| **Arena output** | `.arena/run-20261007-002101-s128618/` (untracked). | Archive only; not a dependency. |

### 1.2 Gotchas that affect ARGUS [FOUND]

- **The `.gitignore` pattern `test-*.js` ignores test files at any depth.** ARGUS tests must not use that naming. **[REC]** Use `*.test.js`.
- `.gitignore` also ignores `*.bin`, `*.sqlite3` and `.env.*`. These are harmless for ARGUS but worth knowing.
- The root `package.json` is `"type": "commonjs"`, named `incidentmind`. ARGUS should not share it (§11).
- The existing OpenRouter calls use **free-tier models** (`openai/gpt-oss-120b:free`, `google/gemma-4-31b-it:free`) and plain chat completions. There is **no tool-calling code**.

### 1.3 Reuse verdict

| Item | Verdict | Reason |
|---|---|---|
| `OPENROUTER_API_KEY` in `.env` | **Reuse** (value) | The spec uses OpenRouter [SPEC]. |
| Express 5 + Socket.IO 4.8 server *pattern* | **Reuse knowledge, not code** | The spec stack is Node + Express + Socket.IO [SPEC]. ARGUS events (`tick`, `step`, `future`, `decision`, `observation`, `clock`) are entirely different from `incident_event`. |
| Vite + React 19 + Tailwind *scaffolding* | **Reuse as a template** (copy the config pattern, not the components) | The spec stack is React/Vite [SPEC]. |
| socket.io-client usage pattern | Reuse the pattern | |
| axios → OpenRouter call shape | Reference only | ARGUS needs tool calling plus an MCP client, so this must be rewritten. |
| `server/blast-radius` | **Do not reuse** | In-memory BFS; ARGUS does blast radius in Cypher on FalkorDB [SPEC §6.6]. Reusing it would weaken the "remove FalkorDB" argument. |
| `server/parallel-universe` | **Do not reuse** | Hard-coded outcome numbers; this directly violates "not dependent on fake numbers" and a032 rule 2. |
| `prediction`, `recovery`, `business-impact`, `incident-engine` | **Do not reuse** | Different problem (post-incident RCA); the spec cuts all IncidentMind modules [SPEC §18]. |
| `rag/*`, Chroma, `@xenova/transformers` | **Do not reuse** | Explicitly cut [SPEC §18]. |
| `rca/*`, `ask-incidentmind` | **Do not reuse** | Cut [SPEC §18]. |
| Datasets, `historyData.js`, jsonl data, `incidentmind-source.yaml` | **Do not reuse** | ARGUS's data is the §8.1 topology. |
| `DependencyGraph.jsx` (React Flow) | **Do not reuse** | The spec names Cytoscape or react-force-graph-2d with fixed preset coordinates [SPEC §15.1]. React Flow is not on that list (see §5, item 18). |
| Scratch, test and verify scripts | Ignore | Dead or irrelevant to ARGUS. |

---

## 2. Spec → repository gap analysis

| Component | Exists? | Reusable? | Needs changes? | New implementation? | Notes |
|---|---|---|---|---|---|
| FalkorDB deployment | No | – | – | **Yes** | Docker compose with a pinned image [SPEC]; no compose file exists. |
| WORLD graph + world clock | No | – | – | **Yes** | Orchestrator owns WORLD, admin user, 5 ticks/s, in-memory tick state [SPEC §3]. |
| TWIN graph | No | – | – | **Yes** | |
| Simulator (`sim.js`) | No (the `parallel-universe` module is fake) | No | – | **Yes** | Port Appendix A; PRNG parity [SPEC §7]. |
| Python reference simulator | No (only in the spec) | – | – | **Yes** (verbatim copy plus a driver) | The Appendix A code exists; **the driver that produces §8.3 is described but not written.** |
| Graph schema | No | – | – | **Yes** | 12 labels, 17 relationship types [SPEC §5]. |
| Seed data | No | – | – | **Yes** | `topology.yaml` → `seed.cypher` [SPEC §6.1, IMPL-INTERPRETATION]. |
| Cypher (rules, amplifier, scope, charge, templates…) | No | – | – | **Yes** | Most queries are verbatim in the spec. |
| `GRAPH.COPY` forks | No | – | – | **Yes** | Delete-then-copy [SPEC]; docs confirm COPY errors if the destination exists [FOUND, docs.falkordb.com]. |
| RED | No | – | – | **Yes** | LLM role plus B5-RED. |
| BLUE | No | – | – | **Yes** | LLM role plus B5-BLUE. |
| MCP server (8 tools, per-role stdio) | No | – | – | **Yes** | No MCP code or SDK in the repo. |
| Graph algorithms | Partial (an unrelated JS BFS) | **No** | – | **Yes** | Must be Cypher / `algo.pageRank`. |
| Intervention engine (templates, APPLY) | No | – | – | **Yes** | |
| Decision engine (rule + harm + audit) | No | – | – | **Yes** | |
| Calibration | No | – | – | **Yes** | Appendix A `calibrate`. |
| Deterministic fallback (B5 + takeover) | No | – | – | **Yes** | |
| Replay (cassette) | `ReplayEngine.jsx` (unrelated UI) | No | – | **Yes** | Spec replay = LLM-decision cassette with live execution. |
| UI (4 panels + header) | An IncidentMind UI exists | Scaffolding only | – | **Yes** | |
| Socket.IO | Yes (server + client deps) | Pattern and dependency versions | Yes (new events) | **Yes** (new server) | |
| Reset mechanism | No | – | – | **Yes** | `npm run reset` < 2 s [SPEC]. |
| Tests | Ad-hoc scripts | No | – | **Yes** | Day-1/2/3 gate suites [SPEC §16, §22]. |
| Demo mode (live/replay/autopilot, run sheet) | No | – | – | **Yes** | |
| Hardening PR (YAML diff) | No | – | – | **Yes** | `js-yaml` [SPEC]. |

**Summary: ARGUS is 100% new implementation.** From IncidentMind it can reuse only the OpenRouter key, the stack choice (Node/Express/Socket.IO/React/Vite/Tailwind), and scaffolding patterns.

---

## 3. Environment audit [FOUND]

| Tool | Current | Required | Action |
|---|---|---|---|
| Node.js | **v22.23.2** | Node for app + MCP [SPEC]; exact minimum SPEC SILENT | OK |
| npm | **10.9.8** | – | OK |
| Python | **3.14.4** (`python` and `py`; `python3` resolves to the Microsoft Store stub) | Python for the Appendix A reference (stdlib only: `math`, `copy`, `statistics`) [SPEC] | OK. **[REC]** invoke as `python`, not `python3`. |
| Git | **2.54.0** | – | OK |
| Docker CLI | **29.4.2** | Docker for FalkorDB [SPEC] | OK |
| Docker Compose | **v5.1.3** | Pinned compose [SPEC] | OK |
| Docker daemon | **NOT RUNNING** (`dockerDesktopLinuxEngine` pipe missing); WSL default distro `docker-desktop` | Must run | **Start Docker Desktop** (user action) |
| FalkorDB | **Not present** (no image checked; the daemon is off) | Pinned FalkorDB image [SPEC] | Pull and pin on Day 1 H1 (§4) |
| Redis | No `redis-cli` / `redis-server` on PATH | Not required separately: FalkorDB *is* a Redis module, and its image ships `redis-cli` | **[REC]** use `docker exec … redis-cli` for ACL and probes |
| `falkordb` npm client | Not installed; registry latest **6.8.0** (depends on `redis ^5.10.0`) | `falkordb` npm client [SPEC §17.1 H1] | Install at Phase 0 (pin exact) |
| `@modelcontextprotocol/sdk` | Not installed; registry latest **1.32.1** | MCP SDK: SPEC SILENT (TBD #1) | Decide now (§5 A) |
| `js-yaml` | Not installed; latest **5.4.3** | Hardening PR diff [SPEC] (and the topology loader [REC]) | Install when needed |
| `cytoscape` / `react-force-graph-2d` | Not installed; latest **3.34.3** / **1.29.2** | One of them [SPEC §15.1] | Decide at UI phase |
| Test runner | None | SPEC SILENT | **[REC]** built-in `node:test` (no dependency) |
| `OPENROUTER_API_KEY` | Present in `.env` (value not read) | OpenRouter [SPEC] | Verify tool-calling model access (§5) |
| Model with tool calling | Repo uses free-tier chat models only | Temperature 0 + tool calling [SPEC]; model SPEC SILENT | Decide on Day 2 (§5 B) |

---

## 4. FalkorDB compatibility

### 4.1 What the spec requires [SPEC]

| Feature | Use | Spec fallback |
|---|---|---|
| `GRAPH.COPY` | Every counterfactual fork | `forkGraph()`: read nodes and edges, bulk `CREATE` |
| Variable-length paths `*1..5`, `*0..4`, `*0..6` | Amplifier, trigger set, scope | `*0..` unsupported → `UNION` of the target's own faults with `*1..4` |
| `reduce` with list indexing `ns[i]`, `rs[i]` | Amplifier query | SPEC SILENT on a fallback |
| `algo.pageRank` | `rank_nodes` | Compute in JS, store `s.pagerank` |
| `shortestPath` | "Why?" | Stored `EVIDENCED_BY` path |
| `GRAPH.RO_QUERY` | `query_graph` | – |
| Redis ACL key patterns on `GRAPH.*` | WORLD isolation (`NOPERM`) | Server-side graph-name allowlist |
| `GRAPH.DELETE` | Reset, fork cleanup | – |

### 4.2 Verified from FalkorDB documentation [FOUND, docs.falkordb.com, 2026-10-07]

- `GRAPH.COPY <src> <dest>` makes a complete clone: nodes, relationships, properties, indexes and constraints, as a consistent snapshot. **It returns an error if `<dest>` exists**, and the docs say to use `GRAPH.DELETE` first. This confirms the spec's delete-then-copy step and resolves the DEL-vs-GRAPH.DELETE half of TBD #11 in favour of **`GRAPH.DELETE`**.
- PageRank: `CALL algo.pageRank(label, relationship-type) YIELD node, score`. This matches the spec's §6.7 IMPL-NOTE form. Scores sum to 1.0. **Damping factor and iteration count are not documented**, which matters for the spec's networkx reference values (0.220…). See §8, risk R4.
- **Neither page states a minimum version.** ACL behaviour for `GRAPH.COPY` is not documented.

### 4.3 Recommended setup

- **Image: `falkordb/falkordb`, pinned by tag *and* digest. Version: TO BE DECIDED DURING IMPLEMENTATION.** Neither the spec nor the docs I checked state a minimum version for `GRAPH.COPY` or `algo.pageRank`. I will not invent one. **[REC] Procedure (Day 1 H1):** pull the current stable tag, record `docker image inspect` digest and `GRAPH.` module version (`MODULE LIST`), run the feature probe (§7), and pin that exact digest in `docker-compose.yml`. If a probe fails, try the previous stable tag; if it still fails, take the spec fallback for that feature.
- **Persistence:** **[REC] none.** Every demo starts from `npm run reset` [SPEC], so RDB/AOF adds nothing (resolves TBD #12, persistence half).
- **Ports:** 6379 (Redis protocol). The FalkorDB Browser that the spec uses for the Act 3 close is a separate UI. **SPEC SILENT** on how it is run: it ships in some FalkorDB images on port 3000. **Port 3000 collides with IncidentMind's default `PORT`**; **[REC]** run ARGUS's app on a different port (e.g. 4000).
- **ACL:** an `agent` user with `~twin ~fork:* ~argus:*` plus a command list (TBD #11). **[REC]** start from `+GRAPH.RO_QUERY +GRAPH.QUERY +GRAPH.COPY +GRAPH.DELETE +PING`, plus whatever the `falkordb` client issues on connect (to be discovered by the probe). Admin stays the default user with a password from `.env`.

---

## 5. Implementation decisions (the 23 TBD items, spec §23)

### A. Must decide before coding (one recommendation each)

| # | Item | Recommendation [REC] | Why it must be decided now |
|---|---|---|---|
| 21 | Repo location | **New top-level `argus/` folder in this repo with its own `package.json` (`"type":"module"`), `argus/ui/` as its own Vite app.** IncidentMind files untouched. | Every file path depends on it. ESM matches the MCP SDK's examples; it also isolates ARGUS from the CommonJS root. |
| 12 | FalkorDB version / persistence | Pin by digest after the H1 probe (§4.3); **no persistence**. | Every Cypher test depends on the engine. |
| 1 (SDK half) | MCP SDK | **`@modelcontextprotocol/sdk`, exact pin `1.32.1`** (current latest), stdio transport. Schemas: as written in spec §11.2, validated with the SDK's schema support. | Day-2 critical path; affects the server skeleton. |
| 3 | Seed format | **`argus/config/topology.yaml` is the single source** (§8.1 tables, `world:` overrides only for payments `cap_mean` 704 and all `cap_sd` 0). `ingest.js` generates both graphs; `seed.cypher` is emitted from it for inspection. | Both graphs and the Python reference must read the same numbers. |
| 2 | `loadModel` / what `world` contains | **Write the Fault/Intervention rules and a `Round` node into `world` as well**, so `loadModel(graph)` is truly single-graph for every graph. The agent cannot read `world`, so this leaks nothing. | Without it, the world simulation would need constants from `twin`, which breaks "only input is `loadModel(graphName)`". |
| 5 (ids) | Id formats | `Scenario` `S:R<n>`; `Snapshot` `SNAP:R<n>:T<tick>`; `Decision` `D:R<n>`; `Observation` `O:R<n>`; `Future` `fork:R<n>:F<k>` (spec); `NO_SAFE_ACTION` = `Decision.minimality:'NO_SAFE_ACTION'` with no `SELECTS` edge. | Deterministic ids are required for `MERGE`, crash safety and cassette keys [SPEC]. |
| 6 | Step ↔ round | **Add `round` to `Step`.** | `BASED_ON` and the trace UI need it; it is cheap now and painful later. |
| 7 | Per-role tool budget | **`red_tool_budget` and `blue_tool_budget` on `(:Round)`** (both 14). | The charge-query strings (fixed per counter) depend on it. |
| 23 | Indices | **Create indices on `Service(name)`, `Fault(id)`, `Intervention(id)`, `Charge(id)`, `Future(id)`, `Scenario(id)`, `Round(n)`** in ingest. | `GRAPH.COPY` copies indices (docs), so forks inherit them. Trivial cost. |
| – | Test runner (SPEC SILENT) | **`node:test`** + `node --test`; Python reference run via `python`. | Day-1 gates are tests. |

### B. Can decide during implementation (with a default)

| # | Item | Default [REC] | Decide by |
|---|---|---|---|
| 1 (schemas) | Tool I/O schemas | Spec §11.2 interpretation as-is | Day 2 |
| 4 | shortestPath query; PageRank damping | §6.22 interpretation; accept FalkorDB PageRank if the **ordering** matches (ledger-db first) and record its scores; otherwise use the JS fallback | Day 1 H1 probe |
| 5 (defs) | `observed_ttr`, `pred_error`, `Decision.rule` encoding | `pred_error` = observed − predicted median; `observed_ttr` = ticks from APPLY to the start of the final ≥ 10-tick violation-free run; `rule` = a compact string of the thresholds | Day 2 |
| 8 | Stale action-space nodes | Add `active:boolean`; regeneration sets `active=false` on invalid nodes instead of deleting them, so history edges survive; `list_candidates` and rule counts use only `active=true` | Day 2 (before round 2) |
| 9 | Scratch fork naming (RED) | `fork:R<n>:red:<call_id first 8 hex>` | Day 2 |
| 10 | Snapshot-noise seed | `6000 + i` (i = index in ORDER) and **R1.11 re-checked with it** | Day 2 |
| 11 (ACL half) | ACL command list; `argus:*` purpose | Probe-derived list; leave `argus:*` unused unless needed (it is on the cut list, item 3) | Day 2 |
| 13 | Literal whitelist | `0.1` (timeout width), `10` (recovery window), `1` / `1.0` / `0`, `0.999999`, `50`, `1000`, `2` / `Math.PI` (Box-Muller), mulberry32 constants | Day 1, while porting |
| 14 | Landed deploy mirrored to twin | **Yes**: deploys are observable config | Day 2 |
| 15 | Agent may fork "do nothing" | Allow `intervention_ids: []` (counted against budget like any future) | Day 2 |
| 16 | `in_degree` | Count of incoming `CALLS` | Day 2 |
| 17 | Cassette format | JSONL in `argus/cassettes/<name>.jsonl`, one turn per line; volatile fields = timestamps, durations, request ids | Day 3 |
| 19 | OpenRouter model | Pick a **tool-calling-capable, non-free** model; accept it only if Day-2 measured p95 turn latency < 6 s (spec ceiling) and it calls tools correctly at temperature 0. The free-tier models used by IncidentMind are a rate-limit risk. | Day 2 |
| 20 | Day 2–4 hours | See §9 | Now (this report) |

### C. Defer to UI/polish

| # | Item | Note |
|---|---|---|
| 18 | UI graph library; Socket.IO payloads; hotkeys; hardening-PR YAML schema | **[REC] Cytoscape** (native `preset` layout = fixed coordinates, which the spec demands). Payloads defined alongside the UI. Note that React Flow (already used by IncidentMind) is **not** one of the two libraries the spec names. Choosing it would be a spec deviation. |
| 22 | Hidden dependency stretch; round 3 | Stretch only if all gates are green by Day 4 noon [SPEC]. |

---

## 6. Build order (dependency-aware)

The proposed order needs four corrections against the spec:

1. **The Python reference comes before everything.** The spec's numbers are the acceptance criteria for every later phase.
2. **The decision engine and audit must exist before RED/BLUE.** `commit` is an MCP tool, and BLUE cannot finish without it.
3. **The deterministic B5 agent comes before the LLM agents.** The Day-2 gate requires a headless loop in `autopilot`, and B5 is the reliability floor.
4. **Reset comes early.** The count tests need it on Day 1 [SPEC §17.1 H2–3].

| Phase | Content | Depends on | Spec gate |
|---|---|---|---|
| **0 Environment** | Start Docker; pull and probe FalkorDB; pin the digest; scaffold `argus/` (package.json, compose, node:test) | – | Day 1 H1 checks |
| **1 Reference truth** | Appendix A verbatim + driver → reproduce §8.3 headline numbers in Python | Python | Numbers reproduce |
| **2 Graph foundation** | `topology.yaml`, `ingest.js`, rules (plus round-2 regeneration), indices, `npm run reset`, count test (10/55/27/376), DAG check, scope queries + counts (15→118, 12→78) | 0 | Day 1 H2–3 |
| **3 `sim.js` + `loadModel`** | Port; PRNG parity; `loadModel` from FalkorDB; magnitude-change test; 3-node cycle test | 1, 2 | Day 1 H4–7 |
| **4 Day-1 gate suite** | R1.1–R1.13, R2.1–R2.8, H.1, P.1, 20-tag robustness, scoped oracles on 21 seed sets, all via `loadModel` | 3 | **Day-1 gate** |
| **5 WORLD/TWIN orchestrator (headless)** | World clock, ACT/inject/t_off/hold, snapshot (noise), APPLY templates to both graphs, OBSERVE, Observation, calibration (800→708.9) | 3 | R1.4/1.5/1.12, R2.6 live |
| **6 Counterfactual forks** | `GRAPH.DELETE`+`GRAPH.COPY`, templates on forks, charge-once, Future commit point, crash test | 2, 3 | Day-2 crash test |
| **7 Decision engine + audit** | Selection rule, per-entry harm, server-run F0/G0, rule-complete BLUE audit, strictly-cheaper RED audit, `audit_sims`, stage/research mode | 6 | R1.10/R2.7 equality |
| **8 MCP server** | 8 tools, role from argv, filtered `listTools`, id/scope validation, budgets, Step persistence, ACL user + allowlist | 6, 7 | Day-2 MCP tests |
| **9 B5 autopilot (RED + BLUE)** | Exact policy; reproduces the stage traces | 8 | Headless loop in `autopilot` |
| **10 LLM agent runtime** | OpenRouter tool calling via MCP client, prompts, 6 s ceiling, takeover rule (5 conditions) | 8, 9 | Headless loop in `live`; scripted wandering test |
| **11 Cassette / replay** | Record/replay, canonical keys, forced-miss → B5 | 10 | Zero-network replay |
| **12 UI** | Socket.IO events; 4 panels; header; controls; PR diff; "Why?"; show rollouts | 5, 7, 9 (UI can be built against autopilot) | Day-3 gate |
| **13 Demo hardening** | Run sheet stopwatch, side-by-side traces, rehearsal ×10, backup video, README "remove FalkorDB" | all | Day 4 |

Phases 5 and 6 can run in parallel after Phase 3. Phase 12 can start against Phase 9 (autopilot) without waiting for the LLM.

---

## 7. First milestone

### M1 — "Reference truth + FalkorDB feature probe"

**Why this is first:** every later acceptance test is a number from spec §8.3, so the first job is to prove those numbers are real on this machine. It also checks the FalkorDB features the whole design rests on. Both parts are small, independent and testable. **Neither writes any ARGUS application logic.**

**Prerequisite (user action):** start Docker Desktop.

**Files to create** (all under `argus/`):

| File | Content |
|---|---|
| `argus/package.json` | `name: argus`, `"type":"module"`, scripts: `ref`, `probe`, `test` (`node --test`). Dependency: `falkordb` (exact pin). |
| `argus/docker-compose.yml` | `falkordb/falkordb` at the tag chosen in the probe step, pinned by digest after the probe; port 6379; no persistence volume. |
| `argus/sim/reference/sim_reference.py` | **Appendix A, verbatim.** |
| `argus/sim/reference/reproduce.py` | Driver per Appendix A's "How the reference-number table is produced": R1.3, R1.5, R1.6–R1.9, R1.12, R2.3–R2.6 at the stage tags, plus the PRNG vector. Prints JSON. |
| `argus/sim/reference/expected.json` | The spec §8.3/§8.4 values to compare against. |
| `argus/tests/ref.test.js` | Runs `python sim/reference/reproduce.py` and asserts against `expected.json`. |
| `argus/scripts/falkordb-probe.js` | On a scratch graph: `GRAPH.COPY` (and error-if-exists), `*0..4` paths, `reduce` with `ns[i]`, the full amplifier query on a mini seed, `algo.pageRank` signature + ordering, `shortestPath`, `GRAPH.RO_QUERY` rejecting writes. Prints PASS/FAIL per feature and `MODULE LIST`. |
| `argus/tests/probe.test.js` | Asserts every probe PASS (or records the chosen fallback). |
| `argus/README.md` | Commands only. |

**Files to modify:** **none.** **[REC]** add `.arena/` to the root `.gitignore` later, as a separate small change, only if you want it.

**Commands:**

```
cd argus
npm install
docker compose up -d
npm run ref        # python sim/reference/reproduce.py
npm run probe      # node scripts/falkordb-probe.js
npm test
```

**Expected output (from spec §8.3, not invented):**

- PRNG seed 1001 → `606341916, 1148489751, 477154826, 1429770400`.
- R1.3: `degrade:ledger-db` sustained **15/16** (tag 101).
- R1.2 sample: `degrade:payments` sustained **0/16** (tag 101).
- R1.5: world goodput **0.0** for ticks 30–39 after the fault is removed.
- R1.6: from the tick-40 snapshot, do-nothing / +50% payments / +50% ledger-db all **0/16** (tag 102).
- R1.7: one-layer `retries_off:checkout>payments` **2/16**.
- R1.8: breaker **16/16, median 14**.
- R1.9: both-layer retries_off **16/16, median 2 (p10–p90 1–3)**; world **3**.
- R1.12: calibration payments **708.9**, n **41**, SE **5.3**; ledger-db n **6** → unchanged.
- R2.3/R2.4/R2.5/R2.6: 0/16 singles; `degrade:ledger-db + deploy:CE-42` **16/16**; G1 32.5, G2 30.5, G3 **0**; world 89/32/31/0.
- Probe: one PASS/FAIL line per feature, plus the module version.

**Acceptance tests:**

1. `ref.test.js` passes: every reproduced value equals `expected.json`.
2. `probe.test.js` passes, or each failing feature has its spec fallback recorded in `argus/README.md`.
3. `docker compose down && docker compose up -d && npm run probe` gives the same result (it is idempotent).

**Definition of DONE:**

- [ ] All listed §8.3 values reproduced exactly by the verbatim Appendix A plus driver.
- [ ] FalkorDB image pinned by digest; module version recorded.
- [ ] Every required FalkorDB feature is PASS or has a recorded fallback.
- [ ] No file outside `argus/` changed.
- [ ] **If any spec number does not reproduce: stop, report the discrepancy, and do not proceed to Phase 2.** Under the spec's own rule, numbers are re-derived from code, never edited by hand.

Robustness tags 1–20, the full oracles and the robustness sweep belong in Phase 4, not in M1.

---

## 8. Risk analysis (top 10)

| # | Risk | Impact | Mitigation | Fallback |
|---|---|---|---|---|
| R1 | **Appendix A does not reproduce §8.3** (e.g. a driver detail differs from what a032 ran) | Every gate and the demo story collapse | M1 runs first; the driver follows Appendix A's production notes line by line | Re-derive numbers from code and update the spec's reference table with an explicit changelog. Never hand-edit. |
| R2 | **FalkorDB feature gaps** (`GRAPH.COPY`, `*0..`, `reduce` indexing, ACL on `GRAPH.*`) | Forks, amplifier query or isolation broken | Day-1 H1 probe; pin the digest | Spec fallbacks: `forkGraph()`, `UNION` with `*1..4`, graph-name allowlist |
| R3 | **`GRAPH.COPY` behaviour**: errors if the destination exists; copy cost; ACL on two keys | Fork failures mid-demo | Delete-then-copy with `GRAPH.DELETE`; crash test; forks kept for Q&A | `forkGraph()` bulk-create |
| R4 | **PageRank values differ** from the networkx reference (damping/iterations undocumented) | Round-2 pivot target could change | Probe checks the *ordering* (ledger-db first) | JS PageRank written to `s.pagerank` [SPEC fallback] |
| R5 | **`sim.js` port drift** (PRNG, draw order, topological order ≠ `ORDER`) | Twin and world numbers diverge from the reference | PRNG parity first; trace equality within 1e-9; assert the derived order equals ORDER on the seed | Use the fixed seed ORDER for the demo; keep lagged-edge logic for cycles only |
| R6 | **Metastable cascade fragile under change** (any parameter tweak breaks 15/16 or "stays down") | The "still down" moment fails | Robustness gate tags 1–20; never tweak the stage topology | Revert to the exact §8.1 parameters (topology.yaml under git) |
| R7 | **WORLD/TWIN isolation leaks** (agent reads `world`) | The honest-prediction claim is false | ACL user + `NOPERM` test; agent process never gets the admin password | Graph-name allowlist in the MCP server [SPEC] |
| R8 | **MCP reliability** (stdio child crash, SDK version quirks) | Phase stalls | Charge-once, Future commit point, respawn-and-retry; exact SDK pin | Takeover to B5 (it uses the same server; on repeated failure, B5 can call the same functions in-process — **[REC]**, not in the spec) |
| R9 | **LLM nondeterminism / latency / rate limits** (free-tier models in repo) | Live Act 3 fails or overruns | Paid tool-calling model, temperature 0, 6 s ceiling, p95 check, cassette | Replay mode; takeover to B5 with `AUTOPILOT` badge [SPEC] |
| R10 | **Time overrun** (FalkorDB from zero is the main risk [SPEC]; UI scope creep) | No demo by Day 4 | Strict day gates; UI built against autopilot from Day 3 morning; cut list in spec order | Cut order: hidden dependency → cameo → ACL user → "Why?" → round 3 → RED audit [SPEC]; recorded video |

Also tracked: UI integration (Socket.IO payloads undefined until Day 3; mitigate by defining them when the orchestrator emits them in Phase 5) and live-demo failure (venue: pinned compose, second laptop, recorded video [SPEC]).

---

## 9. 4-day build plan

**Assumptions [SPEC]:** 2–3 people, about 10 h/day. **[REC]** Day 2–4 hour splits are mine; the spec gives hours only for Day 1.

### Day 1 — foundation + graph + simulator

| Hours | Work | Milestone / acceptance |
|---|---|---|
| H1 | Phase 0 + M1 probe half: Docker up, pull, probe, pin | Probe PASS or fallbacks recorded |
| H1–H2 (in parallel) | M1 reference half | §7 values reproduce |
| H2–3 | Phase 2: topology.yaml, ingest (explicit defaults, indices), rules, reset, counts, DAG, scope queries | Counts 10/55/27/376; scopes 15→118, 12→78; reset < 2 s |
| H4–7 | Phase 3: `sim.js` port, `loadModel`, parity | P.1 parity; magnitude test; 3-node cycle |
| H8–10 | Phase 4: gate suite | **Day-1 gate: R1.1–R1.13, R2.1–R2.8, H.1, robustness 1–20, both oracles on 21 seed sets** |

**Hard deadline:** if the Day-1 gate is not green by the end of Day 1, Day 2 starts on it, and the UI scope shrinks to the minimum in §10.

### Day 2 — agents, MCP, counterfactuals

| Hours | Work | Acceptance |
|---|---|---|
| H1–3 | Phase 5 orchestrator (headless): world clock, ACT, t_off, snapshot, APPLY, OBSERVE, calibration | World R1.4/R1.5; observed 3; calibration 708.9 |
| H1–3 (parallel) | Phase 6 forks: COPY, templates, charge-once, Future | Crash test: one charge, identical Future; repeated call free |
| H4–5 | Phase 7 decision engine + audits | Committed decision = scoped oracle (F5, G3); audit counts 10 / 12; harm per entry |
| H5–7 | Phase 8 MCP server | Role filtering; unknown id error; scope tests; `NOPERM` on world |
| H7–8 | Phase 9 B5 | **Headless 2-round loop in `autopilot` producing §8.4** |
| H8–10 | Phase 10 LLM runtime + takeover | Headless loop in `live`; scripted wandering trace → takeover after the 4th sim; two rejected calls → takeover |

**Day-2 gate [SPEC]:** the 2-round loop runs headless end to end in `live` and `autopilot`, producing the §8.4 numbers.

### Day 3 — UI + integration

| Hours | Work | Acceptance |
|---|---|---|
| H1–2 | Socket.IO events from the orchestrator; UI scaffold (Vite/React/Tailwind) | Events stream in autopilot |
| H2–6 | Four panels + header: graph (fixed coords), trace (+Cypher), futures (R/A/G), pred-vs-obs (band + line), budgets, scope counter, banner + hold, pause indicator | Full demo visible in autopilot |
| H6–7 | PR diff, "Why?", show rollouts, reset button, mode hotkeys | |
| H7–9 | Phase 11: record cassette; replay | **Day-3 gate: full demo in replay with zero network; forced miss → B5 cleanly** |
| H9–10 | Buffer | |

### Day 4 — testing, reliability, polish, rehearsal

| Hours | Work | Acceptance |
|---|---|---|
| H1–3 | Act 3 polish: side-by-side traces, pre-emptive do-nothing line; stopwatch the run sheet | Replay ≈ 81 s; stage plan 84–108 s |
| H3–4 | Full checklist (spec §22) pass | All boxes checked |
| Noon | **Stretch decision** (hidden dependency, cameo, round 3) only if everything is green | |
| H5–8 | 10 rehearsals; backup video; second-laptop setup | |
| H8–10 | README with the "remove FalkorDB" argument; "Remove FalkorDB" slide | |

---

## 10. Demo-first acceptance criteria

**"ARGUS is actually demoable"** when the full two-round story runs end to end **in replay or autopilot** with the UI. The minimum bar does **not** require live LLM; that is the next bar.

- [ ] **HEALTHY:** reset → all green; world healthy 150 ticks (R1.1).
- [ ] **RED investigates:** `amplification_paths(2)` → gateway→checkout→payments 4.5×, triggers listed; trace with Cypher.
- [ ] **Dangerous scenario discovered:** `degrade:payments` 0/16, `degrade:ledger-db` 15/16; `proven: no cheaper attack`.
- [ ] **Failure injected:** world red from the bottom up along the path.
- [ ] **Cascade occurs, and persists:** `TRIGGER REMOVED` at tick 30 with 4 s hold; world stays red (goodput 0.0).
- [ ] **BLUE activates:** snapshot at tick 40; scope counter 6 / 118 / 376.
- [ ] **Counterfactual futures:** F0–F5 render red, red, red, red, amber, green with §8.4 numbers; audit badge "10 options at cost ≤ 2".
- [ ] **Intervention selected by the rule:** F5, `proven-in-scope`.
- [ ] **World recovers:** observed 3 vs predicted 2 on the overlay; calibration 800 → 709.
- [ ] **Hardening persists:** PR diff; retries 0 on two edges in world and twin; action spaces regenerated.
- [ ] **RED attacks again:** amplifier query empty → PageRank → ledger-db → CE-42 → 16/16.
- [ ] **Different reasoning occurs:** round-1 and round-2 traces side by side, visibly different tool sequences.
- [ ] **BLUE pre-emptive:** G1 amber, G2 amber, G3 green; world stays green with slowdown + CE-42; do-nothing flat red line.
- [ ] **Reset works** (< 2 s) and the run repeats identically.
- [ ] **`AUTOPILOT` badge** shown whenever B5 acts.

**Next bar, "stage-ready":** the Act 3 RED pivot runs **live** with `LIVE · LLM`; the run sheet fits 84–108 s; the spec §22 checklist is fully checked; backup video recorded.

---

## 11. Final recommendation

**A. What to do FIRST.** Start Docker Desktop, then execute **M1**: verbatim Appendix A + driver reproducing the §8.3 numbers, and the FalkorDB feature probe with digest pinning. Confirm the Category-A decisions in §5 before M1 starts (above all, the `argus/` location and ESM).

**B. What NOT to touch yet.**
- Any IncidentMind file: `server.js`, `server/`, `frontend/`, datasets, root `package.json`, `.gitignore`.
- The UI, the LLM runtime and the MCP server, until the Day-1 gate is green.
- Stretch items (hidden dependency, round 3, Claude Desktop cameo).
- `.arena/`: leave it as an archive.

**C. What can be reused from IncidentMind.**
- `OPENROUTER_API_KEY` from `.env` (copy into `argus/.env`, or load it).
- Stack choices and versions: Express 5, Socket.IO 4.8, socket.io-client, React 19, Vite, Tailwind.
- The Vite/Tailwind config pattern as a template.

No IncidentMind module logic is reused.

**D. What to build from scratch.** Everything in spec §16: FalkorDB compose + ACL; topology/ingest/rules/reset; `sim.js` + reference; orchestrator (WORLD/TWIN, clock, snapshot, APPLY, OBSERVE, calibration); forks; decision engine + audits; MCP server (8 tools); B5; LLM runtime + takeover; cassette; UI; tests; hardening PR; README.

**E. The first exact coding task after this audit.** Create `argus/sim/reference/sim_reference.py` (Appendix A verbatim) and `argus/sim/reference/reproduce.py`. The driver should reproduce, in this order: the PRNG vector for seed 1001; R1.3 (`ensemble(T, init_state(T), ['degrade:ledger-db'], 30, 90, tag=101)` → 15/16 sustained); R1.5 (world `rollout(W, init, ['degrade:ledger-db'], ∞, 30, 7)` then `rollout(W, s, [], 0, 10, 8)` → goodput 0.0); and F0–F5 from the tick-40 snapshot at tag 102. Then compare the output against `expected.json`. This needs only Python, which is already installed, and it validates the numbers that every later test depends on.

---

*Audit complete. No source files modified, no dependencies installed. Only this report was created: `docs/ARGUS_BUILD_READINESS_AUDIT.md`.*
