// Database permission boundary (spec §3.4; build-readiness decision A#11 / TBD #11).
// Creates the Redis ACL user `agent` and puts a password on the default (admin) user, so that only the
// orchestrator can touch WORLD and nothing can connect anonymously. Verified on FalkorDB 6.0.1: ACL key
// patterns ARE enforced on GRAPH.* commands, so the spec's graph-name allowlist fallback is not needed.
import { pathToFileURL } from 'node:url';
import { createClient } from 'redis';
import { endpoint, AGENT_USER } from './db.js';

// agent: graph commands only; keys twin, fork:*, argus:*; GRAPH.DELETE only on fork:* (ACL selector).
// [IMPL-INTERPRETATION] the command list completes the spec's `+GRAPH.RO_QUERY +GRAPH.QUERY +GRAPH.COPY …`
// with what the falkordb client needs to connect (it runs INFO on connect: server metadata, no graph data)
// and to list graphs.
export const AGENT_ACL = Object.freeze([
  'reset', 'on', 'resetchannels', '~twin', '~fork:*', '~argus:*', '-@all',
  '+ping', '+hello', '+auth', '+client|setinfo', '+info', '+graph.query', '+graph.ro_query', '+graph.copy', '+graph.list',
  '(~fork:* +graph.delete)',
]);

// node-redis directly (the client falkordb itself uses): a failed probe connection can be destroyed, so a
// wrong password fails fast instead of leaving a reconnecting client behind.
async function tryConnect(password) {
  const c = createClient({ socket: { ...endpoint(), reconnectStrategy: false }, ...(password ? { username: 'default', password } : {}) });
  c.on('error', () => {});
  try {
    await c.connect();
    await c.sendCommand(['PING']);
    return c;
  } catch {
    try { c.destroy(); } catch { /* already closed */ }
    return null;
  }
}

export async function bootstrapAcl({ adminPassword = process.env.ARGUS_ADMIN_PASSWORD, agentPassword = process.env.ARGUS_AGENT_PASSWORD } = {}) {
  if (!adminPassword || !agentPassword) throw new Error('ARGUS_ADMIN_PASSWORD and ARGUS_AGENT_PASSWORD must be set (run `npm run env:init`)');
  // a fresh container has no password; an already bootstrapped one requires the admin password
  const c = (await tryConnect(adminPassword)) ?? (await tryConnect(null));
  if (!c) throw new Error('cannot connect to FalkorDB as admin (wrong ARGUS_ADMIN_PASSWORD for this container?)');
  try {
    await c.sendCommand(['ACL', 'SETUSER', AGENT_USER, ...AGENT_ACL, `>${agentPassword}`]);
    await c.sendCommand(['ACL', 'SETUSER', 'default', 'on', 'resetpass', `>${adminPassword}`]);
    await c.sendCommand(['ACL', 'LOG', 'RESET']);
  } finally {
    c.destroy();
  }
  return { agent: AGENT_USER, adminProtected: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bootstrapAcl();
  console.log(`ACL ok: user '${AGENT_USER}' restricted to twin/fork:*/argus:*; default user password-protected`);
}
