// argus-mcp — the ARGUS tool server (spec §11.1). Spawned once per role:  node mcp/server.js --role red|blue
// Transport: MCP over stdio. The role is read from argv only (a client cannot change it). listTools returns
// only that role's tools; every call — including unlisted tools — goes to the existing authoritative tool layer
// (runtime/tools.js invoke), which authorizes, charges, executes and records a (:Step). No tool logic lives here.
// Database: the ACL-restricted `agent` user (graph/acl.js) — no WORLD, no deletes outside fork:*, no admin.
// Shared state crosses processes only through FalkorDB (spec §2): BLUE's phase context is read from the graph.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connect, roRows, GRAPHS } from '../graph/db.js';
import { createToolbox } from '../runtime/tools.js';
import { RED_TOOL_SCHEMAS } from '../runtime/red.js';
import { BLUE_TOOL_SCHEMAS } from '../runtime/blue.js';

const roleArg = process.argv.indexOf('--role');
const role = roleArg > 0 ? process.argv[roleArg + 1] : null;
if (role !== 'red' && role !== 'blue') {
  process.stderr.write('usage: node mcp/server.js --role red|blue\n');
  process.exit(2);
}
// the tool server must never hold the admin identity
delete process.env.ARGUS_ADMIN_PASSWORD;
const db = await connect({ as: 'agent' });
const schemas = role === 'red' ? RED_TOOL_SCHEMAS : BLUE_TOOL_SCHEMAS;

// BLUE's context (scenario, futures mode, snapshot) is written on the Round by the orchestrator (spec §2.2 SNAP).
async function phaseContext() {
  if (role !== 'blue') return {};
  const r = (await roRows(db, GRAPHS.twin, `MATCH (r:Round) RETURN r.blue_scenario_id AS s, r.blue_future_mode AS m, r.blue_snapshot_id AS snap ORDER BY r.n DESC LIMIT 1`))[0] ?? {};
  return { scenarioId: r.s ?? undefined, futureMode: r.m ?? undefined, snapshotId: r.snap ?? undefined };
}

const server = new Server({ name: `argus-mcp-${role}`, version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: schemas.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  // provenance: 'b5' only when the trusted runtime marks the call; anything else is the LLM
  const by = request.params._meta?.argus_by === 'b5' ? 'b5' : 'llm';
  try {
    const tb = await createToolbox(db, await phaseContext());
    const r = await tb.invoke(role, name, args, by);
    const payload = { ok: r.ok, tool: r.tool, result: r.result, summary: r.summary, step: r.step, budgetExhausted: r.budgetExhausted,
      error: r.error ? r.error.message : null, cause: r.error?.cause ? { rule_winner: r.error.cause.rule_winner ?? null, reason: r.error.cause.reason ?? null } : null };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !r.ok };
  } catch (e) {
    // infrastructure failure (database, driver): reported as such, never disguised as a tool result
    return { content: [{ type: 'text', text: JSON.stringify({ infra: true, message: e.message }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
const shutdown = async () => { try { await db.close(); } finally { process.exit(0); } };
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
