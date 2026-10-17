// The ARGUS tool layer (spec §11.2): the 8 tools with their server semantics, called in-process.
// [IMPL-INTERPRETATION] M6 needs the tool semantics so B5 and the runtime can drive them; the MCP stdio
// transport that exposes these same functions is a later milestone. Every call — accepted or rejected —
// is persisted as a (:Step) with its Cypher, a deterministic summary, and the services it touched.
import { rows, roRows, GRAPHS, FORK_PREFIX } from '../graph/db.js';
import { loadModel } from '../graph/load-model.js';
import { charge, callId, readRound, addAuditSims, TOOL_COUNTER, BudgetExhausted } from '../graph/budget.js';
import { evaluateFuture, chargeOrReserve, ToolRejected } from '../graph/evaluate.js';
import { commitDecision, NO_SAFE_ACTION } from '../graph/decision.js';
import { readScope, computeScope, candidateSets } from '../graph/scope.js';
import { writeScenario } from '../graph/records.js';
import { deleteGraphIfExists } from '../graph/forks.js';
import { writeStep, linkDecisionSteps } from '../graph/steps.js';
import { buildModel, healthyState, ensemble } from '../sim/sim.js';
import { SEED_SCHEME } from '../graph/forks.js';

/* RUNTIME POLICY CONSTANTS (spec §9.2 RED objective "at least 8 of 16"; §11.2 RED sims use
   tag 100·r + 1). Not system-model data. */
export const RED_POLICY = Object.freeze({ SUSTAINED_MIN: 8, SIM_TAG_OFFSET: 1, MAX_FAULTS: 2 });
/* END RUNTIME POLICY CONSTANTS */

export const ROLE_TOOLS = Object.freeze({
  red: ['query_graph', 'amplification_paths', 'rank_nodes', 'blast_radius', 'list_candidates', 'simulate', 'commit'],
  blue: ['query_graph', 'amplification_paths', 'rank_nodes', 'blast_radius', 'list_candidates', 'fork_and_simulate', 'commit'],
});

// Argument contract of the model-facing `commit` schemas (runtime/red.js, runtime/blue.js), checked before role
// authorization and before any server-side logic (M5 stays the authority on what is accepted). Types are never
// coerced: a JSON-encoded string where an array is declared is rejected, not parsed.
const isString = (v) => typeof v === 'string';
const isStringArray = (v) => Array.isArray(v) && v.every(isString);
const ARG_CONTRACT = Object.freeze({
  red: { commit: [['fault_ids', isStringArray, 'an array of strings', true], ['evidence_path', isStringArray, 'an array of strings', true]] },
  blue: { commit: [['future_id', isString, 'a string', true], ['rationale', isString, 'a string', false]] },
});
export function validateArgs(role, tool, args) {
  const contract = ARG_CONTRACT[role]?.[tool];
  if (!contract) return;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new ToolRejected(`${tool}: arguments must be an object`);
  for (const [field, ok, what, required] of contract) {
    if (args[field] === undefined && !required) continue;
    if (!ok(args[field])) throw new ToolRejected(`${tool}: ${field} must be ${what}`);
  }
}

// ---------------------------------------------------------------- the tools' Cypher (spec §6)
/* SPEC QUERIES: Cypher as written in the spec (its literals, e.g. LIMIT 5 and *1..5, are query shape).
   [IMPL-NOTE] amplification_paths adds `WHERE coalesce(f.active, true)` to the spec §6.4 trigger match:
   after regeneration (§6.3, B#8) only active faults are in the action space.
   [IMPL-NOTE] it also orders AFTER the aggregation (`ORDER BY overload DESC, target, amplifier`): the spec's
   pre-aggregation ORDER BY leaves the row order unspecified when several amplifiers qualify. */
export const Q = Object.freeze({
  // §6.4 (hop count corrected 2026-10-07)
  amplification_paths: `
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
LIMIT 5`,
  // §6.7
  pagerank: `CALL algo.pageRank('Service', 'CALLS') YIELD node, score RETURN node.name AS service, score ORDER BY score DESC, service`,
  // [IMPL-INTERPRETATION] in_degree = number of incoming CALLS (build-readiness B#16)
  in_degree: `MATCH (s:Service) OPTIONAL MATCH (:Service)-[c:CALLS]->(s) RETURN s.name AS service, count(c) AS score ORDER BY score DESC, service`,
  // §6.6
  blast_radius: `
MATCH p = (u:Service)-[:CALLS*1..6]->(x:Service {name:$service})
WITH u, min(length(p)) AS hops
RETURN u.name AS upstream, u.entry AS is_entry, hops ORDER BY hops, upstream`,
  // §6.10
  list_faults: `MATCH (f:Fault)-[:APPLIES_TO]->(s:Service) WHERE coalesce(f.active, true)
RETURN f.id AS id, f.kind AS kind, s.name AS target, f.cost_to_attacker AS cost ORDER BY id`,
});
/* END SPEC QUERIES */

/* DISPLAY CONSTANTS: Step-summary formatting only. */
const DISPLAY = Object.freeze({ TOP_RANKED: 3, SCORE_DECIMALS: 3, ROWS_PREVIEW_CHARS: 160 });
/* END DISPLAY CONSTANTS */

const json = (x) => JSON.stringify(x);

// ---------------------------------------------------------------- toolbox
/**
 * @param {object} db
 * @param {object} ctx  { scenarioId?, futureMode?: 'reactive'|'preemptive', snapshotId? } — the BLUE phase context
 */
export async function createToolbox(db, ctx = {}) {
  const services = (await roRows(db, GRAPHS.twin, `MATCH (s:Service) RETURN s.name AS n ORDER BY n`)).map((r) => r.n);
  // services named in a call's arguments or result: whole tokens of [A-Za-z0-9_-]
  const touchedBy = (...xs) => { const tokens = new Set(json(xs).split(/[^A-Za-z0-9_-]+/)); return services.filter((n) => tokens.has(n)); };

  // Charge the role's tool budget once per call (spec §11.3: every tool call except commit).
  async function chargeTool(role, tool, args, by, round) {
    const id = callId({ round: round.n, role, tool, args });
    await chargeOrReserve(db, { round: round.n, counter: TOOL_COUNTER[role], callId: id, tool }, by === 'b5');
    return id;
  }

  const impl = {
    async query_graph(role, args, by, round) {
      if (typeof args.cypher !== 'string') throw new ToolRejected('query_graph needs {cypher}');
      const id = await chargeTool(role, 'query_graph', args, by, round);
      let r;
      try { r = await roRows(db, GRAPHS.twin, args.cypher, args.params); } catch (e) { throw new ToolRejected(`query rejected: ${e.message}`); }
      return { id, cypher: args.cypher, result: { rows: r }, summary: `${r.length} row(s): ${json(r).slice(0, DISPLAY.ROWS_PREVIEW_CHARS)}` };
    },
    async amplification_paths(role, args, by, round) {
      const id = await chargeTool(role, 'amplification_paths', args, by, round);
      const r = await roRows(db, GRAPHS.twin, Q.amplification_paths, { min_risk: args.min_risk });
      return { id, cypher: Q.amplification_paths, result: { rows: r },
        summary: r.length ? r.map((x) => `${x.amplifier.join('>')} ${x.overload}x triggers ${x.triggers.join(',')}`).join(' | ') : 'empty' };
    },
    async rank_nodes(role, args, by, round) {
      if (!['pagerank', 'in_degree'].includes(args.metric)) throw new ToolRejected(`unknown metric '${args.metric}'`);
      const id = await chargeTool(role, 'rank_nodes', args, by, round);
      const r = await roRows(db, GRAPHS.twin, Q[args.metric]);
      return { id, cypher: Q[args.metric], result: { rows: r }, summary: r.slice(0, DISPLAY.TOP_RANKED).map((x) => `${x.service} ${Number(x.score).toFixed(DISPLAY.SCORE_DECIMALS)}`).join(', ') };
    },
    async blast_radius(role, args, by, round) {
      if (!services.includes(args.service)) throw new ToolRejected(`Service '${args.service}' not in graph`);
      const id = await chargeTool(role, 'blast_radius', args, by, round);
      const r = await roRows(db, GRAPHS.twin, Q.blast_radius, { service: args.service });
      return { id, cypher: Q.blast_radius, result: { rows: r }, summary: r.map((x) => `${x.upstream}@${x.hops}`).join(', ') };
    },
    async list_candidates(role, args, by, round) {
      const id = await chargeTool(role, 'list_candidates', args, by, round);
      if (role === 'red') {
        const r = await roRows(db, GRAPHS.twin, Q.list_faults);
        return { id, cypher: Q.list_faults, result: { ids: r }, summary: `${r.length} faults` };
      }
      const scenarioId = args.scope ?? ctx.scenarioId;
      let scope;
      try {
        scope = await readScope(db, scenarioId);
      } catch (e) {
        // an unknown or unscoped scenario id (a model passing e.g. the literal word from the objective) is a rejected
        // call, recorded as a Step and answered to the model; infrastructure errors (database, driver) still propagate
        if (e.constructor === Error) throw new ToolRejected(`list_candidates rejected: ${e.message}`);
        throw e;
      }
      const all = await roRows(db, GRAPHS.twin, `MATCH (i:Intervention) WHERE coalesce(i.active,true) RETURN i.id AS id, i.kind AS kind, i.caller AS caller, i.callee AS callee, i.cost AS cost`);
      // [IMPL-INTERPRETATION] the scope is returned with the scenario it belongs to (RED's public finding:
      // its faults and evidence path), so BLUE can reason about where the failure is (spec §8 scope / §10.2)
      const sc = (await roRows(db, GRAPHS.twin, `
        MATCH (sc:Scenario {id:$id}) OPTIONAL MATCH (sc)-[:CONTAINS]->(f:Fault)-[:APPLIES_TO]->(t:Service)
        WITH sc, f, t ORDER BY f.id
        RETURN sc.evidence_path AS evidence_path, collect({id: f.id, kind: f.kind, target: t.name}) AS faults`, { id: scenarioId }))[0];
      const result = { scenario: { id: scenarioId, faults: sc.faults, evidence_path: sc.evidence_path ?? [] },
        ids: scope.map(({ id: x, kind, target, caller, callee, cost }) => ({ id: x, kind, target, caller, callee, cost })),
        in_scope_futures: candidateSets(scope).length - 1, unscoped_futures: candidateSets(all).length - 1 };
      return { id, cypher: 'MATCH (sc:Scenario {id:$id}) RETURN sc.scope_ids', result,
        summary: `${scope.length} interventions in scope · ${result.in_scope_futures} in-scope futures · ${result.unscoped_futures} unscoped` };
    },
    async simulate(role, args, by, round) {
      const ids = [...new Set(args.fault_ids ?? [])].sort();
      const id = callId({ round: round.n, role, tool: 'simulate', args: { fault_ids: ids } });
      // a simulation already run under this call_id is returned free (spec §14.2)
      const cached = await roRows(db, GRAPHS.twin, `MATCH (c:Charge) WHERE c.call_id STARTS WITH $id AND c.result IS NOT NULL RETURN c.result AS r`, { id });
      if (cached.length) { const r = JSON.parse(cached[0].r); return { id, cypher: 'cached', result: { ...r, cached: true }, summary: `${r.sustained}/16 sustained (cached)` }; }
      await chargeOrReserve(db, { round: round.n, counter: TOOL_COUNTER[role], callId: id, tool: 'simulate' }, by === 'b5');
      if (ids.length === 0 || ids.length > RED_POLICY.MAX_FAULTS) throw new ToolRejected(`simulate takes 1..${RED_POLICY.MAX_FAULTS} fault ids`);
      const known = (await roRows(db, GRAPHS.twin, Q.list_faults)).map((r) => r.id);
      const missing = ids.filter((f) => !known.includes(f));
      if (missing.length) throw new ToolRejected(`Fault '${missing[0]}' not in graph`);
      await chargeOrReserve(db, { round: round.n, counter: 'sim_budget', callId: id, tool: 'simulate' }, by === 'b5');
      const r = await simulateOnScratchFork(round, ids, id);
      await rows(db, GRAPHS.twin, `MATCH (c:Charge) WHERE c.call_id STARTS WITH $id AND c.counter IN ['sim_budget','autopilot_reserve'] SET c.result = $r`, { id, r: json(r) });
      return { id, cypher: `GRAPH.COPY twin ${r.fork}; loadModel('${r.fork}'); ensemble tag=${r.tag} n=${SEED_SCHEME.ROLLOUTS}`, result: r,
        summary: `${r.sustained}/16 sustained` };
    },
    async fork_and_simulate(role, args, by, round) {
      let f;
      try {
        f = await evaluateFuture(db, { role, scenarioId: args.scenario_id ?? ctx.scenarioId, interventionIds: args.intervention_ids ?? [],
          mode: ctx.futureMode, snapshotId: ctx.snapshotId, useReserve: by === 'b5' });
      } catch (e) {
        // the same classification as list_candidates / commit: an unknown scenario id or an invalid future request is a
        // rejected call, never a run-aborting failure; infrastructure errors still propagate
        if (e.constructor === Error) throw new ToolRejected(`fork_and_simulate rejected: ${e.message}`);
        throw e;
      }
      const result = { future_id: f.id, p_recover: f.p_recover, viol_ticks_p50: f.viol_ticks_p50, p10: f.p10, p90: f.p90, cost: f.cost, verdict: f.verdict };
      return { id: f.id, cypher: `GRAPH.COPY twin ${f.id}; apply templates; loadModel('${f.id}'); ensemble tag=${f.tag}`, result,
        summary: `${f.p_recover}/16 recover, median ${f.viol_ticks_p50} (${f.p10}-${f.p90}), cost ${f.cost}, ${f.verdict}` };
    },
    async commit(role, args, by, round) {
      if (role === 'red') return submitScenario(args, by, round);
      let r;
      try {
        r = await commitDecision(db, { scenarioId: args.scenario_id ?? ctx.scenarioId, proposal: args.future_id, proposedBy: by,
          rationale: args.rationale ?? '', mode: ctx.futureMode, snapshotId: ctx.snapshotId });
      } catch (e) {
        // M5's own validation (unknown/unevaluated/out-of-scope proposal) is a rejected proposal, recorded as a Step;
        // infrastructure errors (database, driver) still propagate
        if (e.constructor === Error) throw new ToolRejected(`commit rejected: ${e.message}`);
        throw e;
      }
      if (!r.accepted) throw new ToolRejected(`commit rejected: ${r.reason}${r.rule_winner ? `; rule winner ${r.rule_winner}` : ''}`, { cause: r });
      return { id: r.decision.id, cypher: 'commitDecision (rule + audit)', result: { accepted: true, decision: r.decision, audit_sims: r.audit_sims },
        summary: `${r.decision.minimality}: ${r.decision.selected_future} (audit ${r.decision.audit_sims})` };
    },
  };

  // RED simulation: 16 rollouts on a scratch fork from a healthy state; transient faults off at t_off;
  // 90-tick horizon (spec §11.2 #6; scratch-fork name per build-readiness B#9).
  async function simulateOnScratchFork(round, faultIds, id) {
    const fork = `${FORK_PREFIX}R${round.n}:red:${id.slice(0, 8)}`;
    await deleteGraphIfExists(db, fork);
    await db.selectGraph(GRAPHS.twin).copy(fork);
    try {
      const model = buildModel(await loadModel(db, fork));
      const tag = SEED_SCHEME.ROUND_TAG_STRIDE * round.n + RED_POLICY.SIM_TAG_OFFSET;
      const e = ensemble(model, healthyState(model), faultIds, round.t_off, round.horizon_preemptive, tag, SEED_SCHEME.ROLLOUTS);
      return { fault_ids: faultIds, sustained: e.sustained, recovered: e.recovered, median: e.median, tag, fork };
    } finally {
      await deleteGraphIfExists(db, fork);
    }
  }

  // RED commit = submit_scenario: re-verify with the same seeds, run the strictly-cheaper audit (spec §13.2),
  // write (:Scenario) with the server-computed scope.
  async function submitScenario(args, by, round) {
    const ids = [...new Set(args.fault_ids ?? [])].sort();
    const scenarioId = `S:R${round.n}`;
    const existing = await roRows(db, GRAPHS.twin, `MATCH (sc:Scenario {id:$id}) RETURN sc.minimality AS m`, { id: scenarioId });
    if (existing.length && existing[0].m) return { id: scenarioId, cypher: 'existing', result: { scenario_id: scenarioId, reused: true }, summary: `scenario ${scenarioId} (existing)` };
    const faults = await roRows(db, GRAPHS.twin, Q.list_faults);
    const cost = (set) => set.reduce((a, f) => a + faults.find((x) => x.id === f).cost, 0);
    if (!ids.length || ids.some((f) => !faults.some((x) => x.id === f))) throw new ToolRejected('commit: unknown or empty fault set');
    const fork = `${FORK_PREFIX}R${round.n}:red:audit`;
    await deleteGraphIfExists(db, fork);
    await db.selectGraph(GRAPHS.twin).copy(fork);
    let verified, cheaper = null, audited = 0;
    try {
      const model = buildModel(await loadModel(db, fork));
      const tag = SEED_SCHEME.ROUND_TAG_STRIDE * round.n + RED_POLICY.SIM_TAG_OFFSET;
      const run = (set) => ensemble(model, healthyState(model), set, round.t_off, round.horizon_preemptive, tag, SEED_SCHEME.ROLLOUTS);
      verified = run(ids);
      if (verified.sustained < RED_POLICY.SUSTAINED_MIN) throw new ToolRejected(`commit: ${verified.sustained}/16 sustained (< ${RED_POLICY.SUSTAINED_MIN})`);
      // strictly cheaper scenarios only: proves "no cheaper attack exists" and nothing more
      const fids = faults.map((f) => f.id);
      const sets = [...fids.map((f) => [f]), ...fids.flatMap((a, i) => fids.slice(i + 1).map((b) => [a, b]))];
      for (const s of sets.filter((s) => cost(s) < cost(ids))) {
        audited += 1;
        if (run(s).sustained >= RED_POLICY.SUSTAINED_MIN) { cheaper = s; break; }
      }
    } finally {
      await deleteGraphIfExists(db, fork);
    }
    await addAuditSims(db, round.n, audited);
    if (cheaper) throw new ToolRejected(`commit: a cheaper attack exists: ${cheaper.join('+')}`);
    const evidence = Array.isArray(args.evidence_path) ? args.evidence_path : [];
    await writeScenario(db, { id: scenarioId, round: round.n, faultIds: ids, sustained_k: verified.sustained, minimality: 'proven: no cheaper attack',
      evidence_path: evidence, proposed_by: by, red_audit_sims: audited });
    await rows(db, GRAPHS.twin, `UNWIND range(0, size($p)-1) AS k MATCH (sc:Scenario {id:$id}) MATCH (s:Service) WHERE s.name = $p[k] MERGE (sc)-[:EVIDENCED_BY {order:k}]->(s)`,
      { id: scenarioId, p: evidence });
    const scope = await computeScope(db, scenarioId);
    return { id: scenarioId, cypher: 'submit_scenario (re-verify + strictly-cheaper audit + §6.9 scope)',
      result: { scenario_id: scenarioId, fault_ids: ids, sustained: verified.sustained, cost: cost(ids), audit_sims: audited, scope: scope.ids.length },
      summary: `${ids.join('+')} ${verified.sustained}/16 sustained; proven: no cheaper attack (audit ${audited}); scope ${scope.ids.length}` };
  }

  /** Invoke a tool as `role` on behalf of `by` ('llm' | 'b5'). Never throws for tool-level rejections. */
  async function invoke(role, tool, args = {}, by = 'llm') {
    const round = await readRound(db);
    const t0 = performance.now();
    let out, ok = true, error = null;
    try {
      validateArgs(role, tool, args);
      if (!ROLE_TOOLS[role]?.includes(tool)) throw new ToolRejected(`tool '${tool}' is not available to role '${role}'`);
      out = await impl[tool](role, args, by, round);
    } catch (e) {
      if (!(e instanceof ToolRejected) && !(e instanceof BudgetExhausted)) throw e;
      ok = false; error = e;
      out = { id: callId({ round: round.n, role, tool, args }), cypher: '', result: null, summary: `rejected: ${e.message}` };
    }
    const step = await writeStep(db, { round: round.n, role, by, tool, args, cypher: out.cypher, summary: out.summary, ok,
      ms: Math.round(performance.now() - t0), callId: out.id, touched: touchedBy(args, out.result) });
    if (ok && tool === 'commit' && role === 'blue') await linkDecisionSteps(db, out.result.decision.id, round.n);
    return { ok, tool, args, result: out.result, summary: out.summary, error, budgetExhausted: error instanceof BudgetExhausted, step };
  }

  return { invoke, services, ctx };
}

export { NO_SAFE_ACTION };
