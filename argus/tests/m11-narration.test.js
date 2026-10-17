// M11 — the narration beat ledger. Speech is keyed by run + round + beat and recorded BEFORE it is attempted, so no
// event repetition, reconnect, reload, Replay, mute/unmute or speech failure can make a beat speak twice; a new run
// id starts a fresh ledger; one tab per browser speaks. Fake speech engine, fake storage and a fake BroadcastChannel
// hub, driven by the real canonical event log (replay cassette, MCP, FalkorDB — no LLM). Requires `npm run db:up`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { createEventBus } from '../runtime/events.js';
import { createWorldClock } from '../runtime/clock.js';
import { runCanonicalDemo } from '../runtime/demo.js';
import { loadCassette } from '../runtime/cassette-file.js';
import { initialState, applyEvent, reduceAll } from '../ui/js/state.js';
import { createPlayback, dwellFor } from '../ui/js/playback.js';
import { storyModel, BEATS } from '../ui/js/story.js';
import { createNarrationLedger, introBeat } from '../ui/js/narration.js';
import { INTRO } from '../ui/js/director.js';
import { mcpToolboxes } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let db, agentDb, boxes, log;

before(async () => {
  db = await connect(); agentDb = await connect({ as: 'agent' }); boxes = await mcpToolboxes(agentDb);
  await reset(db);
  const { cassette } = loadCassette(`${ROOT}cassettes/reference-scripted.json`);
  const events = createEventBus();
  await runCanonicalDemo(db, { mode: 'replay', events, clock: createWorldClock({ pacing: 'virtual', events }),
    adapters: { red: cassette.player(), blue: cassette.player() }, toolboxes: boxes.toolboxes });
  log = events.log;
});
after(async () => { await boxes.close(); await agentDb.close(); await reset(db); await db.close(); });

// fakes: a speech engine (records what would be heard), sessionStorage, and a BroadcastChannel hub
function fakeSpeech({ fail = false } = {}) {
  const heard = [], interrupts = [];
  let cancels = 0;
  return { heard, interrupts, get cancels() { return cancels; },
    speak: (text, { interrupt }) => { if (fail) throw new Error('synthesis-failed'); heard.push(text); interrupts.push(interrupt); if (interrupt) cancels += 1; return true; },
    cancel: () => { cancels += 1; } };
}
function fakeStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }
function channelHub() {
  const members = new Set();
  return () => {
    const listeners = new Set();
    const ch = { addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f),
      postMessage: (data) => { for (const m of members) if (m !== ch) for (const f of m.listeners) f({ data }); }, listeners };
    members.add(ch);
    return ch;
  };
}
function rig({ run = 'run-1', storage = fakeStorage(), channel = null, speech = fakeSpeech(), claim = true } = {}) {
  const lines = [];
  const ledger = createNarrationLedger({ speak: speech.speak, cancel: speech.cancel, storage, channel, log: (l) => lines.push(l) });
  ledger.setRun(run);
  if (claim) ledger.claim();
  return { ledger, speech, lines, storage };
}
// what a page does per presented event: reduce, tell the story so far, hand a newly reached beat to the ledger
function present(events, ledger, { mode = 'guided' } = {}) {
  const s = initialState();
  let last = null;
  events.forEach((ev, i) => {
    applyEvent(s, ev);
    const sp = storyModel(events.slice(0, i + 1), s, { mode }).speech;
    const key = sp && `${sp.round}:${sp.beat}`;
    if (key && key !== last) { last = key; ledger.narrate(sp); }
  });
  return s;
}
const spokenBeats = (lines) => lines.filter((l) => l.endsWith('→ spoken')).map((l) => l.split(' ')[1]);

test('1. fixed beat ids: the canonical run speaks each beat once, in order, with the required log lines', () => {
  const { ledger, lines, speech } = rig();
  INTRO.forEach((line, i) => ledger.narrate({ round: 0, beat: introBeat(i), text: line.speech ?? line.text }));
  present(log, ledger);
  assert.deepEqual(spokenBeats(lines), ['intro_1', 'intro_2', 'intro_3', 'intro_4', 'intro_5', 'intro_6', 'intro_7',
    'red_search', 'red_attack_found', 'world_attack', 'blue_search', 'intervention_selected', 'hardening', 'world_observation',
    'round2', 'red_search', 'red_attack_found', 'intervention_selected', 'finale', 'safe']);
  assert.equal(speech.heard.length, 20);
  for (const l of lines) assert.match(l, /^NARRATION [a-z0-9_]+ → (spoken|skipped \(already spoken\))$/);
  assert.deepEqual([...BEATS].sort(), ['blue_search', 'finale', 'graph_changed', 'hardening', 'intervention_selected', 'red_attack_found', 'red_search',
    'round2', 'safe', 'verifier', 'world_attack', 'world_observation', 'your_move']);
});

test('2. the same event twice → one spoken beat; two different events mapping to one beat → one spoken beat', () => {
  const { ledger, lines, speech } = rig();
  const found = log.find((e) => e.type === 'SCENARIO_COMMITTED');
  const upTo = log.slice(0, log.indexOf(found) + 1);
  present(upTo, ledger);
  const n = speech.heard.length;
  present(upTo, ledger);                                   // a fresh page, the same events again
  assert.equal(speech.heard.length, n, 'the repeated events speak nothing');
  assert.equal(lines.at(-1), 'NARRATION red_attack_found → skipped (already spoken)');
  // the attack being committed and the attack being injected are different events, one beat
  const inject = log.find((e) => e.type === 'WORLD_FAULT_INJECTED');
  const key = (ev) => { const k = log.indexOf(ev) + 1; const m = storyModel(log.slice(0, k), reduceAll(log.slice(0, k)), { mode: 'guided' }); return `${m.speech.round}:${m.speech.beat}`; };
  assert.equal(key(found), key(inject));
  assert.equal(key(found), '1:red_attack_found');
  const before = speech.heard.length;
  present(log.slice(0, log.indexOf(inject) + 1), ledger);
  assert.equal(speech.heard.length, before, 'still one red_attack_found');
});

test('3. a socket replay / reconnect of the session log speaks nothing new (the page resets, the ledger does not)', () => {
  const { ledger, speech, lines } = rig();
  present(log, ledger);
  const n = speech.heard.length;
  present(log, ledger);                       // the browser's resetView + playback.load of the same session's log
  present(log, ledger);
  assert.equal(speech.heard.length, n);
  assert.ok(lines.slice(-3).every((l) => l.endsWith('skipped (already spoken)')));
});

test('4. a round-1 beat cannot repeat within round 1; 5. round 2 speaks its own beat once', () => {
  const { ledger, speech } = rig();
  for (let i = 0; i < 4; i++) ledger.narrate({ round: 1, beat: 'red_search', text: 'x' });
  assert.equal(speech.heard.length, 1);
  present(log, ledger);
  const r2 = (beat) => ledger.has(2, beat);
  assert.ok(r2('round2') && r2('safe'));
  ledger.narrate({ round: 2, beat: 'round2', text: 'again' });
  assert.equal(speech.heard.filter((t) => t === 'again').length, 0);
  // a beat spoken in both rounds is spoken once in each; the same beat id in another round is a different key
  assert.ok(ledger.has(1, 'red_search') && ledger.has(2, 'red_search'));
  assert.equal(ledger.narrate({ round: 2, beat: 'world_attack', text: 'r2' }), true);
  assert.equal(ledger.narrate({ round: 2, beat: 'world_attack', text: 'r2' }), false);
});

test('6. mute then unmute never replays; muting cancels the speech in progress', () => {
  const { ledger, speech, lines } = rig();
  ledger.narrate({ round: 1, beat: 'red_search', text: 'one' });
  ledger.setMuted(true);
  const cancels = speech.cancels;
  assert.ok(cancels >= 1);
  ledger.narrate({ round: 1, beat: 'red_attack_found', text: 'two' });
  ledger.setMuted(false);
  assert.deepEqual(speech.heard, ['one'], 'nothing that passed while muted is spoken on unmute');
  ledger.narrate({ round: 1, beat: 'red_attack_found', text: 'two' });
  assert.deepEqual(speech.heard, ['one']);
  assert.equal(lines[1], 'NARRATION red_attack_found → skipped (muted)');
  ledger.narrate({ round: 1, beat: 'world_attack', text: 'three' });
  assert.deepEqual(speech.heard, ['one', 'three']);
});

test('7. Reset / new session → a fresh ledger: the new run narrates once; Replay in the same run stays silent', () => {
  const storage = fakeStorage();
  const { ledger, speech } = rig({ storage });
  present(log, ledger);
  const n = speech.heard.length;
  assert.equal(ledger.setRun('run-1'), false, 'the same run id keeps the ledger');
  present(log, ledger);
  assert.equal(speech.heard.length, n, 'Replay (same run) is silent');
  assert.equal(ledger.setRun('run-2'), true);
  present(log, ledger);
  assert.equal(speech.heard.length, 2 * n, 'the new run narrates every beat once');
  present(log, ledger);
  assert.equal(speech.heard.length, 2 * n);
});

test('8. the reducer state and the playback schedule are identical with the ledger on or off, event for event', () => {
  const run = (withLedger) => {
    const s = initialState();
    const { ledger } = rig();
    const seen = [];
    const schedule = [];
    const pb = createPlayback({ apply(ev) {
      applyEvent(s, ev); seen.push(ev);
      const sp = storyModel(seen, s, { mode: 'guided' }).speech;
      if (withLedger && sp) ledger.narrate(sp);
      schedule.push([ev.seq, dwellFor(ev)]);
    } });
    pb.load(log);
    pb.seek(log.length);
    return { s: JSON.parse(JSON.stringify(s)), schedule };
  };
  assert.deepEqual(run(true), run(false));
});

test('9. reload protection: a reloaded page (same run, same sessionStorage) re-speaks nothing', () => {
  const storage = fakeStorage();
  const first = rig({ storage });
  present(log, first.ledger);
  assert.ok(first.speech.heard.length > 0);
  const reloaded = rig({ storage });
  present(log, reloaded.ledger);
  assert.equal(reloaded.speech.heard.length, 0);
  assert.ok(reloaded.lines.every((l) => l.endsWith('skipped (already spoken)')));
  const other = rig({ storage, run: 'run-9' });
  present(log, other.ledger);
  assert.equal(other.speech.heard.length, first.speech.heard.length, 'storage is per run');
});

test('10. BroadcastChannel: two tabs can never both speak — the last START claims, the other falls silent', () => {
  const hub = channelHub();
  const a = rig({ channel: hub(), storage: fakeStorage() });
  const b = rig({ channel: hub(), storage: fakeStorage(), claim: false });
  present(log, b.ledger);
  assert.equal(b.speech.heard.length, 0, 'a tab without START never speaks');
  assert.equal(b.ledger.size, 0, '…and consumes no beat');
  present(log, a.ledger);
  const heardA = a.speech.heard.length;
  assert.ok(heardA > 0);
  b.ledger.setRun('run-2'); a.ledger.setRun('run-2');
  b.ledger.claim();                                   // START in the second tab
  assert.equal(a.ledger.speaker, false);
  assert.ok(a.speech.cancels > 0, 'the first tab stops speaking');
  present(log, a.ledger);
  present(log, b.ledger);
  assert.equal(a.speech.heard.length, heardA, 'the first tab is silent for the new run');
  assert.ok(b.speech.heard.length > 0);
});

test('11. speech failure never affects playback: the beat is recorded first, never retried, and narrate never throws', () => {
  const { ledger, lines } = rig({ speech: fakeSpeech({ fail: true }) });
  assert.doesNotThrow(() => present(log, ledger));
  assert.ok(lines[0].startsWith('NARRATION red_search → speech failed'));
  assert.equal(ledger.has(1, 'red_search'), true);
  ledger.narrate({ round: 1, beat: 'red_search', text: 'again' });
  assert.equal(lines.at(-1), 'NARRATION red_search → skipped (already spoken)');
  const throwing = createNarrationLedger({ speak: () => true, storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, log: () => {} });
  throwing.setRun('r'); throwing.claim();
  assert.equal(throwing.narrate({ round: 1, beat: 'safe', text: 'x' }), true, 'blocked storage only loses reload protection');
  assert.equal(throwing.narrate({ round: 1, beat: 'safe', text: 'x' }), false);
});

test('12. cancel only on a genuinely new beat: intro lines queue, a new beat interrupts, a repeat never cancels', () => {
  const { ledger, speech } = rig();
  INTRO.forEach((line, i) => ledger.narrate({ round: 0, beat: introBeat(i), text: line.text }));
  assert.deepEqual(speech.interrupts, INTRO.map(() => false), 'moving between intro lines never cancels');
  ledger.narrate({ round: 1, beat: 'red_search', text: 'a' });
  assert.equal(speech.interrupts.at(-1), true);
  const c = speech.cancels;
  ledger.narrate({ round: 1, beat: 'red_search', text: 'a' });
  assert.equal(speech.cancels, c, 'a skipped repeat does not cancel');
  // the page: speech starts only through the ledger; cards never speak; a view reset never cancels
  const main = readFileSync(`${ROOT}ui/js/main.js`, 'utf8');
  const guide = readFileSync(`${ROOT}ui/js/guide.js`, 'utf8');
  assert.deepEqual([...main.matchAll(/\.say\(/g)].length, 1, 'main calls say() only as the ledger\'s speak hook');
  assert.match(main, /createNarrationLedger\(\{ speak: \(text, o\) => guide\.say\(text, o\)/);
  assert.ok(!/say\(card|show\(card|clear\(/.test(guide), 'no card speaks by itself, and no view reset touches speech');
  assert.equal([...guide.matchAll(/\.cancel\(\)/g)].length, 2, 'speech is cancelled only by a new beat (say interrupt) or by muting');
});

test('13. a tab that is not the speaker consumes nothing: when it becomes the speaker (its click), the current beat is spoken', () => {
  const hub = channelHub();
  const reloaded = rig({ channel: hub(), storage: fakeStorage(), claim: false });      // e.g. a page reloaded mid-session
  const half = log.findIndex((e) => e.type === 'BLUE_STARTED') + 1;
  present(log.slice(0, half), reloaded.ledger);
  assert.equal(reloaded.speech.heard.length, 0);
  assert.equal(reloaded.ledger.size, 0, 'nothing recorded while silent');
  assert.ok(reloaded.lines.every((l) => l.endsWith('skipped (another tab is the speaker)')));
  reloaded.ledger.claim();                                                             // the visitor clicks the voice toggle
  present(log.slice(0, half), reloaded.ledger);
  assert.ok(reloaded.speech.heard.length > 0, 'the beats it never spoke are spoken now that it is the speaker');
  assert.equal(reloaded.lines.at(-1), 'NARRATION blue_search → spoken');
  const main = readFileSync(`${ROOT}ui/js/main.js`, 'utf8');
  assert.match(main, /if \(!ledger\.speaker\) \{ ledger\.claim\(\); guide\.setMuted\(false\); \}/, 'the voice toggle claims the speaker role with a user gesture');
});
