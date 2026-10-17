// M9 — the one high-value end-to-end test (spec §2.1/§2.2). The complete canonical two-round run, with LLM agents
// (deterministic scripted models stand in for the provider — no API key) acting ONLY through the MCP tool servers
// on the restricted agent identity; WORLD driven by the real simulator against the real `world` graph; every event
// delivered over Socket.IO. Asserts the actual FalkorDB state, then resets and replays the saved cassette and
// requires an identical event log and identical final graphs. Requires `npm run db:up` (ACL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { io as ioClient } from 'socket.io-client';
import { connect, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readSteps } from '../graph/steps.js';
import { setKey } from '../graph/decision.js';
import { createEventBus } from '../runtime/events.js';
import { createWorldClock } from '../runtime/clock.js';
import { runCanonicalDemo } from '../runtime/demo.js';
import { createCassette } from '../runtime/runtime.js';
import { saveCassette, loadCassette } from '../runtime/cassette-file.js';
import { createRedAgent } from '../runtime/red.js';
import { createBlueAgent } from '../runtime/blue.js';
import { startEventServer } from '../app/server.js';
import { createScriptedRedModel } from './fixtures/red-model.js';
import { createScriptedBlueModel } from './fixtures/blue-model.js';
import { dumpGraph, dumpDiff, mcpToolboxes, raw } from './helpers.js';

let db, agentDb, boxes;
before(async () => { db = await connect(); agentDb = await connect({ as: 'agent' }); boxes = await mcpToolboxes(agentDb); });
after(async () => { await boxes.close(); await agentDb.close(); await reset(db); await db.close(); });

// Step.ms (tool latency) is the only wall-clock value anywhere in the graphs
const stable = (dump) => ({ nodes: dump.nodes.map((s) => s.replace(/\\"ms\\":[0-9.]+/g, '\\"ms\\":0')), rels: dump.rels });

async function canonicalRun(adapters, mode) {
  await reset(db);
  const world0 = await dumpGraph(db, 'world');
  const events = createEventBus();
  const server = await startEventServer({ bus: events, port: 0 });
  const client = ioClient(server.url, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => client.once('state', r));
  const received = [];
  client.on('event', (e) => received.push(e));
  try {
    const result = await runCanonicalDemo(db, { mode, adapters, events, clock: createWorldClock({ pacing: 'virtual' }), toolboxes: boxes.toolboxes });
    await new Promise((r) => { const iv = setInterval(() => { if (received.length === events.log.length) { clearInterval(iv); r(); } }, 5); });
    return { result, events, received, world0 };
  } finally {
    client.disconnect();
    await server.close();
  }
}

test('the complete canonical run over MCP produces the real WORLD outcome, and replays identically', { timeout: 900000 }, async () => {
  // ---------------------------------------------------------------- live (scripted LLM) run, recorded
  await raw(db, 'ACL', 'LOG', 'RESET');
  const rec = createCassette();
  const live = await canonicalRun({ red: rec.record(createRedAgent(createScriptedRedModel())), blue: rec.record(createBlueAgent(createScriptedBlueModel())) }, 'live');
  const { result, events, received } = live;

  // agents: all four phases LLM-driven, over MCP, no takeover
  assert.deepEqual(result.phases.map((p) => [p.role, p.round, p.proposedBy, p.takeover, p.transport]), [
    ['red', 1, 'llm', null, 'mcp'], ['blue', 1, 'llm', null, 'mcp'], ['red', 2, 'llm', null, 'mcp'], ['blue', 2, 'llm', null, 'mcp']]);
  assert.deepEqual(events.log.filter((e) => e.type === 'TAKEOVER' || e.type === 'TOOL_TRANSPORT_FAILOVER'), []);

  // Socket.IO delivered every event, in order, unchanged
  assert.deepEqual(received, events.log);
  const order = (t) => events.log.findIndex((e) => e.type === t);
  assert.ok(order('ROUND_STARTED') < order('RED_STARTED') && order('RED_STARTED') < order('SCENARIO_COMMITTED')
    && order('SCENARIO_COMMITTED') < order('WORLD_FAULT_INJECTED') && order('WORLD_FAULT_INJECTED') < order('WORLD_FAULT_REMOVED')
    && order('WORLD_FAULT_REMOVED') < order('SNAPSHOT_TAKEN') && order('SNAPSHOT_TAKEN') < order('BLUE_STARTED')
    && order('BLUE_STARTED') < order('DECISION_COMMITTED') && order('DECISION_COMMITTED') < order('HARDENING_APPLIED')
    && order('HARDENING_APPLIED') < order('WORLD_OBSERVATION') && order('WORLD_OBSERVATION') < order('CALIBRATION_UPDATED')
    && order('WORLD_DEPLOY_LANDED') > order('ROUND_COMPLETED') && order('DEMO_COMPLETED') === events.log.length - 1, 'canonical act order');
  const toolCalls = events.log.filter((e) => e.type === 'TOOL_CALL');
  const steps = await readSteps(db, {});
  assert.equal(toolCalls.length, steps.length, 'one TOOL_CALL event per recorded Step');
  assert.ok(steps.every((s) => s.by === 'llm'));

  // ---------------------------------------------------------------- the actual FalkorDB state
  assert.deepEqual((await db.list()).sort(), ['twin', 'world'], 'no fork survives');
  const decisions = await roRows(db, 'twin', `MATCH (d:Decision) RETURN d.id AS id, d.selected_future AS f, d.proposed_by AS by, d.applied AS applied, d.hardening_pr AS pr ORDER BY id`);
  assert.deepEqual(decisions.map((d) => [d.id, d.f, d.by, d.applied]), [
    ['D:R1', `fork:R1:${setKey(['retries_off:checkout>payments', 'retries_off:gateway>checkout'])}`, 'llm', true],
    ['D:R2', `fork:R2:${setKey(['scale_out:ledger-db'])}`, 'llm', true]]);
  for (const d of decisions) assert.equal(load(d.pr).decision, d.id);
  // WORLD (ground truth) holds both hardenings and the landed deploy
  const worldCalls = Object.fromEntries((await roRows(db, 'world', `MATCH (a:Service)-[c:CALLS]->(b:Service) RETURN a.name + '>' + b.name AS e, c.retries AS r`)).map((x) => [x.e, x.r]));
  assert.deepEqual([worldCalls['checkout>payments'], worldCalls['gateway>checkout'], worldCalls['orders>ledger-db']], [0, 0, 3]);
  assert.equal((await roRows(db, 'world', `MATCH (c:ChangeEvent {id:'CE-42'}) RETURN c.status AS s`))[0].s, 'landed');
  const ledger = await roRows(db, 'world', `MATCH (s:Service {name:'ledger-db'}) RETURN s.cap_mean AS c`);
  const ledgerTwin = await roRows(db, 'twin', `MATCH (s:Service {name:'ledger-db'}) RETURN s.cap_mean AS c`);
  assert.ok(ledger[0].c > 0 && ledger[0].c === ledgerTwin[0].c, 'scale_out applied identically to WORLD and TWIN');
  const wd = dumpDiff(live.world0, await dumpGraph(db, 'world'));
  assert.ok(wd.added.length > 0 && wd.removed.length > 0, 'WORLD differs from its initial state');
  // Observations from the real world traces, verifying the decisions; calibration from them
  const obs = await roRows(db, 'twin', `MATCH (o:Observation)-[:VERIFIES]->(d:Decision) RETURN o.id AS id, d.id AS d, o.observed_viol_ticks AS v, o.predicted_viol_ticks_p50 AS p ORDER BY id`);
  assert.deepEqual(obs.map((o) => [o.d, o.v]), [['D:R1', 3], ['D:R2', 0]]);
  assert.deepEqual(obs.map((o) => [o.d, o.v]), result.rounds.map((r) => [`D:R${r.round}`, r.observation.observed_viol_ticks]));
  const cal = await roRows(db, 'twin', `MATCH (o:Observation)-[c:CALIBRATED]->(s:Service) RETURN o.id AS o, s.name AS s, c.before AS b, c.after AS a, s.cap_mean AS now ORDER BY o, s`);
  const pay = cal.find((c) => c.s === 'payments');
  assert.deepEqual([pay.b, Math.round(pay.a * 100) / 100], [800, 708.85]);
  // the finale: safe within the error budget
  assert.equal(result.safe, true);
  assert.equal(result.finale.ticks, 90);
  assert.ok(result.finale.observed_viol_ticks <= result.finale.error_budget);
  const finaleTicks = events.log.filter((e) => e.type === 'WORLD_TICK' && e.payload.segment === 'FINALE');
  assert.equal(finaleTicks.length, 90);
  assert.equal(finaleTicks.filter((e) => e.payload.viol).length, result.finale.observed_viol_ticks, 'the verdict is the released world trace');
  // the boundary held for the whole run
  assert.deepEqual((await raw(db, 'ACL', 'LOG')).reply, [], 'no agent-side permission denial during the run');
  const twinLive = stable(await dumpGraph(db, 'twin'));
  const worldLive = await dumpGraph(db, 'world');

  // ---------------------------------------------------------------- replay from the saved cassette
  const path = join(mkdtempSync(join(tmpdir(), 'argus-e2e-')), 'run.json');
  saveCassette(path, rec, { source: 'm9 e2e (scripted models)' });
  const { cassette } = loadCassette(path);
  const replay = await canonicalRun({ red: cassette.player(), blue: cassette.player() }, 'replay');
  // identical event stream; the only permitted difference is the run's own mode label (live → replay)
  const asLive = (log) => JSON.parse(JSON.stringify(log).replaceAll('"mode":"replay"', '"mode":"live"'));
  assert.ok(JSON.stringify(replay.events.log).includes('"mode":"replay"'));
  assert.deepEqual(asLive(replay.events.log), events.log, 'identical event stream');
  assert.deepEqual(replay.result.phases, result.phases);
  assert.deepEqual(stable(await dumpGraph(db, 'twin')), twinLive, 'identical TWIN');
  assert.deepEqual(await dumpGraph(db, 'world'), worldLive, 'identical WORLD');
});
