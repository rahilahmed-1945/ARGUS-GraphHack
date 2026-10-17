// MCP client side (argus-app): a toolbox with the same interface as runtime/tools.js createToolbox()
// ({ invoke(role, tool, args, by), ctx }) whose calls travel over MCP stdio to `argus-mcp --role <role>`.
// The child gets ONLY the agent database identity (never the admin password, never LLM keys).
// A crashed child is respawned and the call retried once (charge-once call_ids make that safe, spec §9).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SERVER_PATH = fileURLToPath(new URL('./server.js', import.meta.url));
const CALL_TIMEOUT_MS = 300000;   // an audit over many forks can take seconds; the runtime has its own LLM ceiling

export class TransportError extends Error {}
export class ToolInfraError extends Error {}

export function childEnvironment(env = process.env) {
  const keep = ['ARGUS_FALKORDB_HOST', 'ARGUS_FALKORDB_PORT', 'ARGUS_AGENT_PASSWORD'];
  return { ...getDefaultEnvironment(), ...Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])) };
}

/**
 * @param {object} o
 * @param {'red'|'blue'} o.role
 * @param {object} [o.ctx]          client-side copy of the phase context (B5 reads tb.ctx); the server reads the graph
 * @param {string} [o.command]      override (tests: an unavailable server)
 * @param {string[]} [o.args]
 * @param {object} [o.env]
 */
export async function createMcpToolbox({ role, ctx = {}, command = process.execPath, args = [SERVER_PATH, '--role', role], env = childEnvironment() }) {
  let client = null;
  let spawned = 0;
  const start = async () => {
    const transport = new StdioClientTransport({ command, args, env, cwd: ROOT, stderr: 'pipe' });
    const c = new Client({ name: 'argus-app', version: '0.1.0' });
    try {
      await c.connect(transport);
    } catch (e) {
      try { await c.close(); } catch { /* not started */ }
      throw new TransportError(`cannot start argus-mcp --role ${role}: ${e.message}`);
    }
    spawned += 1;
    client = c;
  };
  await start();
  const tools = (await client.listTools()).tools.map((t) => t.name);

  async function call(tool, a, by) {
    return client.callTool({ name: tool, arguments: a, _meta: { argus_by: by } }, undefined, { timeout: CALL_TIMEOUT_MS });
  }

  return {
    transport: 'mcp',
    role,
    tools,
    ctx,
    get spawned() { return spawned; },
    setCtx(next) { this.ctx = next; },
    async invoke(callerRole, tool, a = {}, by = 'llm') {
      if (callerRole !== role) throw new Error(`toolbox for '${role}' cannot invoke as '${callerRole}'`);
      let res;
      try {
        res = await call(tool, a, by);
      } catch (e) {
        // the child died or the pipe broke: respawn once and retry the same (idempotent) call
        try { await client.close(); } catch { /* already gone */ }
        try {
          await start();
          res = await call(tool, a, by);
        } catch (e2) {
          throw new TransportError(`argus-mcp --role ${role} unavailable: ${e2.message}`);
        }
      }
      const payload = JSON.parse(res.content?.[0]?.text ?? '{}');
      if (payload.infra) throw new ToolInfraError(payload.message);
      const error = payload.ok ? null : Object.assign(new Error(payload.error ?? payload.summary), { cause: payload.cause ?? undefined });
      return { ok: payload.ok, tool, args: a, result: payload.result, summary: payload.summary, error, budgetExhausted: payload.budgetExhausted, step: payload.step };
    },
    async kill() { await client?.close(); },
    async close() { try { await client?.close(); } catch { /* closed */ } },
  };
}
