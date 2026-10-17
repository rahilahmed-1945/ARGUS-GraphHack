// The authoritative runtime event stream. One canonical representation: {seq, type, round, tick, payload}.
// Events are produced by the runtime/orchestrator only; consumers (Socket.IO now, the UI later) never derive
// their own state from anywhere else. Events carry no wall-clock time, so a replayed run is event-identical.
export const EVENT_TYPES = Object.freeze([
  'ROUND_STARTED', 'RED_STARTED', 'TOOL_CALL', 'TOOL_RESULT', 'ATTACK_DISCOVERED', 'SCENARIO_COMMITTED',
  'BLUE_STARTED', 'FUTURE_EVALUATION_STARTED', 'FUTURE_EVALUATION_COMPLETED', 'DECISION_PROPOSED', 'DECISION_AUDITED',
  'DECISION_COMMITTED', 'HARDENING_STARTED', 'HARDENING_APPLIED', 'WORLD_FAULT_INJECTED', 'WORLD_FAULT_REMOVED',
  'WORLD_DEPLOY_LANDED', 'WORLD_TICK', 'WORLD_OBSERVATION', 'SNAPSHOT_TAKEN', 'CALIBRATION_UPDATED', 'ROUND_COMPLETED',
  'TAKEOVER', 'TOOL_TRANSPORT_FAILOVER', 'CLOCK', 'DEMO_COMPLETED',
]);

// The current state a (re)connecting client needs, reduced from the stream itself.
function reduce(state, ev) {
  const p = ev.payload;
  switch (ev.type) {
    case 'ROUND_STARTED': state.round = p.round; state.phase = 'round'; state.graphs = p.graphs; state.futures = []; state.scenario = null; state.decision = null; break;
    case 'RED_STARTED': state.phase = 'red'; break;
    case 'BLUE_STARTED': state.phase = 'blue'; state.blueContext = p; break;
    case 'SCENARIO_COMMITTED': state.scenario = p; break;
    case 'FUTURE_EVALUATION_COMPLETED': state.futures = [...state.futures.filter((f) => f.future_id !== p.future_id), p]; break;
    case 'DECISION_COMMITTED': state.decision = p.decision; break;
    case 'HARDENING_APPLIED': state.hardening = p; state.graphs = p.graphs ?? state.graphs; break;
    case 'WORLD_TICK': state.world = p; state.tick = p.tick; break;
    case 'WORLD_OBSERVATION': state.observation = p; break;
    case 'CALIBRATION_UPDATED': state.calibration = [...(state.calibration ?? []), p]; break;
    case 'CLOCK': state.clock = p; break;
    case 'TAKEOVER': state.takeovers = [...(state.takeovers ?? []), p]; break;
    case 'ROUND_COMPLETED': state.phase = 'round_completed'; state.completedRounds = [...(state.completedRounds ?? []), p]; break;
    case 'DEMO_COMPLETED': state.phase = 'completed'; state.result = p; break;
    default: break;
  }
  state.lastSeq = ev.seq;
}

export function createEventBus() {
  const log = [];
  const subs = new Set();
  const state = { round: null, phase: 'idle', tick: 0, futures: [], lastSeq: 0 };
  return {
    emit(type, payload = {}) {
      if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type '${type}'`);
      const ev = { seq: log.length + 1, type, round: state.round, tick: state.tick, payload: structuredClone(payload) };
      log.push(ev);
      reduce(state, ev);
      for (const f of subs) f(ev);
      return ev;
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    since(seq) { return log.filter((e) => e.seq > seq); },
    state() { return structuredClone(state); },
    get log() { return log; },
  };
}
