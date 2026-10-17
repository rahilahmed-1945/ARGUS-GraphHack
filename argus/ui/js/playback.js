// Presentation queue over the real event log. The runtime emits events at machine speed; this queue releases them
// to the view in order, holding each on screen long enough to be read. It never creates, drops, reorders or alters
// an event — pacing is the only thing it adds.

/* DISPLAY CONSTANTS — on-screen dwell per event type at 1× (ms). WORLD ticks follow the spec's 5 ticks/s. */
const DWELL = {
  ROUND_STARTED: 3000, RED_STARTED: 1500, BLUE_STARTED: 1600, TOOL_CALL: 260, ATTACK_DISCOVERED: 900, SCENARIO_COMMITTED: 3000,
  WORLD_FAULT_INJECTED: 1600, WORLD_TICK: 200, WORLD_FAULT_REMOVED: 2000, SNAPSHOT_TAKEN: 1100, CLOCK: 0,
  FUTURE_EVALUATION_STARTED: 500, FUTURE_EVALUATION_COMPLETED: 1150, DECISION_PROPOSED: 700, DECISION_AUDITED: 1100,
  DECISION_COMMITTED: 2400, HARDENING_STARTED: 700, HARDENING_APPLIED: 4200, WORLD_DEPLOY_LANDED: 2800,
  WORLD_OBSERVATION: 3600, CALIBRATION_UPDATED: 2200, ROUND_COMPLETED: 1400, TAKEOVER: 1800, TOOL_TRANSPORT_FAILOVER: 1200, DEMO_COMPLETED: 0,
};
const RESULT_DWELL = { amplification_paths: 2300, simulate: 1100, commit: 1600, fork_and_simulate: 150, query_graph: 650, rank_nodes: 900, list_candidates: 900, blast_radius: 800 };
/* END DISPLAY CONSTANTS */

export function dwellFor(ev) {
  if (ev.type === 'TOOL_RESULT') return RESULT_DWELL[ev.payload?.tool] ?? 800;
  return DWELL[ev.type] ?? 400;
}

export function createPlayback({ apply, onChange = () => {} }) {
  let log = [];
  let cursor = 0;
  let playing = false;
  let speed = 1;
  let timer = null;

  const status = () => ({ playing, speed, cursor, total: log.length, caughtUp: cursor >= log.length });
  function step() {
    timer = null;
    if (!playing) return onChange(status());
    if (cursor >= log.length) return onChange(status());     // wait for the runtime to emit more
    const ev = log[cursor++];
    apply(ev);
    onChange(status());
    timer = setTimeout(step, dwellFor(ev) / speed);
  }
  const kick = () => { if (playing && !timer) step(); };

  return {
    status,
    load(events) { clearTimeout(timer); timer = null; log = [...events]; cursor = 0; onChange(status()); kick(); },
    push(ev) { if (log.length && ev.seq <= log.at(-1).seq) return; log.push(ev); onChange(status()); kick(); },
    play() { playing = true; kick(); onChange(status()); },
    pause() { playing = false; clearTimeout(timer); timer = null; onChange(status()); },
    restart() { clearTimeout(timer); timer = null; cursor = 0; onChange(status()); kick(); },
    setSpeed(x) { speed = x; onChange(status()); },
    // jump: re-apply the first n events at once (the reducer is pure, so this equals having played them)
    seek(n) { clearTimeout(timer); timer = null; playing = false; cursor = 0; while (cursor < Math.min(n, log.length)) apply(log[cursor++]); onChange(status()); },
    get log() { return log; },
  };
}
