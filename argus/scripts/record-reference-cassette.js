// Records cassettes/reference-scripted.json: the decisions of the deterministic scripted RED/BLUE test models
// (tests/fixtures) over the full canonical run, through the real MCP tool servers and a fresh graph.
// This is NOT a recording of a real LLM — its `source` field says so. It lets `npm run demo` replay the whole
// agent/tool/event/decision sequence without an API key. A live run can be recorded with --mode live --record.
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
import { createCassette } from '../runtime/runtime.js';
import { saveCassette } from '../runtime/cassette-file.js';
import { createMcpToolbox } from '../mcp/client.js';
import { createScriptedRedModel } from '../tests/fixtures/red-model.js';
import { createScriptedBlueModel } from '../tests/fixtures/blue-model.js';

const out = fileURLToPath(new URL('../cassettes/reference-scripted.json', import.meta.url));
await bootstrapAcl();
const db = await connect();
await reset(db);
const agentDb = await connect({ as: 'agent' });
const mcp = { red: await createMcpToolbox({ role: 'red' }), blue: await createMcpToolbox({ role: 'blue' }) };
const recorder = createCassette();
const events = createEventBus();
const result = await runCanonicalDemo(db, {
  mode: 'live', events, clock: createWorldClock({ pacing: 'virtual' }),
  adapters: { red: recorder.record(createRedAgent(createScriptedRedModel())), blue: recorder.record(createBlueAgent(createScriptedBlueModel())) },
  toolboxes: { red: async (ctx) => { mcp.red.setCtx(ctx); return mcp.red; }, blue: async (ctx) => { mcp.blue.setCtx(ctx); return mcp.blue; },
    fallback: async (role, ctx) => createToolbox(agentDb, ctx) },
});
const n = saveCassette(out, recorder, { source: 'deterministic scripted test models (tests/fixtures/red-model.js, blue-model.js) — not a real LLM recording' });
console.log(`recorded ${n} decisions → ${out} (safe: ${result.safe}, takeovers: ${result.phases.filter((p) => p.takeover).length})`);
for (const tb of Object.values(mcp)) await tb.close();
await agentDb.close();
await db.close();
