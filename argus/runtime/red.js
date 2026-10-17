// RED — the adversarial agent (spec §7 RED strategy, §9.2 objective, §11.2 tools, §14 modes).
// "How could I break this system?" RED is an LLM behind a provider-agnostic interface. It sees only its
// objective, its RED tools and the results of its own tool calls; it never receives the topology or the
// answer from the orchestrator. Each turn it proposes tool call(s); the tool layer validates and executes
// them (rejections are recorded), the server re-verifies and audits the submitted scenario, and B5 takes
// over if the model is unavailable, slow, wandering or unusable (runtime.js).
//
// LLM interface (injected):   llm.complete({ system, messages, tools }) → Promise<{ toolCalls?: [{ name, args }], text? }>
// A real provider adapter (e.g. OpenRouter tool calling) only has to implement complete(); none is bound here.
import { RED_POLICY } from './tools.js';
import { SEED_SCHEME } from '../graph/forks.js';
import { SHAPE } from '../sim/sim.js';

// Spec §9.2 objective, with every number filled from graph data or the shared policy constants (so a changed
// Round changes what RED is told). On the canonical Round its first paragraph is exactly the spec's text.
// [M9.1] It is followed by working rules for a live model: the turn limit the runtime enforces (§14.2, passed in the
// observation as max_turn), batching, and spending simulations deliberately. The rules name no fault, service or
// path — only tools and thresholds.
// [M13] The rules also give the evidence order a live model should follow (amplifier triggers, then pairs with a
// pending deploy or an entry surge, then the top-ranked service) and the no-progress takeover (observation
// no_progress_calls), because a live model that surveyed unrelated single faults was taken over in every phase.
// The order is the spec's own strategy (§9.6); it names mechanisms and tools, never a service, fault or answer.
export function renderRedObjective({ budgets, roundInfo, turn, max_turn: maxTurn, no_progress_calls: noProgress }) {
  const threshold = `${RED_POLICY.SUSTAINED_MIN} of ${SEED_SCHEME.ROLLOUTS}`;
  const objective = `Find the cheapest combination of at most ${RED_POLICY.MAX_FAULTS} faults that, per \`simulate\`, leaves the entry SLO violated `
    + `in the last ${SHAPE.RECOVERY_WINDOW} ticks of a ${roundInfo.horizon_preemptive}-tick horizon (transient faults removed at tick ${roundInfo.t_off}) `
    + `in at least ${threshold} rollouts. You have ${budgets.sim_budget} simulations. `
    + 'Every fault must come from `list_candidates`. Submit it with its multi-hop evidence path. '
    + 'The server will check that no cheaper scenario works.';
  const rules = [
    Number.isInteger(maxTurn)
      ? `You have at most ${maxTurn} turns; one turn is one response from you.${Number.isInteger(turn) ? ` This is turn ${turn + 1} of ${maxTurn}.` : ''} `
        + `After turn ${maxTurn} without a commit, an autopilot takes over. On your final turn, if you hold any qualifying result, respond with \`commit\` only.`
      : 'You have a limited number of turns (one turn is one response from you); commit as soon as the stopping rule below is met.',
    'Independent read-only graph-inspection calls may be batched in one response when their results are not needed to choose among them.',
    'NEVER batch multiple `simulate` calls in the same response. A simulation result must be observed before deciding whether another simulation is necessary.',
    'NEVER batch `commit` with another simulation.',
    `Stopping rule, applied after every \`simulate\` result: a result qualifies when \`sustained\` is at least ${RED_POLICY.SUSTAINED_MIN} (of ${SEED_SCHEME.ROLLOUTS}). `
      + 'A qualifying fault set is a cheapest attack when no strictly cheaper set is left untested — compare the total costs from `list_candidates`; '
      + 'a single fault with the lowest listed cost can never be beaten. When you hold a cheapest qualifying set, your next response must be a single '
      + '`commit` call with exactly those fault ids and its evidence path. Do not simulate alternatives of equal or higher cost: the server accepts ties '
      + 'and only rejects a commit if a strictly cheaper scenario works.',
    'If a qualifying set could still be beaten by a strictly cheaper untested candidate (for example, one fault of a qualifying pair on its own), '
      + 'simulate that cheaper candidate next, then commit the cheapest qualifying set.',
    'Do not spend additional simulation budget merely to reconfirm a result that already satisfies the objective.',
    'Plan from graph evidence before you simulate: call `list_candidates` (fault ids, kinds, costs) and `amplification_paths` first. '
      + 'An amplifier is a call path whose retry layers multiply load onto its target; its `triggers` (fault_id@hops) are the faults beneath that target, '
      + 'and the deepest trigger of the strongest amplifier is the slowdown that retries turn into a self-sustaining cascade. Simulate it first.',
    'If the best single trigger does not qualify, pair it — in this order. First with a fault of kind deploy from `list_candidates` whose pending change '
      + 'lands more retries on the path into the trigger\'s service (ask `query_graph` which ChangeEvent MODIFIES a caller of that service): a persistent '
      + 'deploy can turn a slowdown that heals by itself into a sustained cascade, so this pair is the most likely to qualify. Only when no such pending '
      + 'deploy exists, or that pair does not qualify, pair the trigger with the surge fault of the amplifier\'s entry service.',
    'If no amplifier is reported, start from the most depended-on service (`rank_nodes`): simulate its slowdown, then that slowdown paired with each '
      + 'pending deploy landing on it, then with a surge at an entry. Do not spend a simulation on a fault that is on no amplifier and not on the '
      + 'top-ranked service: such single faults rarely qualify.',
    Number.isInteger(noProgress)
      ? `The autopilot also takes over after ${noProgress} simulations without a qualifying result, so your first ${noProgress} simulations must be the `
        + 'best-evidenced candidates in the order above, never a survey of unrelated single faults.'
      : 'The autopilot also takes over after a few simulations without a qualifying result, so your first simulations must be the best-evidenced '
        + 'candidates in the order above, never a survey of unrelated single faults.',
    'Avoid generic or exploratory queries (counting nodes, listing properties, guessing property names). `query_graph` is for targeted questions, '
      + 'such as which pending change lands on a given service.',
    'Every simulation consumes your simulation budget. Choose each one deliberately from the graph evidence.',
    'A single fault is cheaper than a pair, so test the best-evidenced single first and its pair second; you do not need to test every single fault.',
    'Once the stopping rule is met, commit. Do not keep exploring merely to gather more information.',
    'Never invent a fault: use only fault ids returned by `list_candidates`.',
    '`commit` needs the fault ids and a multi-hop evidence path: the service names, in call order, of a graph path that leads to the faulted service.',
    'The server re-verifies every commit and rejects it if a cheaper scenario works; its validation is final and binding.',
  ];
  return `${objective}\n\nHow to work:\n${rules.map((r) => `- ${r}`).join('\n')}`;
}

// RED's tools as offered to the model (spec §11.2; schemas are the §11.2 [IMPL-INTERPRETATION]).
// fork_and_simulate is BLUE-only and is not offered; a call to it is rejected server-side.
export const RED_TOOL_SCHEMAS = Object.freeze([
  { name: 'query_graph', description: 'Read-only Cypher on the twin graph; write clauses are rejected. Schema: (:Service {name, entry, cap_mean})-[:CALLS {retries, timeout_ms, breaker, fanout}]->(:Service); '
      + '(:Fault {id, kind, active})-[:APPLIES_TO]->(:Service); a Fault of kind deploy also -[:LANDS]->(:ChangeEvent {id, status, field, new_value})-[:MODIFIES {callee}]->(:Service) (the caller of the edge it changes); '
      + '(:Intervention {id, kind, cost, caller, callee})-[:APPLIES_TO]->(:Service); (:Round). Only these labels and properties exist. '
      + "Cypher rules: an inline property map takes literal values only, e.g. {status: 'pending'}; the shorthand {callee} and variables inside a map are rejected, "
      + 'so compare properties in WHERE (m.callee = b.name). ChangeEvent has no kind: a pending deploy is status = pending, and the fault that lands it is the Fault '
      + 'with a LANDS edge to it. Pending deploys with the edge each changes and its fault id: '
      + "MATCH (ce:ChangeEvent {status: 'pending'})-[m:MODIFIES]->(caller:Service)-[:CALLS]->(callee:Service) WHERE m.callee = callee.name "
      + 'OPTIONAL MATCH (f:Fault)-[:LANDS]->(ce) RETURN ce.id, f.id AS deploy_fault, caller.name AS caller, callee.name AS callee, ce.field, ce.new_value',
    input_schema: { type: 'object', properties: { cypher: { type: 'string' }, params: { type: 'object' } }, required: ['cypher'] } },
  { name: 'amplification_paths', description: 'Call paths from an entry service ranked by the worst-case retry load on their target (overload, strongest first), each with its triggers: '
      + 'the faults beneath the target as fault_id@hops. The retry layers above the target multiply any slowdown below it, so the deepest trigger of the strongest amplifier is the most likely seed of a sustained cascade.',
    input_schema: { type: 'object', properties: { min_risk: { type: 'number' } }, required: ['min_risk'] } },
  { name: 'rank_nodes', description: 'Rank services by graph importance (how much of the system transitively depends on them).',
    input_schema: { type: 'object', properties: { metric: { type: 'string', enum: ['pagerank', 'in_degree'] } }, required: ['metric'] } },
  { name: 'blast_radius', description: 'Upstream services and entry points that depend on a service, with hop counts.',
    input_schema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] } },
  { name: 'list_candidates', description: 'Every fault RED may use (id, kind, target service, cost to attacker). Kinds: degrade = a transient slowdown of a service; '
      + 'surge = transient extra traffic at an entry service; deploy = a pending change that lands permanently (for example more retries on a call edge) and can make a slowdown it amplifies unrecoverable.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'simulate', description: 'Run seeded rollouts of up to 2 faults on the twin; returns how many of the rollouts stay SLO-violated (sustained).',
    input_schema: { type: 'object', properties: { fault_ids: { type: 'array', items: { type: 'string' } } }, required: ['fault_ids'] } },
  { name: 'commit', description: 'Commit the attack with its multi-hop evidence path. The server re-verifies it and checks that no cheaper scenario works.',
    input_schema: { type: 'object', properties: { fault_ids: { type: 'array', items: { type: 'string' } }, evidence_path: { type: 'array', items: { type: 'string' } } },
      required: ['fault_ids', 'evidence_path'] } },
]);

// The transcript the model sees: objective, a kickoff, then per turn its tool calls and their results.
// Built only from the runtime observation (graph-derived budgets/constants + the model's own call results).
export function buildRedMessages(obs) {
  const messages = [{ role: 'user', content: `Round ${obs.round}. ${obs.budgets.tool_budget} tool calls and ${obs.budgets.sim_budget} simulations remain. How could you break this system?` }];
  const turns = [...new Set(obs.history.map((h) => h.turn))].sort((a, b) => a - b);
  for (const t of turns) {
    const calls = obs.history.filter((h) => h.turn === t);
    messages.push({ role: 'assistant', toolCalls: calls.map((h, k) => ({ id: `t${t}c${k}`, name: h.tool, args: h.args })) });
    calls.forEach((h, k) => messages.push({ role: 'tool', toolCallId: `t${t}c${k}`, name: h.tool,
      content: JSON.stringify(h.ok ? h.result : { error: h.summary }) }));
  }
  return messages;
}

/**
 * Wrap an LLM as the runtime adapter for RED. The model's reply is mapped to tool call(s); anything that is
 * not a well-formed tool call is passed through and the runtime counts it as unusable output.
 */
export function createRedAgent(llm) {
  if (!llm || typeof llm.complete !== 'function') throw new Error('createRedAgent: an LLM with complete({system, messages, tools}) is required');
  return {
    async next(obs) {
      const reply = await llm.complete({ system: renderRedObjective(obs), messages: buildRedMessages(obs), tools: RED_TOOL_SCHEMAS });
      const calls = Array.isArray(reply?.toolCalls) ? reply.toolCalls : [];
      if (!calls.length || !calls.every((c) => c && typeof c.name === 'string' && (c.args === undefined || (typeof c.args === 'object' && c.args !== null)))) {
        return { unusable: reply?.text ?? reply };
      }
      return calls.length === 1 ? { tool: calls[0].name, args: calls[0].args ?? {} } : { calls: calls.map((c) => ({ tool: c.name, args: c.args ?? {} })) };
    },
  };
}
