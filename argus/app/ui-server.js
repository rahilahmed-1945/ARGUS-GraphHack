// ARGUS command-center server (M10). Serves the static UI (ui/), the three.js build, and the canonical run's
// authoritative event stream over Socket.IO. It runs the REAL runtime — runCanonicalDemo over the MCP tool servers
// against FalkorDB — in replay (reference cassette, default), autopilot (B5) or live (real LLM via OpenRouter) mode.
// The browser never simulates anything: it only presents the events this process emits.
//
// Live mode (opt-in, `--mode live`): the production provider and agent adapters, exactly as `npm run demo -- --mode
// live`, with the configured turn ceiling (`--ceiling-ms`, default spec 6 s) and a cassette recording. The session
// is labelled live LLM with the model id and ceiling; every phase's `proposedBy` (llm | b5) and takeover reason are
// reported after the run (`info().phases`) and written into the cassette's provenance. Judge configuration and the
// interactive start are refused in live mode, so a live session can never silently switch to the scripted models.
//
// Interactive judge demo (opt-in): the judge picks one validated graph configuration (a real FalkorDB write on
// TWIN and WORLD), the run uses the deterministic reference reasoning models live (no cassette: they react to the
// changed graph), and the run pauses before round 2 until the judge presses ATTACK AGAIN. Everything interactive
// travels on side channels; the canonical event stream and its schema are untouched.
//
//   npm run ui                                  replay the reference cassette
//   npm run ui -- --mode autopilot              deterministic B5 only
//   npm run ui -- --mode live [--ceiling-ms <n>] [--record <file>]   real LLM (needs OPENROUTER_API_KEY + ARGUS_LLM_MODEL)
//   options: --port <n> (default 4173)  --cassette <file>  --autostart
//
// Socket.IO protocol (namespace /):
//   server → client  'hello'   {session, runId, status, mode, source, awaiting, interactive, choices,
//                               live, model, ceilingMs, phases, cassette}                                on connect
//                    'log'     {session, events}            every event of the session so far, on connect
//                    'event'   {session, ev}                each new canonical event {seq, type, round, tick, payload}
//                    'status'  {…same as hello}             run lifecycle: ready | running | awaiting | done | failed
//                    'preview' {session, graphs, amplification}   the graph as it is now, read from FalkorDB (before a run)
//                    'judge'   {session, at, choice, edits, amplification: {before, after}}   the judge's configuration
//                    'trace'   {session, seq, step, at, cypher}  the stored Cypher of the Step a TOOL_RESULT reports
//   client → server  'control' {action, …}, ack(status)
//     start {interactive?}   run the demo (a finished session is reset first)      reset   new empty session
//     configure {choice}     interactive: reset, then apply one validated configuration
//     attack-again           interactive: release the pause before round 2
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { connect, rows, roRows, GRAPHS } from '../graph/db.js';
import { bootstrapAcl } from '../graph/acl.js';
import { reset } from '../graph/reset.js';
import { loadTopology } from '../graph/topology.js';
import { regenerateActionSpaces } from '../graph/schema.js';
import { createEventBus } from '../runtime/events.js';
import { createWorldClock } from '../runtime/clock.js';
import { runCanonicalDemo, graphState } from '../runtime/demo.js';
import { createToolbox, Q } from '../runtime/tools.js';
import { B5_POLICY } from '../runtime/b5.js';
import { createRedAgent } from '../runtime/red.js';
import { createBlueAgent } from '../runtime/blue.js';
import { createCassette, TAKEOVER } from '../runtime/runtime.js';
import { saveCassette, loadCassette, phaseSummary } from '../runtime/cassette-file.js';
import { createLLMFromEnv, ProviderConfigError } from '../runtime/providers/openrouter.js';
import { createMcpToolbox } from '../mcp/client.js';
// the deterministic reference reasoning models (they reason only from tool results; no graph access, no network)
import { createScriptedRedModel } from '../tests/fixtures/red-model.js';
import { createScriptedBlueModel } from '../tests/fixtures/blue-model.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI_DIR = join(ROOT, 'ui');
const THREE_DIR = join(ROOT, 'node_modules', 'three');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/* JUDGE CHOICES — the only configurations a judge may pick. Each was verified end to end (RED adapts, BLUE and the
   verifier find a fix, ATTACK AGAIN finds a different attack, the WORLD ends SAFE). Arbitrary edits are never accepted. */
export const JUDGE_CHOICES = Object.freeze([
  { id: 'keep', label: 'Keep retries', detail: 'Gateway → Checkout keeps retrying failed calls', edits: [] },
  { id: 'off', label: 'Turn retries off', detail: 'Gateway → Checkout stops retrying failed calls',
    edits: [{ caller: 'gateway', callee: 'checkout', field: 'retries', value: 0 }] },
]);
/* END JUDGE CHOICES */
const INTERACTIVE_SOURCE = 'reference reasoning models (deterministic, offline) — not a live LLM';

// a path inside `base`, or null (no traversal out of the served directories)
function within(base, rel) {
  const p = normalize(join(base, decodeURIComponent(rel)));
  return p === base || p.startsWith(base + sep) ? p : null;
}

/**
 * @param {object} o
 * @param {'replay'|'autopilot'|'live'} [o.mode]
 * @param {string} [o.cassettePath]
 * @param {number} [o.port]   0 = any free port
 * @param {string} [o.host]
 * @param {object} [o.llm]         live: an injected LLM (tests: the offline mock provider); default createLLMFromEnv(env)
 * @param {object} [o.env]         live: environment for createLLMFromEnv (default process.env)
 * @param {number} [o.ceilingMs]   live: per-turn LLM ceiling (default TAKEOVER.TURN_CEILING_MS = spec 6 s)
 * @param {string} [o.recordPath]  live: cassette file for each run (default cassettes/recorded-ui-live-<timestamp>.json)
 * @param {string|null} [o.operatorToken]  public deployment: when set, a live `start` over the socket must carry this token
 *                                   (`control {action:'start', token}`); anonymous visitors cannot spend the provider quota.
 *                                   Replay, autopilot and the interactive judge demo stay open. The in-process control()
 *                                   API (tests, operator scripts) is trusted and never needs it.
 * @param {number} [o.cooldownMs]    public deployment: minimum gap between two runs STARTED from the same client address; the
 *                                   operator token bypasses it. 0 = off (local default). Only `start` is rate-limited: reset
 *                                   and configure are the steps of one interaction (the judge's choice is configure, then
 *                                   start a few seconds later) and ATTACK AGAIN continues a paused run; none of them may
 *                                   be refused by the cooldown, or the visitor is left waiting for nothing.
 * @param {number} [o.liveMaxRunsPerDay]  public deployment: cap on live runs per UTC day (free provider quota); Infinity = off.
 */
export async function startUiServer({ mode = 'replay', cassettePath = join(ROOT, 'cassettes', 'reference-scripted.json'), port = 4173, host = '127.0.0.1',
  llm = null, env = process.env, ceilingMs = TAKEOVER.TURN_CEILING_MS, recordPath = null,
  operatorToken = null, cooldownMs = 0, liveMaxRunsPerDay = Infinity } = {}) {
  if (!['replay', 'autopilot', 'live'].includes(mode)) throw new Error(`ui-server mode must be replay, autopilot or live`);
  if (!Number.isInteger(ceilingMs) || ceilingMs <= 0) throw new Error(`ceilingMs must be a positive integer of milliseconds (default ${TAKEOVER.TURN_CEILING_MS})`);
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0) throw new Error('cooldownMs must be a non-negative integer of milliseconds');
  if (!(liveMaxRunsPerDay === Infinity || (Number.isInteger(liveMaxRunsPerDay) && liveMaxRunsPerDay >= 0))) throw new Error('liveMaxRunsPerDay must be a non-negative integer or Infinity');
  if (operatorToken !== null && (typeof operatorToken !== 'string' || operatorToken.length < 16)) throw new Error('operatorToken must be a string of at least 16 characters');
  // live: the provider is configured first, so a missing key or model fails here, before anything touches the database
  const live = mode === 'live' ? (llm ?? createLLMFromEnv(env)) : null;
  const replay = mode === 'replay' ? loadCassette(cassettePath) : null;
  const source = live ? `live LLM · ${live.provider} · ${live.model} · turn ceiling ${ceilingMs} ms`
    : replay ? `cassette · ${replay.source}${replay.provenance ? ` · ${phaseSummary(replay.provenance.phases)}` : ''}`
      + `${replay.provenance?.late_decisions ? ` · ${replay.provenance.late_decisions} late decision(s) excluded` : ''}`
      : 'deterministic B5 autopilot';
  const instance = `${process.pid}.${Date.now().toString(36)}`;      // run ids stay unique across server restarts

  await bootstrapAcl();
  const db = await connect();
  const agentDb = await connect({ as: 'agent' });
  const mcp = {};
  const toolbox = (role) => async (ctx) => {
    mcp[role] ??= await createMcpToolbox({ role, ctx });
    mcp[role].setCtx(ctx);
    return mcp[role];
  };

  // ---------------------------------------------------------------- sessions: one bus per run
  let session = 0;
  let bus = createEventBus();
  let status = 'ready';
  let error = null;
  let unsubscribe = () => {};
  let queue = Promise.resolve();          // lifecycle actions run one at a time
  let interactive = false;                // the current session is a judge session
  let judge = null;                       // the judge's configuration of this session
  let awaiting = null;                    // 'attack-again' while the run is paused before round 2
  let release = null;
  let traces = [];
  let phases = null;                      // live: per-phase provenance of the completed run (DEMO_COMPLETED.phases)
  let cassette = null;                    // live: where the completed run's cassette was written
  // public-deployment guards (all off by default): operator token for live runs, per-client cooldown, daily live-run cap
  const liveRuns = { day: null, count: 0 };
  const liveRunsToday = () => { const day = new Date().toISOString().slice(0, 10); if (liveRuns.day !== day) { liveRuns.day = day; liveRuns.count = 0; } return liveRuns.count; };
  const lastStart = new Map();             // client address → time of the last run it started (the cooldown clock)
  const info = () => ({ session, runId: `${instance}-${session}`, status, mode: interactive ? 'interactive' : mode,
    source: interactive ? INTERACTIVE_SOURCE : source, error, awaiting, interactive,
    choices: JUDGE_CHOICES.map(({ id, label, detail }) => ({ id, label, detail })),
    live: !!live, model: live?.model ?? null, ceilingMs: live ? ceilingMs : null, phases, cassette,
    operatorRequired: !!(live && operatorToken), liveRunsToday: live ? liveRunsToday() : null,
    liveMaxRunsPerDay: live && liveMaxRunsPerDay !== Infinity ? liveMaxRunsPerDay : null, cooldownMs });

  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/state') return send(res, 200, TYPES['.json'], JSON.stringify({ ...info(), events: bus.log.length, view: bus.state() }));
      let file = null;
      if (url.pathname.startsWith('/vendor/three/')) file = within(THREE_DIR, url.pathname.slice('/vendor/three/'.length));
      else file = within(UI_DIR, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!file) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', await readFile(file));
    } catch {
      return send(res, 404, 'text/plain', 'not found');
    }
  });
  const io = new Server(http);

  // the graph as FalkorDB holds it right now, and what the amplification query (the same Cypher RED uses) returns
  const amplification = async () => roRows(db, GRAPHS.twin, Q.amplification_paths, { min_risk: B5_POLICY.AMP_MIN_RISK });
  const preview = async () => ({ session, graphs: { twin: await graphState(db, GRAPHS.twin), world: await graphState(db, GRAPHS.world) }, amplification: await amplification() });
  const sendPreview = async (target = io) => target.emit('preview', await preview());

  const openSession = () => {
    unsubscribe();
    session += 1;
    bus = createEventBus();
    error = null;
    awaiting = null;
    release = null;
    traces = [];
    phases = null;
    cassette = null;
    const s = session;
    unsubscribe = bus.subscribe((ev) => {
      io.emit('event', { session: s, ev });
      // side channel: the Cypher the tool layer stored for this Step (FalkorDB visibility; the event is unchanged)
      if (ev.type === 'TOOL_RESULT' && ev.payload?.step) {
        const at = Date.now();                                   // when the tool layer reported this step
        roRows(db, GRAPHS.twin, 'MATCH (st:Step {i:$i}) RETURN st.cypher AS cypher', { i: ev.payload.step })
          .then((r) => { if (s !== session) return; const t = { session: s, seq: ev.seq, step: ev.payload.step, at, cypher: r[0]?.cypher ?? '' }; traces.push(t); io.emit('trace', t); })
          .catch(() => {});
      }
    });
    io.emit('log', { session, events: [] });
  };
  const setStatus = (next) => { status = next; io.emit('status', info()); };

  const doReset = async ({ keepInteractive = false } = {}) => {
    if (release) { release(); release = null; }             // never leave a paused run behind
    await reset(db);
    if (!keepInteractive) { interactive = false; judge = null; }
    openSession();
    setStatus('ready');
    await sendPreview();
  };

  // interactive: a fresh session with the judge's validated configuration written to TWIN and WORLD
  const doConfigure = async (choiceId) => {
    if (live) throw new Error('judge configuration is not available in live mode: the live LLM run uses the untouched graph');
    const choice = JUDGE_CHOICES.find((c) => c.id === choiceId);
    if (!choice) throw new Error(`unknown configuration '${choiceId}'`);
    await doReset({ keepInteractive: true });
    interactive = true;
    const before = await amplification();
    const edits = [];
    for (const e of choice.edits) {
      const was = (await roRows(db, GRAPHS.twin, `MATCH (:Service {name:$a})-[c:CALLS]->(:Service {name:$b}) RETURN c.${e.field} AS v`, { a: e.caller, b: e.callee }))[0]?.v;
      const cypher = `MATCH (:Service {name:'${e.caller}'})-[c:CALLS]->(:Service {name:'${e.callee}'}) SET c.${e.field} = ${e.value}`;
      for (const g of [GRAPHS.twin, GRAPHS.world]) {
        await rows(db, g, `MATCH (:Service {name:$a})-[c:CALLS]->(:Service {name:$b}) SET c.${e.field} = $v`, { a: e.caller, b: e.callee, v: e.value });
        await regenerateActionSpaces(db, g, loadTopology());      // the action space follows the changed graph
      }
      edits.push({ edge: `${e.caller}>${e.callee}`, field: e.field, before: was, after: e.value, cypher, graphs: [GRAPHS.twin, GRAPHS.world] });
    }
    judge = { session, at: Date.now(), choice: choice.id, label: choice.label, detail: choice.detail, edits, amplification: { before, after: await amplification() } };
    io.emit('judge', judge);
    setStatus('ready');
    await sendPreview();
  };

  // onStarted: called once the run is actually under way (status 'running', after any reset) or refused, so a browser's
  // ack describes the run it asked for (its session, mode and status), never the session that was just torn down
  const doRun = async ({ interactive: wantInteractive = false, onStarted = () => {} } = {}) => {
    if (live && wantInteractive) {        // never switch a live session to the scripted models: refuse, stay ready
      error = 'the interactive judge demo is not available in live mode';
      setStatus(status);
      onStarted();
      return;
    }
    if (live && !wantInteractive && liveRunsToday() >= liveMaxRunsPerDay) {   // the free provider quota is shared by every visitor
      error = `the daily limit of ${liveMaxRunsPerDay} live run(s) is reached; the replay of the recorded live run remains available`;
      setStatus(status);
      onStarted();
      return;
    }
    error = null;                         // an accepted start: an earlier refusal must not be reported as this run's error
    if (status === 'done' || status === 'failed') await doReset({ keepInteractive: wantInteractive && interactive });
    if (wantInteractive) interactive = true;
    if (live && !interactive) { liveRunsToday(); liveRuns.count += 1; }
    setStatus('running');
    onStarted();
    try {
      const scripted = interactive;                       // the deterministic reference models (judge demo)
      let recorder = null;
      const adapters = scripted ? { red: createRedAgent(createScriptedRedModel()), blue: createBlueAgent(createScriptedBlueModel()) }
        : live ? (recorder = createCassette(), { red: recorder.record(createRedAgent(live)), blue: recorder.record(createBlueAgent(live)) })
          : replay ? { red: replay.cassette.player(), blue: replay.cassette.player() } : {};
      const result = await runCanonicalDemo(db, {
        mode: scripted || live ? 'live' : mode, events: bus, clock: createWorldClock({ pacing: 'virtual', events: bus }),
        adapters,
        toolboxes: { red: toolbox('red'), blue: toolbox('blue'), fallback: async (role, ctx) => createToolbox(agentDb, ctx) },
        ...(live ? { ceilingMs } : {}),
        ...(scripted ? { gate: () => new Promise((resolve) => { release = resolve; awaiting = 'attack-again'; setStatus('awaiting'); }) } : {}),
      });
      if (live) {
        // provenance: who decided each phase; replies that arrived after a takeover are counted, never stored as entries
        phases = result.phases;
        const path = recordPath ?? join(ROOT, 'cassettes', `recorded-ui-live-${Date.now()}.json`);
        saveCassette(path, recorder, { source: 'live OpenRouter run (UI)',
          provenance: { live: true, provider: live.provider, model: live.model, ceiling_ms: ceilingMs, phases: result.phases, late_decisions: recorder.late } });
        cassette = path;
      }
      setStatus('done');
    } catch (e) {
      error = e.message;
      setStatus('failed');
    }
  };
  const enqueue = (fn) => (queue = queue.then(fn, fn));
  const attackAgain = () => {
    if (!release) return false;
    const r = release;
    release = null;
    awaiting = null;
    setStatus('running');
    r();
    return true;
  };

  // constant-time token comparison (never log or echo the token)
  const tokenOk = (given) => typeof given === 'string' && given.length === operatorToken.length
    && timingSafeEqual(Buffer.from(given), Buffer.from(operatorToken));
  const clientAddress = (socket) => String(socket.handshake.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || socket.handshake.address;

  io.on('connection', (socket) => {
    socket.emit('hello', info());
    socket.emit('log', { session, events: bus.log });
    if (judge?.session === session) socket.emit('judge', judge);
    for (const t of traces) socket.emit('trace', t);
    sendPreview(socket).catch(() => {});
    socket.on('control', (msg, ack) => {
      const action = msg?.action;
      const done = (extra = {}) => { if (typeof ack === 'function') ack({ ...info(), ...extra }); };
      const operator = !!operatorToken && tokenOk(msg?.token);
      // a refusal is answered with its reason (the ack and a status payload carry `error`; the status is unchanged) and
      // logged with the client address, never with a token
      const refuse = (why, extra = {}) => { error = why; console.warn(`[ui-server] ${action} refused for ${clientAddress(socket)}: ${why}`); setStatus(status); done(extra); };
      if (action === 'start') {
        // public guards, on runs only: a live run needs the operator token; one address may start a run once per cooldown
        if (live && !msg?.interactive && operatorToken && !operator) return refuse('live runs require the operator token; the replay of the recorded live run stays available');
        if (status === 'running') return done();                                // already running: nothing to start, no error
        if (status === 'awaiting' && msg?.interactive) return done();           // the judge's own paused run: ATTACK AGAIN continues it
        if (cooldownMs > 0 && !operator) {
          const who = clientAddress(socket);
          const since = Date.now() - (lastStart.get(who) ?? -Infinity);
          if (since < cooldownMs) return refuse(`please wait ${Math.ceil((cooldownMs - since) / 1000)} s before starting another run`, { retryAfterMs: cooldownMs - since });
          lastStart.set(who, Date.now());
        }
        // a guided start while a judge run is paused: the paused run is released and finishes, then doRun resets and the
        // canonical run follows (the ack comes once that run is under way)
        if (status === 'awaiting') attackAgain();
        enqueue(async () => {
          let answered = false;
          const answer = () => { if (!answered) { answered = true; done(); } };
          // a failure before the run is under way (e.g. the reset) is reported, never swallowed into a silent "done"
          await doRun({ interactive: !!msg?.interactive, onStarted: answer }).catch((e) => { error = e.message; setStatus(status); });
          answer();                                                             // never leave a browser unanswered
        });
      } else if (action === 'reset') {
        if (release) attackAgain();                              // a paused run is released so it can finish first
        // waits for a running demo to finish first; a failed reset is reported, and the client is always answered
        enqueue(async () => { try { await doReset(); } catch (e) { error = e.message; setStatus(status); } finally { done(); } });
      } else if (action === 'configure') {
        if (status === 'running' || status === 'awaiting') return done();
        enqueue(async () => { try { await doConfigure(msg?.choice); } catch (e) { error = e.message; setStatus(status); } done(); });
      } else if (action === 'attack-again') {
        // nothing paused (a stale page, or the run was reset meanwhile): say so instead of silently doing nothing
        if (!attackAgain()) return refuse('no paused run is waiting for ATTACK AGAIN; press Reset to start again');
        done();
      } else done();
    });
  });

  await reset(db);
  openSession();
  await new Promise((resolve) => http.listen(port, host, resolve));
  const bound = http.address().port;
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    info,
    minIntervalMs: live?.minIntervalMs ?? null,
    get log() { return bus.log; },
    get judge() { return judge; },
    get traces() { return traces; },
    control: (action, opts = {}) => new Promise((resolve) => {
      if (action === 'start') { if (status === 'running' || status === 'awaiting') return resolve(info()); enqueue(async () => { await doRun(opts); resolve(info()); }); }
      else if (action === 'configure') enqueue(async () => { try { await doConfigure(opts.choice); } catch (e) { error = e.message; setStatus(status); } resolve(info()); });
      else if (action === 'attack-again') resolve(attackAgain());
      else enqueue(async () => { try { await doReset(); } catch (e) { error = e.message; setStatus(status); } finally { resolve(info()); } });
    }),
    async close() {
      if (release) attackAgain();
      await queue.catch(() => {});
      unsubscribe();
      await new Promise((r) => io.close(() => r()));
      for (const tb of Object.values(mcp)) await tb.close();
      await agentDb.close();
      await db.close();
    },
  };
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

// ---------------------------------------------------------------- CLI
// Flags win over environment variables; local defaults are unchanged (127.0.0.1:4173, replay of the reference cassette).
// Deployment (docs/DEPLOY_RENDER.md) configures everything through the environment: ARGUS_UI_HOST, PORT / ARGUS_UI_PORT,
// ARGUS_UI_MODE, ARGUS_UI_CASSETTE, ARGUS_UI_CEILING_MS, ARGUS_UI_RECORD, ARGUS_OPERATOR_TOKEN, ARGUS_PUBLIC_COOLDOWN_MS,
// ARGUS_LIVE_MAX_RUNS_PER_DAY.
export function cliOptions(argv = process.argv, env = process.env) {
  const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : def; };
  const int = (label, raw, def, { min = 0, allowInfinity = false } = {}) => {
    if (raw === undefined || raw === null || raw === '') return def;
    if (allowInfinity && String(raw).toLowerCase() === 'infinity') return Infinity;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`invalid ${label} '${raw}' (an integer >= ${min})`);
    return n;
  };
  return {
    mode: arg('mode', env.ARGUS_UI_MODE || 'replay'),
    cassettePath: arg('cassette', env.ARGUS_UI_CASSETTE || undefined),
    host: arg('host', env.ARGUS_UI_HOST || '127.0.0.1'),
    port: int('port', arg('port', env.ARGUS_UI_PORT || env.PORT), 4173, { min: 0 }),
    ceilingMs: int('--ceiling-ms', arg('ceiling-ms', env.ARGUS_UI_CEILING_MS), TAKEOVER.TURN_CEILING_MS, { min: 1 }),
    recordPath: arg('record', env.ARGUS_UI_RECORD || null),
    operatorToken: env.ARGUS_OPERATOR_TOKEN || null,
    cooldownMs: int('ARGUS_PUBLIC_COOLDOWN_MS', env.ARGUS_PUBLIC_COOLDOWN_MS, 0),
    liveMaxRunsPerDay: int('ARGUS_LIVE_MAX_RUNS_PER_DAY', env.ARGUS_LIVE_MAX_RUNS_PER_DAY, Infinity, { allowInfinity: true }),
    autostart: argv.includes('--autostart'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts;
  try { opts = cliOptions(); } catch (e) { console.error(e.message); process.exit(2); }
  const { autostart, ...options } = opts;
  let server;
  try {
    server = await startUiServer(options);
  } catch (e) {
    if (e instanceof ProviderConfigError) { console.error(`live mode unavailable: ${e.message}\nrun the deterministic replay instead:  npm run ui`); process.exit(3); }
    throw e;
  }
  const { mode, source, live, model, operatorRequired, liveMaxRunsPerDay, cooldownMs } = server.info();
  const ceilingMs = options.ceilingMs;
  console.log(`ARGUS command center: ${server.url}  (mode ${mode}; ${source})`);
  if (live) console.log(`live LLM: model ${model}; turn ceiling ${ceilingMs} ms${ceilingMs === TAKEOVER.TURN_CEILING_MS ? ' (spec default)' : ` (spec default ${TAKEOVER.TURN_CEILING_MS})`}; request pacing ${server.minIntervalMs} ms (counts toward the ceiling); a slower turn still hands the phase to B5 (shown as autopilot)`);
  if (operatorRequired || cooldownMs > 0 || liveMaxRunsPerDay !== null) console.log(`public guards: operator token ${operatorRequired ? 'required for live runs' : 'off'}; cooldown ${cooldownMs} ms per client; live runs per day ${liveMaxRunsPerDay ?? 'unlimited'}`);
  if (autostart) server.control('start');
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
