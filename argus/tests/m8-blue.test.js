// M8 acceptance: the BLUE defensive agent (spec §10, §10.2, §11.2, §13, §14). BLUE is an injected LLM behind the
// M6 runtime/tool layer; tests use a deterministic scripted model (tests/fixtures/blue-model.js) that reasons only
// from its transcript. Requires the pinned FalkorDB (`npm run db:up`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, rows, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readRound } from '../graph/budget.js';
import { readSteps } from '../graph/steps.js';
import { readDecision, setKey } from '../graph/decision.js';
import { writeSnapshot, scenarioFaults } from '../graph/records.js';
import { listForks } from '../graph/forks.js';
import { regenerateActionSpaces } from '../graph/schema.js';
import { loadTopology } from '../graph/topology.js';
import { World } from '../sim/contexts.js';
import { runPhase, createCassette, REASONS } from '../runtime/runtime.js';
import { runRound1, hardenAfterRound, runPreemptiveRound, WORLD_SCRIPT } from '../runtime/orchestrator.js';
import { createRedAgent } from '../runtime/red.js';
import { createBlueAgent, renderBlueObjective, BLUE_TOOL_SCHEMAS } from '../runtime/blue.js';
import { createScriptedRedModel } from './fixtures/red-model.js';
import { createScriptedBlueModel } from './fixtures/blue-model.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXPECTED = JSON.parse(readFileSync(`${ROOT}sim/reference/expected.json`, 'utf8'));
const SPEC_OBJECTIVE = 'Restore (round 1) or protect (round 2) the entry SLO. Get candidates from `list_candidates(scope=scenario)`. You have 6 futures, each with at most 2 interventions. Commit to one.';
const F = { F0: [], F1: ['scale_out:payments'], F2: ['scale_out:ledger-db'], F3: ['retries_off:checkout>payments'],
  F4: ['breaker:checkout>payments'], F5: ['retries_off:checkout>payments', 'retries_off:gateway>checkout'] };
const fid = (n, ids) => `fork:R${n}:${setKey(ids)}`;
let db;
before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); });

const stable = (steps) => steps.map(({ ms, ...rest }) => rest);
const scripted = (script) => ({ async next(obs) { return script[obs.turn]; } });
const forks = (steps) => steps.filter((s) => s.tool === 'fork_and_simulate' && s.ok).map((s) => [[...s.args.intervention_ids].sort(), s.summary]);

// Round 1 up to BLUE: reset → RED (B5) → ACT → trigger removed → snapshot. Returns BLUE's context.
async function upToBlue({ before: mutate } = {}) {
  await reset(db);
  if (mutate) await mutate();
  const red = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const scenarioId = red.outcome.scenarioId;
  const round = await readRound(db);
  const world = await World.open(db);
  world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: await scenarioFaults(db, scenarioId) });
  world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  return { scenarioId, futureMode: 'reactive', snapshotId };
}
const bluePhase = (ctx, adapter, extra = {}) => runPhase(db, { role: 'blue', mode: 'live', ctx, adapter, ...extra });

test('1. canonical BLUE round 1 (spec run sheet: 4 turns, 8 calls; F0–F5; F5 proven-in-scope)', async () => {
  const ctx = await upToBlue();
  const model = createScriptedBlueModel();
  const b = await bluePhase(ctx, createBlueAgent(model));
  assert.deepEqual([b.proposedBy, b.takeover, b.turns, b.history.length], ['llm', null, 4, 8]);
  const steps = await readSteps(db, { role: 'blue' });
  assert.deepEqual(forks(steps), [
    [F.F0, '0/16 recover, median 60 (60-60), cost 0, red'],
    [F.F1, '0/16 recover, median 60 (60-60), cost 3, red'],
    [F.F2, '0/16 recover, median 60 (60-60), cost 3, red'],
    [F.F3, '2/16 recover, median 60 (11-60), cost 1, red'],
    [F.F4, '16/16 recover, median 14 (14-14), cost 2, amber'],
    [F.F5, '16/16 recover, median 2 (1-3), cost 2, green']]);
  const d = b.outcome.decision;
  assert.deepEqual([d.selected_future, d.minimality, d.proposed_by, d.audit_sims, d.agent_futures], [fid(1, F.F5), 'proven-in-scope', 'llm', 10, 6]);
  assert.ok(model.transcripts[0].system.startsWith(`${SPEC_OBJECTIVE}\n\n`), 'the objective opens with the spec §10.2 text');
  assert.equal(model.transcripts[0].messages[0].content, 'Round 1. Scenario S:R1 (reactive: the outage is live now). 14 tool calls and 6 futures remain. Which intervention prevents the cascade?');
});

test('2. candidates are discovered from the graph (scope), not given to BLUE', async () => {
  const ctx = await upToBlue();
  const model = createScriptedBlueModel();
  await bluePhase(ctx, createBlueAgent(model));
  const services = (await roRows(db, 'twin', `MATCH (s:Service) RETURN s.name AS n`)).map((x) => x.n);
  const first = JSON.stringify(model.transcripts[0]);
  assert.deepEqual(services.filter((n) => first.includes(n)), [], 'nothing BLUE starts with names a service');
  const listed = JSON.parse(model.transcripts[1].messages.find((m) => m.name === 'list_candidates').content);
  const offered = new Set(listed.ids.map((i) => i.id));
  assert.equal(offered.size, 15);
  const used = (await readSteps(db, { role: 'blue' })).filter((s) => s.tool === 'fork_and_simulate').flatMap((s) => s.args.intervention_ids);
  assert.ok(used.every((i) => offered.has(i)), 'every evaluated intervention came from the server-computed scope');
  // a different graph → a different scenario and evidence path → different candidates (same model code)
  // (the action space is regenerated from the changed graph, as hardening does)
  const ctx2 = await upToBlue({ before: async () => {
    await rows(db, 'twin', `MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name+'>'+b.name IN ['mobile-gw>orders','orders>ledger-db'] SET c.retries = 3`);
    await regenerateActionSpaces(db, 'twin', loadTopology());
  } });
  const b2 = await bluePhase(ctx2, createBlueAgent(createScriptedBlueModel()));
  const ev = (await roRows(db, 'twin', `MATCH (sc:Scenario {id:'S:R1'}) RETURN sc.evidence_path AS p`))[0].p;
  assert.deepEqual(ev, ['mobile-gw', 'orders', 'ledger-db']);
  const tried = forks(await readSteps(db, { role: 'blue' })).map((x) => x[0]);
  assert.deepEqual(tried.slice(0, 3), [[], ['scale_out:orders'], ['scale_out:ledger-db']], 'capacity above the trigger is now orders');
  assert.ok(tried.some((ids) => ids.includes('retries_off:orders>ledger-db')), 'the retry knob nearest this trigger');
  assert.ok(b2.outcome.decision, 'BLUE reaches a decision on the new graph');
});

test('3. counterfactual evaluation uses real FalkorDB forks and the simulator', async () => {
  const ctx = await upToBlue();
  await bluePhase(ctx, createBlueAgent(createScriptedBlueModel()));
  const steps = (await readSteps(db, { role: 'blue' })).filter((s) => s.tool === 'fork_and_simulate');
  for (const s of steps) assert.match(s.cypher, /^GRAPH\.COPY twin fork:R1:\S+; apply templates; loadModel\('fork:R1:\S+'\); ensemble tag=102$/);
  const futures = await roRows(db, 'twin', `MATCH (:Scenario {id:'S:R1'})-[:PRODUCES]->(f:Future)-[:FROM]->(:Snapshot {id:$s})
    RETURN f.audit AS audit, count(f) AS n ORDER BY audit`, { s: ctx.snapshotId });
  assert.deepEqual(futures.map((x) => [x.audit, x.n]), [[false, 6], [true, 10]]);
  for (const [k, ids] of Object.entries(F)) {
    const f = (await roRows(db, 'twin', `MATCH (f:Future {id:$id}) RETURN f.p_recover AS r, f.viol_ticks_p50 AS m, f.p10 AS a, f.p90 AS b`, { id: fid(1, ids) }))[0];
    assert.equal(f.r, EXPECTED[`${k}_p_recover`].expected, k);
    assert.equal(f.m, EXPECTED[`${k}_median`].expected, k);
    if (`${k}_p10_p90` in EXPECTED) assert.deepEqual([f.a, f.b], EXPECTED[`${k}_p10_p90`].expected, k);
  }
  assert.deepEqual(await listForks(db), []);
});

test('4. parallel tool calls per turn follow the run sheet', async () => {
  const ctx = await upToBlue();
  const b = await bluePhase(ctx, createBlueAgent(createScriptedBlueModel()));
  assert.deepEqual(b.history.map((h) => h.turn), [0, 1, 1, 1, 2, 2, 2, 3], 'list | 3 futures ∥ | 3 futures ∥ | commit');
  assert.deepEqual(b.history.map((h) => h.tool), ['list_candidates', ...Array(6).fill('fork_and_simulate'), 'commit']);
  // takeover condition 2 is judged at the turn boundary: 4 non-green futures inside one turn of 3+3 is not wandering
  assert.equal(b.takeover, null);
});

test('5. budget accounting: futures and tool calls charged once, audit work never charged', async () => {
  const ctx = await upToBlue();
  await bluePhase(ctx, createBlueAgent(createScriptedBlueModel()));
  let r = await readRound(db);
  assert.deepEqual([r.fork_budget, r.blue_tool_budget, r.audit_sims], [0, 7, 10], '6 futures; list + 6 forks charged; commit free');
  // identical repeated futures are free; the 7th distinct future exhausts the budget → B5 on the reserve
  const ctx2 = await upToBlue();
  const many = [[], ['scale_out:payments'], ['scale_out:ledger-db'], ['scale_out:checkout'], ['scale_out:orders'], ['breaker:gateway>checkout'], ['breaker:mobile-gw>orders']];
  const b = await bluePhase(ctx2, scripted([
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: [] } }, { tool: 'fork_and_simulate', args: { intervention_ids: [] } }, { tool: 'fork_and_simulate', args: { intervention_ids: F.F5 } }] },
    { calls: many.slice(1).map((ids) => ({ tool: 'fork_and_simulate', args: { intervention_ids: ids } })) },
  ]));
  assert.deepEqual([b.takeover.reason, b.proposedBy], [REASONS.BUDGET, 'b5']);
  r = await readRound(db);
  assert.equal(r.fork_budget, 0);
  const s = await readSteps(db, { role: 'blue' });
  assert.match(s[1].summary, /^0\/16 recover/, 'the repeated do-nothing future was returned, not re-run');
  assert.equal(s.filter((x) => x.by === 'llm' && x.tool === 'fork_and_simulate' && x.ok).length, 7, '6 charged + 1 free repeat');
  assert.equal((await readDecision(db, 'D:R1')).selected_future, fid(1, F.F5));
});

test('6. rejected and unauthorized BLUE calls are rejected server-side and recorded as Steps', async () => {
  const ctx = await upToBlue();
  const b = await bluePhase(ctx, scripted([
    { calls: [{ tool: 'simulate', args: { fault_ids: ['degrade:ledger-db'] } }, { tool: 'list_candidates', args: {} }] },
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: ['breaker:checkout>inventory'] } }, { tool: 'fork_and_simulate', args: { intervention_ids: [] } }] },
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: ['scale_out:payments', 'scale_out:orders', 'scale_out:checkout'] } }, { tool: 'fork_and_simulate', args: { intervention_ids: F.F5 } }] },
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: ['retries_off:checkout>payments', 'cap_retries:checkout>payments'] } }, { tool: 'blast_radius', args: { service: 'payments' } }] },
    { calls: [{ tool: 'commit', args: { future_id: 'fork:R1:never-evaluated' } }, { tool: 'commit', args: { future_id: fid(1, F.F5) } }] },
  ]));
  const rej = (await readSteps(db, { role: 'blue' })).filter((s) => !s.ok).map((s) => [s.tool, s.summary]);
  assert.deepEqual(rej.map((x) => x[0]), ['simulate', 'fork_and_simulate', 'fork_and_simulate', 'fork_and_simulate', 'commit']);
  assert.match(rej[0][1], /not available to role 'blue'/);
  assert.match(rej[1][1], /not in the scope of 'S:R1'/);
  assert.match(rej[2][1], /at most 2/);
  assert.match(rej[3][1], /same edge/);
  assert.match(rej[4][1], /not an evaluated future/);
  assert.deepEqual([b.proposedBy, b.outcome.decision.selected_future], ['llm', fid(1, F.F5)]);
});

test('7. BLUE has no direct database access', async () => {
  for (const [file, allowed] of [['runtime/blue.js', ['../graph/forks.js']], ['tests/fixtures/blue-model.js', []]]) {
    const src = readFileSync(`${ROOT}${file}`, 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    assert.deepEqual(imports, allowed, file);
    assert.ok(!/\bdb\b|selectGraph|GRAPH\.|roRows|\brows\(/.test(src.replace(/\/\/.*$/gm, '')), `${file} touches the database`);
  }
  assert.equal(createBlueAgent.length, 1);
  const ctx = await upToBlue();
  await bluePhase(ctx, scripted([
    { calls: [{ tool: 'query_graph', args: { cypher: `MATCH (d:Decision) DETACH DELETE d` } }, { tool: 'list_candidates', args: {} }] },
    { calls: [{ tool: 'query_graph', args: { cypher: `CREATE (:Decision {id:'D:R1', selected_future:'forged'})` } }, { tool: 'fork_and_simulate', args: { intervention_ids: F.F5 } }] },
    { tool: 'commit', args: { future_id: fid(1, F.F5) } },
  ]));
  assert.deepEqual((await readSteps(db, { role: 'blue' })).filter((s) => !s.ok).map((s) => s.tool), ['query_graph', 'query_graph']);
  const d = await readDecision(db, 'D:R1');
  assert.equal(d.selected_future, fid(1, F.F5), 'the only Decision is the one M5 wrote');
});

test('8. M5 stays authoritative: BLUE proposes, the rule and audit decide', async () => {
  // an amber proposal is rejected and the rule names F5; the Decision keeps BLUE's first proposal
  let ctx = await upToBlue();
  const a = await bluePhase(ctx, scripted([
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: [] } }, { tool: 'fork_and_simulate', args: { intervention_ids: F.F4 } }] },
    { tool: 'commit', args: { future_id: fid(1, F.F4) } },
    { tool: 'commit', args: { future_id: fid(1, F.F5) } },
  ]));
  assert.match(a.history[2].summary, /rule winner fork:R1:retries_off:checkout>payments\+retries_off:gateway>checkout/);
  let d = await readDecision(db, 'D:R1');
  assert.deepEqual([d.proposed_future, d.committed_proposal, d.selected_future, d.minimality], [fid(1, F.F4), fid(1, F.F5), fid(1, F.F5), 'proven-in-scope']);
  // a green but costlier proposal (cost 4) loses to the audited cheaper F5; NO_SAFE_ACTION is refused when a fix exists
  ctx = await upToBlue();
  const cost4 = ['retries_off:checkout>payments', 'scale_out:payments'];
  const c = await bluePhase(ctx, scripted([
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: cost4 } }, { tool: 'commit', args: { future_id: 'NO_SAFE_ACTION' } }, { tool: 'list_candidates', args: {} }] },
    { calls: [{ tool: 'commit', args: { future_id: fid(1, cost4) } }, { tool: 'blast_radius', args: { service: 'payments' } }] },
    { tool: 'commit', args: { future_id: fid(1, F.F5) } },
  ]));
  assert.equal(c.takeover, null);
  assert.match(c.history[1].summary, /a qualifying intervention exists in scope/);
  assert.match(c.history[3].summary, /rule winner fork:R1:retries_off:checkout>payments\+retries_off:gateway>checkout/);
  d = await readDecision(db, 'D:R1');
  assert.deepEqual([d.selected_future, d.proposed_by], [fid(1, F.F5), 'llm']);
  // with the scripted model the agent's own proposal is the rule's winner (no rejection needed)
  ctx = await upToBlue();
  const m = await bluePhase(ctx, createBlueAgent(createScriptedBlueModel()));
  assert.ok(m.history.filter((h) => h.tool === 'commit').every((h) => h.ok));
});

test('9. deterministic fallback to B5 when the LLM fails, stalls or is unusable', async () => {
  for (const [llm, reason, extra] of [
    [{ complete: async () => { throw new Error('429 rate limited'); } }, REASONS.ERROR, {}],
    [{ complete: () => new Promise(() => {}) }, REASONS.TIMEOUT, { ceilingMs: 50 }],
    [{ complete: async () => ({ text: 'Scale everything up.' }) }, REASONS.REJECTS, {}],
  ]) {
    const ctx = await upToBlue();
    const b = await bluePhase(ctx, createBlueAgent(llm), extra);
    assert.deepEqual([b.takeover.reason, b.proposedBy, b.outcome.decision.selected_future, b.outcome.decision.proposed_by], [reason, 'b5', fid(1, F.F5), 'b5'], reason);
  }
  // failure mid-phase: B5 reuses BLUE's evaluated futures instead of re-running or re-charging them
  const ctx = await upToBlue();
  const inner = createScriptedBlueModel();
  let k = 0;
  const b = await bluePhase(ctx, createBlueAgent({ complete: async (x) => { if (k++ === 2) throw new Error('connection reset'); return inner.complete(x); } }));
  assert.deepEqual([b.takeover.reason, b.takeover.turn, b.proposedBy], [REASONS.ERROR, 2, 'b5']);
  const r = await readRound(db);
  assert.equal(r.fork_budget, 2, 'BLUE: 3 futures; B5: do-nothing reused (free) + path fix (1)');
  assert.equal((await readDecision(db, 'D:R1')).selected_future, fid(1, F.F5));
});

test('10. reproducible behaviour and cassette replay', async () => {
  let ctx = await upToBlue();
  const m1 = createScriptedBlueModel();
  const cassette = createCassette();
  await bluePhase(ctx, cassette.record(createBlueAgent(m1)));
  const s1 = stable(await readSteps(db, { role: 'blue' }));
  ctx = await upToBlue();
  const m2 = createScriptedBlueModel();
  await bluePhase(ctx, createBlueAgent(m2));
  assert.deepEqual(stable(await readSteps(db, { role: 'blue' })), s1);
  assert.deepEqual(m2.transcripts, m1.transcripts);
  ctx = await upToBlue();
  const replay = await runPhase(db, { role: 'blue', mode: 'replay', ctx, adapter: createCassette(cassette.toJSON()).player() });
  assert.deepEqual([replay.proposedBy, replay.takeover], ['llm', null]);
  assert.deepEqual(stable(await readSteps(db, { role: 'blue' })), s1);
});

test('11. graph changes alter BLUE\'s behaviour (hardened round 2, spec run sheet: 3 turns, 5 calls)', async () => {
  await reset(db);
  const red = { mode: 'live', adapter: createRedAgent(createScriptedRedModel()) };
  const model = createScriptedBlueModel();
  const blue = { mode: 'live', adapter: createBlueAgent(model) };
  const r1 = await runRound1(db, { mode: 'live', red, blue });
  await hardenAfterRound(db, { world: r1.world, decisionId: r1.blueRun.outcome.decision.id, actTicks: [...r1.act, ...r1.hold] });
  const r2 = await runPreemptiveRound(db, { mode: 'live', red, blue });
  const b2 = r2.blueRun;
  assert.deepEqual([b2.proposedBy, b2.takeover, b2.turns, b2.history.length], ['llm', null, 3, 5]);
  assert.deepEqual(b2.history.map((h) => h.turn), [0, 1, 1, 1, 2]);
  const listed = b2.history[0].result;
  assert.ok(!listed.ids.some((i) => i.kind === 'retries_off' || i.kind === 'cap_retries'), 'hardening removed the retry knobs from the scope');
  assert.deepEqual(forks(await readSteps(db, { round: 2, role: 'blue' })), [
    [['block_deploy:CE-42'], '16/16 recover, median 32.5 (20-33), cost 1, amber'],
    [['breaker:orders>ledger-db'], '16/16 recover, median 30.5 (19-32), cost 2, amber'],
    [['scale_out:ledger-db'], '16/16 recover, median 0 (0-0), cost 3, green']]);
  const d2 = b2.outcome.decision;
  assert.deepEqual([d2.selected_future, d2.minimality, d2.proposed_by], [fid(2, ['scale_out:ledger-db']), 'proven-in-scope', 'llm']);
  assert.equal(d2.audit_sims, 13, '12 untested candidates at cost ≤ 3 (spec §8.4) + the server-evaluated do-nothing reference');
  assert.match(model.transcripts.find((t) => t.messages.length === 1 && /^Round 2/.test(t.messages[0].content)).messages[0].content, /pre-emptive/);
});

test('12. no topology duplication in BLUE code', () => {
  const topo = loadTopology();
  const names = topo.services.map((s) => s.name);
  const values = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.values(x).forEach(walk); else values.add(x); };
  walk({ services: topo.services, calls: topo.calls, change_events: topo.change_events, world_overrides: topo.world_overrides,
         faults: topo.faults, interventions: topo.interventions, round: topo.round });
  const structural = new Set(['pending', 'transient', 'persistent', 'retries', 'stage', 'degrade', 'surge', 'deploy']);
  const needles = [...values].filter((v) => (typeof v === 'number' && !(Number.isInteger(v) && v >= 0 && v <= 2))
    || (typeof v === 'string' && !structural.has(v)));
  for (const file of ['runtime/blue.js', 'tests/fixtures/blue-model.js']) {
    const code = readFileSync(`${ROOT}${file}`, 'utf8').replace(/\/\* MODEL POLICY[\s\S]*?END MODEL POLICY \*\//, '')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const v of needles) {
      const re = typeof v === 'number' ? new RegExp(`(?<![\\w.])${String(v).replace('.', '\\.')}(?![\\w.])`) : new RegExp(`['"\`]${v}['"\`]`);
      assert.ok(!re.test(code), `${file}: ${JSON.stringify(v)}`);
    }
    assert.deepEqual(names.filter((n) => code.includes(n)), [], `${file} names a service`);
    assert.ok(!/CE-\d+/.test(code), `${file} names a ChangeEvent`);
    assert.ok(!/(retries_off|cap_retries|breaker|scale_out|shed|block_deploy):/.test(code), `${file} names an intervention id`);
  }
  assert.deepEqual(BLUE_TOOL_SCHEMAS.map((t) => t.name).sort(),
    ['amplification_paths', 'blast_radius', 'commit', 'fork_and_simulate', 'list_candidates', 'query_graph', 'rank_nodes']);
  assert.match(renderBlueObjective({ budgets: { fork_budget: 3 } }), /You have 3 futures/);
});
