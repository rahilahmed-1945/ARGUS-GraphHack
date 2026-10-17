// M9 — event stream, world clock, Socket.IO delivery, hardening PR, cassette file, and failure/takeover behaviour
// over the real MCP transport. Requires `npm run db:up` (ACL). No API key: provider failures use a fake fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { io as ioClient } from 'socket.io-client';
import { connect, rows, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readRound } from '../graph/budget.js';
import { readSteps } from '../graph/steps.js';
import { setKey } from '../graph/decision.js';
import { writeSnapshot, scenarioFaults, setBlueContext } from '../graph/records.js';
import { applyDecisionWithPR, captureConfig } from '../graph/hardening-pr.js';
import { World } from '../sim/contexts.js';
import { createEventBus, EVENT_TYPES } from '../runtime/events.js';
import { createWorldClock, PACING } from '../runtime/clock.js';
import { runPhase, createCassette, REASONS } from '../runtime/runtime.js';
import { runRound1, WORLD_SCRIPT } from '../runtime/orchestrator.js';
import { createToolbox } from '../runtime/tools.js';
import { createRedAgent } from '../runtime/red.js';
import { saveCassette, loadCassette, CASSETTE_FORMAT } from '../runtime/cassette-file.js';
import { createOpenRouterLLM } from '../runtime/providers/openrouter.js';
import { createMcpToolbox, ToolInfraError } from '../mcp/client.js';
import { startEventServer } from '../app/server.js';
import { createScriptedRedModel } from './fixtures/red-model.js';
import { mcpToolboxes } from './helpers.js';

let db, agentDb, boxes;
before(async () => { db = await connect(); agentDb = await connect({ as: 'agent' }); boxes = await mcpToolboxes(agentDb); });
after(async () => { await boxes.close(); await agentDb.close(); await reset(db); await db.close(); });

// ------------------------------------------------------------------ event stream / clock / delivery
test('1. event bus: ordered seq, closed type set, reduced state, catch-up from a seq', () => {
  const bus = createEventBus();
  assert.throws(() => bus.emit('SOMETHING_ELSE', {}), /unknown event type/);
  bus.emit('ROUND_STARTED', { round: 1, mode: 'reactive', graphs: {} });
  bus.emit('RED_STARTED', { role: 'red' });
  bus.emit('WORLD_TICK', { tick: 7, viol: true });
  bus.emit('TAKEOVER', { role: 'red', reason: 'llm_error' });
  assert.deepEqual(bus.log.map((e) => [e.seq, e.type, e.round, e.tick]), [[1, 'ROUND_STARTED', null, 0], [2, 'RED_STARTED', 1, 0], [3, 'WORLD_TICK', 1, 0], [4, 'TAKEOVER', 1, 7]]);
  assert.deepEqual(bus.since(2).map((e) => e.seq), [3, 4]);
  const s = bus.state();
  assert.deepEqual([s.round, s.phase, s.tick, s.lastSeq, s.takeovers.length], [1, 'red', 7, 4, 1]);
  assert.ok(bus.log.every((e) => !('time' in e) && !('ts' in e)), 'no wall-clock fields: a replayed run is event-identical');
  assert.ok(EVENT_TYPES.includes('WORLD_DEPLOY_LANDED') && EVENT_TYPES.includes('DECISION_AUDITED'));
});

test('2. world clock: hold/advance account virtual time; realtime sleeps only through the injected sleep', async () => {
  const bus = createEventBus();
  const v = createWorldClock({ pacing: 'virtual', events: bus, sleep: () => { throw new Error('virtual pacing must not sleep'); } });
  v.pause('RED deciding');
  v.run('ACT');
  for (let k = 0; k < 10; k++) await v.tick();
  await v.hold('TRIGGER REMOVED');
  assert.equal(v.virtualMs, 10 * (1000 / PACING.TICKS_PER_SECOND) + PACING.HOLD_MS);
  assert.deepEqual(bus.log.map((e) => e.payload.state), ['paused', 'running', 'held']);
  const slept = [];
  const r = createWorldClock({ pacing: 'realtime', sleep: async (ms) => { slept.push(ms); } });
  await r.tick(); await r.hold('x');
  assert.deepEqual(slept, [200, 4000]);
  assert.equal(r.virtualMs, 4200);
  assert.throws(() => createWorldClock({ pacing: 'fast' }));
});

test('3. Socket.IO: in-order delivery, state on connect, channels, and gap fill after reconnect', async () => {
  const bus = createEventBus();
  const server = await startEventServer({ bus, port: 0 });
  const client = (opts = {}) => ioClient(server.url, { transports: ['websocket'], forceNew: true, ...opts });
  try {
    const c = client();
    const firstState = await new Promise((r) => c.once('state', r));
    assert.equal(firstState.phase, 'idle');
    const got = [], ticks = [];
    c.on('event', (e) => got.push(e.seq));
    c.on('tick', (e) => ticks.push(e.payload.tick));
    bus.emit('ROUND_STARTED', { round: 1, mode: 'reactive', graphs: {} });
    for (let t = 1; t <= 50; t++) bus.emit('WORLD_TICK', { tick: t });
    bus.emit('CLOCK', { state: 'held' });
    await new Promise((r) => { const iv = setInterval(() => { if (got.length === 52) { clearInterval(iv); r(); } }, 5); });
    assert.deepEqual(got, Array.from({ length: 52 }, (_, i) => i + 1), 'strictly in order, none lost');
    assert.deepEqual(ticks, Array.from({ length: 50 }, (_, i) => i + 1));
    c.disconnect();
    // events while the client is away
    for (let t = 51; t <= 60; t++) bus.emit('WORLD_TICK', { tick: t });
    const c2 = client();
    const state = await new Promise((r) => c2.once('state', r));
    assert.deepEqual([state.lastSeq, state.tick, state.clock.state], [62, 60, 'held']);
    const missed = await c2.timeout(2000).emitWithAck('replay', 52);
    assert.deepEqual(missed.map((e) => e.seq), [53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
    const http = await (await fetch(`${server.url}/state`)).json();
    assert.equal(http.lastSeq, 62);
    c2.disconnect();
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------------ hardening PR + cassette file
test('4. the hardening PR is generated from the actual graph mutation and is deterministic', async () => {
  const once = async () => {
    await reset(db);
    const r1 = await runRound1(db, { mode: 'autopilot' });
    const before = { world: await captureConfig(db, 'world'), twin: await captureConfig(db, 'twin') };
    const pr = await applyDecisionWithPR(db, r1.blueRun.outcome.decision.id);
    return { r1, before, pr };
  };
  const { pr, before } = await once();
  assert.deepEqual(pr.before, before);
  const expected = [
    { edge: 'checkout>payments', field: 'retries', before: 3, after: 0 },
    { edge: 'gateway>checkout', field: 'retries', before: 2, after: 0 }];
  assert.deepEqual(pr.pr.changes, { world: expected, twin: expected });
  // the changes are what the database now holds
  for (const g of ['world', 'twin']) {
    const live = await roRows(db, g, `MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name + '>' + b.name IN ['checkout>payments','gateway>checkout'] RETURN c.retries AS r`);
    assert.deepEqual(live.map((x) => x.r), [0, 0]);
  }
  assert.deepEqual([pr.pr.label, pr.pr.decision, pr.pr.interventions, pr.pr.minimality, pr.pr.prediction.recovered],
    ['emergency mitigation', 'D:R1', ['retries_off:checkout>payments', 'retries_off:gateway>checkout'], 'proven-in-scope', '16/16']);
  const stored = (await roRows(db, 'twin', `MATCH (d:Decision {id:'D:R1'}) RETURN d.hardening_pr AS y`))[0].y;
  assert.equal(stored, pr.yaml);
  assert.deepEqual(load(stored), pr.pr, 'the stored YAML parses back to the PR');
  assert.equal((await once()).pr.yaml, pr.yaml, 'byte-identical on a fresh run');
});

test('5. cassette file: sorted, versioned, labelled, and round-trips to an identical player', async () => {
  await reset(db);
  const rec = createCassette();
  const live = await runPhase(db, { role: 'red', mode: 'live', adapter: rec.record(createRedAgent(createScriptedRedModel())) });
  const path = join(mkdtempSync(join(tmpdir(), 'argus-')), 'c.json');
  assert.equal(saveCassette(path, rec, { source: 'test' }), rec.size);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual([file.format, file.source, Object.keys(file.entries)], [CASSETTE_FORMAT, 'test', Object.keys(file.entries).sort()]);
  assert.ok(Object.keys(file.entries).every((k) => /^[0-9a-f]{64}$/.test(k)));
  const liveSteps = (await readSteps(db, {})).map(({ ms, ...s }) => s);
  await reset(db);
  const { cassette } = loadCassette(path);
  const replay = await runPhase(db, { role: 'red', mode: 'replay', adapter: cassette.player() });
  assert.deepEqual([replay.proposedBy, replay.takeover, replay.outcome], [live.proposedBy, null, live.outcome]);
  assert.deepEqual((await readSteps(db, {})).map(({ ms, ...s }) => s), liveSteps);
  assert.throws(() => { saveCassette(path, createCassette(), { source: 'x' }); loadCassette(path.replace('c.json', 'missing.json')); });
});

// ------------------------------------------------------------------ failure / takeover over MCP
const toolCall = (name, args) => ({ id: `c_${name}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const providerReply = (message) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) });
const providerLLM = (fetch, timeoutMs = 30000) => createOpenRouterLLM({ apiKey: 'sk-test', model: 'test/model', fetch, timeoutMs });
const scripted = (script) => ({ async next(obs) { return script[obs.turn]; } });

// one phase over the MCP servers, with the in-process (agent identity) fallback and an event bus
async function mcpPhase(role, adapter, { ctx = {}, toolboxFactory, ceilingMs } = {}) {
  const events = createEventBus();
  const r = await runPhase(db, { role, mode: 'live', adapter, ctx, events, ...(ceilingMs ? { ceilingMs } : {}),
    toolboxFactory: toolboxFactory ?? (() => boxes.toolboxes[role](ctx)),
    fallbackToolboxFactory: () => boxes.toolboxes.fallback(role, ctx) });
  return { r, events, steps: await readSteps(db, { role }) };
}
function assertTakeover({ r, events, steps }, reason, { scenario = 'S:R1' } = {}) {
  assert.equal(r.takeover?.reason, reason);
  assert.equal(r.proposedBy, 'b5');
  const tk = events.log.filter((e) => e.type === 'TAKEOVER');
  assert.deepEqual(tk.map((e) => e.payload.reason), [reason], 'one TAKEOVER event');
  assert.ok(steps.some((s) => s.by === 'b5'), 'B5 continued through the tool layer (recorded Steps)');
  if (scenario) assert.equal(r.outcome.scenarioId, scenario);
  const firstB5 = events.log.findIndex((e) => e.type === 'TOOL_CALL' && e.payload.by === 'b5');
  assert.ok(firstB5 > events.log.indexOf(tk[0]), 'the takeover is announced before B5 acts');
}

test('6. provider failure (HTTP 503) → llm_error → B5 over MCP', async () => {
  await reset(db);
  const out = await mcpPhase('red', createRedAgent(providerLLM(async () => ({ ok: false, status: 503, text: async () => 'unavailable' }))));
  assertTakeover(out, REASONS.ERROR);
  assert.equal(out.r.transport, 'mcp');
});

test('7. provider stall → turn ceiling → B5', async () => {
  await reset(db);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const out = await mcpPhase('red', createRedAgent(providerLLM(hang, 500)), { ceilingMs: 50 });
  assertTakeover(out, REASONS.TIMEOUT);
});

test('8. malformed tool calls (unparseable arguments, twice) → consecutive_rejects → B5', async () => {
  await reset(db);
  const out = await mcpPhase('red', createRedAgent(providerLLM(async () => providerReply({ tool_calls: [toolCall('simulate', '{"fault_ids": [')] }))));
  assertTakeover(out, REASONS.REJECTS);
  assert.equal(out.r.takeover.turn, 2);
});

test('9. MCP server unavailable at startup → in-process fallback on the agent identity → mcp_unavailable → B5', async () => {
  await reset(db);
  const out = await mcpPhase('red', createRedAgent(createScriptedRedModel()), {
    toolboxFactory: () => createMcpToolbox({ role: 'red', command: 'argus-no-such-mcp-binary' }) });
  assertTakeover(out, REASONS.MCP_UNAVAILABLE);
  assert.equal(out.r.transport, 'in-process');
  const fo = out.events.log.filter((e) => e.type === 'TOOL_TRANSPORT_FAILOVER');
  assert.deepEqual(fo.map((e) => [e.payload.tool, e.payload.to]), [[null, 'in-process']]);
});

test('10. unauthorized tool → recorded rejected Step; the LLM keeps control when it recovers', async () => {
  await reset(db);
  const out = await mcpPhase('red', scripted([
    { tool: 'fork_and_simulate', args: { intervention_ids: ['scale_out:ledger-db'] } },
    { tool: 'simulate', args: { fault_ids: ['degrade:ledger-db'] } },
    { tool: 'commit', args: { fault_ids: ['degrade:ledger-db'], evidence_path: ['gateway', 'checkout', 'payments', 'ledger-db'] } }]));
  assert.deepEqual([out.r.proposedBy, out.r.takeover], ['llm', null]);
  assert.deepEqual(out.steps.map((s) => [s.tool, s.ok, s.by]), [['fork_and_simulate', false, 'llm'], ['simulate', true, 'llm'], ['commit', true, 'llm']]);
  assert.match(out.steps[0].summary, /not available to role 'red'/);
  assert.equal((await readRound(db)).fork_budget, 6, 'nothing was charged for the refused call');
});

test('11. database/tool infrastructure failure mid-phase → failover + tool_failure → B5', async () => {
  await reset(db);
  // a transport whose second call fails at the infrastructure level (e.g. the tool server lost its DB connection)
  const flaky = async () => {
    const inner = await boxes.toolboxes.red({});
    let n = 0;
    return { transport: 'mcp', ctx: inner.ctx, async invoke(...a) { if (++n === 2) throw new ToolInfraError('ECONNRESET talking to FalkorDB'); return inner.invoke(...a); } };
  };
  const out = await mcpPhase('red', createRedAgent(createScriptedRedModel()), { toolboxFactory: flaky });
  assertTakeover(out, REASONS.TOOL_FAILURE);
  const fo = out.events.log.filter((e) => e.type === 'TOOL_TRANSPORT_FAILOVER');
  assert.equal(fo.length, 1);
  assert.match(fo[0].payload.error, /ECONNRESET/);
  assert.equal(out.r.transport, 'in-process');
  // the failed call was retried on the fallback exactly once: its Step exists once and was charged once
  const failedTool = fo[0].payload.tool;
  assert.equal(out.steps.filter((s) => s.by === 'llm' && s.tool === failedTool).length, 1);
});

test('12. exhausted simulation budget → budget_exhausted → B5 on the visible reserve', async () => {
  await reset(db);
  await rows(db, 'twin', `MATCH (r:Round {n:1}) SET r.sim_budget = 1`);
  const out = await mcpPhase('red', scripted([
    { tool: 'simulate', args: { fault_ids: ['degrade:auth'] } }, { tool: 'simulate', args: { fault_ids: ['degrade:orders'] } }]));
  assertTakeover(out, REASONS.BUDGET);
  const rr = await readRound(db);
  assert.equal(rr.sim_budget, 0);
  assert.ok(rr.autopilot_reserve < 3);
});

test('13. RED no-progress (4 simulations without a qualifying attack) → B5', async () => {
  await reset(db);
  const wander = ['degrade:payments', 'degrade:auth', 'degrade:orders', 'degrade:inventory'].map((f) => ({ tool: 'simulate', args: { fault_ids: [f] } }));
  const out = await mcpPhase('red', scripted(wander));
  assertTakeover(out, REASONS.NO_PROGRESS);
  assert.equal(out.r.takeover.turn, 4);
});

test('14. BLUE no-progress (4 futures without a green one) → B5 → a valid M5 decision', async () => {
  await reset(db);
  const red = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const round = await readRound(db);
  const world = await World.open(db);
  world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: await scenarioFaults(db, red.outcome.scenarioId) });
  world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  const ctx = { scenarioId: red.outcome.scenarioId, futureMode: 'reactive', snapshotId };
  await setBlueContext(db, ctx);
  const futures = [[], ['scale_out:payments'], ['scale_out:ledger-db'], ['retries_off:checkout>payments']];
  const out = await mcpPhase('blue', scripted(futures.map((ids) => ({ tool: 'fork_and_simulate', args: { intervention_ids: ids } }))), { ctx });
  assertTakeover(out, REASONS.NO_PROGRESS, { scenario: null });
  const d = out.r.outcome.decision;
  assert.deepEqual([d.selected_future, d.proposed_by], [`fork:R1:${setKey(['retries_off:checkout>payments', 'retries_off:gateway>checkout'])}`, 'b5']);
  assert.ok(out.steps.filter((s) => s.by === 'b5' && s.tool === 'fork_and_simulate').every((s) => !s.args.intervention_ids.length || s.summary), 'B5 forks recorded');
});
