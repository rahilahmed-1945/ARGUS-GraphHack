// The story layer (Guided demo): a read-only, plain-English view of the real ARGUS event stream. These tests run the
// canonical demo (replay cassette, MCP, FalkorDB — no LLM), then tell its real event log. Requires `npm run db:up`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { loadTopology } from '../graph/topology.js';
import { createEventBus } from '../runtime/events.js';
import { createWorldClock } from '../runtime/clock.js';
import { runCanonicalDemo } from '../runtime/demo.js';
import { loadCassette } from '../runtime/cassette-file.js';
import { initialState, applyEvent, reduceAll } from '../ui/js/state.js';
import { createPlayback, dwellFor } from '../ui/js/playback.js';
import { storyModel, BEATS, FINAL_LINE, CHAINS } from '../ui/js/story.js';
import { createGuide } from '../ui/js/guide.js';
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

// what the browser does: apply each event to the reducer, then tell the story of everything presented so far
function tell(events, opts = { mode: 'guided' }) {
  const s = initialState();
  const frames = [];
  events.forEach((ev, i) => { applyEvent(s, ev); frames.push({ seq: ev.seq, m: storyModel(events.slice(0, i + 1), s, opts) }); });
  return { s, frames };
}
const chapters = (frames) => frames.map((f) => f.m.chapter).filter((c, i, a) => c !== a[i - 1]);
const at = (frames, type, pred = () => true) => frames.find((f) => { const ev = log.find((e) => e.seq === f.seq); return ev.type === type && pred(ev); }).m;
// "the system twin" is the approved plain name for the graph; WORLD is always "the live system" on screen
const JARGON = /\b(SLO|ticks?|M5|B5|audit|scope|forks?|cypher|sustained|verdict|amber|p_recover|proven-in-scope|calibrat\w*|snapshot|counterfactual|scenario|reactive|pre-?emptive|WORLD|S:R\d|D:R\d|O:R\d)\b/;

test('1. every Story value is read from a real event: the chapters follow the run, the numbers are the payloads\' own', () => {
  const { frames } = tell(log);
  assert.deepEqual(chapters(frames), ['ready', 'red', 'real', 'blue', 'proven', 'hardened', 'again', 'red2', 'blue2', 'proven2', 'finale', 'safe']);
  const ev = (type, pred = () => true) => log.find((e) => e.type === type && pred(e)).payload;
  const sc1 = ev('SCENARIO_COMMITTED');
  assert.match(at(frames, 'SCENARIO_COMMITTED').panel.result, new RegExp(`breaks the system in ${sc1.sustained} of 16 simulated runs`));
  const d1 = ev('DECISION_COMMITTED').decision;
  assert.match(at(frames, 'DECISION_COMMITTED').panel.graph, new RegExp(`tested ${d1.audit_sims} other possible fixes`));
  const h1 = ev('HARDENING_APPLIED').changes.world;
  for (const c of h1) assert.ok(at(frames, 'HARDENING_APPLIED').panel.graph.includes(`retries ${c.before} → ${c.after}`), 'the hardening values are the measured change');
  const o1 = ev('WORLD_OBSERVATION');
  assert.equal(at(frames, 'WORLD_OBSERVATION').panel.result, `Predicted ${o1.predicted_viol_ticks_p50} bad moments, observed ${o1.observed_viol_ticks}: within the predicted range.`);
  const sc2 = ev('SCENARIO_COMMITTED', (e) => e.round === 2);
  assert.match(at(frames, 'SCENARIO_COMMITTED', (e) => e.round === 2).panel.result, new RegExp(`in ${sc2.sustained} of 16 simulated runs`));
  // the what-if cards are exactly the futures BLUE evaluated, with their outcomes
  const futures1 = log.filter((e) => e.type === 'FUTURE_EVALUATION_COMPLETED' && e.round === 1).map((e) => e.payload);
  const cards = at(frames, 'DECISION_COMMITTED').whatif.cards;
  assert.equal(cards.length, futures1.length);
  assert.deepEqual(cards.map((c) => c.tone), futures1.map((f) => ({ green: 'good', amber: 'partial', red: 'bad' }[f.verdict])));
  assert.equal(cards.filter((c) => c.chosen).length, 1);
  assert.equal(cards[0].question, 'What if we do nothing?');
  // the chain strip lights the right step
  assert.equal(at(frames, 'DECISION_COMMITTED').chain[at(frames, 'DECISION_COMMITTED').step], 'Cheapest safe fix proven');
});

test('2. the story introduces no graph or state data: the view state is identical with or without it; the modules name nothing', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(tell(log).s)), JSON.parse(JSON.stringify(reduceAll(log))), 'the story never mutates the view state');
  const names = loadTopology().services.map((s) => s.name);
  for (const f of ['ui/js/story.js', 'ui/js/story-view.js', 'ui/js/guide.js', 'ui/js/narration.js', 'ui/js/director.js']) {
    const code = readFileSync(`${ROOT}${f}`, 'utf8');
    for (const n of names) assert.ok(!new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(code), `${f} names service ${n}`);
    assert.ok(!/\b(degrade|surge|deploy|retries_off|scale_out|breaker|block_deploy|cap_retries|shed):[\w-]/.test(code), `${f} names a fault or intervention id`);
    assert.ok(!/\b[SDO]:R\d\b|fork:R\d|CE-\d/.test(code), `${f} names a scenario, decision, future or change event`);
  }
  assert.deepEqual([...readFileSync(`${ROOT}ui/js/story.js`, 'utf8').matchAll(/^import .* from '([^']+)';/gm)], [], 'the story model imports nothing');
});

test('3. nothing is told before a mode is chosen; with no events the story waits', () => {
  const main = readFileSync(`${ROOT}ui/js/main.js`, 'utf8');
  assert.match(main, /function tellStory\(\) \{\s*if \(!mode\) return;/, 'no story (and no voice) before CONTROL THE SYSTEM or GUIDED DEMO');
  assert.match(main, /let mode = null;/);
  const empty = storyModel([], initialState(), { mode: 'guided' });
  assert.deepEqual([empty.chapter, empty.speech, empty.final], ['ready', null, null]);
  const choose = storyModel([], initialState(), { mode: 'control' });
  assert.deepEqual([choose.chapter, choose.speech.beat], ['choose', 'your_move']);
});

test('4. the story does not alter demo behaviour: same state, same playback timing, told after the reducer', () => {
  const run = (withStory) => {
    const s = initialState();
    const seen = [];
    const schedule = [];
    const pb = createPlayback({ apply(ev) { applyEvent(s, ev); seen.push(ev); if (withStory) storyModel(seen, s, { mode: 'guided' }); schedule.push([ev.seq, dwellFor(ev)]); } });
    pb.load(log);
    pb.seek(log.length);
    return { s: JSON.parse(JSON.stringify(s)), schedule };
  };
  assert.deepEqual(run(true), run(false));
  assert.ok(!/story|narrat|guide/.test(readFileSync(`${ROOT}ui/js/playback.js`, 'utf8')), 'playback does not know about the story');
  const main = readFileSync(`${ROOT}ui/js/main.js`, 'utf8');
  assert.match(main, /applyEvent\(state, ev\);[^\n]*tellStory\(\)/, 'the story reads the state after the real event was applied');
});

test('5. Guided reaches SAFE exactly like the plain run, and its final frame is the real verdict', async () => {
  const { s, frames } = tell(log);
  assert.deepEqual(s.result, reduceAll(log).result);
  const last = frames.at(-1).m;
  assert.deepEqual([last.chapter, last.final.safe, last.final.violated, last.final.ticks, last.final.line], ['safe', true, 0, 90, FINAL_LINE]);
  assert.equal(last.step, CHAINS.guided.length - 1);
  const o = await roRows(db, 'twin', `MATCH (o:Observation {id:'O:R2'}) RETURN o.observed_viol_ticks AS v`);
  assert.equal(o[0].v, last.final.violated, 'the verdict is the one FalkorDB recorded');
  assert.deepEqual(last.final.columns.map((c) => c.k), ['ATTACK 1 → FIX 1', 'ATTACK 2 → FIX 2']);
  assert.deepEqual(tell(log).frames.at(-1).m, last, 'deterministic');
});

test('6. the spoken beats are fixed ids, one per moment, in the order of the run; the last words are the final line', () => {
  const { frames } = tell(log);
  const spoken = [];
  for (const { m } of frames) if (m.speech && spoken.at(-1)?.key !== `${m.speech.round}:${m.speech.beat}`) spoken.push({ key: `${m.speech.round}:${m.speech.beat}`, ...m.speech });
  assert.deepEqual(spoken.map((x) => x.key), ['1:red_search', '1:red_attack_found', '1:world_attack', '1:blue_search', '1:intervention_selected', '1:hardening', '1:world_observation',
    '2:round2', '2:red_search', '2:red_attack_found', '2:intervention_selected', '2:finale', '2:safe']);
  for (const x of spoken) assert.ok(BEATS.includes(x.beat), `${x.beat} is a fixed beat`);
  assert.ok(spoken.at(-1).text.endsWith(FINAL_LINE));
});

test('7. voice on or off: the demo reaches the identical SAFE state, and speech never runs the playback', () => {
  const heard = [];
  const synth = { speak: (u) => heard.push(u.text), cancel() {}, getVoices: () => [] };
  function Utterance(text) { this.text = text; }
  const run = (muted) => {
    const guide = createGuide({ synth, Utterance });
    guide.setMuted(muted);
    const st = initialState();
    let last = null;
    log.forEach((ev, i) => { applyEvent(st, ev); const m = storyModel(log.slice(0, i + 1), st, { mode: 'guided' }); const k = m.speech && `${m.speech.round}:${m.speech.beat}`; if (k && k !== last) { last = k; guide.say(m.speech.text); } });
    return st;
  };
  const voiced = run(false);
  const n = heard.length;
  const muted = run(true);
  assert.ok(n > 0, 'the unmuted run spoke');
  assert.equal(heard.length, n, 'the muted run spoke nothing');
  assert.deepEqual(JSON.parse(JSON.stringify(voiced)), JSON.parse(JSON.stringify(muted)));
});

test('8. plain English first: no technical jargon in the Story panel, the what-if cards or the final frame; the evidence keeps it', () => {
  const { frames } = tell(log);
  for (const { m } of frames) {
    for (const [k, v] of Object.entries(m.panel)) assert.ok(!JARGON.test(v), `panel.${k} in ${m.chapter}: "${v}"`);
    for (const c of m.whatif?.cards ?? []) for (const v of [c.question, c.answer, c.detail]) assert.ok(!JARGON.test(v), `what-if: "${v}"`);
    if (m.speech) assert.ok(!JARGON.test(m.speech.text), `speech: "${m.speech.text}"`);
    if (m.final) for (const c of m.final.columns) for (const v of [c.a, c.b, c.c]) assert.ok(!JARGON.test(v), `final: "${v}"`);
    assert.ok(!JARGON.test(m.title), `title: ${m.title}`);
  }
  // the technical record is still there, behind ▸ query: every tool step carries its tool name and raw result
  const ev = frames.at(-1).m.evidence;
  const steps = ev.filter((r) => r.key.startsWith('s'));
  assert.ok(steps.length > 10);
  assert.ok(steps.every((r) => r.tech.label && r.text && !JARGON.test(r.text.replace(/scratch copy/g, ''))), 'plain sentence first, technical label kept');
  assert.ok(ev.some((r) => r.tech.label.includes('GRAPH.COPY')), 'graph copies are kept as evidence');
});
