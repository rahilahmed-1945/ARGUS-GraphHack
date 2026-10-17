// M11 — the interactive judge demo. The judge picks one validated graph configuration (a real FalkorDB write on TWIN
// and WORLD), the deterministic reference reasoning models run live over MCP against the changed graph (no LLM, no
// cassette), and the run pauses before round 2 until ATTACK AGAIN. Everything interactive travels on side channels;
// the canonical replay path is unchanged. Requires `npm run db:up` (ACL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { connect, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readSteps } from '../graph/steps.js';
import { startUiServer, JUDGE_CHOICES } from '../app/ui-server.js';
import { createEventBus } from '../runtime/events.js';
import { createWorldClock } from '../runtime/clock.js';
import { runCanonicalDemo } from '../runtime/demo.js';
import { createToolbox } from '../runtime/tools.js';
import { loadCassette } from '../runtime/cassette-file.js';
import { fileURLToPath } from 'node:url';
import { reduceAll } from '../ui/js/state.js';
import { storyModel, CHAINS, FINAL_LINE } from '../ui/js/story.js';

const CASSETTE = fileURLToPath(new URL('../cassettes/reference-scripted.json', import.meta.url));
let server, db, client;
const side = { judge: [], preview: [], trace: [], status: [] };

before(async () => {
  db = await connect();
  server = await startUiServer({ port: 0 });
  client = ioClient(server.url, { transports: ['websocket'], forceNew: true });
  for (const k of ['judge', 'preview', 'trace']) client.on(k, (m) => side[k].push(m));
  client.on('status', (m) => side.status.push(m.status));
  await new Promise((r) => client.once('hello', r));
});
after(async () => { client.disconnect(); await server.close(); await reset(db); await db.close(); });

const control = (msg) => new Promise((resolve) => client.emit('control', msg, resolve));
async function until(cond, ms = 300000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); }
}
const retries = async (g) => (await roRows(db, g, `MATCH (:Service {name:'gateway'})-[c:CALLS]->(:Service {name:'checkout'}) RETURN c.retries AS r`))[0].r;
// volatile timing, and the transport label (the direct comparison run uses the in-process tool layer, the server MCP)
const strip = (log) => JSON.parse(JSON.stringify(log, (k, v) => (k === 'ms' || k === 'transport' ? undefined : v)));
const ev = (log, type) => log.filter((e) => e.type === type);
const summary = (log) => ({
  scenarios: ev(log, 'SCENARIO_COMMITTED').map((e) => e.payload.scenario?.faults ?? e.payload.faults),
  decisions: ev(log, 'DECISION_COMMITTED').map((e) => e.payload.decision.selected_future),
  done: ev(log, 'DEMO_COMPLETED')[0]?.payload,
});
async function runInteractive(choice) {
  await control({ action: 'configure', choice });
  await control({ action: 'start', interactive: true });
  await until(() => ['awaiting', 'done', 'failed'].includes(server.info().status));
  return server.info();
}

test('1. canonical (non-interactive) through the UI server is unchanged: same events as the runtime run directly', async () => {
  await control({ action: 'start' });
  await until(() => ['done', 'failed'].includes(server.info().status));
  assert.equal(server.info().status, 'done', server.info().error);
  assert.equal(server.info().interactive, false);
  const viaServer = strip(server.log);
  // the same canonical run, called directly with the same cassette and the in-process tool layer
  await reset(db);
  const agentDb = await connect({ as: 'agent' });
  const replay = loadCassette(CASSETTE);
  const events = createEventBus();
  await runCanonicalDemo(db, { mode: 'replay', events, clock: createWorldClock({ pacing: 'virtual', events }),
    adapters: { red: replay.cassette.player(), blue: replay.cassette.player() },
    toolboxes: { red: async (ctx) => createToolbox(agentDb, ctx), blue: async (ctx) => createToolbox(agentDb, ctx) } });
  await agentDb.close();
  assert.equal(viaServer.length, 299);
  assert.deepEqual(viaServer, strip(events.log));
  assert.equal(summary(viaServer).done.safe, true);
});

test('2. whitelist only: an unknown configuration is refused and writes nothing', async () => {
  await control({ action: 'reset' });
  const n = side.judge.length;
  await control({ action: 'configure', choice: 'retries=99' });
  assert.equal(side.judge.length, n);
  assert.equal(await retries('twin'), 2);
  assert.equal(await retries('world'), 2);
  assert.deepEqual(JUDGE_CHOICES.map((c) => c.id), ['keep', 'off']);
});

test('3. configure "off" is a real write on TWIN and WORLD, reported with its Cypher and the amplification before/after', async () => {
  await control({ action: 'configure', choice: 'off' });
  assert.equal(await retries('twin'), 0);
  assert.equal(await retries('world'), 0);
  const j = side.judge.at(-1);
  assert.equal(j.choice, 'off');
  assert.equal(j.session, server.info().session);
  assert.deepEqual(j.edits.map((e) => [e.edge, e.before, e.after]), [['gateway>checkout', 2, 0]]);
  assert.match(j.edits[0].cypher, /SET c\.retries = 0/);
  assert.ok(j.amplification.before.length > 0, 'amplification paths exist before the edit');
  assert.equal(j.amplification.after.length, 0, 'retries off removes every amplification path');
  const p = side.preview.at(-1);
  assert.equal(p.graphs.twin.calls.find((c) => c.caller === 'gateway' && c.callee === 'checkout').retries, 0);
  // the action space follows the changed graph: the retry intervention on that edge is no longer offered
  assert.ok(!p.graphs.twin.interventions.some((i) => i.id === 'retries_off:gateway>checkout' && i.active));
});

test('4. the gate: the interactive run pauses before round 2 until ATTACK AGAIN; RED adapts to the judge\'s graph', async () => {
  const s = await runInteractive('off');
  assert.equal(s.status, 'awaiting', s.error);
  assert.equal(s.awaiting, 'attack-again');
  assert.equal(s.mode, 'interactive');
  const log = server.log;
  assert.equal(log.at(-1).type, 'ROUND_COMPLETED');
  assert.equal(ev(log, 'ROUND_STARTED').length, 1, 'round 2 has not started');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(server.log.length, log.length, 'nothing happens while awaiting');
  // RED round 1 adapted to the changed graph (probe): no amplification path → candidates → rank → query → simulate → commit
  const red1 = (await readSteps(db, { round: 1, role: 'red' })).map((st) => st.tool);
  assert.deepEqual(red1.slice(0, 4), ['amplification_paths', 'list_candidates', 'rank_nodes', 'query_graph']);
  const sc = (await roRows(db, 'twin', `MATCH (:Scenario {id:'S:R1'})-[:CONTAINS]->(f:Fault) RETURN collect(f.id) AS f`))[0].f;
  assert.deepEqual(sc, ['degrade:ledger-db']);
  const d1 = (await roRows(db, 'twin', `MATCH (d:Decision {id:'D:R1'}) RETURN d.selected_future AS f`))[0].f;
  assert.equal(d1, 'fork:R1:retries_off:checkout>payments', 'the verifier\'s cheaper fix');
});

test('5. ATTACK AGAIN: round 2 runs a different RED attack, BLUE verifies, the WORLD ends SAFE', async () => {
  await control({ action: 'attack-again' });
  await until(() => ['done', 'failed'].includes(server.info().status));
  assert.equal(server.info().status, 'done', server.info().error);
  const sm = summary(server.log);
  assert.equal(sm.done.safe, true);
  assert.equal(server.log.length, 289);   // the probe's 280 plus 9 CLOCK events (the server's clock reports on the bus)
  const sc2 = (await roRows(db, 'twin', `MATCH (:Scenario {id:'S:R2'})-[:CONTAINS]->(f:Fault) RETURN f.id AS f ORDER BY f`)).map((r) => r.f);
  assert.notDeepEqual(sc2, ['degrade:ledger-db'], 'a different attack in round 2');
  assert.ok(side.status.includes('awaiting'));
});

test('6. trace side channel: every TOOL_RESULT step carries exactly the Cypher stored on its Step', async () => {
  await until(() => side.trace.filter((t) => t.session === server.info().session).length === ev(server.log, 'TOOL_RESULT').filter((e) => e.payload.step).length, 10000);
  const traces = side.trace.filter((t) => t.session === server.info().session);
  assert.ok(traces.length > 10);
  const steps = new Map((await readSteps(db)).map((st) => [st.i, st.cypher]));
  for (const t of traces) assert.equal(t.cypher, steps.get(t.step));
  for (const t of traces) assert.equal(server.log.find((e) => e.seq === t.seq).payload.step, t.step);
});

test('7. the Control story over the real run: the causal chain, every value read from events and side channels', async () => {
  const log = server.log;
  const judge = side.judge.at(-1);
  const traces = new Map(side.trace.filter((t) => t.session === server.info().session).map((t) => [t.seq, t]));
  const atPause = log.findIndex((e) => e.type === 'ROUND_COMPLETED') + 1;
  const tell = (n, extra = {}) => storyModel(log.slice(0, n), reduceAll(log.slice(0, n)), { mode: 'control', judge, traces, ...extra });
  // walk the presented prefix the way the page does
  const frames = [];
  for (let n = 0; n <= log.length; n++) frames.push(tell(n, { awaiting: n === atPause }));
  const chapters = frames.map((m) => m.chapter).filter((c, i, a) => c !== a[i - 1]);
  assert.deepEqual(chapters, ['changed', 'red', 'real', 'blue', 'proven', 'hardened', 'again', 'red2', 'blue2', 'proven2', 'finale', 'safe']);
  const steps = frames.map((m) => m.chain[m.step]).filter((c, i, a) => c !== a[i - 1]);
  assert.deepEqual(steps, CHAINS.control, 'every link of the causal chain is reached, in order');
  // the judge's change, then RED adapting to it
  assert.match(frames[0].panel.graph, /now finds nothing/);
  assert.match(frames[0].panel.result, /retries 2 → 0/);
  const found = frames[log.findIndex((e) => e.type === 'SCENARIO_COMMITTED') + 1];
  assert.match(found.panel.why, /retry storm, is gone/);
  assert.match(found.panel.graph, /is the service everything depends on most/);
  // BLUE finds no fix; the verifier proves a cheaper one
  const verdict = frames[log.findIndex((e) => e.type === 'DECISION_AUDITED' && !e.payload.accepted) + 1];
  assert.match(verdict.panel.result, /BLUE said "I found no safe fix\." ARGUS rejected that answer/);
  const proven = frames[log.findIndex((e) => e.type === 'DECISION_COMMITTED') + 1];
  assert.match(proven.panel.now, /overruled BLUE/);
  assert.match(proven.panel.graph, /tested 89 other possible fixes/);
  assert.deepEqual(proven.whatif.cards.map((c) => [c.answer, c.chosen]), [['Still broken', false], ['Still broken', false], ['Works: found by ARGUS', true]]);
  // ATTACK AGAIN is offered only while the run is paused and the presentation has caught up
  assert.equal(frames[atPause].awaiting, true);
  assert.equal(tell(atPause).awaiting, false);
  assert.match(frames[atPause].panel.proves, /predicted 2 bad moments, observed 3/);
  // different reasoning, and the final sentence
  const found2 = frames[log.findIndex((e) => e.type === 'SCENARIO_COMMITTED' && e.round === 2) + 1];
  assert.equal(found2.panel.proves, 'ARGUS changed its attack because the graph changed.');
  const last = frames.at(-1);
  assert.deepEqual([last.final.safe, last.final.violated, last.final.ticks, last.final.line], [true, 0, 90, FINAL_LINE]);
  assert.deepEqual(last.final.columns.map((c) => c.k), ['YOUR CHANGE', 'ATTACK 1 → FIX 1', 'ATTACK 2 → FIX 2']);
  assert.match(last.final.columns[1].c, /\(one change\) · found by the verifier/);
  assert.notEqual(last.final.columns[1].a, last.final.columns[2].a);
  // evidence: plain sentences first; every tool step keeps its stored Cypher and timestamp behind ▸ query
  const ev = last.evidence;
  assert.match(ev[0].text, /^You changed the graph: .* retries 2 → 0/);
  assert.match(ev[0].tech.cypher, /SET c\.retries = 0/);
  const tools = ev.filter((r) => r.key.startsWith('s'));
  for (const r of tools) { const t = traces.get(r.seq); if (!t) continue; assert.equal(r.tech.cypher, t.cypher); assert.equal(r.tech.at, t.at); }
  assert.equal(ev.filter((r) => r.key.startsWith('f')).length, log.filter((e) => e.type === 'FUTURE_EVALUATION_COMPLETED').length, 'one line per tested fix');
  // no jargon in the primary story
  const JARGON = /\b(SLO|ticks?|M5|B5|audit|scope|forks?|cypher|sustained|verdict|amber|proven-in-scope|calibrat\w*|snapshot|counterfactual|scenario|WORLD)\b/;
  for (const m of frames) for (const v of [...Object.values(m.panel), m.title, m.speech?.text ?? '', ...(m.whatif?.cards ?? []).flatMap((c) => [c.question, c.answer, c.detail])]) {
    assert.ok(!JARGON.test(v), `${m.chapter}: "${v}"`);
  }
});

test('8. "keep" also reaches SAFE through the gate, matching the canonical decisions', async () => {
  await control({ action: 'configure', choice: 'keep' });
  assert.equal(await retries('twin'), 2);
  await control({ action: 'start', interactive: true });
  await until(() => ['awaiting', 'done', 'failed'].includes(server.info().status));
  assert.equal(server.info().status, 'awaiting', server.info().error);
  await control({ action: 'attack-again' });
  await until(() => ['done', 'failed'].includes(server.info().status));
  assert.equal(server.info().status, 'done', server.info().error);
  const sm = summary(server.log);
  assert.equal(sm.done.safe, true);
  assert.equal(server.log.length, 299);   // the probe's 290 plus 9 CLOCK events
  assert.deepEqual(sm.decisions, ['fork:R1:retries_off:checkout>payments+retries_off:gateway>checkout', 'fork:R2:scale_out:ledger-db']);
  await control({ action: 'reset' });
  assert.equal(server.info().interactive, false);
  assert.equal(await retries('twin'), 2);
});
