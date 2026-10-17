// M9 — database permission boundary and MCP transport (spec §3.4, §11.1). Requires `npm run db:up` (ACL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { connect, roRows, endpoint } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readSteps } from '../graph/steps.js';
import { readRound } from '../graph/budget.js';
import { createMcpToolbox, childEnvironment } from '../mcp/client.js';
import { raw } from './helpers.js';
import { writeSnapshot, scenarioFaults, setBlueContext } from '../graph/records.js';
import { setKey } from '../graph/decision.js';
import { World } from '../sim/contexts.js';
import { runPhase } from '../runtime/runtime.js';
import { WORLD_SCRIPT } from '../runtime/orchestrator.js';
import { validateArgs } from '../runtime/tools.js';
import { RED_TOOL_SCHEMAS } from '../runtime/red.js';
import { BLUE_TOOL_SCHEMAS } from '../runtime/blue.js';
import { toChatTools } from '../runtime/providers/openrouter.js';

let db, agent, red, blue;
before(async () => {
  db = await connect();
  await reset(db);
  agent = await connect({ as: 'agent' });
  red = await createMcpToolbox({ role: 'red' });
  blue = await createMcpToolbox({ role: 'blue' });
});
after(async () => { await red.close(); await blue.close(); await agent.close(); await reset(db); await db.close(); });

test('1. the agent identity cannot reach WORLD, delete canonical graphs, or run admin/arbitrary commands', async () => {
  await raw(db, 'ACL', 'LOG', 'RESET');
  const denied = [
    ['GRAPH.RO_QUERY', 'world', 'MATCH (s:Service) RETURN count(s)'],
    ['GRAPH.QUERY', 'world', 'MATCH (s:Service) SET s.cap_mean = 1'],
    ['GRAPH.COPY', 'world', 'fork:steal'],
    ['GRAPH.COPY', 'twin', 'world2'],
    ['GRAPH.DELETE', 'twin'],
    ['GRAPH.DELETE', 'world'],
    ['SET', 'foo', 'bar'], ['KEYS', '*'], ['FLUSHALL'], ['ACL', 'LIST'], ['CONFIG', 'SET', 'requirepass', 'x'], ['DEL', 'twin'],
  ];
  for (const cmd of denied) {
    const r = await raw(agent, ...cmd);
    assert.equal(r.ok, false, cmd.join(' '));
    assert.match(r.error, /NOPERM/, cmd.join(' '));
  }
  // what the tool layer needs is allowed: read twin, scratch forks
  assert.equal((await raw(agent, 'GRAPH.RO_QUERY', 'twin', 'MATCH (s:Service) RETURN count(s)')).ok, true);
  assert.equal((await raw(agent, 'GRAPH.COPY', 'twin', 'fork:acl:test')).ok, true);
  assert.equal((await raw(agent, 'GRAPH.DELETE', 'fork:acl:test')).ok, true);
  // every attempt was refused by FalkorDB itself and logged (Redis merges repeated identical denials into one entry)
  const log = (await raw(db, 'ACL', 'LOG')).reply;
  assert.ok(log.length > 0);
  assert.ok(log.every((e) => e.includes('agent')), 'all denials belong to the agent identity');
  assert.equal((await roRows(db, 'world', 'MATCH (s:Service {name:"payments"}) RETURN s.cap_mean AS c'))[0].c, 704, 'WORLD untouched');
});

test('2. nothing connects anonymously; the tool server never receives admin or LLM secrets', async () => {
  const c = createClient({ socket: { ...endpoint(), reconnectStrategy: false } });
  c.on('error', () => {});
  await c.connect();
  await assert.rejects(c.sendCommand(['GRAPH.LIST']), /NOAUTH/);
  c.destroy();
  const env = childEnvironment({ ARGUS_ADMIN_PASSWORD: 'admin-secret', OPENROUTER_API_KEY: 'sk-live', ARGUS_AGENT_PASSWORD: 'agent-pw', ARGUS_FALKORDB_PORT: '6379' });
  assert.equal(env.ARGUS_ADMIN_PASSWORD, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.ARGUS_AGENT_PASSWORD, 'agent-pw');
});

test('3. MCP: each role server lists only its tools; cross-role and unlisted calls are rejected and recorded', async () => {
  assert.deepEqual(red.tools.sort(), ['amplification_paths', 'blast_radius', 'commit', 'list_candidates', 'query_graph', 'rank_nodes', 'simulate']);
  assert.deepEqual(blue.tools.sort(), ['amplification_paths', 'blast_radius', 'commit', 'fork_and_simulate', 'list_candidates', 'query_graph', 'rank_nodes']);
  await reset(db);
  const calls = [
    [red, 'red', 'fork_and_simulate', { intervention_ids: [] }],
    [blue, 'blue', 'simulate', { fault_ids: ['degrade:ledger-db'] }],
    [red, 'red', 'drop_database', {}],
    [red, 'red', 'query_graph', { cypher: 'MATCH (s:Service) DETACH DELETE s' }],
    [blue, 'blue', 'query_graph', { cypher: `CREATE (:Decision {id:'D:R1', selected_future:'forged'})` }],
    [red, 'red', 'commit', { future_id: 'fork:R1:x' }],
  ];
  for (const [tb, role, tool, args] of calls) {
    const r = await tb.invoke(role, tool, args, 'llm');
    assert.equal(r.ok, false, `${role}/${tool}`);
  }
  const steps = await readSteps(db, {});
  assert.deepEqual(steps.map((s) => [s.role, s.tool, s.ok]), calls.map(([, role, tool]) => [role, tool, false]), 'every rejection is a Step');
  assert.match(steps[2].summary, /not available to role 'red'/);
  assert.equal((await roRows(db, 'twin', `MATCH (d:Decision) RETURN count(d) AS n`))[0].n, 0, 'no Decision can be forged');
  assert.equal((await roRows(db, 'twin', `MATCH (s:Service) RETURN count(s) AS n`))[0].n, 8);
  // a client cannot use the other role's server: the role comes from the server's argv
  await assert.rejects(red.invoke('blue', 'fork_and_simulate', { intervention_ids: [] }, 'llm'), /cannot invoke as 'blue'/);
});

test('4. MCP calls run on the agent identity and keep provenance; legitimate tool work triggers no ACL denial', async () => {
  await reset(db);
  await raw(db, 'ACL', 'LOG', 'RESET');
  assert.equal((await red.invoke('red', 'amplification_paths', { min_risk: 2 }, 'llm')).ok, true);
  assert.equal((await red.invoke('red', 'simulate', { fault_ids: ['degrade:ledger-db'] }, 'b5')).summary, '15/16 sustained');
  const commit = await red.invoke('red', 'commit', { fault_ids: ['degrade:ledger-db'], evidence_path: ['gateway', 'checkout', 'payments', 'ledger-db'] }, 'llm');
  assert.equal(commit.ok, true, 'scenario + server-side audit + scope computed through the agent identity');
  const steps = await readSteps(db, {});
  assert.deepEqual(steps.map((s) => [s.tool, s.by]), [['amplification_paths', 'llm'], ['simulate', 'b5'], ['commit', 'llm']]);
  assert.deepEqual((await raw(db, 'ACL', 'LOG')).reply, [], 'the tool server never needed anything outside its ACL');
  assert.deepEqual((await db.list()).sort(), ['twin', 'world'], 'scratch forks were removed by the agent identity');
});

test('5. a crashed MCP server is respawned and the call retried without a double charge', async () => {
  await reset(db);
  const tb = await createMcpToolbox({ role: 'red' });
  try {
    assert.equal((await tb.invoke('red', 'simulate', { fault_ids: ['degrade:payments'] }, 'llm')).summary, '0/16 sustained');
    await tb.kill();
    const again = await tb.invoke('red', 'simulate', { fault_ids: ['degrade:payments'] }, 'llm');
    assert.equal(tb.spawned, 2);
    assert.equal(again.summary, '0/16 sustained (cached)');
    const r = await readRound(db);
    assert.deepEqual([r.sim_budget, r.red_tool_budget], [5, 13], 'charged once');
  } finally {
    await tb.close();
  }
});

// ------------------------------------------------------------------ M9.3: the model-facing commit contract
test('6. the LLM and MCP see `commit` as the only commit tool; no internal alias is named anywhere it can read', async () => {
  const RED = ['query_graph', 'amplification_paths', 'rank_nodes', 'blast_radius', 'list_candidates', 'simulate', 'commit'];
  const BLUE = ['query_graph', 'amplification_paths', 'rank_nodes', 'blast_radius', 'list_candidates', 'fork_and_simulate', 'commit'];
  // exact MCP listings, in order, and the same names/descriptions the provider sends
  for (const [role, names, schemas] of [['red', RED, RED_TOOL_SCHEMAS], ['blue', BLUE, BLUE_TOOL_SCHEMAS]]) {
    const tb = await createMcpToolbox({ role });
    try { assert.deepEqual(tb.tools, names, `${role} MCP listing`); } finally { await tb.close(); }
    const wire = toChatTools(schemas);
    assert.deepEqual(wire.map((t) => t.function.name), names, `${role} provider tool names`);
    const text = JSON.stringify(wire);
    for (const alias of ['submit_scenario', 'commit_decision', 'submitScenario', 'commitDecision']) assert.ok(!text.includes(alias), `${role} tools mention ${alias}`);
    assert.match(wire.find((t) => t.function.name === 'commit').function.description, /^Commit /);
  }
});

test('7. RED commit: malformed argument types are rejected before any server logic; a well-typed commit is accepted', async () => {
  await reset(db);
  const path = ['gateway', 'checkout', 'payments', 'ledger-db'];
  const before = await readRound(db);
  // CASE B / C: JSON-encoded strings where arrays are declared (exactly what the live model sent) — never parsed
  const b = await red.invoke('red', 'commit', { fault_ids: '["degrade:ledger-db"]', evidence_path: path }, 'llm');
  const c = await red.invoke('red', 'commit', { fault_ids: ['degrade:ledger-db'], evidence_path: '["gateway", "checkout", "payments", "ledger-db"]' }, 'llm');
  const missing = await red.invoke('red', 'commit', { fault_ids: ['degrade:ledger-db'] }, 'llm');
  const nested = await red.invoke('red', 'commit', { fault_ids: ['degrade:ledger-db', 7], evidence_path: path }, 'llm');
  assert.deepEqual([b, c, missing, nested].map((r) => [r.ok, r.summary]), [
    [false, 'rejected: commit: fault_ids must be an array of strings'],
    [false, 'rejected: commit: evidence_path must be an array of strings'],
    [false, 'rejected: commit: evidence_path must be an array of strings'],
    [false, 'rejected: commit: fault_ids must be an array of strings']]);
  assert.equal((await roRows(db, 'twin', `MATCH (sc:Scenario) RETURN count(sc) AS n`))[0].n, 0, 'nothing reached submit/audit');
  assert.deepEqual(await readRound(db), before, 'no budget touched');
  // CASE A: the same commit, correctly typed → the existing re-verify + strictly-cheaper audit accepts it
  const a = await red.invoke('red', 'commit', { fault_ids: ['degrade:ledger-db'], evidence_path: path }, 'llm');
  assert.equal(a.ok, true);
  assert.equal(a.summary, 'degrade:ledger-db 15/16 sustained; proven: no cheaper attack (audit 0); scope 15');
  const sc = (await roRows(db, 'twin', `MATCH (sc:Scenario {id:'S:R1'}) RETURN sc.proposed_by AS by, sc.evidence_path AS ev`))[0];
  assert.deepEqual([sc.by, sc.ev], ['llm', path]);
  // every attempt is a recorded Step, in order
  assert.deepEqual((await readSteps(db, {})).map((s) => [s.tool, s.ok]), [['commit', false], ['commit', false], ['commit', false], ['commit', false], ['commit', true]]);
  // semantic rejections now name the public tool, not an internal alias
  await reset(db);
  const empty = await red.invoke('red', 'commit', { fault_ids: [], evidence_path: [] }, 'llm');
  assert.equal(empty.summary, 'rejected: commit: unknown or empty fault set');
});

test('8. BLUE commit: malformed argument types are rejected; a valid commit is decided by M5 exactly as before', async () => {
  await reset(db);
  const r = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const round = await readRound(db);
  const world = await World.open(db);
  world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: await scenarioFaults(db, r.outcome.scenarioId) });
  world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  await setBlueContext(db, { scenarioId: r.outcome.scenarioId, futureMode: 'reactive', snapshotId });
  const F5 = ['retries_off:checkout>payments', 'retries_off:gateway>checkout'];
  const f5 = `fork:R1:${setKey(F5)}`;
  assert.equal((await blue.invoke('blue', 'fork_and_simulate', { intervention_ids: F5 }, 'llm')).summary, '16/16 recover, median 2 (1-3), cost 2, green');
  const bad = [
    await blue.invoke('blue', 'commit', { future_id: [f5] }, 'llm'),
    await blue.invoke('blue', 'commit', {}, 'llm'),
    await blue.invoke('blue', 'commit', { future_id: f5, rationale: 42 }, 'llm')];
  assert.deepEqual(bad.map((x) => x.summary), [
    'rejected: commit: future_id must be a string', 'rejected: commit: future_id must be a string', 'rejected: commit: rationale must be a string']);
  assert.equal((await roRows(db, 'twin', `MATCH (d:Decision) RETURN count(d) AS n`))[0].n, 0);
  // CASE D: unchanged M5 behaviour
  const ok = await blue.invoke('blue', 'commit', { future_id: f5, rationale: 'both retry layers' }, 'llm');
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.result.decision.id, ok.result.decision.selected_future, ok.result.decision.proposed_by, ok.result.decision.minimality],
    ['D:R1', f5, 'llm', 'proven-in-scope']);
});

test('9. validateArgs: the contract covers commit only and never coerces', () => {
  assert.doesNotThrow(() => validateArgs('red', 'commit', { fault_ids: ['a'], evidence_path: [] }));
  assert.doesNotThrow(() => validateArgs('blue', 'commit', { future_id: 'NO_SAFE_ACTION' }));
  assert.doesNotThrow(() => validateArgs('red', 'simulate', { fault_ids: 'not checked here' }), 'other tools keep their existing handling');
  assert.throws(() => validateArgs('red', 'commit', null), /commit: arguments must be an object/);
  assert.throws(() => validateArgs('red', 'commit', { fault_ids: 'a', evidence_path: [] }), /fault_ids must be an array of strings/);
  assert.throws(() => validateArgs('blue', 'commit', { future_id: 5 }), /future_id must be a string/);
});
