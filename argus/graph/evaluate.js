// Agent-facing future evaluation with budget and scope enforcement — the server semantics of
// fork_and_simulate (spec §9 steps 0-1, §11.3). The MCP wrapper that exposes it is a later milestone.
import { runFuture, readFuture, futureId, MAX_INTERVENTIONS } from './forks.js';
import { readScope, conflicting } from './scope.js';
import { charge, callId, readRound, TOOL_COUNTER, BudgetExhausted } from './budget.js';
import { setKey } from './decision.js';

export class ToolRejected extends Error {}

// useReserve: after a takeover, B5's new calls fall back to Round.autopilot_reserve when the agent
// budget is exhausted (spec §14.2 "charged to the remaining agent budget first and then to autopilot_reserve").
export async function chargeOrReserve(db, args, useReserve) {
  try {
    return await charge(db, args);
  } catch (e) {
    // distinct id per drained counter, so a call that exhausts two counters draws two reserve units
    if (useReserve && e instanceof BudgetExhausted) return charge(db, { ...args, counter: 'autopilot_reserve', callId: `${args.callId}:${args.counter}` });
    throw e;
  }
}

/**
 * Evaluate a candidate future for an agent. Order (spec §9): an already recorded future is returned
 * free; otherwise the tool budget is charged once per call_id (invalid calls ARE charged), the
 * request is validated against the server-computed scope, the fork budget is charged once, and the
 * future is run on a real graph fork.
 */
export async function evaluateFuture(db, { role, scenarioId, interventionIds, mode, snapshotId, useReserve = false }) {
  if (role !== 'blue') throw new ToolRejected(`role '${role}' may not evaluate futures (BLUE only)`);
  const round = await readRound(db);
  const ids = [...interventionIds].sort();
  const label = setKey(ids);
  const existing = await readFuture(db, futureId(round.n, label));
  if (existing && existing.scenario === scenarioId) return { ...existing, reused: true, charged: false };

  const id = callId({ round: round.n, role, tool: 'fork_and_simulate', args: { scenario_id: scenarioId, intervention_ids: ids } });
  await chargeOrReserve(db, { round: round.n, counter: TOOL_COUNTER[role], callId: id, tool: 'fork_and_simulate' }, useReserve);

  const scope = await readScope(db, scenarioId);
  const inScope = new Map(scope.map((i) => [i.id, i]));
  const outside = ids.filter((i) => !inScope.has(i));
  if (outside.length) throw new ToolRejected(`Intervention(s) not in the scope of '${scenarioId}': ${outside.join(', ')}`);
  if (ids.length > MAX_INTERVENTIONS) throw new ToolRejected(`at most ${MAX_INTERVENTIONS} interventions per future`);
  if (ids.length === 2 && conflicting(inScope.get(ids[0]), inScope.get(ids[1]))) throw new ToolRejected('retries_off and cap_retries on the same edge cannot be combined');

  await chargeOrReserve(db, { round: round.n, counter: 'fork_budget', callId: id, tool: 'fork_and_simulate' }, useReserve);
  const f = await runFuture(db, { scenarioId, label, interventionIds: ids, mode, snapshotId });
  return { ...f, charged: true };
}
