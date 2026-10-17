// M7 acceptance: the RED adversarial agent (spec §7, §9.2, §11.2, §14). RED is an injected LLM behind the
// M6 runtime/tool layer; tests use a deterministic scripted model (tests/fixtures/red-model.js) that reasons
// only from its transcript. Requires the pinned FalkorDB (`npm run db:up`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, rows, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readRound } from '../graph/budget.js';
import { readSteps } from '../graph/steps.js';
import { loadTopology } from '../graph/topology.js';
import { runPhase, createCassette, REASONS } from '../runtime/runtime.js';
import { runRound1, hardenAfterRound, runPreemptiveRound } from '../runtime/orchestrator.js';
import { createRedAgent, renderRedObjective, RED_TOOL_SCHEMAS } from '../runtime/red.js';
import { createScriptedRedModel } from './fixtures/red-model.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEC_OBJECTIVE = 'Find the cheapest combination of at most 2 faults that, per `simulate`, leaves the entry SLO violated in the last 10 ticks of a 90-tick horizon (transient faults removed at tick 30) in at least 8 of 16 rollouts. You have 6 simulations. Every fault must come from `list_candidates`. Submit it with its multi-hop evidence path. The server will check that no cheaper scenario works.';
let db;
before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); });

const stable = (steps) => steps.map(({ ms, ...rest }) => rest);
const redPhase = (adapter, extra = {}) => runPhase(db, { role: 'red', mode: 'live', adapter, ...extra });
const scenario = async (id) => (await roRows(db, 'twin', `MATCH (sc:Scenario {id:$id}) OPTIONAL MATCH (sc)-[:CONTAINS]->(f:Fault)
  RETURN properties(sc) AS p, collect(f.id) AS faults`, { id }))[0];
const sims = (steps) => steps.filter((s) => s.tool === 'simulate' && s.ok).map((s) => [s.args.fault_ids, s.summary]);
const scripted = (script) => ({ async next(obs) { return script[obs.turn]; } });

test('1. RED completes the canonical round-1 attack with a scripted LLM', async () => {
  await reset(db);
  const model = createScriptedRedModel();
  const r = await redPhase(createRedAgent(model));
  assert.deepEqual([r.proposedBy, r.takeover, r.turns, r.history.length], ['llm', null, 4, 5], 'spec §10: 4 LLM turns, 5 tool calls');
  assert.deepEqual(r.outcome, { scenarioId: 'S:R1', faults: ['degrade:ledger-db'], proposedBy: 'llm' });
  const sc = await scenario('S:R1');
  assert.deepEqual([sc.p.minimality, sc.p.proposed_by, sc.p.sustained_k, sc.p.red_audit_sims], ['proven: no cheaper attack', 'llm', 15, 0]);
  assert.deepEqual(sc.p.evidence_path, ['gateway', 'checkout', 'payments', 'ledger-db']);
  assert.ok(model.transcripts[0].system.startsWith(`${SPEC_OBJECTIVE}

`), 'the objective opens with the spec §9.2 text, filled from the graph');
});

test('2. RED discovers the amplifier through graph tools, not from the orchestrator', async () => {
  await reset(db);
  const services = (await roRows(db, 'twin', `MATCH (s:Service) RETURN s.name AS n`)).map((x) => x.n);
  const model = createScriptedRedModel();
  await redPhase(createRedAgent(model));
  // before its first tool result, nothing RED was given names a service, a fault or a path
  const first = JSON.stringify(model.transcripts[0]);
  assert.deepEqual(services.filter((n) => first.includes(n)), []);
  assert.ok(!first.includes('degrade:'));
  // the amplifier enters RED's context only as the result of its own amplification_paths call
  const second = model.transcripts[1].messages;
  const ampMsg = second.find((m) => m.role === 'tool' && m.name === 'amplification_paths');
  assert.deepEqual(JSON.parse(ampMsg.content).rows[0].amplifier, ['gateway', 'checkout', 'payments']);
  // a different graph → a different amplifier → a different attack (same model code)
  await reset(db);
  await rows(db, 'twin', `MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name+'>'+b.name IN ['mobile-gw>orders','orders>ledger-db'] SET c.retries = 3`);
  const m2 = createScriptedRedModel();
  const r2 = await redPhase(createRedAgent(m2));
  const steps = await readSteps(db, { role: 'red' });
  assert.match(steps[0].summary, /^mobile-gw>orders>ledger-db/);
  assert.deepEqual(steps.find((s) => s.tool === 'simulate').args.fault_ids, ['degrade:ledger-db'], 'attacks beneath the new amplifier first');
  assert.equal(r2.proposedBy, 'llm');
  assert.deepEqual((await scenario('S:R1')).p.evidence_path, ['mobile-gw', 'orders', 'ledger-db']);
});

test('3. RED evaluates candidates with the real simulator and finds the dangerous fault', async () => {
  await reset(db);
  await redPhase(createRedAgent(createScriptedRedModel()));
  const steps = await readSteps(db, { role: 'red' });
  assert.deepEqual(sims(steps), [[['degrade:payments'], '0/16 sustained'], [['degrade:ledger-db'], '15/16 sustained']]);
  assert.match(steps.find((s) => s.tool === 'simulate').cypher, /^GRAPH\.COPY twin fork:R1:red:[0-9a-f]{8}; loadModel/);
  assert.deepEqual((await scenario('S:R1')).faults, ['degrade:ledger-db']);
  assert.ok(steps.every((s) => s.by === 'llm'), 'no B5 step: RED found it itself');
});

test('4. RED tool calls produce the required Step trace', async () => {
  await reset(db);
  const r = await redPhase(createRedAgent(createScriptedRedModel()));
  const steps = await readSteps(db, {});
  assert.deepEqual(steps.map((s) => s.tool), ['amplification_paths', 'list_candidates', 'simulate', 'simulate', 'commit']);
  for (const s of steps) {
    assert.deepEqual([s.round, s.role, s.by, s.ok], [1, 'red', 'llm', true]);
    assert.ok(s.cypher.length > 0 && s.summary.length > 0 && typeof s.ms === 'number' && /^[0-9a-f]{64}$|^S:R1$/.test(s.call_id));
  }
  assert.deepEqual(steps.map((s) => s.summary), r.history.map((h) => h.summary), 'trace = what RED saw');
  assert.ok(steps[3].touched.includes('ledger-db'));
  assert.deepEqual(steps[4].touched, ['checkout', 'gateway', 'ledger-db', 'payments']);
  const next = await roRows(db, 'twin', `MATCH (:Step)-[:NEXT]->(:Step) RETURN count(*) AS n`);
  assert.equal(next[0].n, 4);
  const ev = await roRows(db, 'twin', `MATCH (:Scenario {id:'S:R1'})-[e:EVIDENCED_BY]->(s:Service) RETURN s.name AS s ORDER BY e.order`);
  assert.deepEqual(ev.map((x) => x.s), ['gateway', 'checkout', 'payments', 'ledger-db']);
});

test('5. RED respects its tool and simulation budgets (charge-once, then B5 on the reserve)', async () => {
  await reset(db);
  await redPhase(createRedAgent(createScriptedRedModel()));
  let r = await readRound(db);
  assert.deepEqual([r.sim_budget, r.red_tool_budget, r.fork_budget, r.blue_tool_budget], [4, 10, 6, 14], '2 sims; 4 charged tool calls (commit is free)');
  // an identical repeated call is free
  await reset(db);
  await redPhase(scripted([{ calls: [{ tool: 'simulate', args: { fault_ids: ['degrade:payments'] } }, { tool: 'simulate', args: { fault_ids: ['degrade:payments'] } }] },
    { tool: 'commit', args: { fault_ids: ['degrade:ledger-db'], evidence_path: [] } }]));
  r = await readRound(db);
  assert.deepEqual([r.sim_budget, r.red_tool_budget], [5, 13]);
  // the simulation budget runs out mid-attack → the phase is handed to B5, which continues on the visible reserve
  await reset(db);
  await rows(db, 'twin', `MATCH (r:Round {n:1}) SET r.sim_budget = 1`);
  const x = await redPhase(createRedAgent(createScriptedRedModel()));
  assert.deepEqual([x.takeover.reason, x.proposedBy, x.outcome.scenarioId], [REASONS.BUDGET, 'b5', 'S:R1']);
  r = await readRound(db);
  assert.equal(r.sim_budget, 0);
  assert.ok(r.autopilot_reserve < 3);
  const steps = await readSteps(db, { role: 'red' });
  assert.equal(steps.filter((s) => s.by === 'llm' && s.tool === 'simulate' && s.ok).length, 1, 'RED could only run one simulation');
});

test('6. invalid or unauthorized RED actions are rejected server-side and recorded', async () => {
  await reset(db);
  const r = await redPhase(scripted([
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: [] } }, { tool: 'amplification_paths', args: { min_risk: 2 } }] },
    { calls: [{ tool: 'simulate', args: { fault_ids: ['degrade:auth', 'degrade:orders', 'degrade:payments'] } }, { tool: 'list_candidates', args: {} }] },
    { calls: [{ tool: 'simulate', args: { fault_ids: ['degrade:redis'] } }, { tool: 'simulate', args: { fault_ids: ['degrade:payments'] } }] },
    { calls: [{ tool: 'commit', args: { fault_ids: ['degrade:payments'], evidence_path: [] } }, { tool: 'blast_radius', args: { service: 'payments' } }] },
    { calls: [{ tool: 'commit', args: { fault_ids: ['degrade:ledger-db', 'surge:gateway'], evidence_path: [] } },
      { tool: 'commit', args: { fault_ids: ['degrade:ledger-db'], evidence_path: ['gateway', 'checkout', 'payments', 'ledger-db'] } }] },
  ]));
  const rejected = (await readSteps(db, {})).filter((s) => !s.ok).map((s) => [s.tool, s.summary]);
  assert.deepEqual(rejected.map((x) => x[0]), ['fork_and_simulate', 'simulate', 'simulate', 'commit', 'commit']);
  assert.match(rejected[0][1], /not available to role 'red'/);
  assert.match(rejected[1][1], /1\.\.2 fault ids/);
  assert.match(rejected[2][1], /Fault 'degrade:redis' not in graph/);
  assert.match(rejected[3][1], /0\/16 sustained \(< 8\)/);
  assert.match(rejected[4][1], /a cheaper attack exists: degrade:ledger-db/);
  assert.deepEqual([r.proposedBy, r.outcome.faults], ['llm', ['degrade:ledger-db']], 'valid actions still go through');
  // two unusable outputs in a row → rejected → B5
  await reset(db);
  const u = await redPhase(createRedAgent({ complete: async () => ({ text: 'I think we should attack the database.' }) }));
  assert.deepEqual([u.takeover.reason, u.proposedBy], [REASONS.REJECTS, 'b5']);
});

test('7. RED cannot query or mutate FalkorDB outside its tool layer', async () => {
  // static: RED code holds no database handle and imports only constant modules
  for (const file of ['runtime/red.js', 'tests/fixtures/red-model.js']) {
    const src = readFileSync(`${ROOT}${file}`, 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    assert.ok(imports.every((i) => ['./tools.js', '../graph/forks.js', '../sim/sim.js'].includes(i)), `${file}: ${imports}`);
    assert.ok(!/\bdb\b|selectGraph|GRAPH\.|roRows|\brows\(/.test(src.replace(/\/\/.*$/gm, '')), `${file} touches the database directly`);
  }
  assert.equal(createRedAgent.length, 1, 'the agent is built from an LLM only');
  // dynamic: query_graph is read-only and runs on the twin only
  await reset(db);
  const before = (await roRows(db, 'twin', `MATCH (n) RETURN count(n) AS n`))[0].n;
  await redPhase(scripted([
    { calls: [{ tool: 'query_graph', args: { cypher: `CREATE (:Service {name:'evil'})` } }, { tool: 'list_candidates', args: {} }] },
    { calls: [{ tool: 'query_graph', args: { cypher: `MATCH (s:Service {name:'payments'}) SET s.cap_mean = 1` } }, { tool: 'query_graph', args: { cypher: `MATCH (s:Service {name:'payments'}) RETURN s.cap_mean AS c` } }] },
    { tool: 'commit', args: { fault_ids: ['degrade:ledger-db'], evidence_path: [] } },
  ]));
  const steps = await readSteps(db, {});
  assert.deepEqual(steps.filter((s) => !s.ok).map((s) => s.tool), ['query_graph', 'query_graph']);
  assert.match(steps.find((s) => s.tool === 'query_graph' && s.ok).summary, /"c":800/, 'reads the twin (800), never the world (704)');
  assert.equal((await roRows(db, 'twin', `MATCH (s:Service {name:'evil'}) RETURN count(s) AS n`))[0].n, 0);
  assert.equal((await roRows(db, 'twin', `MATCH (s:Service {name:'payments'}) RETURN s.cap_mean AS c`))[0].c, 800);
  assert.ok((await roRows(db, 'twin', `MATCH (n) RETURN count(n) AS n`))[0].n >= before);
});

test('8. a graph change makes RED take the different round-2 path (spec §9.8)', async () => {
  await reset(db);
  const model = createScriptedRedModel();
  const red = { mode: 'live', adapter: createRedAgent(model) };
  const r1 = await runRound1(db, { mode: 'autopilot', red });
  await hardenAfterRound(db, { world: r1.world, decisionId: r1.blueRun.outcome.decision.id, actTicks: [...r1.act, ...r1.hold] });
  const r2 = await runPreemptiveRound(db, { mode: 'autopilot', red });
  const s1 = await readSteps(db, { round: 1, role: 'red' }), s2 = await readSteps(db, { round: 2, role: 'red' });
  assert.deepEqual(s1.map((s) => s.tool), ['amplification_paths', 'list_candidates', 'simulate', 'simulate', 'commit']);
  assert.deepEqual(s2.map((s) => s.tool), ['amplification_paths', 'list_candidates', 'rank_nodes', 'query_graph', 'simulate', 'simulate', 'commit']);
  assert.equal(s2[0].summary, 'empty', 'the hardened graph has no amplifier');
  assert.match(s2[2].summary, /^ledger-db 0\.220/);
  assert.match(s2[3].summary, /"ce":"CE-42","caller":"orders","target":"ledger-db"/);
  assert.deepEqual(sims(s2), [[['degrade:ledger-db'], '0/16 sustained'], [['degrade:ledger-db', 'deploy:CE-42'], '16/16 sustained']]);
  assert.deepEqual([r2.redRun.proposedBy, r2.redRun.takeover, r2.redRun.turns], ['llm', null, 6], 'spec §10: 6 LLM turns, 7 tool calls');
  assert.deepEqual((await scenario('S:R2')).faults, ['degrade:ledger-db', 'deploy:CE-42']);
  assert.ok([...s1, ...s2].every((s) => s.by === 'llm'));
  // the same model object drove both rounds, starting from the same objective (a fresh Round: 6 simulations);
  // only the tool results differed. The objective tracks the live budget as it drains.
  const starts = model.transcripts.filter((t) => t.messages.length === 1);
  assert.equal(starts.length, 2);
  assert.ok(starts[0].system.startsWith(`${SPEC_OBJECTIVE}

`));
  assert.ok(starts[1].system.startsWith(`${SPEC_OBJECTIVE}

`));
  assert.match(starts[1].messages[0].content, /^Round 2\./);
  assert.match(model.transcripts[model.transcripts.length - 1].system, /You have 4 simulations/);
});

test('9. a failing, timed-out or unusable LLM falls back to B5', async () => {
  const cases = [
    [{ complete: async () => { throw new Error('503 from provider'); } }, REASONS.ERROR, {}],
    [{ complete: () => new Promise(() => {}) }, REASONS.TIMEOUT, { ceilingMs: 50 }],
    [{ complete: async () => ({ toolCalls: [{ name: 42 }] }) }, REASONS.REJECTS, {}],
  ];
  for (const [llm, reason, extra] of cases) {
    await reset(db);
    const r = await redPhase(createRedAgent(llm), extra);
    assert.deepEqual([r.takeover.reason, r.proposedBy, r.outcome.scenarioId, r.outcome.faults], [reason, 'b5', 'S:R1', ['degrade:ledger-db']], reason);
    assert.equal((await scenario('S:R1')).p.proposed_by, 'b5');
  }
  // takeover mid-phase: B5 reuses RED's earlier simulation for free
  await reset(db);
  let k = 0;
  const flaky = createScriptedRedModel();
  const r = await redPhase(createRedAgent({ complete: async (x) => { if (k++ === 2) throw new Error('connection reset'); return flaky.complete(x); } }));
  assert.deepEqual([r.takeover.reason, r.takeover.turn, r.proposedBy], [REASONS.ERROR, 2, 'b5']);
  const b5sims = (await readSteps(db, { role: 'red' })).filter((s) => s.by === 'b5' && s.tool === 'simulate');
  assert.match(b5sims[0].summary, /cached/);
});

test('10. a deterministic scripted LLM gives reproducible RED behaviour, and a cassette replays it', async () => {
  await reset(db);
  const m1 = createScriptedRedModel();
  const cassette = createCassette();
  await redPhase(cassette.record(createRedAgent(m1)));
  const steps1 = stable(await readSteps(db, {}));
  await reset(db);
  const m2 = createScriptedRedModel();
  await redPhase(createRedAgent(m2));
  assert.deepEqual(stable(await readSteps(db, {})), steps1);
  assert.deepEqual(m2.transcripts, m1.transcripts, 'identical transcripts');
  // replay: no model call at all, identical trace
  await reset(db);
  const replay = await redPhase(createCassette(cassette.toJSON()).player(), { mode: 'replay' });
  assert.deepEqual([replay.proposedBy, replay.takeover], ['llm', null]);
  assert.deepEqual(stable(await readSteps(db, {})), steps1);
});

test('11. M5 stays authoritative: RED proposes attacks only; decisions are made by the rule', async () => {
  await reset(db);
  const r = await redPhase(scripted([
    { calls: [{ tool: 'commit', args: { future_id: 'fork:R1:retries_off:checkout>payments' } }, { tool: 'list_candidates', args: {} }] },
    { calls: [{ tool: 'fork_and_simulate', args: { intervention_ids: ['retries_off:checkout>payments'] } }, { tool: 'amplification_paths', args: { min_risk: 2 } }] },
    { tool: 'commit', args: { fault_ids: ['degrade:ledger-db'], evidence_path: ['gateway', 'checkout', 'payments', 'ledger-db'] } },
  ]));
  assert.equal(r.proposedBy, 'llm');
  const rej = (await readSteps(db, {})).filter((s) => !s.ok).map((s) => s.tool);
  assert.deepEqual(rej, ['commit', 'fork_and_simulate'], 'RED cannot commit a decision or evaluate interventions');
  assert.equal((await roRows(db, 'twin', `MATCH (d:Decision) RETURN count(d) AS n`))[0].n, 0);
  assert.equal((await roRows(db, 'twin', `MATCH (f:Future) RETURN count(f) AS n`))[0].n, 0);
  // RED's scenario is then decided by BLUE through M5 (here B5), proven in scope
  const rr = await runRound1(db, { mode: 'autopilot' });
  assert.equal(rr.blueRun.outcome.decision.minimality, 'proven-in-scope');
});

test('12. no topology/configuration is duplicated in RED code', () => {
  const topo = loadTopology();
  const names = topo.services.map((s) => s.name);
  const values = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.values(x).forEach(walk); else values.add(x); };
  walk({ services: topo.services, calls: topo.calls, change_events: topo.change_events, world_overrides: topo.world_overrides,
         faults: topo.faults, interventions: topo.interventions, round: topo.round });
  const structural = new Set(['pending', 'transient', 'persistent', 'retries', 'stage', 'degrade', 'surge', 'deploy']);
  const needles = [...values].filter((v) => (typeof v === 'number' && !(Number.isInteger(v) && v >= 0 && v <= 2))
    || (typeof v === 'string' && !structural.has(v)));
  for (const file of ['runtime/red.js', 'tests/fixtures/red-model.js']) {
    const code = readFileSync(`${ROOT}${file}`, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const v of needles) {
      const re = typeof v === 'number' ? new RegExp(`(?<![\\w.])${String(v).replace('.', '\\.')}(?![\\w.])`) : new RegExp(`['"\`]${v}['"\`]`);
      assert.ok(!re.test(code), `${file}: ${JSON.stringify(v)}`);
    }
    // no service or fault/CE id anywhere, not even inside strings or Cypher
    assert.deepEqual(names.filter((n) => code.includes(n)), [], `${file} names a service`);
    assert.ok(!/CE-\d+/.test(code), `${file} names a ChangeEvent`);
  }
  assert.deepEqual(RED_TOOL_SCHEMAS.map((t) => t.name).sort(),
    ['amplification_paths', 'blast_radius', 'commit', 'list_candidates', 'query_graph', 'rank_nodes', 'simulate']);
  assert.equal(renderRedObjective({ budgets: { sim_budget: 3 }, roundInfo: { horizon_preemptive: 90, t_off: 30 } }).includes('You have 3 simulations'), true,
    'the objective follows the graph budget');
});
