// Offline AI integration suite (npm run test:ai). No API key, no network, no live model.
// Every agent turn goes through the SAME path as a live run:
//   mock OpenRouter endpoint → runtime/providers/openrouter.js (real) → red.js / blue.js adapters (real)
//   → runtime (real) → MCP client → MCP role server (agent identity) → toolbox → FalkorDB → tool result → next request
// The models answering the requests see only the system prompt, the tool definitions and the transcript.
// Requires `npm run db:up` (ACL).
// Status: live provider integration is available but live quota is currently unavailable; offline provider/cassette
// tests cover the integration path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, rows, roRows } from '../../graph/db.js';
import { reset } from '../../graph/reset.js';
import { readRound } from '../../graph/budget.js';
import { readSteps } from '../../graph/steps.js';
import { setKey } from '../../graph/decision.js';
import { writeSnapshot, scenarioFaults, setBlueContext } from '../../graph/records.js';
import { World } from '../../sim/contexts.js';
import { runPhase, createCassette, REASONS } from '../../runtime/runtime.js';
import { WORLD_SCRIPT } from '../../runtime/orchestrator.js';
import { createEventBus } from '../../runtime/events.js';
import { ROLE_TOOLS } from '../../runtime/tools.js';
import { createRedAgent } from '../../runtime/red.js';
import { createBlueAgent } from '../../runtime/blue.js';
import { createOpenRouterLLM } from '../../runtime/providers/openrouter.js';
import { saveCassette, loadCassette } from '../../runtime/cassette-file.js';
import { createScriptedRedModel } from '../fixtures/red-model.js';
import { createScriptedBlueModel } from '../fixtures/blue-model.js';
import { mcpToolboxes, raw } from '../helpers.js';
import { createMockOpenRouter, scriptModel, MOCK_BASE_URL, MOCK_MODEL } from './mock-openrouter.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OFFLINE_KEY = 'offline-test-key';          // not a secret: the mock endpoint ignores it
const PATH = ['gateway', 'checkout', 'payments', 'ledger-db'];
const F5 = ['retries_off:checkout>payments', 'retries_off:gateway>checkout'];
const fid = (ids) => `fork:R1:${setKey(ids)}`;

// any real network use fails the suite
const network = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { network.push(String(url)); throw new Error(`network disabled in offline AI tests: ${url}`); };

let db, agentDb, boxes;
before(async () => { db = await connect(); agentDb = await connect({ as: 'agent' }); boxes = await mcpToolboxes(agentDb); });
after(async () => { await boxes.close(); await agentDb.close(); await reset(db); await db.close(); globalThis.fetch = realFetch; });

// ---------------------------------------------------------------- harness
const offlineLLM = (mock, extra = {}) => createOpenRouterLLM({ apiKey: OFFLINE_KEY, model: MOCK_MODEL, baseUrl: MOCK_BASE_URL, fetch: mock.fetch, ...extra });
const turnOf = (t) => t.messages.filter((m) => m.role === 'assistant').length;
const call = (name, args = {}) => ({ name, args });
const stable = (steps) => steps.map(({ ms, ...s }) => s);

async function phase(role, adapter, { ctx = {}, ...extra } = {}) {
  const events = createEventBus();
  const r = await runPhase(db, { role, mode: 'live', adapter, ctx, events,
    toolboxFactory: () => boxes.toolboxes[role](ctx), fallbackToolboxFactory: () => boxes.toolboxes.fallback(role, ctx), ...extra });
  return { r, events, steps: await readSteps(db, { role }) };
}
const redPhase = async (models, opts = {}) => { await reset(db); const mock = createMockOpenRouter({ models: { red: models }, intercept: opts.intercept });
  return { mock, ...(await phase('red', createRedAgent(offlineLLM(mock, opts.llm)), opts)) }; };

// round 1 up to BLUE: RED (autopilot setup), WORLD act + hold, snapshot, BLUE context on the Round for the MCP server
async function upToBlue() {
  await reset(db);
  const red = await runPhase(db, { role: 'red', mode: 'autopilot' });
  const round = await readRound(db);
  const world = await World.open(db);
  world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: await scenarioFaults(db, red.outcome.scenarioId) });
  world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  const ctx = { scenarioId: red.outcome.scenarioId, futureMode: 'reactive', snapshotId };
  await setBlueContext(db, ctx);
  return ctx;
}
const bluePhase = async (models, opts = {}) => { const ctx = await upToBlue(); const mock = createMockOpenRouter({ models: { blue: models }, intercept: opts.intercept });
  return { mock, ctx, ...(await phase('blue', createBlueAgent(offlineLLM(mock, opts.llm)), { ...opts, ctx })) }; };
// a model that answers turn 0 with `first`, then reasons like the canonical scripted model
const thenCanonical = (first, make = createScriptedRedModel) => { const m = make(); return { complete: (t) => (turnOf(t) === 0 ? first : m.complete(t)) }; };

// ---------------------------------------------------------------- 1–6: the provider ↔ tool contract
test('1. a valid tool call travels provider → adapter → MCP → toolbox → FalkorDB, and its real result returns to the model', async () => {
  const { r, mock, steps } = await redPhase(scriptModel([{ toolCalls: [call('amplification_paths', { min_risk: 2 })] }, { text: 'thinking' }]));
  assert.equal(mock.requests[0].url, `${MOCK_BASE_URL}/chat/completions`);
  assert.equal(mock.requests[0].body.model, MOCK_MODEL);
  assert.deepEqual(mock.requests[0].tools.map((t) => t.name), ROLE_TOOLS.red, 'the model is offered exactly the RED tools');
  assert.deepEqual([steps[0].tool, steps[0].ok, steps[0].by], ['amplification_paths', true, 'llm']);
  const result = JSON.parse(mock.requests[1].messages.at(-1).content);
  assert.deepEqual(result.rows[0].amplifier, ['gateway', 'checkout', 'payments'], 'the next request carries the real graph result');
  assert.equal(r.transport, 'mcp');
});

test('2. an invalid tool name is rejected server-side and recorded; the model can recover', async () => {
  const { r, steps } = await redPhase(thenCanonical({ toolCalls: [call('submit_scenario', { fault_ids: ['degrade:ledger-db'], evidence_path: PATH })] }));
  assert.deepEqual([steps[0].tool, steps[0].ok], ['submit_scenario', false]);
  assert.match(steps[0].summary, /not available to role 'red'/);
  assert.deepEqual([r.proposedBy, r.takeover, r.outcome.scenarioId], ['llm', null, 'S:R1']);
});

test('3. malformed arguments (unparseable JSON) are unusable output — never executed — and count toward takeover', async () => {
  const bad = { toolCalls: [{ name: 'simulate', rawArguments: '{"fault_ids": [' }] };
  const { r, steps } = await redPhase(thenCanonical(bad));
  assert.equal(r.history[0].tool, 'invalid_output');
  assert.notEqual(steps[0].tool, 'simulate', 'nothing reached the tool layer for the malformed call');
  assert.deepEqual([r.proposedBy, r.takeover], ['llm', null], 'one bad turn, then recovered');
  const twice = await redPhase(scriptModel([bad, bad]));
  assert.equal(twice.r.takeover.reason, REASONS.REJECTS);
});

test('4. wrong argument types are rejected before any server logic (no coercion)', async () => {
  const { r, steps } = await redPhase(thenCanonical({ toolCalls: [call('commit', { fault_ids: '["degrade:ledger-db"]', evidence_path: PATH })] }));
  assert.deepEqual([steps[0].tool, steps[0].ok, steps[0].summary], ['commit', false, 'rejected: commit: fault_ids must be an array of strings']);
  assert.deepEqual([r.proposedBy, r.outcome.scenarioId], ['llm', 'S:R1']);
});

test('5. multiple tool calls in one response run in order, and each result is answered to its own call id', async () => {
  const { mock, steps } = await redPhase(createScriptedRedModel());
  const first = mock.requests[0].response.choices[0].message.tool_calls;
  assert.deepEqual(first.map((c) => c.function.name), ['amplification_paths', 'list_candidates']);
  assert.deepEqual(steps.slice(0, 2).map((s) => s.tool), ['amplification_paths', 'list_candidates']);
  // the adapter re-issues deterministic call ids (provider-independent, cassette-stable); within the next request
  // every tool result answers the id of the assistant call it belongs to, in order
  const next = mock.requests[1].body.messages;
  const assistant = next.find((m) => m.role === 'assistant');
  const answers = next.filter((m) => m.role === 'tool');
  assert.deepEqual(assistant.tool_calls.map((c) => c.function.name), ['amplification_paths', 'list_candidates']);
  assert.deepEqual(answers.map((m) => m.tool_call_id), assistant.tool_calls.map((c) => c.id));
});

test('6. a tool rejection is fed back to the model as an error result, and the phase continues', async () => {
  const { mock, steps, r } = await redPhase(thenCanonical({ toolCalls: [call('simulate', { fault_ids: ['degrade:not-a-service'] })] }));
  assert.deepEqual([steps[0].tool, steps[0].ok], ['simulate', false]);
  assert.match(JSON.parse(mock.requests[1].messages.at(-1).content).error, /not in graph/);
  assert.deepEqual([r.proposedBy, r.outcome.scenarioId], ['llm', 'S:R1']);
});

// ---------------------------------------------------------------- 7–11: model failures and the B5 fallback
test('7. an empty model response is unusable; two in a row hand the phase to B5', async () => {
  const { r, events } = await redPhase(scriptModel([{ text: '' }, { text: '' }]));
  assert.deepEqual([r.takeover.reason, r.proposedBy, r.outcome.scenarioId], [REASONS.REJECTS, 'b5', 'S:R1']);
  assert.equal(events.log.filter((e) => e.type === 'TAKEOVER').length, 1);
});

test('8. provider failure (HTTP 503) and a stalled provider both fail over to B5', async () => {
  const down = await redPhase(createScriptedRedModel(), { intercept: () => ({ status: 503, text: 'unavailable' }) });
  assert.deepEqual([down.r.takeover.reason, down.r.proposedBy, down.r.outcome.scenarioId], [REASONS.ERROR, 'b5', 'S:R1']);
  const stall = await redPhase(createScriptedRedModel(), { intercept: () => ({ hang: true }), ceilingMs: 150, llm: { timeoutMs: 400 } });
  assert.deepEqual([stall.r.takeover.reason, stall.r.outcome.scenarioId], [REASONS.TIMEOUT, 'S:R1']);
});

test('9. a model that stops before committing (prose instead of a commit) is taken over; its work is kept', async () => {
  const canonical = createScriptedRedModel();
  const chatty = { async complete(t) { const reply = await canonical.complete(t); return reply.toolCalls?.some((c) => c.name === 'commit') ? { text: 'degrade:ledger-db looks like the attack.' } : reply; } };
  const { r, steps } = await redPhase(chatty);
  assert.equal(r.takeover.reason, REASONS.REJECTS);
  assert.ok(steps.filter((s) => s.by === 'llm' && s.tool === 'simulate').length >= 2, 'the model simulated before stopping');
  const cached = steps.filter((s) => s.by === 'b5' && s.tool === 'simulate' && s.summary.includes('cached'));
  assert.ok(cached.length >= 1, 'B5 reuses the model\'s simulations (charge-once)');
  assert.equal(r.outcome.scenarioId, 'S:R1');
});

test('10. max-turn takeover: eight turns without a commit', async () => {
  const { r } = await redPhase(scriptModel([(t) => ({ toolCalls: [call('blast_radius', { service: turnOf(t) % 2 ? 'payments' : 'orders' })] })]));
  assert.deepEqual([r.takeover.reason, r.takeover.turn, r.outcome.scenarioId], [REASONS.MAX_TURN, 8, 'S:R1']);
});

test('11. B5 fallback completes both roles through MCP when the provider is down', async () => {
  const red = await redPhase(createScriptedRedModel(), { intercept: () => ({ status: 503 }) });
  assert.ok(red.steps.every((s) => s.by === 'b5'));
  assert.equal((await roRows(db, 'twin', `MATCH (sc:Scenario {id:'S:R1'}) RETURN sc.proposed_by AS b`))[0].b, 'b5');
  const blue = await bluePhase(createScriptedBlueModel(), { intercept: () => ({ status: 503 }) });
  assert.deepEqual([blue.r.takeover.reason, blue.r.transport, blue.r.outcome.decision.selected_future, blue.r.outcome.decision.proposed_by], [REASONS.ERROR, 'mcp', fid(F5), 'b5']);
});

// ---------------------------------------------------------------- 12–13: valid commits
test('12. RED commits a valid attack (canonical trace)', async () => {
  const { r, steps } = await redPhase(createScriptedRedModel());
  assert.deepEqual(steps.map((s) => s.tool), ['amplification_paths', 'list_candidates', 'simulate', 'simulate', 'commit']);
  assert.deepEqual([r.proposedBy, r.takeover, r.outcome.faults], ['llm', null, ['degrade:ledger-db']]);
  const sc = (await roRows(db, 'twin', `MATCH (sc:Scenario {id:'S:R1'}) RETURN sc.evidence_path AS p, sc.proposed_by AS b, sc.minimality AS m`))[0];
  assert.deepEqual([sc.p, sc.b, sc.m], [PATH, 'llm', 'proven: no cheaper attack']);
});

test('13. BLUE commits a valid intervention (canonical trace)', async () => {
  const { r } = await bluePhase(createScriptedBlueModel());
  assert.deepEqual(r.history.map((h) => h.tool), ['list_candidates', ...Array(6).fill('fork_and_simulate'), 'commit']);
  const d = r.outcome.decision;
  assert.deepEqual([d.selected_future, d.proposed_by, d.minimality], [fid(F5), 'llm', 'proven-in-scope']);
  assert.equal((await roRows(db, 'twin', `MATCH (d:Decision {id:'D:R1'}) RETURN d.proposed_by AS b`))[0].b, 'llm');
});

// ---------------------------------------------------------------- 14–15: the boundary
test('14. the model cannot see WORLD: graph queries answer from the TWIN; the agent identity is refused WORLD', async () => {
  const q = 'MATCH (s:Service {name:$n}) RETURN s.cap_mean AS cap';
  const { mock } = await redPhase(scriptModel([{ toolCalls: [call('query_graph', { cypher: q, params: { n: 'payments' } })] }, { text: '' }]));
  const seen = JSON.parse(mock.requests[1].messages.at(-1).content).rows[0].cap;
  const twin = (await roRows(db, 'twin', q, { n: 'payments' }))[0].cap;
  const world = (await roRows(db, 'world', q, { n: 'payments' }))[0].cap;
  assert.notEqual(twin, world, 'precondition: belief and truth differ');
  assert.equal(seen, twin, 'the model saw the TWIN belief, not the WORLD truth');
  assert.match((await raw(agentDb, 'GRAPH.RO_QUERY', 'world', 'MATCH (n) RETURN count(n)')).error, /NOPERM/);
});

test('15. the model cannot bypass MCP: raw commands, write Cypher and other roles\' tools are refused; the mock has no shortcut', async () => {
  const before = await roRows(db, 'twin', 'MATCH (s:Service) RETURN s.name AS n, s.cap_mean AS c ORDER BY n');
  // each attempt is followed by a legitimate call, so the model keeps control (two rejects in a row would hand over to B5)
  const { steps } = await redPhase(scriptModel([
    { toolCalls: [call('GRAPH.QUERY', { graph: 'world', cypher: 'MATCH (s:Service) SET s.cap_mean = 1' }), call('amplification_paths', { min_risk: 2 })] },
    { toolCalls: [call('query_graph', { cypher: 'MATCH (s:Service) SET s.cap_mean = 1' }), call('list_candidates')] },
    { toolCalls: [call('fork_and_simulate', { intervention_ids: F5 }), call('rank_nodes', { metric: 'pagerank' })] },
    { toolCalls: [call('query_graph', { cypher: `CREATE (:Decision {id:'D:R1'})` }), call('blast_radius', { service: 'payments' })] },
    { text: '' }, { text: '' }]));
  assert.deepEqual(steps.filter((s) => s.by === 'llm' && !s.ok).map((s) => s.tool), ['GRAPH.QUERY', 'query_graph', 'fork_and_simulate', 'query_graph']);
  assert.deepEqual(await roRows(db, 'twin', 'MATCH (s:Service) RETURN s.name AS n, s.cap_mean AS c ORDER BY n'), before);
  assert.equal((await roRows(db, 'twin', 'MATCH (d:Decision) RETURN count(d) AS n'))[0].n, 0);
  // the mock and the models it runs import nothing: no database, MCP or network handle
  for (const f of ['tests/ai/mock-openrouter.js', 'tests/fixtures/red-model.js', 'tests/fixtures/blue-model.js']) {
    assert.deepEqual([...readFileSync(`${ROOT}${f}`, 'utf8').matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]), [], f);
  }
});

// ---------------------------------------------------------------- 16–19: M5 authority and the cheapest answer
test('16. server-side M5 rejection: a proposal the rule does not select is refused, the winner is named, the model follows it', async () => {
  const breaker = ['breaker:checkout>payments'];
  const { r, events } = await bluePhase(scriptModel([
    { toolCalls: [call('list_candidates')] },
    { toolCalls: [call('fork_and_simulate', { intervention_ids: breaker })] },
    { toolCalls: [call('fork_and_simulate', { intervention_ids: F5 })] },
    { toolCalls: [call('commit', { future_id: fid(breaker), rationale: 'breaker is enough' })] },
    (t) => ({ toolCalls: [call('commit', { future_id: JSON.parse(t.messages.at(-1).content).error.match(/rule winner (\S+)/)[1], rationale: 'the rule winner' })] }),
  ]));
  const audits = events.log.filter((e) => e.type === 'DECISION_AUDITED').map((e) => [e.payload.accepted, e.payload.rule_winner]);
  assert.deepEqual(audits, [[false, fid(F5)], [true, null]]);
  assert.deepEqual([r.outcome.decision.selected_future, r.outcome.decision.proposed_by], [fid(F5), 'llm']);
});

test('17. a cheaper (or equal, better) untested candidate makes the server reject the proposal — RED and BLUE', async () => {
  // RED: the pair qualifies, but a strictly cheaper single fault also does
  const pair = ['degrade:ledger-db', 'degrade:payments'];
  const red = await redPhase(scriptModel([
    { toolCalls: [call('simulate', { fault_ids: pair })] },
    { toolCalls: [call('commit', { fault_ids: pair, evidence_path: PATH })] },
    { toolCalls: [call('simulate', { fault_ids: ['degrade:ledger-db'] })] },
    { toolCalls: [call('commit', { fault_ids: ['degrade:ledger-db'], evidence_path: PATH })] },
  ]));
  const commits = red.steps.filter((s) => s.tool === 'commit').map((s) => [s.ok, s.summary]);
  assert.deepEqual(commits[0], [false, 'rejected: commit: a cheaper attack exists: degrade:ledger-db']);
  assert.equal(commits[1][0], true);
  // BLUE: a green future at cost 2 is proposed while an untested equal-cost future has a lower median
  const capped = ['cap_retries:checkout>payments', 'retries_off:gateway>checkout'];
  const blue = await bluePhase(scriptModel([
    { toolCalls: [call('list_candidates')] },
    { toolCalls: [call('fork_and_simulate', { intervention_ids: capped })] },
    { toolCalls: [call('commit', { future_id: fid(capped) })] },
    (t) => ({ toolCalls: [call('commit', { future_id: JSON.parse(t.messages.at(-1).content).error.match(/rule winner (\S+)/)[1] })] }),
  ]));
  const audits = blue.events.log.filter((e) => e.type === 'DECISION_AUDITED').map((e) => [e.payload.accepted, e.payload.rule_winner]);
  assert.deepEqual(audits, [[false, fid(F5)], [true, null]], 'the audit found the untested F5 and named it');
  assert.equal(blue.r.outcome.decision.selected_future, fid(F5));
});

test('18. RED stops at the cheapest qualifying attack: the next response after a qualifying single fault is the commit', async () => {
  const { r, mock } = await redPhase(createScriptedRedModel());
  assert.match(mock.requests[0].system, /Stopping rule/, 'the model was given the stopping rule');
  const h = r.history;
  const hit = h.findIndex((x) => x.tool === 'simulate' && x.result?.sustained >= 8);
  assert.deepEqual(h[hit].args.fault_ids, ['degrade:ledger-db']);
  assert.equal(h[hit + 1].tool, 'commit');
  assert.equal(h[hit + 1].turn, h[hit].turn + 1, 'committed on the very next turn');
  assert.equal(h.filter((x) => x.tool === 'simulate').length, 2, 'no simulation after the qualifying result');
});

test('19. BLUE commits the cheapest qualifying intervention among those it evaluated', async () => {
  const { r } = await bluePhase(createScriptedBlueModel());
  const futures = r.history.filter((x) => x.tool === 'fork_and_simulate' && x.ok).map((x) => x.result);
  const green = futures.filter((f) => f.verdict === 'green').sort((a, b) => a.cost - b.cost || a.viol_ticks_p50 - b.viol_ticks_p50);
  assert.equal(r.outcome.decision.selected_future, green[0].future_id);
  assert.ok(futures.filter((f) => f.cost < green[0].cost).every((f) => f.verdict !== 'green'), 'nothing cheaper qualified');
  assert.equal(r.outcome.decision.minimality, 'proven-in-scope');
});

// ---------------------------------------------------------------- 20: cassette
test('20. cassette: a recorded offline trace replays through MCP without any provider, identically; no secrets stored', async () => {
  const rec = createCassette();
  const live = await redPhase(createScriptedRedModel());          // warm-up phase run unrecorded is discarded below
  await reset(db);
  const mock = createMockOpenRouter({ models: { red: createScriptedRedModel() } });
  const recorded = await phase('red', rec.record(createRedAgent(offlineLLM(mock))));
  const path = join(mkdtempSync(join(tmpdir(), 'argus-ai-')), 'red.json');
  saveCassette(path, rec, { source: 'offline mock provider (tests/ai)' });
  const text = readFileSync(path, 'utf8');
  for (const secret of [OFFLINE_KEY, 'Bearer', 'Authorization', process.env.ARGUS_AGENT_PASSWORD, process.env.ARGUS_ADMIN_PASSWORD, process.env.OPENROUTER_API_KEY].filter(Boolean)) {
    assert.ok(!text.includes(secret), 'the cassette stores no credentials');
  }
  assert.ok(!/[A-Z]:\\\\|\/home\/|\/Users\//.test(text), 'no machine-specific paths');
  await reset(db);
  const requestsBefore = mock.requests.length;
  const { cassette } = loadCassette(path);
  const replayed = await phase('red', cassette.player());
  assert.equal(mock.requests.length, requestsBefore, 'replay made no provider request');
  assert.deepEqual(stable(replayed.steps), stable(recorded.steps));
  assert.deepEqual([replayed.r.proposedBy, replayed.r.takeover, replayed.r.outcome], [recorded.r.proposedBy, null, recorded.r.outcome]);
  assert.deepEqual(stable(recorded.steps), stable(live.steps), 'recording does not change behaviour');
});

test('no network: nothing in the offline suite reached the network or OpenRouter', () => {
  assert.deepEqual(network, []);
});
