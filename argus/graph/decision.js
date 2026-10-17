// Decision engine + minimality audit (spec §13; §10.3–10.6; §6.19).
// The decision is made by ONE rule over measured counterfactual outcomes stored in FalkorDB (:Future):
//   argmin cost over evaluated futures where
//       p_recover ≥ Round.rec_threshold  AND  median violation ticks ≤ Round.error_budget  AND  not harmful
//   ties: lower median violation ticks, then lexical id.
// The audit runs every untested in-scope candidate (as real forked futures) up to the committed cost
// and re-applies the same rule. The LLM/agent can only propose; it cannot override the rule.
import { rows, roRows, GRAPHS } from './db.js';
import { runFuture, readFuture } from './forks.js';
import { readScope, candidateSets } from './scope.js';
import { addAuditSims, readRound } from './budget.js';
import { harmful } from '../sim/sim.js';

export const NO_SAFE_ACTION = 'NO_SAFE_ACTION';
export const RULE = 'argmin cost | p_recover>=rec_threshold AND viol_ticks_p50<=error_budget AND not harmful | tie: viol_ticks_p50, id';
export const setKey = (ids) => [...ids].sort().join('+') || 'none';
const recordId = (prefix, scenarioId) => `${prefix}:${scenarioId.startsWith('S:') ? scenarioId.slice(2) : scenarioId}`;

// ---------------------------------------------------------------- the rule (pure)
// Classify one stored Future against the Round's explicit safety constraint and the do-nothing reference.
export function assess(future, round, reference) {
  const reasons = [];
  if (future.p_recover < round.rec_threshold) reasons.push('recovery');
  if (future.viol_ticks_p50 > round.error_budget) reasons.push('error_budget');
  if (reference && harmful(future.viol_by_entry, reference.viol_by_entry)) reasons.push('harmful');
  return { id: future.id, cost: future.cost, median: future.viol_ticks_p50, qualifies: reasons.length === 0, reasons };
}

const byRule = (a, b) => a.cost - b.cost || a.median - b.median || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The rule's winner among evaluated futures, or null when none qualifies.
export function selectWinner(futures, round, reference) {
  const ok = futures.map((f) => assess(f, round, reference)).filter((a) => a.qualifies).sort(byRule);
  return ok.length ? futures.find((f) => f.id === ok[0].id) : null;
}

// ---------------------------------------------------------------- graph access
// Evaluated futures of a scenario, one per intervention set (lexically smallest id when duplicated).
export async function scenarioFutures(db, scenarioId) {
  const ids = (await roRows(db, GRAPHS.twin, `MATCH (:Scenario {id:$id})-[:PRODUCES]->(f:Future) RETURN f.id AS id ORDER BY id`, { id: scenarioId })).map((r) => r.id);
  const bySet = new Map();
  for (const id of ids) {
    const f = await readFuture(db, id);
    const k = `${f.mode}|${setKey(f.interventions)}`;
    if (!bySet.has(k)) bySet.set(k, f);
  }
  return [...bySet.values()];
}

export async function readDecision(db, id) {
  const r = await roRows(db, GRAPHS.twin, `
    MATCH (d:Decision {id:$id})-[:ADDRESSES]->(sc:Scenario)
    OPTIONAL MATCH (d)-[:SELECTS]->(i:Intervention)
    RETURN properties(d) AS props, sc.id AS scenario, collect(i.id) AS selects`, { id });
  if (!r.length) return null;
  return { ...r[0].props, scenario: r[0].scenario, selects: [...r[0].selects].sort() };
}

// §6.19 [IMPL-INTERPRETATION]. Steps (BASED_ON) are persisted by the MCP layer (later milestone).
const WRITE_DECISION = `
MATCH (sc:Scenario {id:$scenario_id})
MERGE (d:Decision {id:$id})
  SET d += $props
MERGE (d)-[:ADDRESSES]->(sc)
WITH d
OPTIONAL MATCH (i:Intervention) WHERE i.id IN $selected_ids
FOREACH (_ IN CASE WHEN i IS NULL THEN [] ELSE [1] END | MERGE (d)-[:SELECTS]->(i))
RETURN d.id AS id`;

// ---------------------------------------------------------------- commit with audit
/**
 * Commit a decision for a scenario. Stage mode: rule-complete audit up to the committed cost.
 * Research mode: no audit; the proposal is recorded as-is (spec §13.2 / §19).
 * @param {object} p
 * @param {string} p.scenarioId
 * @param {string} p.proposal     an evaluated Future id of this scenario, or NO_SAFE_ACTION
 * @param {'llm'|'b5'} p.proposedBy
 * @param {string} [p.rationale]
 * @param {'reactive'|'preemptive'} [p.mode]  needed only when the proposal is NO_SAFE_ACTION
 * @param {string} [p.snapshotId]             idem, for reactive mode
 * @returns {Promise<{accepted:boolean, decision?:object, rule_winner?:string|null, reason?:string, audit_sims:number}>}
 */
export async function commitDecision(db, { scenarioId, proposal, proposedBy, rationale = '', mode, snapshotId }) {
  const decisionId = recordId('D', scenarioId);
  const existing = await readDecision(db, decisionId);
  if (existing) return { accepted: true, decision: existing, audit_sims: 0, reused: true };

  const round = await readRound(db);
  const scope = await readScope(db, scenarioId);
  const scopeIds = new Set(scope.map((i) => i.id));
  let futures = await scenarioFutures(db, scenarioId);

  // Context of the decision: from the proposed future, or given explicitly for NO_SAFE_ACTION.
  let proposed = null;
  if (proposal !== NO_SAFE_ACTION) {
    proposed = futures.find((f) => f.id === proposal) ?? (await readFuture(db, proposal));
    if (!proposed || proposed.scenario !== scenarioId) throw new Error(`Future '${proposal}' is not an evaluated future of scenario '${scenarioId}'`);
    if (!proposed.interventions.every((i) => scopeIds.has(i))) throw new Error(`Future '${proposal}' tests interventions outside the scenario scope`);
    mode = proposed.mode; snapshotId = proposed.snapshot ?? undefined;
  } else if (!mode) {
    throw new Error('NO_SAFE_ACTION requires the decision mode (reactive/preemptive)');
  }
  futures = futures.filter((f) => f.mode === mode);
  await rows(db, GRAPHS.twin, `MATCH (sc:Scenario {id:$id}) WHERE sc.first_proposal IS NULL SET sc.first_proposal = $p, sc.first_proposed_by = $by`,
    { id: scenarioId, p: proposal, by: proposedBy });

  let auditSims = 0;
  const audit = async (ids) => {
    const f = await runFuture(db, { scenarioId, label: setKey(ids), interventionIds: ids, mode, snapshotId, audit: true });
    if (!f.reused) auditSims += 1;
    futures.push(f);
    return f;
  };
  // The do-nothing reference is always evaluated by the server, free of the agent's budget.
  let reference = futures.find((f) => f.interventions.length === 0);
  if (!reference) reference = await audit([]);

  if (round.mode === 'research') {
    await addAuditSims(db, round.n, auditSims);
    return writeDecision(db, { decisionId, scenarioId, round, proposal, proposedBy, rationale, winner: proposed, minimality: 'unaudited', auditSims, futures });
  }

  // Stage mode, rule-complete audit (spec §13.2). Bound = the committed cost; for NO_SAFE_ACTION the
  // claim "no safe action exists in scope" needs every candidate [IMPL-INTERPRETATION].
  const evaluatedWinner = selectWinner(futures, round, reference);
  const bound = proposal === NO_SAFE_ACTION ? Infinity : Math.max(proposed.cost, evaluatedWinner?.cost ?? proposed.cost);
  const tested = new Set(futures.map((f) => setKey(f.interventions)));
  for (const c of candidateSets(scope)) {
    if (c.cost <= bound && !tested.has(setKey(c.ids))) await audit(c.ids);
  }
  await addAuditSims(db, round.n, auditSims);
  const winner = selectWinner(futures, round, reference);

  if (proposal === NO_SAFE_ACTION) {
    if (winner) return { accepted: false, reason: 'a qualifying intervention exists in scope', rule_winner: winner.id, audit_sims: auditSims };
    return writeDecision(db, { decisionId, scenarioId, round, proposal, proposedBy, rationale, winner: null, minimality: NO_SAFE_ACTION, auditSims, futures });
  }
  if (!winner) {
    return { accepted: false, reason: `the proposal does not satisfy the rule and nothing qualifies at cost <= ${bound}; test more futures or commit NO_SAFE_ACTION`, rule_winner: null, audit_sims: auditSims };
  }
  if (setKey(winner.interventions) !== setKey(proposed.interventions)) {
    return { accepted: false, reason: 'the selection rule picks a different candidate', rule_winner: winner.id, audit_sims: auditSims };
  }
  return writeDecision(db, { decisionId, scenarioId, round, proposal, proposedBy, rationale, winner, minimality: 'proven-in-scope', auditSims, futures });
}

async function writeDecision(db, { decisionId, scenarioId, round, proposal, proposedBy, rationale, winner, minimality, auditSims, futures }) {
  const first = (await roRows(db, GRAPHS.twin, `MATCH (sc:Scenario {id:$id}) RETURN sc.first_proposal AS p`, { id: scenarioId }))[0].p;
  const props = {
    round: round.n, rule: RULE, minimality, rationale, proposed_by: proposedBy,
    proposed_future: first ?? proposal, committed_proposal: proposal,
    selected_future: winner ? winner.id : NO_SAFE_ACTION,
    predicted_viol_ticks_p50: winner ? winner.viol_ticks_p50 : -1,
    audit_sims: futures.filter((f) => f.audit).length,
    agent_futures: futures.filter((f) => !f.audit).length,
    error_budget: round.error_budget, rec_threshold: round.rec_threshold,
  };
  await rows(db, GRAPHS.twin, WRITE_DECISION, { id: decisionId, scenario_id: scenarioId, props, selected_ids: winner ? winner.interventions : [] });
  return { accepted: true, decision: await readDecision(db, decisionId), audit_sims: auditSims };
}
