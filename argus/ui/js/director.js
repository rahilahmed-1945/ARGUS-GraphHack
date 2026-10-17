// The guided start sequence: landing → introduction (the problem and the cast) → canonical playback. Pure and
// timer-injected (runs in Node tests with a fake clock). One START click does everything: it enables narration,
// speaks the first intro line inside the click (the user gesture browsers require for speech), asks the server to run the canonical demo (its
// events buffer while the intro plays), and releases playback after "Let's begin." The intro runs on a FIXED
// schedule derived from its text — it never waits for speech, so speech can never delay or hold playback.
import { CAST } from './story.js';

/* INTRODUCTION — fixed copy: the problem and the cast, shown as cards and spoken, before the first ARGUS event is
   played. `speech` (when present) is what is said; the card shows `text`. */
export const INTRO = Object.freeze([
  { kicker: 'ARGUS', text: 'What if your system could find its own next failure — before the outage?',
    speech: 'What if your system could find its own next failure, before the outage?' },
  { kicker: 'THE PROBLEM', text: 'This is an online payment system. A slowdown in one service can spread through retries and take the whole purchase flow down.' },
  { kicker: CAST[0].title, text: CAST[0].text, speech: `FalkorDB holds the system twin. ${CAST[0].text}` },
  { kicker: CAST[1].title, text: CAST[1].text, speech: `RED: find the failure. ${CAST[1].text}` },
  { kicker: CAST[2].title, text: CAST[2].text, speech: `BLUE: find the fix. ${CAST[2].text}` },
  { kicker: CAST[3].title, text: CAST[3].text, speech: 'And a separate copy plays the role of production. That is where we check whether ARGUS was right.' },
  { kicker: '', text: "Let's begin." },
]);
/* reading time per line: a calm speaking pace (ms per character) with a floor, plus a pause between lines */
export const INTRO_PACE = Object.freeze({ MS_PER_CHAR: 66, MIN_MS: 1500, PAUSE_MS: 450 });
/* END INTRODUCTION */

/** when each intro line starts (ms after START) and when playback is released */
export function introSchedule(lines = INTRO, pace = INTRO_PACE) {
  let t = 0;
  const at = lines.map((line) => {
    const start = t;
    t += Math.max(pace.MIN_MS, (line.speech ?? line.text).length * pace.MS_PER_CHAR) + pace.PAUSE_MS;   // timed by what is said
    return { start, line };
  });
  return { at, end: t };
}

/**
 * @param {object} hooks
 * @param {function} hooks.onIntroLine   (index, line) — show (and optionally speak) an intro line
 * @param {function} hooks.onIntroEnd    () — hide the intro
 * @param {function} hooks.beginRun      () — ask the server for the canonical run (events buffer meanwhile)
 * @param {function} hooks.beginPlayback () — start presenting events
 * @param {object} [hooks.timers]        {setTimeout, clearTimeout}
 */
export function createDirector({ onIntroLine, onIntroEnd, beginRun, beginPlayback, timers = globalThis }) {
  let phase = 'landing';                 // landing | intro | playing
  const pending = [];
  const sched = introSchedule();
  return {
    get phase() { return phase; },
    get introMs() { return sched.end; },
    /** playback may present events only once the intro is over (or an operator bypassed it) */
    canPlay() { return phase === 'playing'; },
    /** the single START click */
    start() {
      if (phase !== 'landing') return false;
      phase = 'intro';
      onIntroLine(0, sched.at[0].line);            // synchronously, inside the user gesture
      beginRun();
      for (const [i, { start, line }] of sched.at.entries()) {
        if (i === 0) continue;
        pending.push(timers.setTimeout(() => onIntroLine(i, line), start));
      }
      pending.push(timers.setTimeout(() => { phase = 'playing'; onIntroEnd(); beginPlayback(); }, sched.end));
      return true;
    },
    /** an operator control (Run / Replay) skips the landing and intro */
    bypass() { for (const t of pending.splice(0)) timers.clearTimeout(t); if (phase === 'intro') onIntroEnd(); phase = 'playing'; },
  };
}
