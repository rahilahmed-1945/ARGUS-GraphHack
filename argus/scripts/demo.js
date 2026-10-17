// npm run demo — the complete ARGUS demonstration runtime.
//   npm run demo                                   replay the reference cassette (no API key needed)
//   npm run demo -- --mode live [--record <file>]  real LLM via OpenRouter (needs OPENROUTER_API_KEY + ARGUS_LLM_MODEL)
//   npm run demo -- --mode autopilot               deterministic B5 only
//   options: --cassette <file>  --pacing realtime|virtual  --port <n>  --linger-ms <n>
//            --ceiling-ms <n>   per-turn live LLM ceiling (default 6000 = spec §14.2; e.g. 20000 for free-tier reasoning
//                               models measured at 4–15 s per turn, spec §14.5 — a longer ceiling never guarantees an LLM commit)
// It bootstraps the database boundary, resets TWIN/WORLD, starts the event server and one MCP tool server per
// role, runs the canonical two-round loop, prints the trace, leaves the final graph state, and shuts down.
import { fileURLToPath } from 'node:url';
import { connect } from '../graph/db.js';
import { bootstrapAcl } from '../graph/acl.js';
import { reset } from '../graph/reset.js';
import { createEventBus } from '../runtime/events.js';
import { createWorldClock } from '../runtime/clock.js';
import { runCanonicalDemo } from '../runtime/demo.js';
import { createToolbox } from '../runtime/tools.js';
import { createRedAgent } from '../runtime/red.js';
import { createBlueAgent } from '../runtime/blue.js';
import { createCassette, TAKEOVER } from '../runtime/runtime.js';
import { saveCassette, loadCassette, phaseSummary } from '../runtime/cassette-file.js';
import { createLLMFromEnv, ProviderConfigError } from '../runtime/providers/openrouter.js';
import { createMcpToolbox } from '../mcp/client.js';
import { startEventServer } from '../app/server.js';

const DEFAULT_CASSETTE = fileURLToPath(new URL('../cassettes/reference-scripted.json', import.meta.url));
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const mode = arg('mode', 'replay');
const pacing = arg('pacing', 'realtime');
const cassettePath = arg('cassette', DEFAULT_CASSETTE);
const recordPath = arg('record', null);
const port = Number(arg('port', process.env.ARGUS_PORT ?? 4000));
const lingerMs = Number(arg('linger-ms', 0));
const ceilingMs = Number(arg('ceiling-ms', TAKEOVER.TURN_CEILING_MS));
if (!['live', 'replay', 'autopilot'].includes(mode)) { console.error(`unknown --mode '${mode}' (live | replay | autopilot)`); process.exit(2); }
if (!Number.isInteger(ceilingMs) || ceilingMs <= 0) { console.error(`invalid --ceiling-ms '${arg('ceiling-ms')}' (a positive integer of milliseconds; default ${TAKEOVER.TURN_CEILING_MS})`); process.exit(2); }

// ---------- agents for the chosen mode (fail clearly; never silently switch modes)
let adapters = {};
let recorder = null;
let liveLLM = null;
if (mode === 'live') {
  let llm;
  try { llm = liveLLM = createLLMFromEnv(); } catch (e) {
    if (e instanceof ProviderConfigError) { console.error(`live mode unavailable: ${e.message}\nrun the deterministic replay instead:  npm run demo -- --mode replay`); process.exit(3); }
    throw e;
  }
  recorder = createCassette();
  adapters = { red: recorder.record(createRedAgent(llm)), blue: recorder.record(createBlueAgent(llm)) };
  console.log(`live: ${llm.provider} model ${llm.model}; turn ceiling ${ceilingMs} ms${ceilingMs === TAKEOVER.TURN_CEILING_MS ? ' (spec default)' : ` (spec default ${TAKEOVER.TURN_CEILING_MS}; a slower turn still hands the phase to B5)`}; request pacing ${llm.minIntervalMs} ms (counts toward the ceiling)`);
} else if (mode === 'replay') {
  const { cassette, source, size } = loadCassette(cassettePath);
  adapters = { red: cassette.player(), blue: cassette.player() };
  console.log(`replay: ${size} recorded decisions from ${cassettePath}\n        source: ${source}`);
} else {
  console.log('autopilot: deterministic B5 policy only');
}

// ---------- infrastructure
await bootstrapAcl();
const db = await connect();
await reset(db);
const agentDb = await connect({ as: 'agent' });
const events = createEventBus();
const clock = createWorldClock({ pacing, events });
const server = await startEventServer({ bus: events, port });
console.log(`events: Socket.IO on ${server.url} (channels: event, tick, step, future, decision, observation, clock; GET /state)`);
const mcp = {};
const toolbox = (role) => async (ctx) => {
  mcp[role] ??= await createMcpToolbox({ role, ctx });
  mcp[role].setCtx(ctx);
  return mcp[role];
};

// ---------- a compact live trace on stdout
events.subscribe((ev) => {
  const p = ev.payload;
  const line = {
    ROUND_STARTED: () => `\n=== ROUND ${p.round} (${p.mode}) ===`,
    RED_STARTED: () => 'RED  ▸ how could this system break?',
    BLUE_STARTED: () => `BLUE ▸ ${p.scenarioId} (${p.futureMode})`,
    TOOL_RESULT: () => `  ${ev.round ? `R${ev.round}` : ''} ${p.role}/${p.by} ${p.tool} → ${p.summary.slice(0, 110)}`,
    TAKEOVER: () => `  TAKEOVER (${p.reason}) → AUTOPILOT: ${p.detail}`,
    WORLD_FAULT_INJECTED: () => `WORLD ▸ inject ${p.faults.join(' + ')} at tick ${p.tick}`,
    WORLD_FAULT_REMOVED: () => `WORLD ▸ TRIGGER REMOVED (${p.faults.join(', ')}) at tick ${p.tick}`,
    WORLD_DEPLOY_LANDED: () => `WORLD ▸ deploy ${p.change_event} landed: ${p.edge} ${p.field} ${p.before} → ${p.after}`,
    HARDENING_APPLIED: () => `HARDENING ▸ ${p.pr.label}: ${p.pr.interventions.join(' + ')}`,
    WORLD_OBSERVATION: () => `OBSERVE ▸ ${p.observed_viol_ticks} violated ticks (predicted median ${p.predicted_viol_ticks_p50}, band ${p.predicted_p10}-${p.predicted_p90})`,
    CALIBRATION_UPDATED: () => `CALIBRATE ▸ ${p.service} ${p.before} → ${p.after.toFixed(1)} (n=${p.n})`,
    DEMO_COMPLETED: () => `\nRESULT ▸ ${p.safe ? 'SAFE' : 'NOT SAFE'}: finale ${p.finale.observed_viol_ticks} violated ticks over ${p.finale.ticks} (error budget ${p.finale.error_budget})`,
  }[ev.type];
  if (line) console.log(line());
});

let exitCode = 0;
try {
  const result = await runCanonicalDemo(db, {
    mode, adapters, events, clock, ceilingMs,
    toolboxes: { red: toolbox('red'), blue: toolbox('blue'), fallback: async (role, ctx) => createToolbox(agentDb, ctx) },
  });
  if (recorder) {
    // provenance travels with the recording: who decided each phase, and how many replies arrived after a takeover
    // (those are never stored as entries, so this cassette cannot replay them as decisions the run used)
    const provenance = { live: true, provider: liveLLM.provider, model: liveLLM.model, ceiling_ms: ceilingMs, phases: result.phases, late_decisions: recorder.late };
    const n = saveCassette(recordPath ?? `cassettes/recorded-${Date.now()}.json`, recorder, { source: 'live OpenRouter run', provenance });
    console.log(`recorded ${n} decisions (${recorder.late} late, excluded); phases: ${phaseSummary(result.phases)}`);
  }
  console.log(`events: ${events.log.length}; world virtual time ${(result.virtual_ms / 1000).toFixed(1)} s; graphs: ${(await db.list()).join(', ')}`);
  exitCode = result.safe ? 0 : 1;
  if (lingerMs > 0) await new Promise((r) => setTimeout(r, lingerMs));
} catch (e) {
  console.error(`demo failed: ${e.stack ?? e.message}`);
  exitCode = 1;
} finally {
  for (const tb of Object.values(mcp)) await tb.close();
  await server.close();
  await agentDb.close();
  await db.close();
}
process.exit(exitCode);
