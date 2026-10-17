// Shared test helpers (not a test file: node --test runs *.test.js only).
import { roRows } from '../graph/db.js';

// Full, id-independent dump of a graph: every node and relationship with labels/types and properties.
export async function dumpGraph(db, g) {
  const nodes = await roRows(db, g, `MATCH (n) RETURN labels(n) AS labels, properties(n) AS props`);
  const rels = await roRows(db, g, `MATCH (a)-[r]->(b) RETURN type(r) AS type, properties(r) AS props,
      labels(a) AS al, coalesce(a.name, a.id, toString(a.n)) AS ak, labels(b) AS bl, coalesce(b.name, b.id, toString(b.n)) AS bk`);
  const canon = (x) => JSON.stringify(x, Object.keys(x).sort());
  return {
    nodes: nodes.map((n) => JSON.stringify([n.labels, canon(n.props)])).sort(),
    rels: rels.map((r) => JSON.stringify([r.type, r.al, r.ak, r.bl, r.bk, canon(r.props)])).sort(),
  };
}

// Entries present in `b` but not in `a` (and vice versa) for two dumps.
export function dumpDiff(a, b) {
  const minus = (x, y) => x.filter((v) => !y.includes(v));
  return { added: [...minus(b.nodes, a.nodes), ...minus(b.rels, a.rels)], removed: [...minus(a.nodes, b.nodes), ...minus(a.rels, b.rels)] };
}

// One MCP tool server per role (spawned once), plus an in-process fallback on the agent identity.
export async function mcpToolboxes(agentDb) {
  const { createMcpToolbox } = await import('../mcp/client.js');
  const { createToolbox } = await import('../runtime/tools.js');
  const mcp = { red: await createMcpToolbox({ role: 'red' }), blue: await createMcpToolbox({ role: 'blue' }) };
  return {
    mcp,
    toolboxes: {
      red: async (ctx) => { mcp.red.setCtx(ctx); return mcp.red; },
      blue: async (ctx) => { mcp.blue.setCtx(ctx); return mcp.blue; },
      fallback: async (role, ctx) => createToolbox(agentDb, ctx),
    },
    async close() { await mcp.red.close(); await mcp.blue.close(); },
  };
}

// Raw Redis command as a given connection (node-redis client under the falkordb client).
export async function raw(db, ...cmd) {
  const c = await db.connection;
  try { return { ok: true, reply: await c.sendCommand(cmd.map(String)) }; } catch (e) { return { ok: false, error: e.message }; }
}
