// Agent runtime foundation (spec §2.2 agent loop, §14.1 modes, §14.2 takeover, §14.3 cassette).
// One phase = one role (RED or BLUE) in one round. In `live` mode an LLM adapter proposes tool calls;
// in `replay` mode the adapter is a recorded cassette; in `autopilot` B5 drives from the start.
// The LLM never decides anything final: tools validate, the server rules decide (M5).
// Any LLM failure (unavailable, error, timeout, unusable output, wandering) hands the phase to B5.
import { createHash } from 'node:crypto';
import { createToolbox, RED_POLICY } from './tools.js';
import { b5Red, b5Blue } from './b5.js';

/* TAKEOVER POLICY CONSTANTS (spec §14.2, §10 run sheet). Not system-model data. */
export const TAKEOVER = Object.freeze({
  TURN_CEILING_MS: 6000,        // a live turn slower than 6 s is cut
  NO_PROGRESS_CALLS: 4,         // 4 simulations (RED) / futures (BLUE) without a qualifying result
  MAX_TURN: 8,                  // turn 8 of the phase arrives without a commit
  CONSECUTIVE_REJECTS: 2,       // two consecutive rejected tool calls
});
/* END TAKEOVER POLICY CONSTANTS */

export const REASONS = Object.freeze({
  UNAVAILABLE: 'llm_unavailable', ERROR: 'llm_error', TIMEOUT: 'turn_ceiling', MISS: 'cassette_miss',
  NO_PROGRESS: 'no_progress', MAX_TURN: 'max_turn', REJECTS: 'consecutive_rejects', BUDGET: 'budget_exhausted',
  MCP_UNAVAILABLE: 'mcp_unavailable', TOOL_FAILURE: 'tool_failure',
});

// Wrap a toolbox: (1) failover — if a call fails at the transport/infrastructure level (not a tool rejection),
// switch to the fallback toolbox and retry the same call (call_ids make it idempotent); (2) events — every
// call, by the LLM or by B5, emits TOOL_CALL / TOOL_RESULT and the derived domain events.
function wrapToolbox(primary, { fallbackFactory, events, role, onFailover }) {
  let tb = primary;
  let failedOver = false;
  const emit = (type, payload) => events?.emit(type, payload);
  async function rawInvoke(r, tool, args, by) {
    try {
      return await tb.invoke(r, tool, args, by);
    } catch (e) {
      if (failedOver || !fallbackFactory) throw e;
      failedOver = true;
      const detail = `${tool}: ${e.message}`;
      tb = await fallbackFactory();
      emit('TOOL_TRANSPORT_FAILOVER', { role, tool, error: e.message, to: tb.transport ?? 'in-process' });
      onFailover?.(detail);
      return tb.invoke(r, tool, args, by);
    }
  }
  return {
    get ctx() { return tb.ctx; },
    get failedOver() { return failedOver; },
    get transport() { return tb.transport ?? 'in-process'; },
    async invoke(r, tool, args = {}, by = 'llm') {
      emit('TOOL_CALL', { role: r, by, tool, args });
      if (tool === 'fork_and_simulate') emit('FUTURE_EVALUATION_STARTED', { role: r, by, intervention_ids: args.intervention_ids ?? [] });
      if (r === 'blue' && tool === 'commit') emit('DECISION_PROPOSED', { by, future_id: args.future_id ?? null, rationale: args.rationale ?? '' });
      const res = await rawInvoke(r, tool, args, by);
      emit('TOOL_RESULT', { role: r, by, tool, ok: res.ok, summary: res.summary, step: res.step, result: res.result ?? null });
      if (res.ok && tool === 'simulate' && res.result.sustained >= RED_POLICY.SUSTAINED_MIN) {
        emit('ATTACK_DISCOVERED', { by, fault_ids: res.result.fault_ids, sustained: res.result.sustained, tag: res.result.tag });
      }
      if (res.ok && r === 'red' && tool === 'commit') emit('SCENARIO_COMMITTED', { by, ...res.result });
      if (res.ok && tool === 'fork_and_simulate') emit('FUTURE_EVALUATION_COMPLETED', { by, ...res.result, intervention_ids: args.intervention_ids ?? [] });
      if (r === 'blue' && tool === 'commit') {
        emit('DECISION_AUDITED', { by, proposal: args.future_id ?? null, accepted: res.ok, rule_winner: res.error?.cause?.rule_winner ?? null,
          reason: res.ok ? null : res.summary, audit_sims: res.ok ? res.result.decision.audit_sims : null });
        if (res.ok) emit('DECISION_COMMITTED', { by, decision: res.result.decision });
      }
      return res;
    },
  };
}

const canonical = (x) => (Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`
    : JSON.stringify(x));

// Cassette key (spec §14.3): sha256 of (role, round, turn index, canonical messages). The messages are the
// deterministic history the agent saw (tool, args, summary); volatile fields (timings) are never included.
export function cassetteKey({ role, round, turn, history }) {
  return createHash('sha256').update(canonical({ role, round, turn, history })).digest('hex');
}

export function createCassette(entries = {}) {
  const map = new Map(Object.entries(entries));
  const late = new Map();
  return {
    // recorder: wraps a live adapter and stores each decision under its key. A decision that arrives after the
    // runtime cut the turn (obs.abandoned: the ceiling fired, B5 took over) was never used by the run: it is kept
    // apart and never written as an entry, so a replay of this cassette misses at that turn and takes over too.
    record(adapter) {
      return { async next(obs) { const d = await adapter.next(obs); (obs.abandoned ? late : map).set(cassetteKey(obs), d); return d; } };
    },
    // player: replays decisions; a miss is reported to the runtime (→ takeover)
    player() {
      return { async next(obs) { const k = cassetteKey(obs); if (!map.has(k)) { const e = new Error('cassette miss'); e.cassetteMiss = true; throw e; } return structuredClone(map.get(k)); } };
    },
    toJSON() { return Object.fromEntries(map); },
    get size() { return map.size; },
    get late() { return late.size; },           // decisions that arrived after a takeover (recorded nowhere else)
  };
}

function withCeiling(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { const e = new Error(`turn exceeded ${ms} ms`); e.timeout = true; rej(e); }, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A decision is one tool call {tool, args} or several independent calls in one turn {calls: [...]}
// (spec §10 run sheet: "the agent issues parallel tool calls in one turn"). Only the SHAPE is checked
// here; whether the role may use the tool is decided by the tool layer, which rejects and records it.
const validCall = (c) => c && typeof c === 'object' && typeof c.tool === 'string' && c.tool.length > 0
  && (c.args === undefined || (typeof c.args === 'object' && c.args !== null && !Array.isArray(c.args)));
const callsOf = (d) => (d && typeof d === 'object' && Array.isArray(d.calls) ? d.calls : [d]);
const validDecision = (d) => { const cs = callsOf(d); return cs.length > 0 && cs.every(validCall); };

// What the agent sees each turn: its budgets and round constants from the graph, and every earlier call with
// its full (deterministic) result. Timings are never included, so the observation can key a cassette.
async function observe(readRound, db, role, turn, history, ctx) {
  const r = await readRound(db);
  const budgets = role === 'red'
    ? { sim_budget: r.sim_budget, tool_budget: r.red_tool_budget }
    : { fork_budget: r.fork_budget, tool_budget: r.blue_tool_budget };
  const roundInfo = { t_off: r.t_off, horizon_reactive: r.horizon_reactive, horizon_preemptive: r.horizon_preemptive,
    error_budget: r.error_budget, rec_threshold: r.rec_threshold };
  const context = role === 'blue' ? { scenarioId: ctx.scenarioId ?? null, futureMode: ctx.futureMode ?? null } : {};
  // max_turn / no_progress_calls: the takeover limits, so an agent can be told them (M9.1); not part of the cassette key
  return { role, round: r.n, turn, max_turn: TAKEOVER.MAX_TURN, no_progress_calls: TAKEOVER.NO_PROGRESS_CALLS, budgets, roundInfo, context, history: structuredClone(history) };
}

/**
 * Run one phase.
 * @param {object} db
 * @param {object} p
 * @param {'red'|'blue'} p.role
 * @param {'live'|'replay'|'autopilot'} p.mode
 * @param {{next: function}|null} [p.adapter]   live: the LLM adapter (null = LLM unavailable); replay: cassette player
 * @param {object} [p.ctx]                      BLUE context: { scenarioId, futureMode, snapshotId }
 * @param {number} [p.ceilingMs]                per-turn ceiling (default spec 6 s)
 * @returns {Promise<{role, mode, outcome, proposedBy, takeover: null|{reason, turn, detail}, turns, history}>}
 */
export async function runPhase(db, { role, mode, adapter = null, ctx = {}, ceilingMs = TAKEOVER.TURN_CEILING_MS,
  toolboxFactory = null, fallbackToolboxFactory = null, events = null }) {
  // the tool transport: MCP (toolboxFactory) or in-process; an unavailable transport → fallback + B5 takeover
  let primary, startupFailure = null;
  try {
    primary = toolboxFactory ? await toolboxFactory() : await createToolbox(db, ctx);
  } catch (e) {
    if (!fallbackToolboxFactory) throw e;
    startupFailure = e.message;
    primary = await fallbackToolboxFactory();
    events?.emit('TOOL_TRANSPORT_FAILOVER', { role, tool: null, error: e.message, to: primary.transport ?? 'in-process' });
  }
  let infraFailure = null;
  const tb = wrapToolbox(primary, { fallbackFactory: fallbackToolboxFactory, events, role, onFailover: (d) => { infraFailure = d; } });
  const { readRound } = await import('../graph/budget.js');
  const history = [];
  const state = { turn: 0, rejectsInARow: 0, progressCalls: 0, progressed: false };
  let takeover = null;

  const finish = async (reason, detail) => {
    takeover = reason === null ? null : { reason, turn: state.turn, detail };
    if (takeover) events?.emit('TAKEOVER', { role, ...takeover, transport: tb.transport });
    const res = role === 'red' ? await b5Red(tb) : await b5Blue(tb);
    return { role, mode, outcome: res, proposedBy: 'b5', takeover, turns: state.turn, history, transport: tb.transport };
  };

  if (mode === 'autopilot') return finish(null);
  if (startupFailure) return finish(REASONS.MCP_UNAVAILABLE, startupFailure);
  if (!adapter) return finish(REASONS.UNAVAILABLE, 'no LLM adapter');

  for (;;) {
    if (state.turn >= TAKEOVER.MAX_TURN) return finish(REASONS.MAX_TURN, `turn ${state.turn} without a commit`);
    const obs = await observe(readRound, db, role, state.turn, history, ctx);
    let decision;
    try {
      decision = await withCeiling(Promise.resolve().then(() => adapter.next(obs)), ceilingMs);
    } catch (e) {
      if (e.timeout) obs.abandoned = true;      // the adapter may still answer later; a recorder must not keep that answer as used
      return finish(e.cassetteMiss ? REASONS.MISS : e.timeout ? REASONS.TIMEOUT : REASONS.ERROR, e.message);
    }
    const turn = state.turn;
    state.turn += 1;
    if (!validDecision(decision)) {
      // [IMPL-INTERPRETATION] unusable LLM output counts as a rejected call (takeover condition 4)
      history.push({ turn, tool: 'invalid_output', args: {}, summary: 'rejected: unusable output', result: null, ok: false });
      state.rejectsInARow += 1;
      if (state.rejectsInARow >= TAKEOVER.CONSECUTIVE_REJECTS) return finish(REASONS.REJECTS, 'unusable output');
      continue;
    }
    // independent calls of one turn run in the order given (deterministic); the turn ends at a commit
    for (const call of callsOf(decision)) {
      const r = await tb.invoke(role, call.tool, call.args ?? {}, 'llm');
      history.push({ turn, tool: call.tool, args: call.args ?? {}, summary: r.summary, result: r.ok ? r.result : null, ok: r.ok });
      if (infraFailure) return finish(REASONS.TOOL_FAILURE, infraFailure);
      if (r.budgetExhausted) return finish(REASONS.BUDGET, r.summary);
      if (!r.ok) {
        state.rejectsInARow += 1;
        if (state.rejectsInARow >= TAKEOVER.CONSECUTIVE_REJECTS) return finish(REASONS.REJECTS, r.summary);
        continue;
      }
      state.rejectsInARow = 0;
      if (call.tool === 'commit') {
        const outcome = role === 'red'
          ? { scenarioId: r.result.scenario_id, faults: r.result.fault_ids, proposedBy: 'llm' }
          : { decision: r.result.decision, proposedBy: 'llm' };
        return { role, mode, outcome, proposedBy: 'llm', takeover: null, turns: state.turn, history, transport: tb.transport };
      }
      if ((role === 'red' && call.tool === 'simulate') || (role === 'blue' && call.tool === 'fork_and_simulate')) {
        state.progressCalls += 1;
        state.progressed ||= role === 'red' ? r.result.sustained >= RED_POLICY.SUSTAINED_MIN : r.result.verdict === 'green';
      }
    }
    // [IMPL-INTERPRETATION] takeover condition 2 is checked at the turn boundary: calls issued together in one
    // turn run in parallel in the spec's run sheet (e.g. BLUE's F3, F4, F5), so they are judged together.
    if (state.progressCalls >= TAKEOVER.NO_PROGRESS_CALLS && !state.progressed) {
      return finish(REASONS.NO_PROGRESS, `${state.progressCalls} ${role === 'red' ? 'simulate' : 'fork_and_simulate'} calls without a qualifying result`);
    }
  }
}
