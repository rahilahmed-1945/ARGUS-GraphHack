// M13 — prompt guidance for a live model, and the safety invariants around it. The live run of 15 Oct 2026 showed a
// free model that explored correctly (list_candidates, amplification_paths, blast_radius) but then surveyed unrelated
// single faults / single edges until the no-progress takeover fired in every phase. The objectives now give the
// evidence order (the spec's own strategy) and name the no-progress limit the runtime enforces. These tests check that
// the guidance is present, names no service / fault / intervention / change event, that the runtime passes the limit
// to the prompt, that the canonical scripted runs are unchanged, and that the takeover policy, tool sets and budgets
// were not weakened. Requires `npm run db:up` (ACL); no network, no LLM.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { loadTopology } from '../graph/topology.js';
import { readRound } from '../graph/budget.js';
import { writeSnapshot, scenarioFaults, setBlueContext } from '../graph/records.js';
import { World } from '../sim/contexts.js';
import { WORLD_SCRIPT } from '../runtime/orchestrator.js';
import { TAKEOVER, REASONS, runPhase } from '../runtime/runtime.js';
import { ROLE_TOOLS, RED_POLICY } from '../runtime/tools.js';
import { renderRedObjective, RED_TOOL_SCHEMAS, createRedAgent } from '../runtime/red.js';
import { renderBlueObjective, BLUE_TOOL_SCHEMAS, createBlueAgent } from '../runtime/blue.js';
import { createScriptedRedModel } from './fixtures/red-model.js';
import { createScriptedBlueModel } from './fixtures/blue-model.js';

const SPEC_RED = 'Find the cheapest combination of at most 2 faults that, per `simulate`, leaves the entry SLO violated in the last 10 ticks of a 90-tick horizon (transient faults removed at tick 30) in at least 8 of 16 rollouts. You have 6 simulations. Every fault must come from `list_candidates`. Submit it with its multi-hop evidence path. The server will check that no cheaper scenario works.';
const SPEC_BLUE = 'Restore (round 1) or protect (round 2) the entry SLO. Get candidates from `list_candidates(scope=scenario)`. You have 6 futures, each with at most 2 interventions. Commit to one.';
const N = TAKEOVER.NO_PROGRESS_CALLS;
const redObs = (extra = {}) => ({ budgets: { sim_budget: 6, tool_budget: 14 }, roundInfo: { horizon_preemptive: 90, t_off: 30 }, turn: 0, max_turn: TAKEOVER.MAX_TURN, no_progress_calls: N, ...extra });
const blueObs = (extra = {}) => ({ budgets: { fork_budget: 6, tool_budget: 14 }, roundInfo: { rec_threshold: 15, error_budget: 10 }, turn: 0, max_turn: TAKEOVER.MAX_TURN, no_progress_calls: N, ...extra });

let db;
before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); });

test('1. RED: the objective still opens with the spec text, then gives the evidence order and the no-progress limit from the runtime constant', () => {
  const s = renderRedObjective(redObs());
  assert.ok(s.startsWith(`${SPEC_RED}\n\n`));
  assert.ok(s.includes(`after ${N} simulations without a qualifying result`), 'names the no-progress takeover with the enforced count');
  // the order: amplifier triggers (deepest first) → pair with a deploy or an entry surge → top-ranked service; no surveys
  const at = (needle) => { const i = s.indexOf(needle); assert.ok(i >= 0, `objective mentions: ${needle}`); return i; };
  assert.ok(at('deepest trigger of the strongest amplifier') < at('fault of kind deploy'), 'single trigger before the pair');
  assert.ok(at('fault of kind deploy') < at('`rank_nodes`'), 'pairs before the no-amplifier fallback');
  // the pair order is explicit: a pending deploy landing on the trigger's path first, the entry surge only as the fallback
  assert.ok(s.includes('pair it — in this order. First with a fault of kind deploy'));
  assert.ok(at('First with a fault of kind deploy') < at('Only when no such pending deploy exists, or that pair does not qualify, pair the trigger with the surge fault'));
  assert.ok(s.includes('never a survey of unrelated single faults'));
  // without the runtime field the rule is still stated, without a number
  assert.ok(renderRedObjective(redObs({ no_progress_calls: undefined })).includes('after a few simulations without a qualifying result'));
});

test('2. BLUE: the objective still opens with the spec text, then gives the evidence order, verdict reading and the no-progress limit', () => {
  const s = renderBlueObjective(blueObs());
  assert.ok(s.startsWith(`${SPEC_BLUE}\n\n`));
  assert.ok(s.includes(`after ${N} futures without a green verdict`));
  for (const needle of ["retry interventions of the amplifier's edges together in one future", 'before testing any of those edges alone',
    'retries_off and cap_retries on the same edge cannot be combined', 'amber = they recover but slower', 'add capacity at the saturated service',
    '`blast_radius`', 'blocking it alone usually leaves', 'never a survey of single edges']) assert.ok(s.includes(needle), needle);
  // the combined future comes before the single-edge advice, and respects the schema limit on interventions per future
  assert.ok(s.indexOf('together in one future') < s.indexOf('before testing any of those edges alone'));
  assert.ok(s.includes('a future holds up to 2 interventions'));
  assert.ok(renderBlueObjective(blueObs({ no_progress_calls: undefined })).includes('after a few futures without a green verdict'));
});

test('3. the objectives and tool descriptions name no service, fault id, intervention id or change event', () => {
  const topo = loadTopology();
  const names = topo.services.map((x) => x.name);
  const texts = [renderRedObjective(redObs()), renderBlueObjective(blueObs()),
    ...RED_TOOL_SCHEMAS.map((t) => t.description), ...BLUE_TOOL_SCHEMAS.map((t) => t.description)];
  for (const t of texts) {
    assert.deepEqual(names.filter((n) => t.includes(n)), [], `names a service: ${t.slice(0, 60)}`);
    assert.ok(!/CE-\d+/.test(t), 'names a change event');
    assert.ok(!/(degrade|surge|deploy):[a-z]/.test(t), 'names a fault id');
    assert.ok(!/(retries_off|cap_retries|breaker|scale_out|shed|block_deploy):[a-z]/.test(t), 'names an intervention id');
    assert.ok(!/fork:R\d|S:R\d|D:R\d/.test(t), 'names a scenario, decision or future id');
  }
});

test('4. safety invariants: the takeover policy, the tool sets, the RED policy and the Round budgets are unchanged', () => {
  assert.deepEqual({ ...TAKEOVER }, { TURN_CEILING_MS: 6000, NO_PROGRESS_CALLS: 4, MAX_TURN: 8, CONSECUTIVE_REJECTS: 2 });
  assert.deepEqual({ ...RED_POLICY }, { SUSTAINED_MIN: 8, SIM_TAG_OFFSET: 1, MAX_FAULTS: 2 });
  assert.deepEqual([...ROLE_TOOLS.red].sort(), ['amplification_paths', 'blast_radius', 'commit', 'list_candidates', 'query_graph', 'rank_nodes', 'simulate']);
  assert.deepEqual([...ROLE_TOOLS.blue].sort(), ['amplification_paths', 'blast_radius', 'commit', 'fork_and_simulate', 'list_candidates', 'query_graph', 'rank_nodes']);
  assert.deepEqual(RED_TOOL_SCHEMAS.map((t) => t.name).sort(), [...ROLE_TOOLS.red].sort(), 'RED is offered exactly its tools');
  assert.deepEqual(BLUE_TOOL_SCHEMAS.map((t) => t.name).sort(), [...ROLE_TOOLS.blue].sort(), 'BLUE is offered exactly its tools');
  const { round } = loadTopology();
  assert.deepEqual([round.sim_budget, round.fork_budget, round.red_tool_budget, round.blue_tool_budget, round.autopilot_reserve], [6, 6, 14, 14, 3]);
});

test('5. the runtime tells the model the no-progress limit, and the canonical scripted RED and BLUE runs are unchanged by the new guidance', async () => {
  await reset(db);
  const red = createScriptedRedModel();
  const r = await runPhase(db, { role: 'red', mode: 'live', adapter: createRedAgent(red) });
  assert.ok(red.transcripts[0].system.includes(`after ${N} simulations without a qualifying result`), 'the live prompt carries the runtime constant');
  assert.deepEqual([r.proposedBy, r.takeover, r.turns, r.outcome.faults], ['llm', null, 4, ['degrade:ledger-db']]);
  // BLUE round 1 (reactive) from the same world script as the orchestrator
  const round = await readRound(db);
  const world = await World.open(db);
  world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: await scenarioFaults(db, r.outcome.scenarioId) });
  world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  const ctx = { scenarioId: r.outcome.scenarioId, futureMode: 'reactive', snapshotId };
  await setBlueContext(db, ctx);
  const blue = createScriptedBlueModel();
  const b = await runPhase(db, { role: 'blue', mode: 'live', adapter: createBlueAgent(blue), ctx });
  assert.ok(blue.transcripts[0].system.includes(`after ${N} futures without a green verdict`));
  assert.deepEqual([b.proposedBy, b.takeover, b.outcome.decision.minimality, b.outcome.decision.proposed_by], ['llm', null, 'proven-in-scope', 'llm']);
});

test('6. B5 still takes over after exactly the no-progress count of unqualifying simulations — the guidance changes words, not the guarantee', async () => {
  await reset(db);
  // the live model's actual pattern: a survey of single faults that are on no amplifier
  const survey = ['degrade:payments', 'degrade:auth', 'degrade:checkout', 'degrade:inventory', 'degrade:orders'];
  const adapter = { async next(obs) { return { tool: 'simulate', args: { fault_ids: [survey[obs.turn]] } }; } };
  const r = await runPhase(db, { role: 'red', mode: 'live', adapter });
  assert.deepEqual([r.takeover.reason, r.takeover.turn, r.proposedBy, r.outcome.scenarioId], [REASONS.NO_PROGRESS, N, 'b5', 'S:R1']);
  assert.equal(r.history.filter((h) => h.tool === 'simulate').length, N, 'exactly N model simulations before the takeover');
});

test('7. an unknown scope / scenario id from the model is a rejected tool call, not a run-aborting failure: the phase continues, and consecutive rejections hand over to B5 as usual', async () => {
  // the live failure of 16 Oct: a model passed the literal word from the objective as `scope`, and readScope's plain
  // Error escaped the tool layer as an infrastructure failure that aborted the whole run
  await reset(db);
  const red = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const round = await readRound(db);
  const world = await World.open(db);
  world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: await scenarioFaults(db, red.outcome.scenarioId) });
  world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  const ctx = { scenarioId: red.outcome.scenarioId, futureMode: 'reactive', snapshotId };
  await setBlueContext(db, ctx);
  const script = [
    { tool: 'list_candidates', args: { scope: 'scenario' } },                      // the literal word: rejected, phase continues
    { tool: 'list_candidates', args: {} },                                         // the current scenario: fine (resets the reject streak)
    { tool: 'fork_and_simulate', args: { scenario_id: 'S:R9', intervention_ids: [] } },  // unknown scenario on the sibling path: rejected
    { tool: 'list_candidates', args: { scope: 'no-such-scenario' } },              // second consecutive rejection → takeover
  ];
  const adapter = { async next(obs) { return script[Math.min(obs.turn, script.length - 1)]; } };
  const b = await runPhase(db, { role: 'blue', mode: 'live', adapter, ctx });       // must not throw
  const h = b.history;
  assert.deepEqual(h.map((x) => [x.tool, x.ok]), [['list_candidates', false], ['list_candidates', true], ['fork_and_simulate', false], ['list_candidates', false]]);
  assert.match(h[0].summary, /rejected: list_candidates rejected: Scenario 'scenario' not in graph/);
  assert.match(h[2].summary, /rejected: fork_and_simulate rejected: Scenario 'S:R9' not in graph/);
  assert.match(h[3].summary, /rejected: list_candidates rejected: Scenario 'no-such-scenario' not in graph/);
  assert.deepEqual([b.takeover.reason, b.proposedBy, b.outcome.decision.minimality, b.outcome.decision.proposed_by], [REASONS.REJECTS, 'b5', 'proven-in-scope', 'b5']);
  // the rejections are recorded Steps, like any other rejected call
  const { readSteps } = await import('../graph/steps.js');
  const steps = (await readSteps(db, { round: 1, role: 'blue' })).filter((s) => !s.ok);
  assert.ok(steps.length >= 3 && steps.every((s) => /rejected/.test(s.summary)));
});

// Round-1 BLUE context exactly as the orchestrator builds it (RED by autopilot, world script, snapshot)
async function blueRound1Context() {
  await reset(db);
  const red = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const round = await readRound(db);
  const world = await World.open(db);
  world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: await scenarioFaults(db, red.outcome.scenarioId) });
  world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  const ctx = { scenarioId: red.outcome.scenarioId, futureMode: 'reactive', snapshotId };
  await setBlueContext(db, ctx);
  return ctx;
}

test('8. BLUE: the decision rule is the first working rule, operationally explicit, and replaces the older stopping-rule text', () => {
  const s = renderBlueObjective(blueObs());
  const at = (needle) => { const i = s.indexOf(needle); assert.ok(i >= 0, `objective mentions: ${needle}`); return i; };
  assert.ok(at('DECISION RULE') < at('Plan from graph evidence'), 'the decision rule comes before the exploration guidance');
  assert.ok(at('DECISION RULE') < at('Every `fork_and_simulate` call uses one of your'));
  for (const needle of ['your next response is a single `commit`', 'do not run another future and do not gather more information',
    'evaluate only the candidate(s) needed to settle that cost comparison', 'never evaluate a candidate of equal or higher cost than a green future you already hold',
    'forfeits your decision']) assert.ok(s.includes(needle), needle);
  assert.ok(!s.includes('Stopping rule, applied after every'), 'no second, competing stopping rule');
  assert.ok(s.includes('recovers in at least 15 of 16 rollouts with a median of at most 10 violated ticks'), 'qualification still comes from the Round');
});

test('9. the live BLUE failure of 17 Oct reproduced: a green future found at turn 3, then exploration to the turn limit → B5 commits the model\'s own green future', async () => {
  const ctx = await blueRound1Context();
  const GREEN = ['retries_off:gateway>checkout', 'retries_off:checkout>payments'];
  const script = [
    { tool: 'list_candidates', args: {} }, { tool: 'amplification_paths', args: { min_risk: 0 } },
    { tool: 'fork_and_simulate', args: { intervention_ids: GREEN } },                                             // green, cost 2 — should commit next
    { tool: 'fork_and_simulate', args: { intervention_ids: ['cap_retries:gateway>checkout', 'cap_retries:checkout>payments'] } },
    { tool: 'fork_and_simulate', args: { intervention_ids: ['breaker:checkout>payments', 'breaker:gateway>checkout'] } },
    { tool: 'fork_and_simulate', args: { intervention_ids: ['scale_out:ledger-db'] } },
    { tool: 'fork_and_simulate', args: { intervention_ids: ['scale_out:payments'] } },
    { tool: 'fork_and_simulate', args: { intervention_ids: ['scale_out:checkout'] } },
  ];
  const adapter = { async next(obs) { return script[Math.min(obs.turn, script.length - 1)]; } };
  const b = await runPhase(db, { role: 'blue', mode: 'live', adapter, ctx });
  assert.deepEqual([b.takeover.reason, b.takeover.turn, b.proposedBy], [REASONS.MAX_TURN, TAKEOVER.MAX_TURN, 'b5']);
  const green = b.history.find((h) => h.tool === 'fork_and_simulate' && h.ok && h.result.verdict === 'green');
  assert.ok(green && green.turn === 2, 'the model held a green future from its third turn');
  const d = b.outcome.decision;
  assert.deepEqual([d.selected_future, d.minimality, d.proposed_by], [green.result.future_id, 'proven-in-scope', 'b5'], 'B5 committed the future the model had already found');
  // the safety net is unchanged: no decision was taken by the model, and the audit still ran
  assert.ok(d.audit_sims > 0);
});

test('10. RED/BLUE: the pending-deploy Cypher in the tool guidance is schema-valid and runs through the tool layer; the live model\'s broken form is a recorded rejection', async () => {
  await reset(db);
  const { createToolbox } = await import('../runtime/tools.js');
  const tb = await createToolbox(db, {});
  const desc = RED_TOOL_SCHEMAS.find((t) => t.name === 'query_graph').description;
  const pattern = desc.match(/MATCH \(ce:ChangeEvent \{status: 'pending'\}\)[^]*?ce\.new_value/)[0];
  assert.ok(desc.includes('the shorthand {callee} and variables inside a map are rejected'), 'explains the syntax rule');
  assert.ok(desc.includes('ChangeEvent has no kind'), 'corrects the property the live model guessed');
  assert.ok(BLUE_TOOL_SCHEMAS.find((t) => t.name === 'query_graph').description.includes("(ce:ChangeEvent {status: 'pending'})-[m:MODIFIES]->(caller:Service)"));
  const ok = await tb.invoke('red', 'query_graph', { cypher: pattern }, 'llm');
  assert.equal(ok.ok, true, ok.summary);
  const rows = ok.result.rows;
  assert.ok(rows.length >= 1 && rows.every((r) => /^CE-/.test(r['ce.id']) && /^deploy:/.test(r.deploy_fault) && r.caller && r.callee), JSON.stringify(rows));
  // the exact form the live model wrote: inline {kind:'deploy'} on ChangeEvent plus the {callee} shorthand → rejected, not fatal
  const bad = await tb.invoke('red', 'query_graph', { cypher: "MATCH (ce:ChangeEvent {kind:'deploy'})-[:MODIFIES {callee}]->(caller:Service) RETURN ce.id" }, 'llm');
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /query rejected/);
});
