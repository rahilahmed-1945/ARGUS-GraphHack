// Offline AI end-to-end smoke test (npm run test:ai:e2e). No API key, no network, no live model.
// The complete canonical run — RED R1 → BLUE R1 → hardening → WORLD observation → RED R2 → BLUE R2 → hardening →
// WORLD finale → SAFE — with both agents answered by the offline mock OpenRouter endpoint through the REAL provider,
// the production agent adapters and the MCP role servers on the restricted agent identity.
// Requires `npm run db:up` (ACL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { connect, roRows } from '../../graph/db.js';
import { reset } from '../../graph/reset.js';
import { readSteps } from '../../graph/steps.js';
import { setKey } from '../../graph/decision.js';
import { createEventBus } from '../../runtime/events.js';
import { createWorldClock } from '../../runtime/clock.js';
import { runCanonicalDemo } from '../../runtime/demo.js';
import { createCassette } from '../../runtime/runtime.js';
import { ROLE_TOOLS } from '../../runtime/tools.js';
import { createRedAgent } from '../../runtime/red.js';
import { createBlueAgent } from '../../runtime/blue.js';
import { createOpenRouterLLM } from '../../runtime/providers/openrouter.js';
import { loadCassette } from '../../runtime/cassette-file.js';
import { createScriptedRedModel } from '../fixtures/red-model.js';
import { createScriptedBlueModel } from '../fixtures/blue-model.js';
import { mcpToolboxes, raw } from '../helpers.js';
import { createMockOpenRouter, MOCK_BASE_URL, MOCK_MODEL } from './mock-openrouter.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const network = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { network.push(String(url)); throw new Error(`network disabled in offline AI tests: ${url}`); };

let db, agentDb, boxes;
before(async () => { db = await connect(); agentDb = await connect({ as: 'agent' }); boxes = await mcpToolboxes(agentDb); });
after(async () => { await boxes.close(); await agentDb.close(); await reset(db); await db.close(); globalThis.fetch = realFetch; });

test('AI e2e: the full canonical run through the offline provider and MCP reaches SAFE with every guarantee intact', { timeout: 600000 }, async () => {
  await reset(db);
  await raw(db, 'ACL', 'LOG', 'RESET');
  const mock = createMockOpenRouter({ models: { red: createScriptedRedModel(), blue: createScriptedBlueModel() } });
  const llm = createOpenRouterLLM({ apiKey: 'offline-test-key', model: MOCK_MODEL, baseUrl: MOCK_BASE_URL, fetch: mock.fetch });
  const rec = createCassette();
  const events = createEventBus();
  const result = await runCanonicalDemo(db, {
    mode: 'live', events, clock: createWorldClock({ pacing: 'virtual', events }),
    adapters: { red: rec.record(createRedAgent(llm)), blue: rec.record(createBlueAgent(llm)) },
    toolboxes: boxes.toolboxes,
  });

  // ---- every phase driven by the model, over MCP, without takeover; one provider request per agent turn
  assert.deepEqual(result.phases.map((p) => [p.role, p.round, p.proposedBy, p.takeover, p.transport]), [
    ['red', 1, 'llm', null, 'mcp'], ['blue', 1, 'llm', null, 'mcp'], ['red', 2, 'llm', null, 'mcp'], ['blue', 2, 'llm', null, 'mcp']]);
  assert.equal(mock.requests.length, result.phases.reduce((a, p) => a + p.turns, 0));
  assert.ok(mock.requests.every((r) => r.body.model === MOCK_MODEL && r.url === `${MOCK_BASE_URL}/chat/completions`));
  assert.deepEqual(events.log.filter((e) => e.type === 'TAKEOVER' || e.type === 'TOOL_TRANSPORT_FAILOVER'), []);

  // ---- correct tool sequence per role and round (the canonical traces)
  const seq = async (round, role) => (await readSteps(db, { round, role })).map((s) => s.tool);
  assert.deepEqual(await seq(1, 'red'), ['amplification_paths', 'list_candidates', 'simulate', 'simulate', 'commit']);
  assert.deepEqual(await seq(1, 'blue'), ['list_candidates', ...Array(6).fill('fork_and_simulate'), 'commit']);
  assert.deepEqual(await seq(2, 'red'), ['amplification_paths', 'list_candidates', 'rank_nodes', 'query_graph', 'simulate', 'simulate', 'commit']);
  assert.deepEqual(await seq(2, 'blue'), ['list_candidates', ...Array(3).fill('fork_and_simulate'), 'commit']);

  // ---- role permissions: every Step is the model's, within its role's tools, and accepted
  const steps = await readSteps(db, {});
  assert.ok(steps.every((s) => s.by === 'llm' && s.ok && ROLE_TOOLS[s.role].includes(s.tool)));
  assert.equal(steps.length, events.log.filter((e) => e.type === 'TOOL_CALL').length, 'one Step per tool call');

  // ---- MCP boundary: the agent identity needed nothing outside its ACL; nothing reached the network
  assert.deepEqual((await raw(db, 'ACL', 'LOG')).reply, [], 'no permission denial during the run');
  assert.deepEqual(network, [], 'no network or OpenRouter request');

  // ---- M5 authoritative; decisions persisted with their evidence
  const audits = events.log.filter((e) => e.type === 'DECISION_AUDITED').map((e) => e.payload);
  assert.ok(audits.every((a) => a.accepted && a.audit_sims > 0), 'each proposal went through the server rule and audit');
  const decisions = await roRows(db, 'twin', `MATCH (d:Decision) RETURN d.id AS id, d.selected_future AS f, d.minimality AS m, d.proposed_by AS b, d.applied AS a, d.hardening_pr AS pr ORDER BY id`);
  assert.deepEqual(decisions.map((d) => [d.id, d.f, d.m, d.b, d.a, !!d.pr]), [
    ['D:R1', `fork:R1:${setKey(['retries_off:checkout>payments', 'retries_off:gateway>checkout'])}`, 'proven-in-scope', 'llm', true, true],
    ['D:R2', `fork:R2:${setKey(['scale_out:ledger-db'])}`, 'proven-in-scope', 'llm', true, true]]);
  const based = await roRows(db, 'twin', `MATCH (d:Decision)-[:BASED_ON]->(s:Step) RETURN d.id AS d, count(s) AS n ORDER BY d`);
  assert.deepEqual(based.map((b) => [b.d, b.n]), [['D:R1', 8], ['D:R2', 5]], 'each decision links to the BLUE Steps it rests on');
  const scenarios = await roRows(db, 'twin', `MATCH (sc:Scenario) RETURN sc.id AS id, sc.proposed_by AS b, sc.minimality AS m ORDER BY id`);
  assert.deepEqual(scenarios.map((s) => [s.id, s.b, s.m]), [['S:R1', 'llm', 'proven: no cheaper attack'], ['S:R2', 'llm', 'proven: no cheaper attack']]);

  // ---- hardening persists in WORLD and TWIN
  for (const g of ['world', 'twin']) {
    const calls = Object.fromEntries((await roRows(db, g, `MATCH (a:Service)-[c:CALLS]->(b:Service) RETURN a.name + '>' + b.name AS e, c.retries AS r`)).map((x) => [x.e, x.r]));
    assert.deepEqual([calls['checkout>payments'], calls['gateway>checkout'], calls['orders>ledger-db']], [0, 0, 3], `${g}: round-1 hardening kept, CE-42 landed`);
    assert.equal((await roRows(db, g, `MATCH (s:Service {name:'ledger-db'}) RETURN s.cap_mean AS c`))[0].c, 825, `${g}: round-2 scale-out applied`);
  }

  // ---- WORLD/TWIN separation: records live only in the TWIN; WORLD truth differs from TWIN belief
  const labels = async (g) => (await roRows(db, g, 'MATCH (n) UNWIND labels(n) AS l RETURN DISTINCT l ORDER BY l')).map((r) => r.l);
  const worldLabels = await labels('world');
  for (const l of ['Decision', 'Step', 'Scenario', 'Future', 'Observation', 'Charge', 'Snapshot']) assert.ok(!worldLabels.includes(l), `WORLD holds no ${l}`);
  const cap = async (g) => (await roRows(db, g, `MATCH (s:Service {name:'payments'}) RETURN s.cap_mean AS c`))[0].c;
  assert.notEqual(await cap('twin'), await cap('world'), 'the TWIN holds a calibrated belief, not the WORLD truth');

  // ---- WORLD observations and the final verdict
  const obs = await roRows(db, 'twin', `MATCH (o:Observation)-[:VERIFIES]->(d:Decision) RETURN d.id AS d, o.observed_viol_ticks AS v ORDER BY d`);
  assert.deepEqual(obs.map((o) => [o.d, o.v]), [['D:R1', 3], ['D:R2', 0]]);
  assert.deepEqual([result.safe, result.finale.observed_viol_ticks, result.finale.ticks], [true, 0, 90]);
  assert.deepEqual((await db.list()).sort(), ['twin', 'world'], 'every fork cleaned up');

  // ---- the offline provider path reproduces the committed reference cassette decision for decision
  const reference = loadCassette(`${ROOT}cassettes/reference-scripted.json`);
  assert.deepEqual(rec.toJSON(), reference.cassette.toJSON());
});
