// M15 — public-deployment options and guards (docs/DEPLOY_RENDER.md). The command-center server gains environment-driven
// configuration (host, PORT, mode, cassette, ceiling), an operator token for live runs, a per-client cooldown and a daily
// live-run cap. Local defaults are unchanged. Offline: the live server is fed the mock OpenRouter endpoint through the
// real provider; no network, no key beyond a test string. Requires `npm run db:up` (ACL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { connect } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { startUiServer, cliOptions } from '../app/ui-server.js';
import { createOpenRouterLLM } from '../runtime/providers/openrouter.js';
import { TAKEOVER } from '../runtime/runtime.js';
import { createScriptedRedModel } from './fixtures/red-model.js';
import { createScriptedBlueModel } from './fixtures/blue-model.js';
import { createMockOpenRouter, MOCK_BASE_URL, MOCK_MODEL } from './ai/mock-openrouter.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'offline-test-key-SECRET-m15';
const TOKEN = 'operator-token-for-tests-0123456789';
const TMP = mkdtempSync(join(tmpdir(), 'argus-m15-'));   // live-run recordings go here, never into cassettes/
const network = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { network.push(String(url)); throw new Error(`network disabled in offline tests: ${url}`); };

let db;
before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); globalThis.fetch = realFetch; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockLLM = () => createOpenRouterLLM({ apiKey: SECRET, model: MOCK_MODEL, baseUrl: MOCK_BASE_URL,
  fetch: createMockOpenRouter({ models: { red: createScriptedRedModel(), blue: createScriptedBlueModel() } }).fetch });
async function client(server) {
  const c = ioClient(server.url, { transports: ['websocket'], forceNew: true });
  const payloads = [];
  for (const k of ['hello', 'status', 'event']) c.on(k, (m) => payloads.push({ k, m }));
  await new Promise((r) => c.once('hello', r));
  const control = (msg) => new Promise((resolve) => c.emit('control', msg, resolve));
  const until = async (cond, ms = 300000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
  return { c, payloads, control, until, close: () => c.disconnect() };
}

test('1. cliOptions: local defaults are unchanged; flags win over the environment; PORT and the deployment variables are honoured; bad values fail', () => {
  const d = cliOptions(['node', 'ui-server.js'], {});
  assert.deepEqual([d.mode, d.cassettePath, d.host, d.port, d.ceilingMs, d.recordPath, d.operatorToken, d.cooldownMs, d.liveMaxRunsPerDay, d.autostart],
    ['replay', undefined, '127.0.0.1', 4173, TAKEOVER.TURN_CEILING_MS, null, null, 0, Infinity, false]);
  const env = { PORT: '10000', ARGUS_UI_HOST: '0.0.0.0', ARGUS_UI_MODE: 'live', ARGUS_UI_CASSETTE: 'cassettes/x.json', ARGUS_UI_CEILING_MS: '30000',
    ARGUS_UI_RECORD: 'cassettes/r.json', ARGUS_OPERATOR_TOKEN: TOKEN, ARGUS_PUBLIC_COOLDOWN_MS: '15000', ARGUS_LIVE_MAX_RUNS_PER_DAY: '2' };
  const e = cliOptions(['node', 'ui-server.js'], env);
  assert.deepEqual([e.mode, e.cassettePath, e.host, e.port, e.ceilingMs, e.recordPath, e.operatorToken, e.cooldownMs, e.liveMaxRunsPerDay],
    ['live', 'cassettes/x.json', '0.0.0.0', 10000, 30000, 'cassettes/r.json', TOKEN, 15000, 2]);
  assert.equal(cliOptions(['node', 'ui-server.js'], { PORT: '10000', ARGUS_UI_PORT: '4173' }).port, 4173, 'ARGUS_UI_PORT beats PORT');
  const f = cliOptions(['node', 'ui-server.js', '--mode', 'autopilot', '--port', '5000', '--host', '127.0.0.1', '--ceiling-ms', '20000', '--autostart'], env);
  assert.deepEqual([f.mode, f.port, f.host, f.ceilingMs, f.autostart], ['autopilot', 5000, '127.0.0.1', 20000, true]);
  assert.equal(cliOptions(['node', 'x'], { ARGUS_LIVE_MAX_RUNS_PER_DAY: 'infinity' }).liveMaxRunsPerDay, Infinity);
  for (const bad of [{ ARGUS_PUBLIC_COOLDOWN_MS: 'soon' }, { ARGUS_UI_CEILING_MS: '0' }, { ARGUS_LIVE_MAX_RUNS_PER_DAY: '-1' }, { PORT: '80.5' }]) {
    assert.throws(() => cliOptions(['node', 'x'], bad), /invalid/);
  }
  // the server validates the guard options too
  assert.rejects(startUiServer({ port: 0, cooldownMs: -1 }), /cooldownMs/);
  assert.rejects(startUiServer({ port: 0, operatorToken: 'short' }), /operatorToken/);
});

test('2. live mode with an operator token: anonymous visitors cannot start a live run (no provider request); the operator can; replay actions stay open', async () => {
  const server = await startUiServer({ mode: 'live', llm: mockLLM(), port: 0, operatorToken: TOKEN, ceilingMs: 20000, liveMaxRunsPerDay: 1,
    recordPath: join(TMP, 'operator-run.json') });
  const s = await client(server);
  try {
    assert.deepEqual([server.info().operatorRequired, server.info().liveRunsToday, server.info().liveMaxRunsPerDay], [true, 0, 1]);
    // anonymous
    const anon = await s.control({ action: 'start' });
    assert.match(anon.error, /live runs require the operator token/);
    assert.equal(anon.status, 'ready');
    await sleep(200);
    assert.equal(server.log.length, 0, 'no run started');
    // wrong token
    const wrong = await s.control({ action: 'start', token: 'operator-token-for-tests-WRONG000000' });
    assert.match(wrong.error, /operator token/);
    // reset is not a live run: allowed anonymously
    const r = await s.control({ action: 'reset' });
    assert.equal(r.status, 'ready');
    // the operator
    await s.control({ action: 'start', token: TOKEN });
    await s.until(() => ['done', 'failed'].includes(server.info().status));
    assert.equal(server.info().status, 'done', server.info().error);
    assert.equal(server.info().liveRunsToday, 1);
    assert.deepEqual(server.info().phases.map((p) => p.proposedBy), ['llm', 'llm', 'llm', 'llm']);
    // the daily cap: a second authorized live run is refused, with the replay suggested
    const capped = await s.control({ action: 'start', token: TOKEN });
    assert.match(capped.error, /daily limit of 1 live run/);
    assert.equal(server.info().status, 'done', 'the finished session was not reset by the refused start');
    // the token never appears in anything the browser receives
    assert.ok(!JSON.stringify([s.payloads, server.info(), server.log]).includes(TOKEN));
    assert.ok(!JSON.stringify([s.payloads, server.info(), server.log]).includes(SECRET));
    assert.deepEqual(network, []);
  } finally { s.close(); await server.close(); }
});

test('3. public cooldown: only run STARTS from the same client are rate-limited, with the reason and the wait in the ack; reset and configure never are; the operator bypasses; replay mode needs no token', async () => {
  const server = await startUiServer({ port: 0, cooldownMs: 60000, operatorToken: TOKEN });
  const s = await client(server);
  try {
    assert.equal(server.info().operatorRequired, false, 'no live mode → no token needed for start');
    // reset and configure are free, in quick succession (the judge's click is reset → configure → start)
    for (const msg of [{ action: 'reset' }, { action: 'reset' }, { action: 'configure', choice: 'keep' }, { action: 'configure', choice: 'off' }]) {
      const r = await s.control(msg);
      assert.equal(r.error, null, `${msg.action} is never rate-limited`);
    }
    // the first start of this address is accepted; it runs the judge demo on the configured graph
    const first = await s.control({ action: 'start', interactive: true });
    assert.equal(first.error, null);
    assert.equal(first.status, 'running');
    await s.until(() => ['awaiting', 'done', 'failed'].includes(server.info().status));
    await s.control({ action: 'attack-again' });
    await s.until(() => ['done', 'failed'].includes(server.info().status));
    assert.equal(server.info().status, 'done', server.info().error);
    // a second start inside the cooldown: refused, with the reason and a machine-readable wait; the session is untouched
    const b = await s.control({ action: 'start' });
    assert.match(b.error, /please wait \d+ s before starting another run/);
    assert.ok(Number.isInteger(b.retryAfterMs) && b.retryAfterMs > 0 && b.retryAfterMs <= 60000, `retryAfterMs ${b.retryAfterMs}`);
    assert.equal(b.status, 'done', 'the finished session was not reset by the refused start');
    assert.equal(server.info().error, b.error, 'the refusal is visible in the state too');
    // the operator is not rate-limited, and an accepted start clears the stale refusal
    const op = await s.control({ action: 'start', token: TOKEN });
    assert.equal(op.error, null, 'the operator is not rate-limited; the earlier refusal is not reported as this run\'s error');
    assert.equal(op.status, 'running');
    await s.until(() => ['done', 'failed'].includes(server.info().status));
    assert.equal(server.info().status, 'done', server.info().error);
  } finally { s.close(); await server.close(); }
});

test('4. the public replay cassette is a genuine live recording with provenance, and the UI labels replay as a cassette, never as live', async () => {
  const path = `${ROOT}cassettes/public-live-replay.json`;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(file.provenance.live, true);
  assert.ok(file.provenance.phases.some((p) => p.proposedBy === 'llm') && file.provenance.phases.some((p) => p.proposedBy === 'b5'));
  const server = await startUiServer({ port: 0, cassettePath: path });
  try {
    const info = server.info();
    assert.deepEqual([info.mode, info.live, info.operatorRequired], ['replay', false, false]);
    assert.match(info.source, /^cassette · live OpenRouter run \(UI\) · R1 RED b5 \(max_turn\) · R1 BLUE b5 \(no_progress\) · R2 RED llm · R2 BLUE b5 \(turn_ceiling\)/);
  } finally { await server.close(); }
});

test('no network: nothing in this suite reached the network or OpenRouter', () => { assert.deepEqual(network, []); });
