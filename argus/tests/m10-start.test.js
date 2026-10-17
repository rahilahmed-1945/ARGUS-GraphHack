// Start experience: a landing with two explicit choices (nothing starts on its own); GUIDED DEMO → the narrated
// introduction of the problem and the cast → canonical playback. The director, playback
// queue and voice are exercised with a fake clock and a fake speech engine; the page and its wiring are checked
// statically. No database, network or browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDirector, introSchedule, INTRO } from '../ui/js/director.js';
import { createPlayback } from '../ui/js/playback.js';
import { createGuide, pickVoice, sentences } from '../ui/js/guide.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(`${ROOT}${f}`, 'utf8');

// a manual clock: timers fire only when advanced
function fakeTimers() {
  let now = 0, id = 0;
  const q = new Map();
  return {
    setTimeout(fn, ms) { q.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout(i) { q.delete(i); },
    get now() { return now; },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = until;
    },
  };
}
const fakeSynth = () => {
  const spoken = [];
  return { spoken, synth: { speak: (u) => spoken.push(u), cancel() { spoken.cancelled = (spoken.cancelled ?? 0) + 1; }, getVoices: () => [] },
    Utterance: function Utterance(text) { this.text = text; } };
};
function rig({ muted = false } = {}) {
  const clock = fakeTimers();
  const log = [];
  const voice = fakeSynth();
  const guide = createGuide({ synth: voice.synth, Utterance: voice.Utterance });
  guide.setMuted(muted);
  const director = createDirector({
    timers: clock,
    onIntroLine: (i, line) => { log.push(['line', i, clock.now]); guide.say(line.text, { interrupt: false }); },
    onIntroEnd: () => log.push(['introEnd', clock.now]),
    beginRun: () => log.push(['run', clock.now]),
    beginPlayback: () => log.push(['playback', clock.now]),
  });
  return { clock, log, voice, guide, director };
}

test('1. a fresh page shows the landing: the question, one sentence about ARGUS, and exactly two explicit choices', () => {
  const html = read('ui/index.html');
  assert.match(html, /WHAT IF YOUR SYSTEM COULD FIND ITS OWN NEXT FAILURE — BEFORE THE OUTAGE\?/);
  assert.match(html, /<div class="sb-line">ARGUS [^<]+\.<\/div>/, 'one sentence explains ARGUS before the choices');
  assert.match(html, /<button id="start-control"[^>]*><b>CONTROL THE SYSTEM<\/b><span>Interactively change the graph and watch ARGUS adapt\.<\/span>/);
  assert.match(html, /<button id="start-demo"[^>]*><b>GUIDED DEMO<\/b><span>A 4-minute guided explanation\.<\/span>/);
  assert.equal([...html.matchAll(/class="choice-cta"/g)].length, 2, 'two choices, no third path');
  assert.match(html, /Nothing starts until you choose\./);
  assert.match(read('ui/js/main.js'), /\$\('#standby'\)\.classList\.toggle\('hidden', director\.phase !== 'landing' \|\| mode !== null\)/);
  const { director } = rig();
  assert.deepEqual([director.phase, director.canPlay()], ['landing', false]);
});

test('2. the demo does not begin before the click: no run, no playback, events only buffer', () => {
  const { clock, log, director } = rig();
  clock.advance(10 * 60 * 1000);
  assert.deepEqual(log, [], 'nothing happens on its own');
  const main = read('ui/js/main.js');
  assert.match(main, /if \(events\.length && director\.canPlay\(\)\) playback\.play\(\);/, 'a loaded log is not played before START');
  assert.match(main, /if \(!userPaused && director\.canPlay\(\)\) playback\.play\(\);/, 'streamed events are not played before START');
});

test('3. one click starts the narration and the canonical run, then playback — no second step', () => {
  const { clock, log, director, voice } = rig();
  assert.equal(director.start(), true);
  assert.deepEqual(log.slice(0, 2), [['line', 0, 0], ['run', 0]], 'the first line is spoken inside the click, and the run is requested at once');
  assert.equal(voice.spoken[0].text, 'What if your system could find its own next failure — before the outage?');
  assert.equal(director.start(), false, 'a second click does nothing');
  clock.advance(director.introMs);
  assert.deepEqual(log.filter(([k]) => k === 'playback'), [['playback', director.introMs]]);
  assert.equal(director.canPlay(), true);
  const main = read('ui/js/main.js');
  // the click: (any presentation stops, the director returns to the landing,) the story and narration are enabled, then the
  // director starts — in that order, so START always requests the run, even after a resumed or bypassed session (M16)
  const click = /\$\('#start-demo'\)\.addEventListener\('click', \(\) => \{([\s\S]*?)\}\);/.exec(main)?.[1] ?? '';
  assert.match(click, /director\.reset\(\);[\s\S]*enterMode\('guided'\);\s*director\.start\(\);/, 'GUIDED DEMO resets the director, enables the story and narration, then starts the director');
  assert.match(main, /if \(!resumed\) ledger\.claim\(\);/, 'the choosing click makes this tab the speaker');
});

test('4. the introduction finishes before the first canonical event is presented', () => {
  const { clock, log, director } = rig();
  const applied = [];
  const playback = createPlayback({ apply: (e) => applied.push([e.seq, clock.now]) });
  playback.setSpeed(1e9);
  director.start();
  // the server streams events during the intro; they buffer (the browser only plays when the director allows)
  for (let k = 1; k <= 5; k++) { playback.push({ seq: k, type: 'TOOL_CALL', payload: {} }); if (director.canPlay()) playback.play(); }
  clock.advance(director.introMs - 1);
  assert.deepEqual(applied, [], 'no ARGUS event is presented during the intro');
  assert.equal(log.filter(([k]) => k === 'line').length, INTRO.length, 'every intro line was presented');
  assert.equal(log.findLast(([k]) => k === 'line')[1], INTRO.length - 1);
  assert.equal(INTRO.at(-1).text, "Let's begin.");
  const lastLine = log.findLast(([k]) => k === 'line')[2];
  clock.advance(1);
  assert.ok(log.find(([k]) => k === 'playback')[1] > lastLine, '"Let\'s begin." comes before playback');
  playback.play();
  assert.ok(director.canPlay());
});

test('5. the voice can be muted: nothing is spoken, cards still show', () => {
  const { guide, voice } = rig({ muted: true });
  assert.equal(guide.say('A line.'), false);
  assert.equal(voice.spoken.length, 0);
  guide.setMuted(false);
  assert.equal(guide.say('First sentence. Second sentence.'), true);
  assert.deepEqual(voice.spoken.map((u) => u.text), ['First sentence.', 'Second sentence.'], 'one utterance per sentence (natural pauses)');
  assert.ok(voice.spoken.every((u) => u.rate < 1), 'a calm, slightly slower pace');
});

test('6. muting does not change playback: the intro schedule and the release of playback are identical', () => {
  const run = (muted) => { const r = rig({ muted }); r.director.start(); r.clock.advance(r.director.introMs + 1000); return r.log; };
  assert.deepEqual(run(true), run(false));
  assert.ok(!/guide|speech|narrat/i.test(read('ui/js/playback.js')), 'the playback queue knows nothing about voice or narration');
});

test('7. speech never delays playback: the director never waits for speech, and a speech engine that never finishes changes nothing', () => {
  const stuck = rig();
  stuck.voice.synth.speak = () => {};          // an engine that never starts or ends an utterance
  stuck.director.start();
  stuck.clock.advance(stuck.director.introMs);
  assert.equal(stuck.log.at(-1)[0], 'playback');
  assert.equal(stuck.log.at(-1)[1], introSchedule().end, 'released exactly on schedule');
  const dir = read('ui/js/director.js');
  assert.ok(!/onend|onboundary|speechSynthesis|await|Promise/.test(dir), 'the start sequence has no dependency on speech completion');
  const guide = read('ui/js/guide.js');
  assert.ok(!/onend|await|Promise/.test(guide), 'speaking is fire-and-forget');
});

test('10. no network or external API for voice: on-device speech only', () => {
  for (const f of ['ui/js/guide.js', 'ui/js/director.js', 'ui/js/story.js', 'ui/js/narration.js']) {
    const code = read(f);
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|EventSource|https?:\/\//.test(code), `${f} makes no network request`);
  }
  const voices = [
    { name: 'Google UK English Male', lang: 'en-GB', localService: false },      // network-backed
    { name: 'Microsoft Guy Online (Natural)', lang: 'en-US', localService: false },
    { name: 'Microsoft David', lang: 'en-US', localService: true },
    { name: 'Microsoft George', lang: 'en-GB', localService: true },
  ];
  assert.equal(pickVoice(voices).name, 'Microsoft George', 'the most natural on-device voice');
  assert.equal(pickVoice(voices.filter((v) => !v.localService)), null, 'never a network voice');
  assert.deepEqual(sentences("But prediction isn't enough. We now compare."), ["But prediction isn't enough.", 'We now compare.']);
});
