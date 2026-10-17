// BLUE — the defensive agent (spec §8/§10 BLUE strategy, §10.2 objective, §11.2 tools, §13 authority, §14 modes).
// BLUE is an LLM behind the same provider-agnostic interface as RED. It sees only its objective, its BLUE tools
// and the results of its own tool calls. It PROPOSES: it evaluates graph-derived candidate interventions on real
// counterfactual forks and proposes one future; the server rule + audit (M5) DECIDES. A rejected proposal is
// returned to BLUE as a tool error naming the rule's winner. B5 takes over on failure (runtime.js).
//
// LLM interface (injected):   llm.complete({ system, messages, tools }) → Promise<{ toolCalls?: [{ name, args }], text? }>
import { MAX_INTERVENTIONS, SEED_SCHEME } from '../graph/forks.js';

// Spec §10.2 objective; the futures budget is the live Round value from the graph.
// On a fresh canonical Round its first paragraph is exactly the spec's text.
// Working rules for a live model follow (the RED equivalents): the runtime's turn limit (observation max_turn), the
// futures budget, no batched futures, and a stopping rule phrased on the M5 rule (qualification from the Round's
// rec_threshold/error_budget; cost ties go to the server's audit, which names the winner). No service or id is named.
// [M13] The rules also give the evidence order a live model should follow (remove the amplifier's retry layers in one
// future, read amber as "add capacity at the saturated service", block a deploy only in combination) and the
// no-progress takeover (observation no_progress_calls), because a live model that tried one edge at a time was taken
// over in every phase. The order names mechanisms and intervention kinds, never a service, an id or an answer.
export function renderBlueObjective({ budgets, roundInfo = {}, turn, max_turn: maxTurn, no_progress_calls: noProgress }) {
  const objective = 'Restore (round 1) or protect (round 2) the entry SLO. Get candidates from `list_candidates(scope=scenario)`. '
    + `You have ${budgets.fork_budget} futures, each with at most ${MAX_INTERVENTIONS} interventions. Commit to one.`;
  const { rec_threshold: rec, error_budget: budget } = roundInfo;
  const qualifies = Number.isFinite(rec) && Number.isFinite(budget)
    ? `its verdict is green: it recovers in at least ${rec} of ${SEED_SCHEME.ROLLOUTS} rollouts with a median of at most ${budget} violated ticks`
    : 'its verdict is green';
  const rules = [
    Number.isInteger(maxTurn)
      ? `You have at most ${maxTurn} turns; one turn is one response from you.${Number.isInteger(turn) ? ` This is turn ${turn + 1} of ${maxTurn}.` : ''} `
        + `After turn ${maxTurn} without a commit, an autopilot takes over. On your final turn, if you hold a qualifying future, respond with \`commit\` only.`
      : 'You have a limited number of turns (one turn is one response from you); commit as soon as the decision rule below is met.',
    `DECISION RULE — apply it after every \`fork_and_simulate\` result, before anything else. A future qualifies when ${qualifies}. `
      + 'First: if the result is green and no strictly cheaper untested in-scope candidate could still qualify, your next response is a single `commit` '
      + 'with that future_id and nothing else: do not run another future and do not gather more information. '
      + 'Second: if a strictly cheaper untested candidate remains, evaluate only the candidate(s) needed to settle that cost comparison, then commit the cheapest green. '
      + 'Third: never evaluate a candidate of equal or higher cost than a green future you already hold, and never keep exploring after a qualifying future exists: '
      + 'the server audits every cheaper or equal option itself, and a phase that reaches its turn limit without a commit is handed to the autopilot, '
      + 'which commits what you already found — further exploration gains nothing and forfeits your decision.',
    `Every \`fork_and_simulate\` call uses one of your ${budgets.fork_budget} futures. Choose each one deliberately from the scope returned by \`list_candidates\` and the graph evidence.`,
    'NEVER batch multiple `fork_and_simulate` calls in the same response, and NEVER batch `commit` with one. Observe each result before deciding whether another future is necessary.',
    'Plan from graph evidence before you fork: call `list_candidates` (the scope, with the scenario\'s faults and evidence path) and `amplification_paths` first. '
      + 'Kinds in the scope: retries_off and cap_retries remove or cap the retries of one call edge; breaker adds a circuit breaker to an edge; '
      + 'scale_out multiplies the capacity of a service; shed drops a share of an entry\'s traffic; block_deploy keeps a pending change from landing.',
    `A reported amplifier is a retry path whose layers interact: each edge's retries multiply the next, so removing one layer rarely cures it. `
      + `Evaluate the retry interventions of the amplifier's edges together in one future (one per edge; a future holds up to ${MAX_INTERVENTIONS} interventions, `
      + `and retries_off and cap_retries on the same edge cannot be combined) before testing any of those edges alone.`,
    'Read verdicts as evidence. red = the entries do not recover (the cure is off the cascade path or too weak). amber = they recover but slower than '
      + 'the error budget (the bottleneck still saturates). green = qualifies. After an amber result, test a stronger cure next — add capacity at the '
      + 'saturated service (the service the scenario degrades, which `blast_radius` shows every entry depends on) or combine the amber cure with it — '
      + 'never another single cure of the same kind.',
    'If the scenario includes a pending deploy, blocking it alone usually leaves the slowdown\'s own cost: combine it, or prefer the capacity cure. '
      + 'When no amplifier is reported, the bottleneck is capacity: evaluate scale_out on the faulted service early.',
    Number.isInteger(noProgress)
      ? `The autopilot also takes over after ${noProgress} futures without a green verdict, so your first ${noProgress} futures must be the best-evidenced `
        + 'cures in the order above, never a survey of single edges.'
      : 'The autopilot also takes over after a few futures without a green verdict, so your first futures must be the best-evidenced cures in the order above, '
        + 'never a survey of single edges.',
    'The server\'s selection rule and audit make the final decision: they also reject a future that does worse than doing nothing on any entry, '
      + 'and if the rule prefers another option the server rejects your proposal and names the winner, which you may then commit.',
  ];
  return `${objective}\n\nHow to work:\n${rules.map((r) => `- ${r}`).join('\n')}`;
}

// BLUE's tools as offered to the model (spec §11.2; schemas are the §11.2 [IMPL-INTERPRETATION]).
// simulate is RED-only and is not offered; a call to it is rejected server-side.
export const BLUE_TOOL_SCHEMAS = Object.freeze([
  { name: 'query_graph', description: 'Read-only Cypher on the twin graph; write clauses are rejected. Schema: (:Service {name, entry, cap_mean})-[:CALLS {retries, timeout_ms, breaker, fanout}]->(:Service); '
      + '(:Fault {id, kind, active})-[:APPLIES_TO]->(:Service); a Fault of kind deploy also -[:LANDS]->(:ChangeEvent {id, status, field, new_value})-[:MODIFIES {callee}]->(:Service) (the caller of the edge it changes); '
      + '(:Intervention {id, kind, cost, caller, callee})-[:APPLIES_TO]->(:Service); (:Scenario)-[:CONTAINS]->(:Fault); (:Round). Only these labels and properties exist. '
      + "Cypher rules: an inline property map takes literal values only, e.g. {status: 'pending'}; the shorthand {callee} and variables inside a map are rejected, "
      + 'so compare properties in WHERE (m.callee = b.name). A pending deploy and the edge it changes: '
      + "MATCH (ce:ChangeEvent {status: 'pending'})-[m:MODIFIES]->(caller:Service)-[:CALLS]->(callee:Service) WHERE m.callee = callee.name RETURN ce.id, caller.name, callee.name, ce.field, ce.new_value",
    input_schema: { type: 'object', properties: { cypher: { type: 'string' }, params: { type: 'object' } }, required: ['cypher'] } },
  { name: 'amplification_paths', description: 'Call paths from an entry service ranked by the worst-case retry load on their target (overload, strongest first), each with the faults beneath the target as fault_id@hops. '
      + 'The retry layers on an amplifier multiply the faulted service\'s load; removing them on its edges is the usual cheapest cure.',
    input_schema: { type: 'object', properties: { min_risk: { type: 'number' } }, required: ['min_risk'] } },
  { name: 'rank_nodes', description: 'Rank services by graph importance (how much of the system transitively depends on them).',
    input_schema: { type: 'object', properties: { metric: { type: 'string', enum: ['pagerank', 'in_degree'] } }, required: ['metric'] } },
  { name: 'blast_radius', description: 'Upstream services and entry points that depend on a service, with hop counts (the services a cure at that service protects).',
    input_schema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] } },
  { name: 'list_candidates', description: 'The interventions in the scenario\'s server-computed scope (id, kind, target, edge, cost), with the scenario (faults, evidence path) and the size of the search space. '
      + '`scope` is the actual scenario id named in your kickoff message (the id after "Scenario"), or omit it to use the current scenario; it is never the literal word scenario. '
      + 'Kinds: retries_off / cap_retries (remove or cap retries on an edge), breaker (circuit breaker on an edge), scale_out (more capacity at a service), shed (drop a share of an entry\'s traffic), block_deploy (keep a pending change from landing).',
    input_schema: { type: 'object', properties: { scope: { type: 'string', description: 'the scenario id from the kickoff message; omit for the current scenario' } } } },
  { name: 'fork_and_simulate', description: 'Fork the twin, apply up to 2 in-scope interventions, run seeded rollouts; returns recovery count, median violation ticks (p10-p90), cost and verdict. '
      + 'green = qualifies; amber = recovers but slower than the error budget (bottleneck still saturates: add capacity or combine); red = does not recover (cure off-path or too weak).',
    input_schema: { type: 'object', properties: { intervention_ids: { type: 'array', items: { type: 'string' } } }, required: ['intervention_ids'] } },
  { name: 'commit', description: 'Commit your decision by proposing one evaluated future (or NO_SAFE_ACTION) as the selected intervention. The server applies the selection rule and audits every cheaper or equal option; it rejects the proposal and names the winner if the rule selects a different one.',
    input_schema: { type: 'object', properties: { future_id: { type: 'string' }, rationale: { type: 'string' } }, required: ['future_id'] } },
]);

const MODE_TEXT = { reactive: 'reactive: the outage is live now', preemptive: 'pre-emptive: the attack has not happened yet' };

// The transcript the model sees: a kickoff naming its scenario and mode, then its tool calls and their results.
export function buildBlueMessages(obs) {
  const { scenarioId, futureMode } = obs.context ?? {};
  const messages = [{ role: 'user',
    content: `Round ${obs.round}. Scenario ${scenarioId} (${MODE_TEXT[futureMode] ?? futureMode}). ${obs.budgets.tool_budget} tool calls and ${obs.budgets.fork_budget} futures remain. Which intervention prevents the cascade?` }];
  const turns = [...new Set(obs.history.map((h) => h.turn))].sort((a, b) => a - b);
  for (const t of turns) {
    const calls = obs.history.filter((h) => h.turn === t);
    messages.push({ role: 'assistant', toolCalls: calls.map((h, k) => ({ id: `t${t}c${k}`, name: h.tool, args: h.args })) });
    calls.forEach((h, k) => messages.push({ role: 'tool', toolCallId: `t${t}c${k}`, name: h.tool,
      content: JSON.stringify(h.ok ? h.result : { error: h.summary }) }));
  }
  return messages;
}

/** Wrap an LLM as the runtime adapter for BLUE (same reply mapping as RED). */
export function createBlueAgent(llm) {
  if (!llm || typeof llm.complete !== 'function') throw new Error('createBlueAgent: an LLM with complete({system, messages, tools}) is required');
  return {
    async next(obs) {
      const reply = await llm.complete({ system: renderBlueObjective(obs), messages: buildBlueMessages(obs), tools: BLUE_TOOL_SCHEMAS });
      const calls = Array.isArray(reply?.toolCalls) ? reply.toolCalls : [];
      if (!calls.length || !calls.every((c) => c && typeof c.name === 'string' && (c.args === undefined || (typeof c.args === 'object' && c.args !== null)))) {
        return { unusable: reply?.text ?? reply };
      }
      return calls.length === 1 ? { tool: calls[0].name, args: calls[0].args ?? {} } : { calls: calls.map((c) => ({ tool: c.name, args: c.args ?? {} })) };
    },
  };
}
