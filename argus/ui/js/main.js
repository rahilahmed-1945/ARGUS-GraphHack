// Wiring: Socket.IO session stream → playback queue → reducer → 3D twin + the story layer. Nothing starts until the
// visitor chooses CONTROL THE SYSTEM or GUIDED DEMO on the landing page.
import { io } from '/socket.io/socket.io.esm.min.js';
import { initialState, applyEvent, previewState } from './state.js';
import { createPlayback } from './playback.js';
import { createGraphView } from './graph3d.js';
import { createPanels } from './panels.js';
import { createGuide } from './guide.js';
import { createDirector, INTRO } from './director.js';
import { createNarrationLedger, introBeat } from './narration.js';
import { storyModel } from './story.js';
import { createStoryView } from './story-view.js';

const $ = (s) => document.querySelector(s);
const SPEEDS = [1, 2, 4];
/* DISPLAY CONSTANTS — Control mode: how long the judge's change (and its spoken explanation) stays on screen (ms)
   before the run starts. Both modes play at 1×, so every cause can be followed to its effect. */
const JUDGE_HOLD_MS = 6500;
/* END DISPLAY CONSTANTS */

let state = initialState();
const seqTimes = new Map();
const graph = createGraphView($('#twin'));
const panels = createPanels();
let speedIdx = 0;
panels.setSpeedSource(() => SPEEDS[speedIdx]);
const guide = createGuide();
// the beat ledger is the only path to speech: once per run + round + beat, one speaking tab per browser
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('argus-narration') : null;
let storage = null;
try { storage = window.sessionStorage; } catch { /* storage blocked: reload protection is lost, nothing else */ }
const ledger = createNarrationLedger({ speak: (text, o) => guide.say(text, o), cancel: () => window.speechSynthesis?.cancel(), storage, channel });

// the story layer: null until the visitor chooses 'control' or 'guided'
let mode = null;
let judge = null;                 // Control mode: the judge's configuration (side channel)
let preview = null;               // the graph as FalkorDB holds it before a run (side channel)
const traces = new Map();         // the stored Cypher of each Step (side channel)
let story = null;
let lastSpeech = null;
let configuring = false;          // Control mode: a choice was clicked; the buttons stay disabled until the next fresh start
const storyView = createStoryView({ onChoose: chooseConfiguration, onAttackAgain: () => send('attack-again') });

// recompute the story from what has been presented so far; speak when a new beat is reached
function tellStory() {
  if (!mode) return;
  const pb = playback.status();
  story = storyModel(playback.log.slice(0, pb.cursor), state, { mode, judge, traces, awaiting: server.awaiting === 'attack-again' && pb.caughtUp,
    amplification: preview?.session === server.session ? preview.amplification : null });
  // the judge's click opens a new session (a fresh ledger) before its change is reported: the "choose" beat must not repeat
  const s = configuring && story.chapter === 'choose' ? null : story.speech;
  const key = s ? `${ledger.run}:${s.round}:${s.beat}` : null;
  if (key && key !== lastSpeech && !guide.suppressed) { lastSpeech = key; ledger.narrate(s); }
  render();
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    panels.render(state);
    document.body.dataset.actor = state.actor ?? 'none';
    const fx = panels.futuresHeight();
    if (mode && story) {
      const pb = playback.status();
      storyView.render(story, { choices: server.choices, canChoose: !configuring && ['ready', 'done', 'failed'].includes(server.status), canAttack: server.awaiting === 'attack-again' && pb.caughtUp });
      document.body.dataset.status = story.status.key;
      $('#status-text').textContent = story.status.label;
      // frame the twin into the space between the Story panel and the Evidence column (their widths follow the screen)
      const wi = $('#whatif').classList.contains('show') ? $('#whatif').offsetHeight : 0;
      const fin = story.final ? $('#final').offsetHeight + 60 : 0;
      graph.update(state, (seq) => seqTimes.get(seq) ?? 0, { top: Math.max(70, fin), bottom: wi ? wi + 50 : 60,
        left: $('#story').offsetWidth + 20, right: $('#evidence').offsetWidth + 20 });
      return;
    }
    document.body.dataset.status = state.status.key;
    graph.update(state, (seq) => seqTimes.get(seq) ?? 0, { top: state.result ? 205 : 92, bottom: fx ? fx + 54 : 60 });
  });
}

const playback = createPlayback({
  apply(ev) {
    applyEvent(state, ev); seqTimes.set(ev.seq, performance.now()); tellStory();
    render();
  },
  onChange: () => controls(),
});

function resetView() {
  state = mode && preview && preview.session === server.session ? previewState(preview.graphs, preview.amplification) : initialState();
  seqTimes.clear();
  panels.clear();
  graph.reset();
  storyView.clear();
  tellStory();
  render();
}

// ---------------------------------------------------------------- server session
const socket = io({ transports: ['websocket'] });
let server = { session: null, runId: null, status: 'connecting', mode: '', source: '', awaiting: null, interactive: false, choices: [] };

function onInfo(info) {
  server = { ...server, ...info };
  ledger.setRun(info.runId);                         // a new run id (Reset / Run again) → a fresh narration ledger
  if (info.interactive && !mode) enterMode('control', { resumed: true });   // a reload during a Control session
  controls();
}
socket.on('hello', onInfo);
socket.on('status', onInfo);
socket.on('log', ({ session, events }) => {
  if (session !== server.session || playback.log.length === 0 || events.length === 0) {
    if (session !== server.session) { traces.clear(); if (judge?.session !== session) judge = null; }
    server.session = session;
    resetView();
    playback.load(events);
    if (events.length && director.canPlay()) playback.play();
  } else {
    for (const ev of events) playback.push(ev);       // reconnect: fill any gap, keep position
  }
  controls();
});
socket.on('event', ({ session, ev }) => {
  if (session !== server.session) return;
  playback.push(ev);
  if (!userPaused && director.canPlay()) playback.play();   // events buffer during the landing and the intro
});
socket.on('judge', (j) => { if (j.session === server.session) { judge = j; tellStory(); } });
socket.on('preview', (p) => {
  preview = p;
  if (mode && p.session === server.session && playback.log.length === 0) { state = previewState(p.graphs, p.amplification); tellStory(); }
});
socket.on('trace', (t) => { if (t.session === server.session) { traces.set(t.seq, t); if (mode) tellStory(); } });
socket.on('connect', () => { $('#conn').className = 'conn on'; });
socket.on('disconnect', () => { $('#conn').className = 'conn off'; });

// ---------------------------------------------------------------- operator controls (hidden; O shows them)
let userPaused = false;
// a public deployment may require an operator token for live runs: the operator opens the page as ?op=<token>; the
// token travels only inside control messages (never rendered, never stored) and is removed from the address bar
const opToken = new URLSearchParams(location.search).get('op');
if (opToken) history.replaceState(null, '', location.pathname + location.hash);
const send = (action, extra = {}) => new Promise((resolve) => socket.emit('control', { action, ...extra, ...(opToken ? { token: opToken } : {}) }, resolve));

$('#btn-run').addEventListener('click', async () => {
  director.bypass();
  userPaused = false;
  if (server.status === 'ready' && playback.log.length === 0) { playback.play(); await send('start', { interactive: mode === 'control' }); return; }
  if (server.status === 'running') { playback.play(); return; }
  await send('start', { interactive: mode === 'control' });        // a finished session: the server resets and runs again
  playback.play();
});
$('#btn-pause').addEventListener('click', () => {
  if (playback.status().playing) { userPaused = true; playback.pause(); } else { userPaused = false; playback.play(); }
});
$('#btn-speed').addEventListener('click', () => { speedIdx = (speedIdx + 1) % SPEEDS.length; playback.setSpeed(SPEEDS[speedIdx]); });
$('#btn-replay').addEventListener('click', () => { if (!playback.log.length) return; director.bypass(); resetView(); userPaused = false; playback.restart(); playback.play(); });
$('#btn-reset').addEventListener('click', async () => { userPaused = false; configuring = false; playback.pause(); await send('reset'); });

// ---------------------------------------------------------------- GUIDED DEMO: one click → the cast → the canonical run
async function beginRun() {
  if (server.status === 'running') return;
  await send('start');        // a finished session: the server resets FalkorDB and runs the canonical demo again
}
const director = createDirector({
  onIntroLine(i, line) {
    $('#intro-kicker').textContent = line.kicker;
    $('#intro-text').textContent = line.text;
    $('#intro-dots').innerHTML = INTRO.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('');
    const el = $('#intro');
    el.classList.remove('line'); void el.offsetWidth; el.classList.add('show', 'line');
    document.body.dataset.intro = 'on';               // the twin steps back while the cast is introduced
    ledger.narrate({ round: 0, beat: introBeat(i), text: line.speech ?? line.text });   // never awaited: the intro runs on its own fixed schedule
  },
  onIntroEnd() { $('#intro').classList.remove('show'); delete document.body.dataset.intro; controls(); },
  beginRun,
  beginPlayback() { userPaused = false; playback.play(); controls(); },
});

function enterMode(next, { resumed = false } = {}) {
  mode = next;
  document.body.dataset.mode = next;
  graph.setMinimal(true);                             // the story carries the meaning; no decorative effects
  if (!resumed) ledger.claim();                       // the click: this tab becomes the only speaker (speech unlocked)
  if (next === 'control') {                           // no intro: the Story panel and the voice explain as it happens
    director.bypass();
    userPaused = false;
    if (playback.log.length) playback.play();         // a reload mid-session continues from the start of the story
  }
  if (playback.log.length === 0 && preview?.session === server.session) state = previewState(preview.graphs, preview.amplification);
  tellStory();
  controls();
}
$('#start-demo').addEventListener('click', () => {
  enterMode('guided');
  director.start();
  controls(); render();
});
// ---------------------------------------------------------------- CONTROL THE SYSTEM: the judge configures, then attacks again
$('#start-control').addEventListener('click', async () => {
  if (server.status !== 'ready' || server.interactive) await send('reset');   // start from the untouched graph
  configuring = false;
  enterMode('control');
});
async function chooseConfiguration(choice) {
  configuring = true;
  await send('configure', { choice });                // a real write on TWIN and WORLD; the judge message follows
  setTimeout(async () => { userPaused = false; playback.play(); await send('start', { interactive: true }); }, JUDGE_HOLD_MS);
}

// the voice: on by default once a mode is chosen; muting never replays what was missed
$('#voice-toggle').addEventListener('click', () => {
  if (!ledger.speaker) { ledger.claim(); guide.setMuted(false); }   // e.g. after a reload: this click makes this tab the speaker
  else guide.setMuted(!guide.muted);
  ledger.setMuted(guide.muted);
  controls();
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea')) return;
  if (e.code === 'Space' && mode) { e.preventDefault(); $('#btn-pause').click(); }
  if (e.code === 'KeyO') document.body.dataset.ops = document.body.dataset.ops === 'on' ? 'off' : 'on';
});

function controls() {
  const pb = playback.status();
  const running = server.status === 'running';
  $('#btn-run').disabled = running && pb.playing;
  $('#btn-run').textContent = server.status === 'done' || server.status === 'failed' ? 'Run again' : 'Run';
  $('#btn-pause').textContent = pb.playing ? 'Pause' : 'Resume';
  $('#btn-pause').disabled = !pb.total;
  $('#btn-replay').disabled = !pb.total;
  $('#btn-speed').textContent = `${SPEEDS[speedIdx]}×`;
  // the engine badge names what decides: a live LLM, the scripted reference models, a cassette or the B5 autopilot
  const engine = server.mode === 'live' ? 'LIVE LLM' : server.mode === 'interactive' ? 'INTERACTIVE (scripted)' : server.mode ? server.mode.toUpperCase() : '—';
  $('#engine').textContent = `${engine} · ${server.status}${server.error ? ` · ${server.error}` : ''}`;
  document.body.dataset.engine = server.mode || 'none';
  // provenance (what produced this run): always in live mode (model, ceiling, then who decided each phase and why B5
  // took over where it did); otherwise once it describes the session on screen
  const phases = server.phases?.length
    ? ` · ${server.phases.map((p) => `R${p.round} ${String(p.role).toUpperCase()} ${p.proposedBy === 'b5' ? 'autopilot' : p.proposedBy}${p.takeover ? ` (${p.takeover.reason})` : ''}`).join(' · ')}` : '';
  $('#source').textContent = server.mode === 'live' || mode === 'guided' || (mode === 'control' && server.interactive) ? `${server.source ?? ''}${phases}` : '';
  $('#progress').textContent = pb.total ? `event ${pb.cursor}/${pb.total}` : 'no events';
  $('#standby').classList.toggle('hidden', director.phase !== 'landing' || mode !== null);
  const v = $('#voice-toggle');
  const on = !guide.muted && ledger.speaker;
  v.textContent = on ? '🔊  Narration on' : '🔇  Narration off';
  v.setAttribute('aria-pressed', String(on));
  v.disabled = !guide.speechAvailable;
  if (mode) tellStory();                              // ATTACK AGAIN follows the presentation catching up
}

render();
controls();

// read-only handle for inspection (operators, tests): the reducer state, the playback queue and the story
window.argus = { get state() { return state; }, playback, get server() { return server; },
  seekTo(pred) { const i = playback.log.findIndex(pred); if (i < 0) return null; resetView(); guide.suppress(true); playback.seek(i + 1); guide.suppress(false); userPaused = true; return { cursor: i + 1, type: playback.log[i].type }; },
  guide, director, ledger, get story() { return story; }, get mode() { return mode; }, get judge() { return judge; }, traces };
