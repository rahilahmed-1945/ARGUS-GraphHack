// M12 — live mode in the command-center UI server, offline. The REAL provider (runtime/providers/openrouter.js) is
// handed the offline mock OpenRouter endpoint (tests/ai/mock-openrouter.js) answered by the deterministic reference
// models, so every agent turn travels provider → adapter → MCP → toolbox → FalkorDB exactly as a live run, with no
// network and no key beyond a test string. Checks: the session is labelled live with model and ceiling; provenance
// (llm vs b5 per phase, takeover reasons) is reported and recorded; a reply that arrives after the ceiling is never
// recorded as a decision the run used, and a replay of that cassette takes over at the same turn; configuration
// errors fail clearly; the judge configuration and the interactive start are refused in live mode; no secret leaks.
// Requires `npm run db:up` (ACL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { connect, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readSteps } from '../graph/steps.js';
import { startUiServer } from '../app/ui-server.js';
import { createOpenRouterLLM, ProviderConfigError } from '../runtime/providers/openrouter.js';
import { REASONS, runPhase } from '../runtime/runtime.js';
import { loadCassette, phaseSummary } from '../runtime/cassette-file.js';
import { createScriptedRedModel } from './fixtures/red-model.js';
import { createScriptedBlueModel } from './fixtures/blue-model.js';
import { createMockOpenRouter, MOCK_BASE_URL, MOCK_MODEL } from './ai/mock-openrouter.js';

const SECRET = 'offline-test-key-SECRET-7f3a9c';
const TMP = mkdtempSync(join(tmpdir(), 'argus-m12-'));
// any real network use fails the suite
const network = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { network.push(String(url)); throw new Error(`network disabled in offline tests: ${url}`); };

let db;
before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); globalThis.fetch = realFetch; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (log, type) => log.filter((e) => e.type === type);
const offlineLLM = (mock, extra = {}) => createOpenRouterLLM({ apiKey: SECRET, model: MOCK_MODEL, baseUrl: MOCK_BASE_URL, fetch: mock.fetch, ...extra });
const retries = async (g) => (await roRows(db, g, `MATCH (:Service {name:'gateway'})-[c:CALLS]->(:Service {name:'checkout'}) RETURN c.retries AS r`))[0].r;

// a live-mode server plus a browser-like client that keeps every payload it receives
async function liveServer(mock, { ceilingMs, recordPath, llm = {} } = {}) {
  const server = await startUiServer({ mode: 'live', llm: offlineLLM(mock, llm), port: 0, ...(ceilingMs ? { ceilingMs } : {}), recordPath });
  const client = ioClient(server.url, { transports: ['websocket'], forceNew: true });
  const payloads = [];
  for (const k of ['hello', 'status', 'log', 'event', 'preview', 'judge', 'trace']) client.on(k, (m) => payloads.push({ k, m }));
  await new Promise((r) => client.once('hello', r));
  const control = (msg) => new Promise((resolve) => client.emit('control', msg, resolve));
  const until = async (cond, ms = 300000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
  const finished = () => until(() => ['done', 'failed'].includes(server.info().status));
  return { server, client, payloads, control, until, finished, async close() { client.disconnect(); await server.close(); } };
}

test('1. live mode, every phase decided by the provider: labelled live (model, ceiling), llm provenance per phase, cassette with provenance, no network, no secret', async () => {
  const mock = createMockOpenRouter({ models: { red: createScriptedRedModel(), blue: createScriptedBlueModel() } });
  const path = join(TMP, 'all-llm.json');
  const s = await liveServer(mock, { ceilingMs: 20000, recordPath: path });
  try {
    const hello = s.payloads.find((p) => p.k === 'hello').m;
    assert.deepEqual([hello.mode, hello.live, hello.model, hello.ceilingMs, hello.interactive, hello.phases, hello.cassette], ['live', true, MOCK_MODEL, 20000, false, null, null]);
    assert.equal(hello.source, `live LLM · openrouter · ${MOCK_MODEL} · turn ceiling 20000 ms`);
    await s.control({ action: 'start' });
    await s.finished();
    assert.equal(s.server.info().status, 'done', s.server.info().error);
    const log = s.server.log;
    // one provider request per agent turn, all to the (mock) endpoint with the configured model
    assert.ok(mock.requests.length >= 4);
    assert.ok(mock.requests.every((r) => r.url === `${MOCK_BASE_URL}/chat/completions` && r.body.model === MOCK_MODEL));
    assert.deepEqual(ev(log, 'TAKEOVER'), []);
    const steps = ev(log, 'TOOL_RESULT');
    assert.ok(steps.length > 0 && steps.every((e) => e.payload.by === 'llm'), 'every tool call was the model\'s');
    const done = ev(log, 'DEMO_COMPLETED')[0].payload;
    assert.deepEqual(done.phases.map((p) => [p.role, p.round, p.proposedBy, p.takeover]),
      [['red', 1, 'llm', null], ['blue', 1, 'llm', null], ['red', 2, 'llm', null], ['blue', 2, 'llm', null]]);
    assert.equal(done.safe, true);
    // the session reports the phases and the cassette once the run is done (hello/status payloads carry them)
    const info = s.server.info();
    assert.deepEqual(info.phases, done.phases);
    assert.equal(info.cassette, path);
    assert.equal(phaseSummary(info.phases), 'R1 RED llm · R1 BLUE llm · R2 RED llm · R2 BLUE llm');
    await s.until(() => s.payloads.some((p) => p.k === 'status' && p.m.status === 'done'));   // socket delivery is asynchronous
    const lastStatus = s.payloads.filter((p) => p.k === 'status').at(-1).m;
    assert.deepEqual([lastStatus.status, lastStatus.phases.map((p) => p.proposedBy)], ['done', ['llm', 'llm', 'llm', 'llm']]);
    // the graph agrees with the events
    assert.ok((await readSteps(db, {})).every((st) => st.by === 'llm'));
    // the cassette: labelled live, phases recorded, no late decisions, one entry per provider request, loadable
    const file = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual([file.source, file.provenance.live, file.provenance.provider, file.provenance.model, file.provenance.ceiling_ms, file.provenance.late_decisions],
      ['live OpenRouter run (UI)', true, 'openrouter', MOCK_MODEL, 20000, 0]);
    assert.deepEqual(file.provenance.phases.map((p) => p.proposedBy), ['llm', 'llm', 'llm', 'llm']);
    assert.equal(Object.keys(file.entries).length, mock.requests.length);
    assert.equal(loadCassette(path).provenance.live, true);
    // boundary: nothing reached the network; the key went only to the provider, and appears nowhere the browser or a file can see
    assert.deepEqual(network, []);
    assert.ok(mock.requests.every((r) => r.headers.Authorization === `Bearer ${SECRET}`));
    const visible = JSON.stringify([s.payloads, s.server.info(), log, file]);
    assert.ok(!visible.includes(SECRET), 'no secret in any socket payload, status, event or cassette');
  } finally { await s.close(); }
});

test('2. a reply after the ceiling: B5 takes over, the phase is labelled b5 with its reason, the late reply is counted but never recorded, and a replay misses at that turn', async () => {
  // RED round 1, its third turn (turn index 2: the second simulate, after [amplification_paths ∥ list_candidates] and
  // simulate(degrade:payments)) answers 600 ms late; every other turn is prompt
  const isLateTurn = (req) => req.role === 'red' && req.turn === 2 && req.messages[0]?.content.startsWith('Round 1.');
  const mock = createMockOpenRouter({ models: { red: createScriptedRedModel(), blue: createScriptedBlueModel() },
    intercept: async (req) => { if (isLateTurn(req)) await sleep(600); } });
  const path = join(TMP, 'one-late.json');
  const s = await liveServer(mock, { ceilingMs: 250, recordPath: path });
  try {
    await s.control({ action: 'start' });
    await s.finished();
    assert.equal(s.server.info().status, 'done', s.server.info().error);
    await sleep(700);                                             // let the late reply arrive (it must change nothing)
    const log = s.server.log;
    const takeovers = ev(log, 'TAKEOVER').map((e) => [e.round, e.payload.role, e.payload.reason, e.payload.turn]);
    assert.deepEqual(takeovers, [[1, 'red', REASONS.TIMEOUT, 2]]);
    const done = ev(log, 'DEMO_COMPLETED')[0].payload;
    assert.deepEqual(done.phases.map((p) => [p.role, p.round, p.proposedBy, p.takeover?.reason ?? null]),
      [['red', 1, 'b5', REASONS.TIMEOUT], ['blue', 1, 'llm', null], ['red', 2, 'llm', null], ['blue', 2, 'llm', null]]);
    assert.equal(phaseSummary(s.server.info().phases), `R1 RED b5 (${REASONS.TIMEOUT}) · R1 BLUE llm · R2 RED llm · R2 BLUE llm`);
    // the model's two prompt turns (three tool calls) ran as llm; everything after the cut in that phase is b5
    const red1 = (await readSteps(db, { round: 1, role: 'red' }));
    assert.deepEqual(red1.slice(0, 3).map((st) => [st.by, st.tool]), [['llm', 'amplification_paths'], ['llm', 'list_candidates'], ['llm', 'simulate']]);
    assert.ok(red1.slice(3).every((st) => st.by === 'b5'));
    assert.ok(red1.some((st) => st.by === 'b5' && st.tool === 'commit'), 'B5 committed the attack');
    // the UI still says live; the source line never claims the phase was the model's
    assert.deepEqual([s.server.info().mode, s.server.info().live], ['live', true]);
    // the cassette: the late reply is counted and excluded; entries = requests − 1
    const file = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(file.provenance.late_decisions, 1);
    assert.equal(Object.keys(file.entries).length, mock.requests.length - 1);
    assert.deepEqual(file.provenance.phases.map((p) => p.proposedBy), ['b5', 'llm', 'llm', 'llm']);
    assert.deepEqual(network, []);
  } finally { await s.close(); }
  // replaying that cassette cannot use the late reply: the player misses at the cut turn and B5 takes over there too
  await reset(db);
  const { cassette, provenance } = loadCassette(path);
  assert.equal(provenance.late_decisions, 1);
  const replay = await runPhase(db, { role: 'red', mode: 'replay', adapter: cassette.player() });
  assert.deepEqual([replay.proposedBy, replay.takeover.reason, replay.takeover.turn, replay.outcome.scenarioId], ['b5', REASONS.MISS, 2, 'S:R1']);
  assert.deepEqual(replay.history.map((h) => h.tool), ['amplification_paths', 'list_candidates', 'simulate'], 'the two used turns replayed, the late one did not');
});

test('3. a replay of that live cassette through the UI server is labelled as a cassette with its phases and the excluded late reply, and takes over where the live run did', async () => {
  const path = join(TMP, 'one-late.json');
  const server = await startUiServer({ mode: 'replay', cassettePath: path, port: 0 });
  try {
    const info = server.info();
    assert.deepEqual([info.mode, info.live, info.model], ['replay', false, null]);
    assert.equal(info.source, `cassette · live OpenRouter run (UI) · R1 RED b5 (${REASONS.TIMEOUT}) · R1 BLUE llm · R2 RED llm · R2 BLUE llm · 1 late decision(s) excluded`);
    await server.control('start');
    const t0 = Date.now();
    while (!['done', 'failed'].includes(server.info().status)) { if (Date.now() - t0 > 300000) throw new Error('timeout'); await sleep(50); }
    assert.equal(server.info().status, 'done', server.info().error);
    const takeovers = ev(server.log, 'TAKEOVER').map((e) => [e.round, e.payload.role, e.payload.reason]);
    assert.deepEqual(takeovers, [[1, 'red', REASONS.MISS]]);
    assert.deepEqual(ev(server.log, 'DEMO_COMPLETED')[0].payload.phases.map((p) => p.proposedBy), ['b5', 'llm', 'llm', 'llm']);
    assert.deepEqual(network, []);
  } finally { await server.close(); }
});

test('4. configuration: live mode without a key or model fails with ProviderConfigError before any run; a bad ceiling or mode is refused', async () => {
  await assert.rejects(startUiServer({ mode: 'live', env: {}, port: 0 }), ProviderConfigError);
  await assert.rejects(startUiServer({ mode: 'live', env: { OPENROUTER_API_KEY: 'k' }, port: 0 }), ProviderConfigError);
  await assert.rejects(startUiServer({ mode: 'live', llm: offlineLLM(createMockOpenRouter()), ceilingMs: 0, port: 0 }), /ceilingMs/);
  await assert.rejects(startUiServer({ mode: 'live', llm: offlineLLM(createMockOpenRouter()), ceilingMs: 1.5, port: 0 }), /ceilingMs/);
  await assert.rejects(startUiServer({ mode: 'turbo', port: 0 }), /mode must be replay, autopilot or live/);
  assert.deepEqual(network, []);
});

test('5. live mode refuses the judge configuration and the interactive start: no graph write, no provider request, the session stays live and ready', async () => {
  const mock = createMockOpenRouter({ models: { red: createScriptedRedModel(), blue: createScriptedBlueModel() } });
  const path = join(TMP, 'never-written.json');
  const s = await liveServer(mock, { recordPath: path });
  try {
    const before = [await retries('twin'), await retries('world')];
    const ack = await s.control({ action: 'configure', choice: 'off' });
    assert.match(ack.error, /not available in live mode/);
    assert.deepEqual([ack.mode, ack.live, ack.interactive, ack.status], ['live', true, false, 'ready']);
    assert.deepEqual([await retries('twin'), await retries('world')], before, 'the judge edit was not written');
    assert.equal(s.payloads.filter((p) => p.k === 'judge').length, 0);
    const ack2 = await s.control({ action: 'start', interactive: true });
    assert.match(ack2.error, /not available in live mode/);
    assert.deepEqual([ack2.status, ack2.interactive, ack2.mode], ['ready', false, 'live']);
    await sleep(200);
    assert.equal(s.server.log.length, 0, 'no run started');
    assert.equal(mock.requests.length, 0, 'no provider request was made');
    assert.ok(!existsSync(path));
    assert.deepEqual(network, []);
  } finally { await s.close(); }
});

test('no network: nothing in this suite reached the network or OpenRouter', () => {
  assert.deepEqual(network, []);
});
