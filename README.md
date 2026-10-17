# ARGUS

**Find the outage before it happens. Prove the smallest fix. Check the prediction against reality.**

ARGUS is a graph-grounded RED / BLUE agent that attacks a copy of your system in FalkorDB, tests candidate fixes on forked graphs, and only applies a fix the server can prove is the cheapest safe one in scope.

| | |
|---|---|
| **Live demo** | https://argus-graphhack.onrender.com (free tier: the first request can take about a minute to wake) |
| **Health** | https://argus-graphhack.onrender.com/state |
| **Repository** | https://github.com/rahilahmed-1945/ARGUS-GraphHack |
| **Hackathon** | [Graph Hacks: Context for AI Agents](https://www.wemakedevs.org/hackathons/falkordb) by WeMakeDevs × FalkorDB, 15–18 Oct 2026. **Track 01: Agents That Act on Connected Data.** |
| **Demo video** | Coming soon. The link will be added here once the recording exists. |

---

## 1. What if you could find an outage before it happens?

A service slows down. The services that call it retry their requests. Those retries multiply traffic across the system, and one small problem turns into a cascading outage. And the service that *looks* broken is often not the service that *started* it.

Here is the situation ARGUS is built around. Picture an online shop with eight services. For thirty seconds, the ledger database gets slow. Payments, which writes to it, starts timing out. Checkout retries each failed payment three times. The gateway retries each failed checkout twice. Nobody changed anything; this is ordinary, sensible retry configuration.

```
300 requests/s  ×  (1 + 2 retries)  ×  (1 + 3 retries)  =  3,600 attempts/s
against a payments service that can really handle about 704/s
```

Then the database recovers. **The outage does not.** The retries are now the load. Every dashboard points at `payments`, the service that is visibly saturated, but scaling it does nothing and fixing the database did nothing. The trigger was three hops below the users and one hop below the real amplifier. That is a *metastable failure*, and it is exactly the kind of thing a graph can see and a dashboard cannot.

ARGUS searches for dangerous failure combinations like this one **before they happen**, tests the possible fixes on copies of the system, chooses one by a rule it can explain, and then checks whether the fix actually worked.

## 2. What ARGUS does: RED → BLUE → VERIFY

- **RED finds trouble.** A budgeted agent reads the system graph, follows the multi-hop retry path that amplifies load, pairs it with a trigger underneath it, and proves the attack in simulation on a scratch copy. It is not allowed to invent faults: it can only pick from the failure modes the graph generated.
- **BLUE finds a fix.** After the attack, BLUE snapshots the live state, forks the graph once per candidate fix with `GRAPH.COPY`, and runs seeded simulations on each fork. Every candidate comes from the graph, scoped by the server to the paths the fault can actually affect.
- **ARGUS verifies.** A server-side rule, not the model, commits the cheapest future that recovers and stays inside the error budget. The server then audits every untested in-scope option at the same or lower cost. The fix is written to the twin and to a separate hidden WORLD graph, and the twin's prediction is compared with what the world actually did.
- **Then it attacks again.** The hardened system is a different graph, so the second attack has to reason differently. In the recorded run, the retry-storm query comes back empty and the agent pivots to the pending deployment that would turn a routine slowdown into a permanent outage.

## 3. The four stages, as they look in the running UI

All images are unedited captures of the ARGUS command centre replaying the recorded live run (the same recording the public deployment serves).

![The ARGUS command centre: the system twin of eight services drawn as a 3D graph, the story panel on the left explaining the problem, and the empty evidence panel on the right before the run starts](docs/images/01-command-center.jpg)

*Stage 1, the command centre. The twin graph holds every service, every call edge with its retry, timeout and breaker settings, the generated faults and interventions, and the round's budgets and safety constants.*

![RED's investigation: the amplifier path gateway → checkout → payments is highlighted in red with its retry counts, the trigger ledger-db is marked, RED's what-if tests are listed below the graph, and the evidence panel lists each FalkorDB query RED ran](docs/images/02-red-investigation.jpg)

*Stage 2, RED finds the failure. The multi-hop amplifier query reports a 4.5× worst-case load along gateway → checkout → payments. RED then simulates the triggers beneath it: a payments slowdown heals by itself (0 of 16 runs broken) while a ledger-db slowdown, three hops from the users, breaks the system in 15 of 16 runs.*

![BLUE's counterfactual testing: six what-if future cards, each run on its own graph fork, with verdicts such as Still broken, Helps but not enough, and Works; the evidence panel lists each graph copy and the query behind it](docs/images/03-blue-counterfactuals.jpg)

*Stage 3, BLUE tests fixes on forks. Doing nothing, adding ledger-db capacity, limiting or disabling a single retry layer: all still broken. Two circuit breakers recover but blow the error budget. Disabling retries on both amplifier layers recovers in all 16 runs with few bad ticks.*

![Verification: the chapter title reads Cheapest Safe Fix Proven, the chosen future is highlighted, the story panel says ARGUS tested 10 other possible fixes on copies of the graph and none cheaper works, and the chosen edges are labelled on the graph](docs/images/04-verification-cheapest-safe-fix.jpg)

*Stage 4, the server verifies. BLUE proposed the fix; the rule accepted it; the audit then ran the 10 untested in-scope options at the same or lower cost as real forked futures. None qualifies, so the decision is recorded as proven-in-scope.*

![Predicted versus observed: after the fix is applied the story panel reads Predicted 2 bad moments, observed 3, within the predicted range, and the graph shows the two retry edges changed from 2 to 0 and 3 to 0](docs/images/05-predicted-vs-observed.jpg)

*The prediction is checked against the hidden WORLD graph: the twin predicted a median of 2 bad ticks, the world showed 3, inside the predicted p10–p90 band. The twin also recalibrates the payments capacity it had wrong.*

## 4. Why FalkorDB is the centre of the system, not a store behind a chart

Any database could be forced to do each of these jobs. The point is that **one graph is at once the model, the action space, the fork substrate, the algorithm engine, the safety constraint, the access boundary and the trace.**

| What the graph does | How |
|---|---|
| **It is the model** | The simulator has no topology or constants of its own. Its only input is `loadModel(graph)`. Every capacity, retry count, timeout, breaker setting and fault magnitude is a node or edge property. |
| **It generates the action space** | Faults and interventions are not hard-coded lists. Cypher rules run over the topology (`graph/schema.js`) and create a `Fault` node for every non-entry service, entry service and pending deploy, and an `Intervention` node for every retrying edge, breaker-less edge, service and pending deploy. After hardening the rules run again, so the hardened graph offers different moves. |
| **It is the fork substrate** | Every counterfactual future is a real `GRAPH.COPY` of the twin, named `fork:R<round>:<label>`, mutated by a fixed Cypher template, simulated, summarised as a `Future` node on the twin, then deleted. |
| **It is the evidence engine** | The amplifier path (variable-length path plus `reduce` over retries, fan-out and capacity), the downstream closure that finds triggers, `algo.pageRank`, and the blast-radius traversal are the tools the agents call. |
| **It holds the safety constraint** | `error_budget`, `rec_threshold`, the SLO and the simulation horizons live on the `Round` node. The decision rule reads them from the graph. |
| **It enforces the WORLD / TWIN boundary** | The agents' MCP servers connect as a Redis ACL user that can only touch `twin`, `fork:*` and `argus:*`. The hidden `world` graph answers `NOPERM`. The prediction claim is honest because the database enforces it. |
| **It is the shared state and the trace** | Budgets (`Charge`), scenarios, futures, decisions, observations and every tool call (`Step`, with its Cypher) are graph records. The MCP child processes coordinate only through FalkorDB. |

Remove the graph and there is nothing to simulate, nothing valid to choose from, nothing to fork and nothing to audit.

## 5. What is genuinely different about ARGUS

None of the individual algorithms here is new. PageRank, variable-length path queries and Monte Carlo rollouts are standard. What is unusual is how the pieces are arranged.

- **RED finds trouble from the graph.** It discovers fault *combinations* and traces multi-hop amplification, rather than picking a random service to kill. In the recording it pairs a slowdown with a pending deployment that only becomes dangerous together.
- **BLUE finds a fix by testing futures, not by guessing.** Each candidate runs on its own graph fork with 16 seeded rollouts, and the twin keeps the predicted band for later comparison.
- **FalkorDB drives the reasoning.** The topology, the candidate faults, the valid interventions, the scope of a decision and the forks all come from Cypher over the live graph (section 4).
- **The LLM is not the final authority.** The model chooses what to look at and what to test, inside a tool budget. The server decides what is valid (candidate scope, at most two interventions, no conflicting edits), charges the budget, applies the decision rule and runs the minimality audit. A proposal that the rule rejects is refused with a reason.
- **The system checks its own predictions.** A separate WORLD graph, with capacities the twin does not know, plays the role of production. Every decision gets an `Observation` node with predicted and observed bad ticks, and the twin recalibrates from what it saw.
- **It learns what to investigate next.** Round 2 runs on the hardened graph. The amplifier query returns nothing, so the agent has to switch tools (PageRank, then a pending-deploy query) to find the next weakness. The second screenshot below is that moment.

![Round 2: the chapter reads RED, find a new failure, the graph shows the first fix applied (2 → 0 and 3 → 0 retries) and a new red path mobile-gw → orders → ledger-db, the story panel reads failure found: a slowdown in ledger-db plus the pending deploy CE-42, broken in 16 of 16 runs, and the status reads Testing again](docs/images/06-round2-different-reasoning.jpg)

*Round 2 on the hardened graph. In the recorded run this RED phase was decided by the live model: it found that the pending deploy CE-42 (orders → ledger-db, retries 0 → 3) turns a slowdown that now heals on its own (0 of 16) into a permanent outage (16 of 16).*

## 6. How it works

```mermaid
flowchart LR
  subgraph FalkorDB
    TWIN[(twin<br/>what ARGUS believes)]
    WORLD[(world<br/>hidden ground truth)]
    FORKS[(fork:R1:F5 …<br/>GRAPH.COPY per candidate)]
  end
  subgraph argus-app
    ORCH[Orchestrator<br/>rounds · snapshots · WORLD ticks]
    RULE[Decision rule + minimality audit<br/>argmin cost · recovers · within error budget]
    SIM[Executable simulator<br/>fluid model · seeded rollouts]
    UI[Command centre<br/>Socket.IO + three.js]
  end
  subgraph agents
    RED[RED agent<br/>LLM or B5 autopilot]
    BLUE[BLUE agent<br/>LLM or B5 autopilot]
    MCP[MCP tool servers<br/>stdio · ACL user agent]
  end
  RED --> MCP
  BLUE --> MCP
  MCP -- query_graph · amplification_paths · rank_nodes<br/>blast_radius · list_candidates · simulate · fork_and_simulate · commit --> TWIN
  MCP --> FORKS
  FORKS --> SIM
  SIM --> TWIN
  TWIN --> RULE
  RULE -- apply the proven fix --> TWIN
  RULE -- apply the proven fix --> WORLD
  ORCH -- inject fault · tick · observe --> WORLD
  WORLD -- observed vs predicted --> TWIN
  ORCH --> UI
  MCP -. NOPERM .-> WORLD
```

One round, step by step:

1. **Seed.** `config/topology.yaml` is ingested into `twin` and `world` (the world differs only in a few hidden values, such as the real payments capacity). The action-space rules generate `Fault` and `Intervention` nodes.
2. **RED.** The agent calls graph tools over MCP, simulates candidate fault sets on a scratch copy, and commits a scenario. The server re-simulates it with the same seeds and audits that no cheaper attack exists.
3. **Inject.** The orchestrator applies the fault to `world` and advances it tick by tick. At tick 30 the trigger is removed. The world stays broken.
4. **Snapshot and BLUE.** A noisy estimate of the world's live state is written onto the twin. BLUE forks the twin per candidate, applies the fixed intervention template on the fork, runs 16 rollouts from the snapshot, and proposes the future it believes is best.
5. **Commit.** The rule picks the cheapest future with `p_recover ≥ 15/16`, median bad ticks `≤ 10` and no harm to any entry point compared with doing nothing. The audit runs every untested in-scope candidate at the same or lower cost. Only a proposal that equals the rule's winner is accepted.
6. **Harden and observe.** The intervention is applied to twin and world, a YAML config diff is generated from the actual graph change, the world runs on, and an `Observation` records predicted versus observed. The twin calibrates capacities it had wrong.
7. **Round 2.** The rules regenerate the action space on the hardened graph and RED attacks again.

If the model is slow, stuck or invalid, a deterministic autopilot (B5) takes over the phase using the same tools, and the UI labels that phase `autopilot` with the reason. The decision rule and audit apply to the autopilot exactly as they apply to the model.

## 7. Graph data model and real Cypher

### Nodes

| Label | Created by | Key properties |
|---|---|---|
| `Service` | seed | `name`, `entry`, `ext_rps`, `cap_mean`, `cap_sd`, `base_ms`, `queue_s`, `shed` |
| `ChangeEvent` | seed | `id`, `field`, `new_value`, `status` (`pending` / `blocked` / `landed`) |
| `Fault` | action-space rules | `id`, `kind` (`cap_degrade`, `surge`, `deploy`), `magnitude`, `persistence`, `cost_to_attacker`, `active` |
| `Intervention` | action-space rules | `id`, `kind` (`retries_off`, `cap_retries`, `breaker`, `scale_out`, `shed`, `block_deploy`), `caller`, `callee`, `cost`, `factor`, `active` |
| `Round` | seed | `n`, `sim_budget`, `fork_budget`, `red_tool_budget`, `blue_tool_budget`, `error_budget`, `rec_threshold`, SLO and horizon constants |
| `Scenario`, `Snapshot`, `Future`, `Decision`, `Observation`, `Step`, `Charge` | the run | scenario faults and server-computed `scope_ids`; live-state snapshot; per-future `p_recover`, `viol_ticks_p50`, `p10`/`p90`, `bands`, `verdict`, `cost`; the committed decision with its rule and audit counts; predicted vs observed; every tool call with its Cypher; idempotent budget charges |

### Relationships

`(:Service)-[:CALLS {fanout, retries, timeout_ms, breaker, …}]->(:Service)` · `(:ChangeEvent)-[:MODIFIES {callee}]->(:Service)` · `(:Fault|:Intervention)-[:APPLIES_TO]->(:Service)` · `(:Fault)-[:LANDS]->(:ChangeEvent)` · `(:Intervention)-[:BLOCKS]->(:ChangeEvent)` · `(:Scenario)-[:CONTAINS]->(:Fault)` · `(:Scenario)-[:EVIDENCED_BY]->(:Service)` · `(:Scenario)-[:PRODUCES]->(:Future)` · `(:Future)-[:TESTS]->(:Intervention)` · `(:Future)-[:FROM]->(:Snapshot)` · `(:Decision)-[:ADDRESSES]->(:Scenario)` · `(:Decision)-[:SELECTS]->(:Intervention)` · `(:Observation)-[:VERIFIES]->(:Decision)` · `(:Step)-[:TOUCHED]->(:Service)` · `(:Step)-[:NEXT]->(:Step)` · `(:Decision)-[:BASED_ON]->(:Step)`

After the seed the twin holds 8 `Service`, 9 `CALLS`, 2 `ChangeEvent`, 10 `Fault` and 27 `Intervention` nodes. The full schema is in [docs/ARGUS_FINAL_ARCHITECTURE.md](docs/ARGUS_FINAL_ARCHITECTURE.md) §5.

### Cypher the product depends on

All five queries below were executed against the seeded twin on FalkorDB 6.0.1 while writing this README; the results quoted are what they returned.

**The amplifier query** (`amplification_paths`, `runtime/tools.js`). It follows every path from an entry point up to five hops, multiplies the worst-case load along it, bounds the load by each hop's capacity, and then looks *beneath* the overloaded service for the faults that could trigger the storm.

```cypher
MATCH p = (e:Service {entry:true})-[:CALLS*1..5]->(s:Service)
WITH p, e, s, nodes(p) AS ns, relationships(p) AS rs
WITH p, s, reduce(L = toFloat(e.ext_rps), i IN range(0, size(rs)-1) |
       (CASE WHEN L > ns[i].cap_mean THEN ns[i].cap_mean ELSE L END)
       * rs[i].fanout
       * (CASE WHEN rs[i].breaker THEN 1 ELSE 1 + rs[i].retries END)
     ) AS worst_load
WITH p, s, worst_load / s.cap_mean AS overload
WHERE overload >= $min_risk
MATCH q = (s)-[:CALLS*0..4]->(d:Service)<-[:APPLIES_TO]-(f:Fault) WHERE coalesce(f.active, true)
WITH p, s, overload, f, min(length(q)) - 1 AS hops
ORDER BY overload DESC, hops, f.id
RETURN [n IN nodes(p) | n.name] AS amplifier, s.name AS target, overload,
       collect(f.id + '@' + toString(hops)) AS triggers
ORDER BY overload DESC, target, amplifier
LIMIT 5
```

Result on the seed with `min_risk = 2`: one row, amplifier `gateway → checkout → payments`, overload `4.5`, triggers `degrade:payments@0`, `degrade:ledger-db@1`. On the hardened graph the same query returns no rows, which is what forces the agent to change tools in round 2.

**PageRank as a tool** (`rank_nodes`):

```cypher
CALL algo.pageRank('Service', 'CALLS') YIELD node, score
RETURN node.name AS service, score ORDER BY score DESC, service
```

Result: `ledger-db 0.220`, `inventory 0.164`, `auth 0.137`, `payments 0.119`, then checkout and orders.

**Pending deployments into the top-ranked service** (the round-2 pivot, written by the agent through `query_graph`):

```cypher
MATCH (c:ChangeEvent {status:'pending'})-[m:MODIFIES]->(a:Service)-[:CALLS]->(b:Service {name:'ledger-db'})
WHERE m.callee = b.name
RETURN c.id, a.name, b.name ORDER BY c.id
```

Result: `CE-42, orders, ledger-db`.

**Blast radius** (`blast_radius`), everything upstream of a service with hop counts:

```cypher
MATCH p = (u:Service)-[:CALLS*1..6]->(x:Service {name:$service})
WITH u, min(length(p)) AS hops
RETURN u.name AS upstream, u.entry AS is_entry, hops ORDER BY hops, upstream
```

Result for `ledger-db`: orders and payments at 1 hop, checkout and mobile-gw at 2, gateway at 3.

**Scope, computed by the server and never by the agent** (`graph/scope.js`, first of three queries). It collects every entry-to-fault path, so BLUE can only test interventions on paths the fault can actually affect:

```cypher
MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault)-[:APPLIES_TO]->(t:Service)
MATCH p = (e:Service {entry:true})-[:CALLS*0..6]->(t)
RETURN [n IN nodes(p) | n.name] AS ns,
       [r IN relationships(p) | startNode(r).name+'>'+endNode(r).name] AS es
```

**A counterfactual, written on the fork only** (`graph/forks.js`, the `retries_off` template; the value comes from the `Intervention` node, never from code):

```cypher
MATCH (i:Intervention {id:$id})
MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name = i.caller AND b.name = i.callee
SET c.retries = 0 RETURN count(c) AS n
```

## 8. Technology stack and algorithms

| Component | Choice | Why |
|---|---|---|
| Graph database | **FalkorDB 6.0.1** (pinned Docker image), `falkordb` 6.8.0 and `redis` 5.12.1 Node clients | Cypher, `GRAPH.COPY` for forks, `algo.pageRank`, Redis ACL for the WORLD/TWIN boundary |
| Runtime | **Node.js 22**, ES modules, `node:test` | One language from graph layer to UI; built-in test runner |
| Agent tools | **Model Context Protocol** (`@modelcontextprotocol/sdk` 1.32.1), one stdio server per role | The model sees only its role's tools; every call goes through the server's authorisation, budget and `Step` trace |
| LLM | **OpenRouter**, OpenAI-compatible chat completions with tool calling, temperature 0 | Provider-agnostic; the recorded run used `cohere/north-mini-code:free` |
| Fallback agent | **B5 deterministic autopilot** | Same tools, no model; keeps the demo honest and reliable when a free model stalls |
| Simulator | Fluid (rate-based) model of queues, timeouts, retries and breakers; `mulberry32` PRNG with Box–Muller noise | Bit-identical to a frozen Python reference (`sim/reference`); 16 seeded rollouts per future with common random numbers |
| Command centre | Socket.IO 4.8 + three.js 0.186 | Replays the real event log with narration; every evidence line opens the Cypher behind it |
| Deployment | Single Docker image (FalkorDB + Node) on Render Free | ₹0, no persistent state needed |

Algorithms, each of which changes what an agent does:

- **Amplifier-path discovery**: variable-length path with a `reduce` over retries, fan-out and capacity (the retry-storm inequality, evaluated per path).
- **Downstream closure**: `*0..4` traversal beneath the overloaded service to list the faults that can light it.
- **PageRank** over `CALLS`: the fallback evidence when no amplifier exists.
- **Blast radius**: upstream BFS with minimum hop counts.
- **Counterfactual forks**: delete-then-`GRAPH.COPY`, fixed intervention templates, seeded Monte Carlo rollouts.
- **Decision rule**: `argmin cost | p_recover ≥ rec_threshold AND viol_ticks_p50 ≤ error_budget AND not harmful`, ties broken by median bad ticks then id.
- **Scoped minimality audit**: every untested in-scope candidate (do nothing, every single, every non-conflicting pair) at cost ≤ the committed cost is simulated on a real fork before the decision is recorded.
- **Calibration**: capacities re-estimated from clean saturated world ticks, with a 3 % uncertainty floor.

## 9. Quick start (tested on Windows 11 with Docker Desktop, Node 22)

Prerequisites: Node.js 22 or newer, Docker.

```bash
cd argus
npm ci
npm run db:up      # generates argus/.env with random database secrets, starts FalkorDB 6.0.1, bootstraps the ACL
npm run ui         # command centre at http://127.0.0.1:4173 (replay of the scripted reference run)
```

To replay the recorded live run that the public deployment serves:

```bash
npm run ui -- --cassette cassettes/public-live-replay.json
```

Other commands:

```bash
npm run demo                      # the full run in the terminal, with the event log
npm test                          # 198 tests across graph, simulator, forks, decision rule, agents, MCP, UI and deployment (needs db:up)
npm run test:ai                   # offline agent tests against a mock OpenRouter endpoint (no network)
npm run test:ai:e2e               # one end-to-end run through the real MCP transport
npm run reset                     # delete every graph and reseed from config/topology.yaml
npm run db:down
```

Live mode with a real model: put `OPENROUTER_API_KEY` and `ARGUS_LLM_MODEL` in `argus/.env` (see `.env.example`), then run `npm run ui:live -- --ceiling-ms 30000`. The engine badge reads `LIVE LLM`, and the provenance line names which phases the model decided and where the autopilot took over.

## 10. Public demo and what it does and does not do

The public deployment runs the **same code, graph, simulator, decision rule, audit and ACL boundary** as the local demo, inside one container on Render's free tier.

- **Default mode is replay, and it says so.** The engine badge reads `REPLAY`. Every query, graph copy, simulation, audit and graph write executes live on the server when you press start; only the *agent's decisions* are replayed from a recording. No numbers are replayed.
- **The recording is a genuine live run** made on 17 Oct 2026 with `cohere/north-mini-code:free` over OpenRouter. Its provenance line is shown in the UI: `R1 RED autopilot (max_turn) · R1 BLUE autopilot (no_progress) · R2 RED llm · R2 BLUE autopilot (turn_ceiling)`. In plain words: the model decided the round-2 attack on its own; in the other three phases the free model ran out of turns, made no progress, or exceeded the 30-second turn ceiling, and the deterministic autopilot finished the phase with the same tools. Each phase in the UI is labelled accordingly.
- **Three kinds of decision, always distinguished:** *replayed* agent decisions (from the cassette), *fresh LLM* decisions (only in live mode, labelled `llm`), and *B5 autopilot* decisions (labelled `autopilot` with the takeover reason). Replay is never presented as live AI activity.
- **"Control the system"** lets you change the graph (keep or disable the gateway → checkout retries) and watch ARGUS attack the changed graph. That mode runs the deterministic reference models live and is labelled `INTERACTIVE (scripted)`, not an LLM.
- **Live LLM runs on the public instance are operator-only.** Anonymous visitors cannot trigger them: a server-side operator token is required, lifecycle actions are rate-limited per visitor (15 s cooldown), and live runs are capped per day because the free model quota is shared. The OpenRouter key never leaves the server.
- **Free-tier behaviour.** The instance sleeps after 15 minutes without traffic. Waking takes about a minute, then FalkorDB starts and the graph is reseeded (about 35 s more on 0.1 CPU). A full replay takes roughly 75 seconds of server time at that CPU share. The deployment recipe, variables and rollback steps are in [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md).

![The final result screen: a large SAFE heading, the line "The graph changed, so the agent changed its reasoning", 0 bad moments out of 90 on the live system against an allowed limit of 10, and two cards summarising attack 1 → fix 1 and attack 2 → fix 2](docs/images/07-final-safe.jpg)

*The end of the recorded run: both attacks found, both fixes proven and applied, and the live system stays green through the second attack even though the risky deploy CE-42 really lands.*

## 11. How ARGUS differs from IncidentMind

IncidentMind is an earlier project by the same author: an incident-response assistant that reconstructs *past* incidents from deployments, commits, alerts and chat, attributes root causes, and recommends recovery actions. ARGUS is new work built for Graph Hacks, and it answers a different question.

| | IncidentMind | ARGUS |
|---|---|---|
| Question | "What happened, and how do we recover?" | "How could this system fail next, and what is the smallest intervention that prevents it?" |
| When it runs | After an incident | Before one, continuously (attack, harden, attack again) |
| Evidence | Telemetry, alerts, commits, Slack | A FalkorDB graph of the system's real configuration |
| Agents | One analyst over documents and RAG | Adversarial RED and BLUE over graph tools, with a deterministic fallback |
| Output | A briefing and a recommendation | A proven-in-scope fix applied to the graph, a config diff, and a predicted-vs-observed record |
| Verification | None (advice) | A hidden WORLD graph the agent cannot read; the fix is checked against it |
| Graph database | None | FalkorDB is the model, the action space, the forks, the constraint and the trace |

No IncidentMind code is reused.

## 12. Honest limitations and AI-assistance disclosure

- **Scoped, not global, minimality.** "Proven" means: among every intervention set of at most two interventions, drawn from the server-computed scope of this scenario, at cost ≤ the committed cost, none satisfies the rule and is cheaper. It is not a proof over every conceivable change to the system.
- **The world is simulated.** The WORLD graph is a second FalkorDB graph driven by the same fluid simulator with hidden parameter differences, not a real production system. The predicted-versus-observed comparison is real; the world is not.
- **One failure class, eight services.** ARGUS models the retry-storm (metastable) failure over `cap_degrade`, `surge` and `deploy` faults on a fixed eight-service topology. Connection-pool pressure, queue-depth limits and other mechanisms are not modelled.
- **Free LLMs are unreliable.** In the recorded run the model decided one phase of four. The autopilot takes over when a model is slow or stuck, and the UI says so; nothing is hidden, but not every phase is model-decided.
- **Tool budgets are small by design.** 14 tool calls and 6 simulations or forks per role per round. That keeps the demo under four minutes; it also limits how far an agent can explore.
- **Numbers.** Every figure in this README (4.5×, 15 of 16, 16 of 16, 2 predicted versus 3 observed, 10 and 12 audited options) is read from the recorded run and the seeded graph, and can be reproduced with `npm run demo`. No benchmark or user study is claimed.
- **AI assistance.** AI coding assistants (Claude Code) were used during the hackathon for implementation, tests, documentation and this README, directed and reviewed by the author, who can explain the graph model, the queries, the architecture and the technical decisions. All graph modelling, decision-rule and verification design decisions are documented in `docs/ARGUS_FINAL_ARCHITECTURE.md`.

## 13. Future scope

- **Real telemetry in, config PRs out.** Ingest service-mesh configuration and traces to build the twin, and open the generated YAML diff as a pull request against the real mesh config.
- **More failure mechanisms.** Connection-pool exhaustion, queue-depth limits, cache stampedes and dependency fan-in, each as a graph-generated fault kind with its own rule.
- **Larger topologies.** Scope computation and the audit are designed to stay tractable because they are bounded by graph paths; the next step is measuring that on 50 to 200 services.
- **Research baselines.** The architecture defines B0 to B6 baselines and a scoped oracle; B0, B5 and the oracle exist today. Comparing an LLM agent with the deterministic policy across seeds is planned follow-up work.
- **Stronger live-model reliability.** Longer turn ceilings, paid models and parallel candidate evaluation so that every phase can be model-decided within the demo slot.
- **Explainability.** A "Why?" shortest-path explanation from entry point to trigger, and clickable raw rollouts behind every future.

## 14. Demo video

Coming soon. The link will be added here once the recording exists.

---

Built by Rahil Ahmed for Graph Hacks 2026, Track 01: Agents That Act on Connected Data. Source under `argus/`; architecture, build audit and deployment notes under `docs/`.
