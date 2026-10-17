// FalkorDB connections. Two identities (spec §3.4):
//   admin — the orchestrator (argus-app): WORLD and TWIN, resets, APPLY, snapshots, calibration.
//   agent — the tool server (argus-mcp): Redis ACL user restricted to ~twin ~fork:* ~argus:* (no WORLD,
//           no deletes outside fork:*, no admin commands); see graph/acl.js.
// Agents (LLMs) never hold any credentials: they only emit tool calls.
import { FalkorDB } from 'falkordb';

export const GRAPHS = { world: 'world', twin: 'twin' };
export const FORK_PREFIX = 'fork:';
export const AGENT_USER = 'agent';

export function endpoint() {
  return { host: process.env.ARGUS_FALKORDB_HOST ?? 'localhost', port: Number(process.env.ARGUS_FALKORDB_PORT ?? 6379) };
}

export function credentials(as) {
  if (as === 'agent') {
    if (!process.env.ARGUS_AGENT_PASSWORD) throw new Error('ARGUS_AGENT_PASSWORD is not set (run `npm run env:init`)');
    return { username: AGENT_USER, password: process.env.ARGUS_AGENT_PASSWORD };
  }
  if (as !== 'admin') throw new Error(`unknown database identity '${as}'`);
  return process.env.ARGUS_ADMIN_PASSWORD ? { username: 'default', password: process.env.ARGUS_ADMIN_PASSWORD } : {};
}

export async function connect({ as = 'admin' } = {}) {
  return FalkorDB.connect({ socket: endpoint(), ...credentials(as) });
}

// Run a query and return its rows (array of objects keyed by RETURN alias).
export async function rows(db, graphName, cypher, params) {
  const reply = await db.selectGraph(graphName).query(cypher, params ? { params } : undefined);
  return reply.data ?? [];
}

export async function roRows(db, graphName, cypher, params) {
  const reply = await db.selectGraph(graphName).roQuery(cypher, params ? { params } : undefined);
  return reply.data ?? [];
}
