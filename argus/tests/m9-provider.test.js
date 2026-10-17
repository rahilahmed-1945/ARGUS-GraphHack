// M9 — real LLM provider adapter contract (runtime/providers/openrouter.js). No API key or network needed:
// a fake fetch stands in for OpenRouter. An optional live smoke test runs only with ARGUS_LIVE_LLM=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { readSteps } from '../graph/steps.js';
import { runPhase } from '../runtime/runtime.js';
import { createRedAgent, RED_TOOL_SCHEMAS } from '../runtime/red.js';
import { createBlueAgent } from '../runtime/blue.js';
import { createOpenRouterLLM, createLLMFromEnv, ProviderError, ProviderConfigError, toChatMessages } from '../runtime/providers/openrouter.js';

const reply = (message, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(status < 400 ? { choices: [{ message }] } : { error: 'boom' }) });
const toolCall = (name, args, id = `c_${name}`) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const llm = (fetch, extra = {}) => createOpenRouterLLM({ apiKey: 'sk-test', model: 'test/model', fetch, ...extra });

test('1. request: OpenAI-compatible tool-calling payload at temperature 0, key in the header only', async () => {
  let seen;
  const m = llm(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return reply({ content: 'ok' }); });
  await m.complete({ system: 'SYS', tools: RED_TOOL_SCHEMAS, messages: [
    { role: 'user', content: 'Round 1.' },
    { role: 'assistant', toolCalls: [{ id: 't0c0', name: 'amplification_paths', args: { min_risk: 2 } }] },
    { role: 'tool', toolCallId: 't0c0', name: 'amplification_paths', content: '{"rows":[]}' },
  ] });
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test');
  assert.ok(!seen.init.body.includes('sk-test'), 'the key never travels in the body');
  assert.deepEqual([seen.body.model, seen.body.temperature, seen.body.tool_choice, seen.body.parallel_tool_calls], ['test/model', 0, 'auto', true]);
  assert.deepEqual(seen.body.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Round 1.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't0c0', type: 'function', function: { name: 'amplification_paths', arguments: '{"min_risk":2}' } }] },
    { role: 'tool', tool_call_id: 't0c0', content: '{"rows":[]}' }]);
  assert.deepEqual(seen.body.tools.map((t) => [t.type, t.function.name]), RED_TOOL_SCHEMAS.map((t) => ['function', t.name]));
  assert.deepEqual(seen.body.tools[5].function.parameters, RED_TOOL_SCHEMAS[5].input_schema);
});

test('2. response: tool calls (incl. parallel) map to the interface; text maps to unusable output', async () => {
  const m = llm(async () => reply({ tool_calls: [toolCall('amplification_paths', { min_risk: 2 }), toolCall('list_candidates', {})] }));
  assert.deepEqual(await m.complete({ system: 's', messages: [], tools: [] }),
    { toolCalls: [{ name: 'amplification_paths', args: { min_risk: 2 } }, { name: 'list_candidates', args: {} }] });
  const agent = createRedAgent(m);
  const obs = { role: 'red', round: 1, turn: 0, budgets: { sim_budget: 6, tool_budget: 14 }, roundInfo: { t_off: 30, horizon_preemptive: 90 }, history: [] };
  assert.deepEqual(await agent.next(obs), { calls: [{ tool: 'amplification_paths', args: { min_risk: 2 } }, { tool: 'list_candidates', args: {} }] });
  const text = createRedAgent(llm(async () => reply({ content: 'I would attack the database.' })));
  assert.deepEqual(await text.next(obs), { unusable: 'I would attack the database.' });
  // malformed JSON arguments → args null → unusable
  const bad = createBlueAgent(llm(async () => reply({ tool_calls: [toolCall('fork_and_simulate', '{"intervention_ids": [')] })));
  const bobs = { role: 'blue', round: 1, turn: 0, budgets: { fork_budget: 6, tool_budget: 14 }, roundInfo: {}, context: { scenarioId: 'S:R1', futureMode: 'reactive' }, history: [] };
  assert.ok('unusable' in (await bad.next(bobs)));
});

test('3. provider failures throw ProviderError (HTTP error, error body, network, timeout)', async () => {
  await assert.rejects(llm(async () => reply(null, 503)).complete({ system: 's', messages: [], tools: [] }), (e) => e instanceof ProviderError && e.status === 503);
  await assert.rejects(llm(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: 'rate limited', code: 429 } }) }))
    .complete({ system: 's', messages: [], tools: [] }), (e) => e instanceof ProviderError && /rate limited/.test(e.message));
  await assert.rejects(llm(async () => { throw new Error('ECONNRESET'); }).complete({ system: 's', messages: [], tools: [] }), /request failed: ECONNRESET/);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(llm(hang, { timeoutMs: 30 }).complete({ system: 's', messages: [], tools: [] }), /timed out after 30 ms/);
  assert.throws(() => toChatMessages('s', [{ role: 'weird' }]), ProviderError);
});

test('4. configuration: a missing key or model fails clearly (never silently changes mode)', () => {
  assert.throws(() => createLLMFromEnv({ ARGUS_LLM_MODEL: 'x' }), (e) => e instanceof ProviderConfigError && /OPENROUTER_API_KEY/.test(e.message));
  assert.throws(() => createLLMFromEnv({ OPENROUTER_API_KEY: 'k' }), (e) => e instanceof ProviderConfigError && /ARGUS_LLM_MODEL/.test(e.message));
  assert.equal(createLLMFromEnv({ OPENROUTER_API_KEY: 'k', ARGUS_LLM_MODEL: 'm' }).model, 'm');
});

let db;
before(async () => { db = await connect(); });
after(async () => { await reset(db); await db.close(); });

test('5. the adapter plugs into the RED runtime unchanged (fake provider responses drive a real phase)', async () => {
  await reset(db);
  const script = [
    { tool_calls: [toolCall('amplification_paths', { min_risk: 2 }), toolCall('list_candidates', {})] },
    { tool_calls: [toolCall('simulate', { fault_ids: ['degrade:ledger-db'] })] },
    { tool_calls: [toolCall('commit', { fault_ids: ['degrade:ledger-db'], evidence_path: ['gateway', 'checkout', 'payments', 'ledger-db'] })] },
  ];
  let k = 0;
  const bodies = [];
  const m = llm(async (url, init) => { bodies.push(JSON.parse(init.body)); return reply(script[k++]); });
  const r = await runPhase(db, { role: 'red', mode: 'live', adapter: createRedAgent(m) });
  assert.deepEqual([r.proposedBy, r.takeover, r.outcome.scenarioId], ['llm', null, 'S:R1']);
  assert.equal(bodies.length, 3);
  const lastTool = bodies[2].messages.at(-1);
  assert.equal(lastTool.role, 'tool');
  assert.match(lastTool.content, /"sustained":15/, 'the provider saw the real simulation result');
  assert.ok((await readSteps(db, {})).every((s) => s.by === 'llm'));
});

test('6. live OpenRouter smoke test (skipped unless ARGUS_LIVE_LLM=1 with a key and model)', { skip: process.env.ARGUS_LIVE_LLM !== '1' }, async () => {
  const live = createLLMFromEnv();
  const out = await live.complete({ system: 'Call the list_candidates tool.', messages: [{ role: 'user', content: 'Go.' }], tools: RED_TOOL_SCHEMAS });
  assert.ok(Array.isArray(out.toolCalls) || typeof out.text === 'string');
});
