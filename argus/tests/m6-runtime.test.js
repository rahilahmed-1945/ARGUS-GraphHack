// M6 acceptance: deterministic B5 fallback + runtime foundation (spec §14, §9.6/§9.8, §10, §6.20, §2.2).
// Requires the pinned FalkorDB (`npm run db:up`). Each scenario starts from a fresh reset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, rows, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readRound } from '../graph/budget.js';
import { readSteps } from '../graph/steps.js';
import { readDecision, setKey } from '../graph/decision.js';
import { listForks } from '../graph/forks.js';
import { loadTopology } from '../graph/topology.js';
import { runPhase, createCassette, REASONS } from '../runtime/runtime.js';
import { runRound1, hardenAfterRound, runPreemptiveRound } from '../runtime/orchestrator.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const F5 = ['retries_off:checkout>payments', 'retries_off:gateway>checkout'];
const fid = (n, ids) => `fork:R${n}:${setKey(ids)}`;
let db;

before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); });

const tools = (steps, role) => steps.filter((s) => s.role === role).map((s) => s.tool);
const stable = (steps) => steps.map(({ ms, ...rest }) => rest);                       // ms is the only volatile field
async function fullAutopilot() {
  await reset(db);
  const r1 = await runRound1(db, { mode: 'autopilot' });
  const h = await hardenAfterRound(db, { world: r1.world, decisionId: r1.blueRun.outcome.decision.id, actTicks: [...r1.act, ...r1.hold] });
  const r2 = await runPreemptiveRound(db, { mode: 'autopilot' });
  return { r1, h, r2 };
}
// A scripted stand-in for an LLM: returns the turn-th decision of a script (or a function of the observation).
const scripted = (script) => ({ async next(obs) { const d = script[obs.turn]; return typeof d === 'function' ? d(obs) : d; } });

let canon;   // the canonical autopilot run, shared by tests 1, 3, 4, 8

test('1. B5 produces the canonical round-1 behaviour (spec §9.6, §14.4)', async () => {
  canon = await fullAutopilot();
  const { r1 } = canon;
  const steps = await readSteps(db, { round: 1 });
  // RED: amplifier → triggers in (hops,id) order → degrade:payments 0/16 → degrade:ledger-db 15/16 → submit
  const sims = steps.filter((s) => s.tool === 'simulate');
  assert.deepEqual(sims.map((s) => [s.args.fault_ids, s.summary]),
    [[['degrade:payments'], '0/16 sustained'], [['degrade:ledger-db'], '15/16 sustained']]);
  const sc = (await roRows(db, 'twin', `MATCH (sc:Scenario {id:'S:R1'}) RETURN properties(sc) AS p`))[0].p;
  assert.deepEqual([sc.sustained_k, sc.minimality, sc.proposed_by, sc.red_audit_sims], [15, 'proven: no cheaper attack', 'b5', 0]);
  assert.deepEqual(sc.evidence_path, ['gateway', 'checkout', 'payments', 'ledger-db']);
  assert.equal(sc.scope_ids.length, 15);
  // BLUE: F0, then the path fix (green) → commit; the audit clears the 12 untested candidates at cost ≤ 2
  const d = r1.blueRun.outcome.decision;
  assert.equal(d.selected_future, fid(1, F5));
  assert.deepEqual([d.minimality, d.proposed_by, d.audit_sims, d.agent_futures], ['proven-in-scope', 'b5', 12, 2]);
  assert.equal(r1.blueRun.takeover, null);
  assert.deepEqual(await listForks(db), []);
});

test('2. B5 operates from FalkorDB graph state only', async () => {
  // b5.js reaches the system only through the tool layer (no direct graph or simulator access)
  const src = readFileSync(`${ROOT}runtime/b5.js`, 'utf8');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]), ['./tools.js']);
  // remove the canonical trigger from the graph's action space: B5 never tries it, and every fault it
  // simulates is one the graph offered in an earlier tool result
  await reset(db);
  await rows(db, 'twin', `MATCH (f:Fault {id:'degrade:ledger-db'}) SET f.active = false`);
  const red = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const steps = await readSteps(db, { round: 1, role: 'red' });
  const simulated = steps.filter((s) => s.tool === 'simulate').flatMap((s) => s.args.fault_ids);
  assert.ok(!simulated.includes('degrade:ledger-db'));
  assert.equal(steps[0].tool, 'amplification_paths');
  assert.equal(steps[0].summary, 'gateway>checkout>payments 4.5x triggers degrade:payments@0');
  const offered = steps.filter((s) => s.tool !== 'simulate').map((s) => s.summary).join(' ');
  for (const f of new Set(simulated)) assert.ok(offered.includes(f), `${f} came from a graph result`);
  assert.equal(red.outcome.scenarioId, null, 'no ≥ 8/16 attack along the amplifier without the trigger');
});

test('3. B5 selects the expected graph queries/tools on the canonical topology', async () => {
  const s1 = await readSteps(db, {});
  // re-run canonical (test 2 reset the graph) and compare the exact tool sequences
  canon = await fullAutopilot();
  const r1 = await readSteps(db, { round: 1 }), r2 = await readSteps(db, { round: 2 });
  assert.deepEqual(tools(r1, 'red'), ['amplification_paths', 'query_graph', 'simulate', 'simulate', 'query_graph', 'commit']);
  assert.deepEqual(tools(r1, 'blue'), ['fork_and_simulate', 'amplification_paths', 'query_graph', 'fork_and_simulate', 'commit']);
  assert.deepEqual(tools(r2, 'red'), ['amplification_paths', 'rank_nodes', 'query_graph', 'simulate', 'simulate', 'query_graph', 'commit']);
  assert.deepEqual(tools(r2, 'blue'), ['fork_and_simulate', 'amplification_paths', 'list_candidates', 'query_graph', 'query_graph',
    'fork_and_simulate', 'fork_and_simulate', 'fork_and_simulate', 'commit']);
  assert.ok(s1.length > 0);
});

test('4. hardening changes the graph, and the graph changes what ARGUS does (round 2, spec §9.8)', async () => {
  const { h, r2 } = canon;
  // hardening persisted: retries 0 on both amplifier edges in WORLD and TWIN; payments calibrated
  for (const g of ['world', 'twin']) {
    const r = await roRows(db, g, `MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name+'>'+b.name IN ['gateway>checkout','checkout>payments'] RETURN c.retries AS r`);
    assert.deepEqual(r.map((x) => x.r), [0, 0], g);
  }
  assert.deepEqual([h.observation.observed_viol_ticks, h.observation.predicted_viol_ticks_p50], [3, 2]);
  assert.deepEqual(h.calibrated.map((c) => [c.service, c.before, Number(c.after.toFixed(1))]), [['payments', 800, 708.9]]);
  const cal = await roRows(db, 'twin', `MATCH (:Observation {id:'O:R1'})-[c:CALIBRATED]->(s:Service) RETURN s.name AS s, c.n AS n, s.cap_sd AS sd`);
  assert.deepEqual(cal, [{ s: 'payments', n: 41, sd: 0.03 }]);
  assert.equal(h.nextRound, 2);
  // regenerated action space: no retry interventions on hardened edges, history kept (inactive)
  const stale = await roRows(db, 'twin', `MATCH (i:Intervention) WHERE i.id IN $ids RETURN i.id AS id, i.active AS a ORDER BY id`, { ids: F5 });
  assert.deepEqual(stale.map((x) => x.a), [false, false]);
  // round-2 RED: amplifier empty → PageRank → ledger-db → CE-42 (a different graph-grounded path)
  const s2 = await readSteps(db, { round: 2, role: 'red' });
  assert.equal(s2[0].summary, 'empty');
  assert.match(s2[1].summary, /^ledger-db 0\.220/);
  assert.deepEqual(s2.filter((s) => s.tool === 'simulate').map((s) => [s.args.fault_ids, s.summary]),
    [[['degrade:ledger-db'], '0/16 sustained'], [['degrade:ledger-db', 'deploy:CE-42'], '16/16 sustained']]);
  const sc2 = (await roRows(db, 'twin', `MATCH (sc:Scenario {id:'S:R2'}) RETURN properties(sc) AS p`))[0].p;
  assert.deepEqual([sc2.red_audit_sims, sc2.scope_ids.length], [10, 12]);
  assert.deepEqual(sc2.evidence_path, ['mobile-gw', 'orders', 'ledger-db']);
  // round-2 BLUE (pre-emptive): G0 red, block CE-42 amber, breaker orders>ledger-db amber, scale_out ledger-db green
  const blue = (await readSteps(db, { round: 2, role: 'blue' })).filter((s) => s.tool === 'fork_and_simulate');
  assert.deepEqual(blue.map((s) => [s.args.intervention_ids, s.summary]), [
    [[], '0/16 recover, median 89.5 (82-90), cost 0, red'],
    [['block_deploy:CE-42'], '16/16 recover, median 32.5 (20-33), cost 1, amber'],
    [['breaker:orders>ledger-db'], '16/16 recover, median 30.5 (19-32), cost 2, amber'],
    [['scale_out:ledger-db'], '16/16 recover, median 0 (0-0), cost 3, green']]);
  const d2 = r2.blueRun.outcome.decision;
  assert.deepEqual([d2.selected_future, d2.minimality, d2.audit_sims], [fid(2, ['scale_out:ledger-db']), 'proven-in-scope', 12]);
});

test('5. M5 remains the authority: a proposal the rule does not select is rejected', async () => {
  await reset(db);
  const red = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const r1 = await runRound1(db, { mode: 'autopilot', red: {}, blue: { mode: 'live', adapter: scripted([
    { tool: 'fork_and_simulate', args: { intervention_ids: [] } },
    { tool: 'fork_and_simulate', args: { intervention_ids: ['breaker:checkout>payments'] } },
    { tool: 'commit', args: { future_id: fid(1, ['breaker:checkout>payments']) } },        // amber: rule rejects
    { tool: 'fork_and_simulate', args: { intervention_ids: F5 } },
    { tool: 'commit', args: { future_id: fid(1, F5) } },
  ]) } });
  assert.ok(red.outcome.scenarioId);
  const b = r1.blueRun;
  assert.equal(b.proposedBy, 'llm');
  assert.equal(b.takeover, null);
  assert.match(b.history[2].summary, /rejected: commit rejected: the selection rule picks a different candidate; rule winner/);
  const d = await readDecision(db, 'D:R1');
  assert.deepEqual([d.selected_future, d.proposed_future, d.minimality], [fid(1, F5), fid(1, ['breaker:checkout>payments']), 'proven-in-scope']);
});

test('6. with no LLM available, execution completes deterministically through B5', async () => {
  await reset(db);
  const r = await runRound1(db, { mode: 'live', red: { adapter: null }, blue: { adapter: null } });
  assert.deepEqual([r.redRun.takeover.reason, r.blueRun.takeover.reason], [REASONS.UNAVAILABLE, REASONS.UNAVAILABLE]);
  const live = stable(await readSteps(db, {}));
  assert.ok(live.every((s) => s.by === 'b5'));
  await reset(db);
  await runRound1(db, { mode: 'autopilot' });
  assert.deepEqual(stable(await readSteps(db, {})), live, 'identical to a pure autopilot run');
  // an adapter that throws (e.g. network error) also falls back
  await reset(db);
  const e = await runPhase(db, { role: 'red', mode: 'live', adapter: { next: async () => { throw new Error('ECONNREFUSED'); } } });
  assert.deepEqual([e.takeover.reason, e.outcome.scenarioId, e.proposedBy], [REASONS.ERROR, 'S:R1', 'b5']);
});

test('7. takeover on timeout, unusable output, wandering, turn limit and budget exhaustion', async () => {
  // turn ceiling: an LLM that never answers
  await reset(db);
  const t = await runPhase(db, { role: 'red', mode: 'live', ceilingMs: 50, adapter: { next: () => new Promise(() => {}) } });
  assert.deepEqual([t.takeover.reason, t.outcome.scenarioId], [REASONS.TIMEOUT, 'S:R1']);
  // unusable output twice in a row
  await reset(db);
  const u = await runPhase(db, { role: 'red', mode: 'live', adapter: scripted(['not json', { tool: 'rm -rf' }]) });
  assert.deepEqual([u.takeover.reason, u.takeover.turn, u.outcome.scenarioId], [REASONS.REJECTS, 2, 'S:R1']);
  // wandering inside the budget: 4 simulations without a qualifying attack → B5 finishes from cached results
  await reset(db);
  const wander = ['degrade:payments', 'degrade:auth', 'degrade:orders', 'degrade:inventory'].map((f) => ({ tool: 'simulate', args: { fault_ids: [f] } }));
  const w = await runPhase(db, { role: 'red', mode: 'live', adapter: scripted(wander) });
  assert.deepEqual([w.takeover.reason, w.takeover.turn, w.outcome.scenarioId, w.proposedBy], [REASONS.NO_PROGRESS, 4, 'S:R1', 'b5']);
  const sc = (await roRows(db, 'twin', `MATCH (sc:Scenario {id:'S:R1'}) RETURN sc.proposed_by AS b`))[0].b;
  assert.equal(sc, 'b5');
  const steps = await readSteps(db, { round: 1, role: 'red' });
  const cached = steps.filter((s) => s.by === 'b5' && s.tool === 'simulate' && s.summary.includes('cached'));
  assert.deepEqual(cached.map((s) => s.args.fault_ids), [['degrade:payments']], 'B5 re-requests the LLM\'s earlier simulation for free');
  assert.equal((await readRound(db)).sim_budget, 1, '6 − 4 (LLM) − 1 (B5: ledger-db)');
  // turn limit: 8 turns without a commit
  await reset(db);
  const m = await runPhase(db, { role: 'red', mode: 'live', adapter: { next: async (o) => ({ tool: 'blast_radius', args: { service: ['payments', 'orders'][o.turn % 2] } }) } });
  assert.deepEqual([m.takeover.reason, m.takeover.turn, m.outcome.scenarioId], [REASONS.MAX_TURN, 8, 'S:R1']);
  // budget exhaustion: the simulation budget runs out → B5 continues on the autopilot reserve
  await reset(db);
  await rows(db, 'twin', `MATCH (r:Round {n:1}) SET r.sim_budget = 1`);
  const bx = await runPhase(db, { role: 'red', mode: 'live', adapter: scripted([
    { tool: 'simulate', args: { fault_ids: ['degrade:auth'] } }, { tool: 'simulate', args: { fault_ids: ['degrade:orders'] } }]) });
  assert.deepEqual([bx.takeover.reason, bx.outcome.scenarioId], [REASONS.BUDGET, 'S:R1']);
  const rr = await readRound(db);
  assert.equal(rr.sim_budget, 0);
  assert.ok(rr.autopilot_reserve < 3, 'B5 drew on the visible reserve');
});

test('8. Step records contain the required information and are reproducible', async () => {
  const run = await fullAutopilot();
  const steps = await readSteps(db, {});
  assert.deepEqual(steps.map((s) => s.i), steps.map((_, k) => k + 1));
  for (const s of steps) {
    for (const k of ['i', 'round', 'role', 'by', 'tool', 'args', 'cypher', 'summary', 'ok', 'ms', 'call_id']) assert.ok(s[k] !== undefined && s[k] !== null, `Step ${s.i}.${k}`);
    if (s.ok) assert.ok(s.cypher.length > 0, `Step ${s.i} has its Cypher`);
  }
  const next = await roRows(db, 'twin', `MATCH (a:Step)-[:NEXT]->(b:Step) RETURN count(*) AS n`);
  assert.equal(next[0].n, steps.length - 1);
  const sim = steps.find((s) => s.tool === 'simulate' && s.args.fault_ids[0] === 'degrade:ledger-db');
  assert.ok(sim.touched.includes('ledger-db'));
  assert.deepEqual(steps.find((s) => s.tool === 'amplification_paths').touched, ['checkout', 'gateway', 'ledger-db', 'payments']);
  assert.match(steps[0].cypher, /MATCH p = \(e:Service \{entry:true\}\)-\[:CALLS\*1\.\.5\]->/);
  // decisions are BASED_ON their round's BLUE steps
  const based = await roRows(db, 'twin', `MATCH (d:Decision)-[:BASED_ON]->(st:Step) RETURN d.id AS d, count(st) AS n ORDER BY d`);
  assert.deepEqual(based.map((x) => x.d), ['D:R1', 'D:R2']);
  // reproducible: a second fresh run writes identical steps (ms excluded)
  const again = await fullAutopilot();
  assert.deepEqual(stable(await readSteps(db, {})), stable(steps));
  assert.equal(again.r2.blueRun.outcome.decision.selected_future, run.r2.blueRun.outcome.decision.selected_future);
});

test('9. runtime traces replay deterministically from a cassette', async () => {
  const script = [
    { tool: 'amplification_paths', args: { min_risk: 2 } },
    { tool: 'list_candidates', args: {} },
    { tool: 'simulate', args: { fault_ids: ['degrade:payments'] } },
    { tool: 'simulate', args: { fault_ids: ['degrade:ledger-db'] } },
    { tool: 'commit', args: { fault_ids: ['degrade:ledger-db'], evidence_path: ['gateway', 'checkout', 'payments', 'ledger-db'] } },
  ];
  await reset(db);
  const cassette = createCassette();
  const live = await runPhase(db, { role: 'red', mode: 'live', adapter: cassette.record(scripted(script)) });
  assert.deepEqual([live.proposedBy, live.takeover, cassette.size], ['llm', null, 5]);
  const recorded = stable(await readSteps(db, {}));
  // replay against a fresh graph: identical tool calls, results and steps; no LLM involved
  await reset(db);
  const replay = await runPhase(db, { role: 'red', mode: 'replay', adapter: createCassette(cassette.toJSON()).player() });
  assert.deepEqual([replay.proposedBy, replay.takeover, replay.outcome.scenarioId], ['llm', null, 'S:R1']);
  assert.deepEqual(stable(await readSteps(db, {})), recorded);
  assert.deepEqual(replay.history, live.history);
  // a cassette miss (graph state differs from the recording) hands the phase to B5
  await reset(db);
  await rows(db, 'twin', `MATCH (a:Service {name:'checkout'})-[c:CALLS]->(:Service {name:'payments'}) SET c.retries = 2`);
  const miss = await runPhase(db, { role: 'red', mode: 'replay', adapter: createCassette(cassette.toJSON()).player() });
  assert.equal(miss.takeover.reason, REASONS.MISS);
  assert.equal(miss.proposedBy, 'b5');
});

test('10. no topology/configuration is duplicated in runtime JavaScript', () => {
  const topo = loadTopology();
  const values = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.values(x).forEach(walk); else values.add(x); };
  walk({ services: topo.services, calls: topo.calls, change_events: topo.change_events, world_overrides: topo.world_overrides,
         faults: topo.faults, interventions: topo.interventions, round: topo.round });
  const structural = new Set(['pending', 'transient', 'persistent', 'retries', 'stage', 'degrade', 'surge', 'deploy']);
  const needles = [...values].filter((v) => (typeof v === 'number' && !(Number.isInteger(v) && v >= 0 && v <= 2))
    || (typeof v === 'string' && !structural.has(v)));
  const blocks = ['EQUATION-SHAPE CONSTANTS', 'PRNG ALGORITHM', 'SEED SCHEME', 'RUNTIME POLICY CONSTANTS', 'B5 POLICY CONSTANTS',
    'TAKEOVER POLICY CONSTANTS', 'WORLD SCRIPT CONSTANTS', 'SPEC QUERIES', 'DISPLAY CONSTANTS'];
  const offenders = [];
  for (const dir of ['graph', 'sim', 'runtime']) {
    for (const file of readdirSync(`${ROOT}${dir}`).filter((f) => f.endsWith('.js'))) {
      let code = readFileSync(`${ROOT}${dir}/${file}`, 'utf8');
      for (const b of blocks) code = code.replace(new RegExp(`/\\* ${b}[\\s\\S]*?END ${b} \\*/`), '');
      code = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const v of needles) {
        const re = typeof v === 'number' ? new RegExp(`(?<![\\w.])${String(v).replace('.', '\\.')}(?![\\w.])`) : new RegExp(`['"\`]${v}['"\`]`);
        if (re.test(code)) offenders.push(`${dir}/${file}: ${JSON.stringify(v)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
