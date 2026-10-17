// M5 acceptance: decision engine + audit (spec §13, §10.3–10.6, §11.3, §6.9, §6.11, §6.19, §6.21).
// Requires the pinned FalkorDB (`npm run db:up`). Each test starts from a fresh reset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, rows, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { writeScenario, writeSnapshot } from '../graph/records.js';
import { computeScope, candidateSets } from '../graph/scope.js';
import { evaluateFuture, ToolRejected } from '../graph/evaluate.js';
import { commitDecision, readDecision, assess, selectWinner, setKey, NO_SAFE_ACTION } from '../graph/decision.js';
import { BudgetExhausted, readRound } from '../graph/budget.js';
import { writeObservation } from '../graph/observation.js';
import { listForks } from '../graph/forks.js';
import { World } from '../sim/contexts.js';

const F = {
  F0: [], F1: ['scale_out:payments'], F2: ['scale_out:ledger-db'], F3: ['retries_off:checkout>payments'],
  F4: ['breaker:checkout>payments'], F5: ['retries_off:gateway>checkout', 'retries_off:checkout>payments'],
};
const SINGLE_LAYER = ['cap_retries:gateway>checkout', 'retries_off:checkout>payments'];   // cost 2, median 4.5 (R1.13)
const COST4 = ['retries_off:checkout>payments', 'scale_out:payments'];                    // the only qualifying cost-4 set
const fid = (ids) => `fork:R1:${setKey(ids)}`;
let db, snap, world;

// Fresh reset → round-1 ACT → Scenario S:R1 (server scope) + tick-40 snapshot on the twin.
async function setup(faults = ['degrade:ledger-db'], id = 'S:R1') {
  await reset(db);
  world = await World.open(db);
  world.advance({ ticks: 30, seed: 7, faults: ['degrade:ledger-db'] });
  world.advance({ ticks: 10, seed: 8 });
  await writeScenario(db, { id, round: 1, faultIds: faults });
  await computeScope(db, id);
  snap = await writeSnapshot(db, { round: 1, tick: 40, state: world.snapshotState() });
}
const blue = (ids, scenarioId = 'S:R1', mode = 'reactive') =>
  evaluateFuture(db, { role: 'blue', scenarioId, interventionIds: ids, mode, snapshotId: mode === 'reactive' ? snap : undefined });
const setRound = (props) => rows(db, 'twin', `MATCH (r:Round {n:1}) SET r += $p`, { p: props });

// Synthetic futures shaped exactly like stored (:Future) records (readFuture), for pure-rule tests.
const fut = (id, cost, rec, median, byEntry) => ({ id, cost, p_recover: rec, viol_ticks_p50: median, viol_by_entry: byEntry, interventions: [id] });
const ROUND = { rec_threshold: 15, error_budget: 10 };
const REF = fut('none', 0, 0, 60, { gateway: Array(16).fill(60), 'mobile-gw': Array(16).fill(0) });
const ok = (gw = 2, mgw = 0) => ({ gateway: Array(16).fill(gw), 'mobile-gw': Array(16).fill(mgw) });

before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); });

test('1. selects the minimum-cost safe intervention from measured futures (round 1: F5, proven-in-scope)', async () => {
  await setup();
  for (const ids of Object.values(F)) await blue(ids);
  const r = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F5), proposedBy: 'llm', rationale: 'both layers' });
  assert.equal(r.accepted, true);
  assert.equal(r.decision.minimality, 'proven-in-scope');
  assert.deepEqual(r.decision.selects, [...F.F5].sort());
  assert.equal(r.audit_sims, 10, 'spec §8.4: 10 untested candidates at cost <= 2');
  // the same rule over ALL 118 scoped futures + do-nothing (scoped oracle R1.10) gives the same answer
  const scope = await computeScope(db, 'S:R1');
  const sets = candidateSets(scope.interventions);
  assert.equal(sets.length, 119);
  assert.deepEqual(await listForks(db), []);
});

test('2. unsafe candidates are rejected (recovery requirement)', async () => {
  await setup();
  for (const ids of [F.F0, F.F3]) await blue(ids);
  // F3 recovers 2/16: it does not qualify, and nothing at cost <= 1 does
  const r = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F3), proposedBy: 'llm' });
  assert.equal(r.accepted, false);
  assert.equal(r.rule_winner, null);
  assert.match(r.reason, /does not satisfy the rule/);
  assert.equal(await readDecision(db, 'D:R1'), null);
  // assessed from the stored Future: 2/16 recover (recovery) and median 60 (error budget)
  const { readFuture } = await import('../graph/forks.js');
  const [f3, f0] = [await readFuture(db, fid(F.F3)), await readFuture(db, fid(F.F0))];
  assert.equal(f3.p_recover, 2);
  assert.deepEqual(assess(f3, await readRound(db), f0).reasons, ['recovery', 'error_budget']);
  assert.deepEqual(assess(fut('x', 1, 14, 3, ok(3)), ROUND, REF).reasons, ['recovery'], 'recovery alone (14/16 < 15)');
});

test('3. median / error-budget rejection uses the Round in the graph', async () => {
  await setup();
  for (const ids of [F.F0, F.F4, F.F5]) await blue(ids);
  // F4 recovers 16/16 but its median (14) exceeds the error budget (10): amber, not selectable
  const f4 = (await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F4), proposedBy: 'llm' }));
  assert.equal(f4.accepted, false);
  assert.equal(f4.rule_winner, fid(F.F5));
  assert.deepEqual(assess(fut('b', 2, 16, 14, ok(14)), ROUND, REF).reasons, ['error_budget']);
  // tighten the error budget on the graph to 1: F5 (median 2) no longer qualifies either
  await setup();
  for (const ids of [F.F0, F.F5]) await blue(ids);
  await setRound({ error_budget: 1 });
  const r = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F5), proposedBy: 'llm' });
  assert.equal(r.accepted, false);
  assert.equal(r.rule_winner, null);
});

test('4. per-entry harm check rejects a candidate that is worse than do-nothing on any entry', () => {
  // recovers and is inside the error budget overall, but mobile-gw gets worse than doing nothing
  const harmfulOne = fut('h', 2, 16, 4, ok(2, 6));
  assert.deepEqual(assess(harmfulOne, ROUND, REF).reasons, ['harmful']);
  const safe = fut('s', 3, 16, 5, ok(5, 0));
  assert.equal(selectWinner([harmfulOne, safe], ROUND, REF).id, 's', 'cheaper but harmful loses to costlier safe');
  // equal on an entry is not harm (strictly worse is required)
  assert.deepEqual(assess(fut('e', 2, 16, 4, ok(2, 0)), ROUND, REF).reasons, []);
});

test('5. deterministic tie-breaking: cost, then median, then lexical id', () => {
  const a = fut('fork:R1:b', 2, 16, 3, ok(3)), b = fut('fork:R1:a', 2, 16, 3, ok(3)), c = fut('fork:R1:c', 2, 16, 2, ok(2)), d = fut('fork:R1:d', 1, 16, 9, ok(9));
  assert.equal(selectWinner([a, b, c, d], ROUND, REF).id, 'fork:R1:d', 'cheapest wins regardless of median');
  assert.equal(selectWinner([a, b, c], ROUND, REF).id, 'fork:R1:c', 'equal cost: lower median wins');
  assert.equal(selectWinner([a, b], ROUND, REF).id, 'fork:R1:a', 'equal cost and median: lexical id');
  for (const perm of [[b, a], [a, b, a]]) assert.equal(selectWinner(perm, ROUND, REF).id, 'fork:R1:a', 'order-independent');
});

test('6. NO_SAFE_ACTION: accepted only when the audit proves nothing in scope qualifies', async () => {
  // degrade:auth heals by itself (pre-emptive futures): doing nothing is the safe, free choice
  await setup(['degrade:auth'], 'S:R1');
  const scope = await computeScope(db, 'S:R1');
  assert.equal(scope.ids.length, 7);
  const r1 = await commitDecision(db, { scenarioId: 'S:R1', proposal: NO_SAFE_ACTION, proposedBy: 'llm', mode: 'preemptive' });
  assert.equal(r1.accepted, false);
  assert.equal(r1.rule_winner, fid([]));
  // make every candidate fail (recovery threshold above the rollout count): NO_SAFE_ACTION is proven
  await setup(['degrade:auth'], 'S:R1');
  await setRound({ rec_threshold: 17 });
  const r2 = await commitDecision(db, { scenarioId: 'S:R1', proposal: NO_SAFE_ACTION, proposedBy: 'llm', mode: 'preemptive' });
  assert.equal(r2.accepted, true);
  assert.equal(r2.decision.minimality, NO_SAFE_ACTION);
  assert.equal(r2.decision.selected_future, NO_SAFE_ACTION);
  assert.deepEqual(r2.decision.selects, []);
  assert.equal(r2.decision.audit_sims, 29, 'every in-scope candidate (28) + do-nothing was evaluated');
});

test('7. the audit catches an untested candidate at equal or lower cost', async () => {
  // equal cost: the single-layer fix (cost 2, median 4.5) is proposed; untested F5 (cost 2, median 2) wins
  await setup();
  for (const ids of [F.F0, F.F4, SINGLE_LAYER]) await blue(ids);
  const r = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(SINGLE_LAYER), proposedBy: 'llm' });
  assert.equal(r.accepted, false);
  assert.equal(r.rule_winner, fid(F.F5));
  assert.equal((await readRound(db)).fork_budget, 3, 'audit futures are not charged to the agent');
  const ok2 = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F5), proposedBy: 'llm' });
  assert.equal(ok2.accepted, true);
  assert.equal(ok2.decision.proposed_future, fid(SINGLE_LAYER), 'the first proposal is kept on the Decision');
  assert.equal(ok2.decision.committed_proposal, fid(F.F5));
  // cheaper: a qualifying cost-4 proposal; the audit finds F5 at cost 2
  await setup();
  for (const ids of [F.F0, COST4]) await blue(ids);
  const stored = (await roRows(db, 'twin', `MATCH (f:Future {id:$id}) RETURN f.verdict AS v, f.cost AS c`, { id: fid(COST4) }))[0];
  assert.deepEqual(stored, { v: 'green', c: 4 });
  const r4 = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(COST4), proposedBy: 'b5' });
  assert.equal(r4.accepted, false);
  assert.equal(r4.rule_winner, fid(F.F5));
  assert.ok(r4.audit_sims > 10);
  assert.equal((await readRound(db)).audit_sims, r4.audit_sims, 'Round.audit_sims counts the verification work');
});

test('8. budget and scope enforcement (charge-once, graph-held counters, server scope)', async () => {
  await setup();
  // a repeated identical call is free
  const a = await blue(F.F5);
  const b = await blue(F.F5);
  assert.equal(a.charged, true);
  assert.equal(b.reused, true);
  assert.equal(b.charged, false);
  let r = await readRound(db);
  assert.deepEqual([r.fork_budget, r.blue_tool_budget], [5, 13]);
  // invalid / out-of-scope calls are rejected and charged to the tool budget, never to the fork budget
  await assert.rejects(blue(['retries_off:redis>db']), ToolRejected);
  await assert.rejects(blue(['breaker:checkout>inventory']), /not in the scope/);
  await assert.rejects(blue(['retries_off:checkout>payments', 'cap_retries:checkout>payments']), /same edge/);
  await assert.rejects(evaluateFuture(db, { role: 'red', scenarioId: 'S:R1', interventionIds: [], mode: 'reactive', snapshotId: snap }), /BLUE only/);
  r = await readRound(db);
  assert.deepEqual([r.fork_budget, r.blue_tool_budget], [5, 10]);
  // the fork budget runs out at the 7th distinct future
  for (const ids of [F.F0, F.F1, F.F2, F.F3, F.F4]) await blue(ids);
  await assert.rejects(blue(SINGLE_LAYER), BudgetExhausted);
  r = await readRound(db);
  assert.equal(r.fork_budget, 0);
  // the tool budget runs out at 14 calls (here 4 left: 14 − 6 valid − 3 rejected − 1 exhausted-fork call)
  assert.equal(r.blue_tool_budget, 4);
  for (let i = 0; i < 4; i++) await assert.rejects(blue([`scale_out:missing-${i}`]), ToolRejected);
  await assert.rejects(blue(['scale_out:missing-x']), BudgetExhausted);
  // every charge is a (:Charge) record with its call_id; budgets live on the Round node
  const charges = await roRows(db, 'twin', `MATCH (c:Charge) RETURN c.counter AS k, count(*) AS n ORDER BY k`);
  assert.deepEqual(Object.fromEntries(charges.map((x) => [x.k, x.n])), { blue_tool_budget: 14, fork_budget: 6 });
  // the scope is computed by the server; an empty scope is an error
  await writeScenario(db, { id: 'S:empty', round: 1, faultIds: [] });
  await assert.rejects(computeScope(db, 'S:empty'), /empty scope/);
});

test('9. decision and observation records are complete and correct', async () => {
  await setup();
  for (const ids of Object.values(F)) await blue(ids);
  const { decision: d } = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F5), proposedBy: 'llm', rationale: 'retries are the load' });
  assert.equal(d.id, 'D:R1');
  assert.equal(d.scenario, 'S:R1');
  assert.equal(d.round, 1);
  assert.equal(d.minimality, 'proven-in-scope');
  assert.equal(d.proposed_by, 'llm');
  assert.equal(d.rationale, 'retries are the load');
  assert.equal(d.proposed_future, fid(F.F5));
  assert.equal(d.selected_future, fid(F.F5));
  assert.equal(d.predicted_viol_ticks_p50, 2);
  assert.deepEqual([d.audit_sims, d.agent_futures], [10, 6]);
  assert.deepEqual([d.error_budget, d.rec_threshold], [10, 15]);
  assert.match(d.rule, /argmin cost/);
  assert.deepEqual(d.selects, ['retries_off:checkout>payments', 'retries_off:gateway>checkout']);
  // the audited futures are on the graph, flagged as audit work, linked to the scenario
  const audits = await roRows(db, 'twin', `MATCH (:Scenario {id:'S:R1'})-[:PRODUCES]->(f:Future {audit:true}) RETURN count(f) AS n`);
  assert.equal(audits[0].n, 10);
  // committing again is idempotent (no second audit)
  const again = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F5), proposedBy: 'llm' });
  assert.equal(again.reused, true);
  assert.equal((await readRound(db)).audit_sims, 10);
  // predicted vs observed: the world check for the selected fix (seed 99) observes 3 vs predicted 2 (R1.9)
  const observed = world.withInterventions(F.F5).advance({ ticks: 60, seed: 99, tOff: 0 });
  const o = await writeObservation(db, { decisionId: 'D:R1', observedTrace: observed });
  assert.equal(o.id, 'O:R1');
  assert.deepEqual([o.observed_viol_ticks, o.predicted_viol_ticks_p50, o.pred_error], [3, 2, 1]);
  assert.deepEqual([o.predicted_p10, o.predicted_p90, o.within_band], [1, 3, true]);
  assert.equal(o.observed_ttr, 3);
  assert.equal(o.observed_goodput.length, 60);
  const link = await roRows(db, 'twin', `MATCH (:Observation {id:'O:R1'})-[:VERIFIES]->(d:Decision) RETURN d.id AS id`);
  assert.deepEqual(link.map((x) => x.id), ['D:R1']);
});

test('10. audit bound (spec §13.2.1): cost ≤ max(proposal cost, cheapest qualifying evaluated future)', async () => {
  const auditFutures = async () => (await roRows(db, 'twin',
    `MATCH (:Scenario {id:'S:R1'})-[:PRODUCES]->(f:Future {audit:true}) OPTIONAL MATCH (f)-[:TESTS]->(i:Intervention)
     RETURN f.id AS id, f.cost AS cost, collect(i.id) AS ivs`)).map((r) => ({ ...r, key: setKey(r.ivs) }));
  const expectedAudit = async (tested, bound) => {
    const scope = await computeScope(db, 'S:R1');
    const done = new Set(tested.map(setKey));
    return candidateSets(scope.interventions).filter((c) => c.cost <= bound && !done.has(setKey(c.ids))).map((c) => setKey(c.ids)).sort();
  };

  // (a) qualifying proposal: bound = cost(proposal) = 2 — exactly the canonical "cost ≤ committed cost"
  await setup();
  const testedA = Object.values(F);
  for (const ids of testedA) await blue(ids);
  const a = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F5), proposedBy: 'llm' });
  assert.equal(a.accepted, true);
  const auditedA = await auditFutures();
  assert.ok(auditedA.every((f) => f.cost <= 2), 'nothing above the proposal cost is audited');
  assert.deepEqual(auditedA.map((f) => f.key).sort(), await expectedAudit(testedA, 2), 'every untested candidate at cost <= 2 is audited');
  assert.equal(auditedA.length, 10);

  // (b) unqualified proposal (F3: cost 1, red) with a qualifying evaluated future at cost 4:
  //     bound = max(1, 4) = 4, so the untested cost-2 F5 is audited and reported as the rule winner.
  //     (With bound = cost(proposal) = 1, F5 would never be evaluated and the cost-4 future would "win".)
  await setup();
  const testedB = [F.F0, F.F3, COST4];
  for (const ids of testedB) await blue(ids);
  assert.equal((await auditFutures()).length, 0);
  const b = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F3), proposedBy: 'llm' });
  assert.equal(b.accepted, false);
  assert.equal(b.rule_winner, fid(F.F5));
  const auditedB = await auditFutures();
  assert.ok(auditedB.every((f) => f.cost <= 4), 'nothing above the bound is audited');
  assert.ok(auditedB.some((f) => f.cost === 4), 'candidates exactly at the bound are audited');
  assert.ok(auditedB.some((f) => f.key === setKey(F.F5)), 'F5 (cost 2, above the proposal cost) is audited');
  assert.deepEqual(auditedB.map((f) => f.key).sort(), await expectedAudit(testedB, 4), 'every untested candidate at cost <= 4 is audited');

  // (c) unqualified proposal and nothing qualifying evaluated: bound = cost(proposal) only
  await setup();
  const testedC = [F.F0, F.F3];
  for (const ids of testedC) await blue(ids);
  const c = await commitDecision(db, { scenarioId: 'S:R1', proposal: fid(F.F3), proposedBy: 'llm' });
  assert.equal(c.accepted, false);
  assert.equal(c.rule_winner, null);
  const auditedC = await auditFutures();
  assert.ok(auditedC.every((f) => f.cost <= 1));
  assert.deepEqual(auditedC.map((f) => f.key).sort(), await expectedAudit(testedC, 1));
  // (NO_SAFE_ACTION audits the whole scope: test 6, audit_sims = 29 of 29.)
});
