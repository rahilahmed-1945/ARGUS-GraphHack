// The narration voice: the browser's own, on-device speech synthesis, provided to the narration beat ledger
// (narration.js), which is the only caller of say(). Purely presentational: it never touches the playback queue, the
// reducer or the event stream, and nothing here waits for speech — so narration cannot block or delay ARGUS
// playback. Speech is unlocked by the click that chooses a mode (a user gesture).

/* VOICE — calm, deliberate delivery: slightly slower than default, steady pitch, one utterance per sentence so the
   pauses fall where a person would breathe. Only on-device voices are used (no network-backed "online" voices). */
export const VOICE = Object.freeze({ RATE: 0.92, PITCH: 0.97, PREFERRED: [
  // natural-sounding on-device English voices, best first (macOS, Windows, Linux/ChromeOS names)
  'Daniel', 'Oliver', 'Arthur', 'Serena', 'Samantha', 'Alex', 'Karen', 'Moira', 'Tessa',
  'Microsoft George', 'Microsoft Ryan', 'Microsoft Libby', 'Microsoft Mark', 'Microsoft Guy', 'Microsoft Aria', 'Microsoft David', 'Microsoft Zira',
  'English (Great Britain)', 'English (America)',
] });
/* END VOICE */

/** the voice to use: an on-device English voice, preferring the natural-sounding ones; never a network voice */
export function pickVoice(voices) {
  const local = voices.filter((v) => v.localService !== false && /^en([-_]|$)/i.test(v.lang ?? ''));
  for (const name of VOICE.PREFERRED) {
    const v = local.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return local.find((v) => /^en[-_](GB|US)/i.test(v.lang)) ?? local[0] ?? null;
}

/** split a line into sentences, so each is spoken as its own utterance with a natural pause between */
export const sentences = (text) => String(text).match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

export function createGuide({ synth = (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null), Utterance = globalThis.SpeechSynthesisUtterance } = {}) {
  let muted = false;
  let volume = 0.9;
  let suppressed = false;
  let voice = null;
  const refresh = () => { voice = pickVoice(synth?.getVoices?.() ?? []); };
  if (synth) { refresh(); synth.addEventListener?.('voiceschanged', refresh); }

  /** fire-and-forget: queue the sentences of `text`; `interrupt` first cancels whatever is still being said */
  function say(text, { interrupt = true } = {}) {
    if (!synth || !Utterance || muted || suppressed || !text) return false;
    if (interrupt) synth.cancel();
    if (!voice) refresh();
    for (const line of sentences(text)) {
      const u = new Utterance(line);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = VOICE.RATE;
      u.pitch = VOICE.PITCH;
      u.volume = volume;
      synth.speak(u);
    }
    return true;
  }

  return {
    say,
    // speech is cancelled only by the ledger moving to a new beat (say interrupt) or by muting
    // during a jump (seek) many events are applied at once: say nothing
    suppress(v) { suppressed = v; },
    get suppressed() { return suppressed; },
    setMuted(v) { muted = v; if (v) synth?.cancel(); },
    setVolume(v) { volume = Math.min(1, Math.max(0, v)); },
    get muted() { return muted; },
    get voiceName() { return voice?.name ?? null; },
    get speechAvailable() { return !!synth && !!Utterance; },
  };
}
