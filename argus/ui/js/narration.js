// Narration beat ledger: the ONLY code that may start speech. Every spoken line is a fixed beat, and a beat is
// spoken at most once per run + round — the key is recorded BEFORE speech is attempted, so nothing (a repeated or
// re-sent event, a socket reconnect, a page reload, Replay, mute/unmute, a speech failure) can make it speak again.
// A new run id (Reset / Run again → a new server session) starts a fresh ledger. One tab per browser speaks: START
// claims the speaker role over a BroadcastChannel and every other tab falls silent. Pure apart from the injected
// speak/cancel/storage/channel/log, so it runs unchanged in Node tests with fakes.

/* the intro's beats: one per line, all in the 'intro' group (they queue; moving between them never cancels) */
export const introBeat = (i) => `intro_${i + 1}`;
const group = (beat) => (beat.startsWith('intro_') ? 'intro' : beat);
const STORE_PREFIX = 'argus.narration.';

/**
 * @param {object} o
 * @param {function} o.speak     (text, {interrupt}) → truthy when speech was queued; may throw
 * @param {function} [o.cancel]  stop the speech in progress (mute, losing the speaker role)
 * @param {Storage}  [o.storage] sessionStorage: reload protection (per run)
 * @param {BroadcastChannel} [o.channel]  single-speaker protection across tabs
 * @param {function} [o.log]     one line per beat: `NARRATION <beat> → spoken` / `… → skipped (already spoken)`
 * @param {string}   [o.tabId]
 */
export function createNarrationLedger({ speak, cancel = () => {}, storage = null, channel = null, log = (line) => console.log(line),
  tabId = Math.random().toString(36).slice(2) } = {}) {
  let run = null;
  let spoken = new Set();
  let speaker = false;
  let muted = false;
  let current = null;                    // the beat whose speech may still be playing
  const quietly = (f) => { try { f(); } catch { /* speech failures never affect playback */ } };

  const load = (r) => { try { return new Set(JSON.parse(storage?.getItem(STORE_PREFIX + r) ?? '[]')); } catch { return new Set(); } };
  const persist = () => { try { storage?.setItem(STORE_PREFIX + run, JSON.stringify([...spoken])); } catch { /* storage is best effort */ } };

  // another tab claimed the speaker role: this one stops and stays silent
  const onMessage = (e) => {
    if (e?.data?.type !== 'claim' || e.data.tab === tabId || !speaker) return;
    speaker = false;
    quietly(cancel);
    log(`NARRATION speaker → another tab`);
  };
  channel?.addEventListener?.('message', onMessage);

  return {
    get run() { return run; },
    get speaker() { return speaker; },
    get muted() { return muted; },
    get size() { return spoken.size; },
    keyOf: (round, beat) => `${run}:${round ?? 0}:${beat}`,
    has(round, beat) { return spoken.has(`${run}:${round ?? 0}:${beat}`); },
    /** the server's run id (session); a different id starts a fresh ledger (restored from storage after a reload) */
    setRun(r) {
      if (r === run || r === null || r === undefined) return false;
      run = r;
      spoken = load(r);
      current = null;
      return true;
    },
    /** this tab becomes the only speaker in the browser (the START click) */
    claim() {
      speaker = true;
      try { channel?.postMessage({ type: 'claim', tab: tabId }); } catch { /* a missing channel only loses cross-tab protection */ }
    },
    /** muting stops the current speech; unmuting never replays a beat that passed while muted */
    setMuted(v) { muted = !!v; if (muted) quietly(cancel); },
    /** speak one beat at most once per run + round. Never throws, never waits. */
    narrate({ round = 0, beat, text }) {
      if (!beat || !text) return false;
      const key = `${run}:${round ?? 0}:${beat}`;
      if (spoken.has(key)) { log(`NARRATION ${beat} → skipped (already spoken)`); return false; }
      // a tab that is not the speaker says nothing and consumes nothing (it may become the speaker later)
      if (!speaker) { log(`NARRATION ${beat} → skipped (another tab is the speaker)`); return false; }
      spoken.add(key);                   // recorded BEFORE speech: a failure below can never cause a second attempt
      persist();
      if (muted) { log(`NARRATION ${beat} → skipped (muted)`); return false; }
      const fresh = current !== null && group(beat) !== group(current);   // cancel only when a genuinely new beat starts
      current = beat;
      let ok = false;
      try { ok = !!speak(text, { interrupt: fresh }); } catch (e) { log(`NARRATION ${beat} → speech failed (${e?.message ?? e})`); return false; }
      log(ok ? `NARRATION ${beat} → spoken` : `NARRATION ${beat} → skipped (speech unavailable)`);
      return ok;
    },
    close() { channel?.removeEventListener?.('message', onMessage); },
  };
}
