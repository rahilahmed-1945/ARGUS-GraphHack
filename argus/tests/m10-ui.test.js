// M10 — the command-center UI is a view of the real runtime. These tests run the canonical demo through the UI
// server (real runtime, MCP tool servers, FalkorDB; replay cassette — no LLM), receive it over Socket.IO exactly as
// the browser does, and check that every displayed value is derived from those events and matches FalkorDB.
// Requires `npm run db:up` (ACL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { connect, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { loadTopology } from '../graph/topology.js';
import { startUiServer } from '../app/ui-server.js';
import { initialState, applyEvent, reduceAll, edgeKey } from '../ui/js/state.js';
import { createPlayback, dwellFor } from '../ui/js/playback.js';
import { raw } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let server, db, client;
const received = [];
const sessions = [];

before(async () => {
  db = await connect();
  server = await startUiServer({ port: 0 });
  client = ioClient(server.url, { transports: ['websocket'], forceNew: true });
  client.on('log', ({ session }) => sessions.push(session));
  client.on('event', ({ session, ev }) => { if (session === server.info().session) received.push(ev); });
  await new Promise((r) => client.once('hello', r));
});
after(async () => { client.disconnect(); await server.close(); await reset(db); await db.close(); });

const control = (action) => new Promise((resolve) => client.emit('control', { action }, resolve));
async function until(cond, ms = 300000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); }
}

test('1. Run: the UI server executes the real canonical demo and streams every event, in order, to the browser', async () => {
  assert.equal(server.info().status, 'ready');
  await control('start');
  await until(() => server.info().status === 'done' || server.info().status === 'failed');
  assert.equal(server.info().status, 'done', server.info().error);
  await until(() => received.length === server.log.length);
  assert.deepEqual(received, server.log, 'the browser received exactly the runtime\'s event log');
  assert.deepEqual(received.map((e) => e.seq), received.map((_, i) => i + 1));
  assert.equal(received.at(-1).type, 'DEMO_COMPLETED');
  // the run is real: FalkorDB holds the records the events describe
  const decisions = await roRows(db, 'twin', `MATCH (d:Decision) RETURN d.id AS id, d.selected_future AS f ORDER BY id`);
  const committed = received.filter((e) => e.type === 'DECISION_COMMITTED').map((e) => [e.payload.decision.id, e.payload.decision.selected_future]);
  assert.deepEqual(decisions.map((d) => [d.id, d.f]), committed);
});

test('2. the view state is derived from the events and agrees with FalkorDB (no value originates in the UI)', async () => {
  const s = reduceAll(received);
  const ev = (type, pred = () => true) => received.filter((e) => e.type === type && pred(e));
  // final verdict = DEMO_COMPLETED payload
  const done = ev('DEMO_COMPLETED')[0].payload;
  assert.deepEqual([s.result.safe, s.result.observed_viol_ticks, s.result.ticks, s.result.error_budget], [done.safe, done.finale.observed_viol_ticks, done.finale.ticks, done.finale.error_budget]);
  assert.equal(s.status.key, done.safe ? 'safe' : 'unsafe');
  // topology = the latest graph snapshot event, and = FalkorDB TWIN now
  const twinCalls = await roRows(db, 'twin', `MATCH (a:Service)-[c:CALLS]->(b:Service) RETURN a.name AS a, b.name AS b, c.retries AS r`);
  assert.deepEqual(Object.fromEntries(Object.values(s.edges).map((e) => [e.key, e.retries])), Object.fromEntries(twinCalls.map((c) => [edgeKey(c.a, c.b), c.r])));
  const twinCaps = await roRows(db, 'twin', `MATCH (s:Service) RETURN s.name AS n, s.cap_mean AS c`);
  assert.deepEqual(Object.fromEntries(Object.values(s.nodes).map((n) => [n.name, n.cap])), Object.fromEntries(twinCaps.map((r) => [r.n, r.c])));
  // hardening marks = the PR's measured diffs; the landed deploy = WORLD_DEPLOY_LANDED
  const hardenedEdges = ev('HARDENING_APPLIED').flatMap((e) => e.payload.changes.twin.filter((c) => c.edge).map((c) => c.edge)).sort();
  const landed = ev('WORLD_DEPLOY_LANDED').map((e) => e.payload.edge);
  assert.deepEqual(Object.values(s.edges).filter((e) => e.change === 'hardened').map((e) => e.key).sort(), hardenedEdges.filter((k) => !landed.includes(k)));
  assert.deepEqual(Object.values(s.edges).filter((e) => e.change === 'landed').map((e) => e.key), landed);
  const scaled = ev('HARDENING_APPLIED').flatMap((e) => e.payload.changes.twin.filter((c) => c.service).map((c) => c.service));
  assert.deepEqual(Object.values(s.nodes).filter((n) => n.hardened).map((n) => n.name).sort(), [...new Set(scaled)].sort());
  // per-round story: attack evidence = RED's commit arguments; decision = DECISION_COMMITTED; observation = WORLD_OBSERVATION
  for (const r of [1, 2]) {
    const redCommit = ev('TOOL_CALL', (e) => e.round === r && e.payload.role === 'red' && e.payload.tool === 'commit').at(-1).payload.args;
    assert.deepEqual(s.rounds[r].scenario.evidence, redCommit.evidence_path);
    assert.deepEqual(s.rounds[r].scenario.faults, ev('SCENARIO_COMMITTED', (e) => e.round === r)[0].payload.fault_ids);
    const d = ev('DECISION_COMMITTED', (e) => e.round === r)[0].payload.decision;
    assert.deepEqual(s.rounds[r].decision, { id: d.id, selected: d.selected_future, interventions: d.selects });
    const o = ev('WORLD_OBSERVATION', (e) => e.round === r)[0].payload;
    assert.deepEqual([s.rounds[r].observation.predicted, s.rounds[r].observation.observed], [o.predicted_viol_ticks_p50, o.observed_viol_ticks]);
    const dbObs = await roRows(db, 'twin', `MATCH (o:Observation {id:$id}) RETURN o.observed_viol_ticks AS v`, { id: o.id });
    assert.equal(dbObs[0].v, s.rounds[r].observation.observed, 'the observed value shown is the one FalkorDB recorded');
  }
  // every activity row comes from a TOOL_RESULT (or a server/world event), never invented
  const toolRows = s.activity.filter((a) => a.tool && !['audit', 'deploy', 'takeover', 'transport'].includes(a.tool));
  assert.ok(toolRows.every((a) => received.some((e) => e.seq === a.seq && e.type === 'TOOL_RESULT' && e.payload.tool === a.tool)));
  // the calibration shown = CALIBRATION_UPDATED, and the WORLD truth beside it = the WORLD graph snapshot
  const cal = ev('CALIBRATION_UPDATED')[0].payload;
  assert.deepEqual([s.calibration[0].service, s.calibration[0].before, s.calibration[0].after], [cal.service, cal.before, cal.after]);
  const worldCap = (await roRows(db, 'world', `MATCH (x:Service {name:$n}) RETURN x.cap_mean AS c`, { n: cal.service }))[0].c;
  assert.equal(s.worldGraph.services.find((x) => x.name === cal.service).cap_mean, worldCap);
});

test('3. the futures tree is exactly the evaluated futures, with the runtime\'s verdicts', () => {
  // replay up to each BLUE commit and compare the tree with the FUTURE_EVALUATION_COMPLETED events of that phase
  for (const r of [1, 2]) {
    const cut = received.findIndex((e) => e.type === 'DECISION_COMMITTED' && e.round === r);
    const s = reduceAll(received.slice(0, cut + 1));
    const done = received.slice(0, cut + 1).filter((e) => e.type === 'FUTURE_EVALUATION_COMPLETED' && e.round === r);
    assert.deepEqual(s.futures.items.map((f) => f.futureId), done.map((e) => e.payload.future_id));
    assert.deepEqual(s.futures.items.map((f) => f.metric.verdict), done.map((e) => e.payload.verdict));
    const selected = received[cut].payload.decision.selected_future;
    assert.deepEqual(s.futures.items.filter((f) => f.selected).map((f) => f.futureId), [selected]);
  }
  // RED's attack futures: one per simulated fault set, qualifying exactly when the runtime emitted ATTACK_DISCOVERED
  const cut = received.findIndex((e) => e.type === 'SCENARIO_COMMITTED');
  const s = reduceAll(received.slice(0, cut + 1));
  const discovered = received.slice(0, cut + 1).filter((e) => e.type === 'ATTACK_DISCOVERED').map((e) => [...e.payload.fault_ids].sort().join('+'));
  assert.deepEqual(s.futures.items.filter((f) => f.state === 'qualify').map((f) => f.key), discovered);
});

test('4. playback only paces: it applies every event once, in order, unchanged; seek equals playing', async () => {
  const applied = [];
  const pb = createPlayback({ apply: (e) => applied.push(e) });
  pb.load(received.slice(0, 20));
  pb.setSpeed(1e6);
  pb.play();
  for (const e of received.slice(20)) pb.push(e);
  pb.push(received[5]);                                // a duplicate/stale event is ignored, never re-applied
  await until(() => applied.length === received.length, 60000);
  assert.deepEqual(applied, received);
  const seeked = [];
  const pb2 = createPlayback({ apply: (e) => seeked.push(e) });
  pb2.load(received);
  pb2.seek(123);
  assert.deepEqual(seeked, received.slice(0, 123));
  assert.ok(received.every((e) => dwellFor(e) >= 0));
  // the reducer is pure and deterministic: the same events give the same view
  assert.deepEqual(JSON.parse(JSON.stringify(reduceAll(received))), JSON.parse(JSON.stringify(reduceAll(structuredClone(received)))));
  const s = initialState();
  for (const e of received) applyEvent(s, e);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(reduceAll(received))));
});

test('5. Reset: FalkorDB is reset and a new, empty session starts; Run again replays the whole canonical run', async () => {
  const before = server.info().session;
  await control('reset');
  await until(() => server.info().session === before + 1 && server.info().status === 'ready');
  assert.equal(server.log.length, 0);
  assert.ok(sessions.includes(before + 1), 'the browser was told about the new session');
  assert.deepEqual((await db.list()).sort(), ['twin', 'world']);
  assert.equal((await roRows(db, 'twin', `MATCH (d:Decision) RETURN count(d) AS n`))[0].n, 0, 'records from the previous run are gone');
  received.length = 0;
  await control('start');
  await until(() => server.info().status === 'done');
  await until(() => received.length === server.log.length && received.length > 0);
  assert.equal(received.at(-1).type, 'DEMO_COMPLETED');
  assert.equal(reduceAll(received).result.safe, true);
});

test('6. static serving: the UI, its modules and three.js are served; nothing outside them is', async () => {
  const get = (p) => fetch(`${server.url}${p}`);
  assert.equal((await get('/')).status, 200);
  assert.match(await (await get('/')).text(), /<title>ARGUS Command Center<\/title>/);
  for (const p of ['/js/main.js', '/js/state.js', '/styles.css', '/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/renderers/CSS2DRenderer.js', '/socket.io/socket.io.esm.min.js']) {
    assert.equal((await get(p)).status, 200, p);
  }
  for (const p of ['/../package.json', '/%2e%2e/.env', '/vendor/three/../../.env', '/vendor/three/%2e%2e%2f%2e%2e%2f.env']) {
    assert.equal((await get(p)).status, 404, p);
  }
  const state = await (await get('/state')).json();
  assert.equal(state.mode, 'replay');
  assert.ok(!JSON.stringify(state).includes(process.env.ARGUS_AGENT_PASSWORD ?? '\u0000'), 'no secret in /state');
});

test('7. no fake data: the UI source names no service, fault, intervention, change event or decision', async () => {
  const topo = loadTopology();
  const names = topo.services.map((s) => s.name);
  // every action-space id the graph actually holds (faults/interventions are generated from templates)
  const ids = (await roRows(db, 'twin', `MATCH (x) WHERE x:Fault OR x:Intervention RETURN x.id AS id`)).map((r) => r.id);
  const ces = (await roRows(db, 'twin', `MATCH (c:ChangeEvent) RETURN c.id AS id`)).map((r) => r.id);
  assert.ok(ids.length > 20 && ces.length > 0);
  const files = [...readdirSync(`${ROOT}ui/js`).map((f) => `ui/js/${f}`), 'ui/index.html', 'ui/styles.css'];
  for (const file of files) {
    const code = readFileSync(`${ROOT}${file}`, 'utf8');
    for (const n of names) assert.ok(!new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(code), `${file} names service ${n}`);
    for (const id of [...ids, ...ces]) assert.ok(!code.includes(id), `${file} names ${id}`);
    assert.ok(!/\b[SDO]:R\d\b|fork:R\d/.test(code), `${file} names a scenario/decision/observation/future id`);
  }
});

test('8. a failed reset is reported and acknowledged (socket and operator paths); the next reset recovers', async () => {
  const before = server.info();
  const bounded = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no acknowledgement within ${ms} ms`)), ms))]);
  // force reset() to fail: a non-graph value under the key `twin` makes the seed's first GRAPH.QUERY on it fail
  assert.equal((await raw(db, 'SET', 'twin', 'not-a-graph')).ok, true);
  try {
    const ack = await bounded(control('reset'), 15000);           // the browser's Reset: answered, with the error
    const dbError = /wrong Redis type|WRONGTYPE|Invalid graph operation/;   // FalkorDB's wording for a non-graph key
    assert.match(ack.error ?? '', dbError, 'the acknowledgement carries the database error');
    assert.deepEqual([ack.status, ack.session], [before.status, before.session], 'status and session are unchanged');
    const info = await bounded(server.control('reset'), 15000);   // the operator API: resolves, with the same error
    assert.match(info.error ?? '', dbError);
    assert.equal(info.session, before.session);
  } finally {
    await raw(db, 'DEL', 'twin');
  }
  // the lifecycle queue is intact: the next reset succeeds, opens a new session and restores both graphs
  await bounded(control('reset'), 60000);
  await until(() => server.info().status === 'ready' && server.info().session === before.session + 1);
  assert.equal(server.info().error, null);
  assert.deepEqual((await db.list()).sort(), ['twin', 'world']);
});
