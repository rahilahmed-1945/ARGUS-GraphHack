// M16 — the two interaction failures seen on the public deployment, as regressions:
//   1. Control mode: the judge's choice is `configure`, then `start` a few seconds later. With the public cooldown the
//      start used to be refused ("please wait") and the judge was left waiting for nothing. Now only run starts are
//      rate-limited, the judge's flow is accepted inside the cooldown, and every refusal carries its reason.
//   2. Guided mode: GUIDED DEMO chosen while the server held an earlier judge session (paused at ATTACK AGAIN or
//      finished) used to send no start at all (the director had left its landing phase) and replayed the stale
//      session. Now the director can be reset, a guided start releases a paused judge run and the canonical run follows
//      in a fresh non-interactive session, and ATTACK AGAIN with nothing paused is refused with a reason.
// Requires `npm run db:up` (ACL). No network: replay of the reference cassette and the scripted judge models only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { connect } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { startUiServer } from '../app/ui-server.js';
import { createDirector } from '../ui/js/director.js';

let db;
before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function client(server) {
  const c = ioClient(server.url, { transports: ['websocket'], forceNew: true });
  const status = [];
  c.on('status', (m) => status.push(m));
  await new Promise((r) => c.once('hello', r));
  const control = (msg) => new Promise((resolve) => c.emit('control', msg, resolve));
  const until = async (cond, ms = 300000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
  return { c, status, control, until, close: () => c.disconnect() };
}
// an answer within `ms`, or a failure that names the control (the timer is cleared, so it never keeps the process alive)
const bounded = (p, ms, what) => {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no answer within ${ms} ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

test('1. Control mode under the public cooldown: configure, then start a moment later, is accepted; the run pauses at ATTACK AGAIN; ATTACK AGAIN continues it to SAFE', async () => {
  const server = await startUiServer({ port: 0, cooldownMs: 15000 });
  const s = await client(server);
  try {
    const conf = await bounded(s.control({ action: 'configure', choice: 'off' }), 60000, 'configure');
    assert.equal(conf.error, null, 'the judge\'s configure is never rate-limited');
    assert.equal(conf.interactive, true);
    await sleep(500);                                         // the browser waits a few seconds, well inside the cooldown
    const start = await bounded(s.control({ action: 'start', interactive: true }), 60000, 'start');
    assert.equal(start.error, null, 'the start that follows the judge\'s configure must be accepted');
    assert.equal(start.status, 'running');
    await s.until(() => ['awaiting', 'done', 'failed'].includes(server.info().status));
    assert.equal(server.info().status, 'awaiting', server.info().error);
    assert.equal(server.info().awaiting, 'attack-again');
    const round1 = server.log.length;
    const again = await bounded(s.control({ action: 'attack-again' }), 10000, 'attack-again');
    assert.equal(again.error, null);
    assert.equal(again.status, 'running', 'ATTACK AGAIN starts the next round at once');
    await s.until(() => ['done', 'failed'].includes(server.info().status));
    assert.equal(server.info().status, 'done', server.info().error);
    assert.ok(server.log.length > round1, 'round 2 emitted events');
    const done = server.log.find((e) => e.type === 'DEMO_COMPLETED');
    assert.ok(done && done.payload.safe === true, 'the judge demo reaches SAFE');
    assert.ok(s.status.every((m) => m.error === null), 'no refusal was reported to the browser at any point');
  } finally { s.close(); await server.close(); }
});

test('2. ATTACK AGAIN with nothing paused is refused with a reason (never a silent no-op); a reset then recovers', async () => {
  const server = await startUiServer({ port: 0 });
  const s = await client(server);
  try {
    const r = await bounded(s.control({ action: 'attack-again' }), 10000, 'attack-again');
    assert.match(r.error, /no paused run is waiting for ATTACK AGAIN/);
    assert.equal(r.status, 'ready', 'the status did not move');
    const z = await bounded(s.control({ action: 'reset' }), 60000, 'reset');
    assert.equal(z.error, null);
    assert.equal(z.status, 'ready');
  } finally { s.close(); await server.close(); }
});

test('3. GUIDED DEMO while a judge run is paused at ATTACK AGAIN: the start is accepted, the paused run is released and finishes, and the canonical replay follows in a fresh non-interactive session', async () => {
  // no cooldown here: this is the takeover of a paused run; the cooldown is test 1 and m15 #3 (a start inside it is
  // refused with the wait, and the browser retries by itself)
  const server = await startUiServer({ port: 0 });
  const s = await client(server);
  try {
    await s.control({ action: 'configure', choice: 'keep' });
    await s.control({ action: 'start', interactive: true });
    await s.until(() => ['awaiting', 'done', 'failed'].includes(server.info().status));
    assert.equal(server.info().status, 'awaiting', server.info().error);
    const paused = server.info().session;
    // the guided start (no `interactive`): the one the landing page's GUIDED DEMO sends
    const g = await bounded(s.control({ action: 'start' }), 300000, 'guided start while paused');
    assert.equal(g.error, null, 'a guided start is not refused by a paused judge run');
    assert.equal(g.status, 'running');
    assert.equal(g.interactive, false, 'the canonical run is a fresh, non-interactive session');
    assert.ok(g.session > paused, 'a new session');
    await s.until(() => ['done', 'failed'].includes(server.info().status));
    assert.equal(server.info().status, 'done', server.info().error);
    assert.equal(server.info().mode, 'replay');
    assert.ok(server.log.some((e) => e.type === 'DEMO_COMPLETED'), 'the canonical run completed in the new session');
  } finally { s.close(); await server.close(); }
});

test('4. the director: after a bypassed (resumed) session START does nothing; reset() returns it to the landing, so GUIDED DEMO starts the run and the intro', () => {
  let now = 0; const timers = [];
  const clock = { setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; }, clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } };
  const log = [];
  const d = createDirector({ timers: clock, onIntroLine: (i) => log.push(`line${i}`), onIntroEnd: () => log.push('introEnd'), beginRun: () => log.push('run'), beginPlayback: () => log.push('playback') });
  d.bypass();                                                 // a reload into a Control session bypasses the landing
  assert.equal(d.phase, 'playing');
  assert.equal(d.start(), false, 'this is the bug: the guided start used to be silently ignored');
  assert.deepEqual(log, []);
  d.reset();
  assert.deepEqual([d.phase, d.canPlay()], ['landing', false]);
  assert.equal(d.start(), true);
  assert.deepEqual(log, ['line0', 'run'], 'the run is requested inside the click');
  for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) { now = t.at; t.fn(); }
  assert.ok(log.includes('introEnd') && log.at(-1) === 'playback');
  assert.equal(d.canPlay(), true);
  d.reset();                                                  // and again, from 'playing' (a second GUIDED DEMO click after a run)
  assert.equal(d.start(), true);
});

test('5. the client surfaces refusals: the story panel has a notice element and the UI code never drops a control\'s answer', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
  const html = read('ui/index.html'), js = read('ui/js/main.js'), view = read('ui/js/story-view.js');
  assert.match(html, /<div id="story-notice" class="story-notice" role="alert"><\/div>/);
  assert.match(view, /function notice\(text/);
  // a bare `await send('…')` statement throws the ack (and its reason) away; every control's answer must be examined
  for (const action of ['start', 'configure', 'reset', 'attack-again']) assert.ok(!new RegExp(`^\\s*await send\\('${action}'`, 'm').test(js), `a ${action} ack is checked, not dropped`);
  assert.match(js, /director\.reset\(\)/, 'GUIDED DEMO resets the director before START');
  assert.match(js, /retryAfterMs/, 'a cooldown refusal is retried after the stated wait');
});
