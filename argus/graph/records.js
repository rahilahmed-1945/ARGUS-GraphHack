// Records written onto the twin that the counterfactual mechanism depends on (spec §5.2, §6.13, §6.17).
// Scenario: the fault set a future is evaluated against. Snapshot: the live state futures start from.
import { rows, roRows, GRAPHS } from './db.js';

// §6.17 [IMPL-INTERPRETATION]. Only the properties supplied are written (no nulls).
const WRITE_SCENARIO = `
MERGE (sc:Scenario {id: $id})
  SET sc += $props
WITH sc
MATCH (f:Fault) WHERE f.id IN $fault_ids
MERGE (sc)-[:CONTAINS]->(f)
RETURN count(f) AS n`;

export async function writeScenario(db, { id, round, faultIds, ...props }) {
  const known = await roRows(db, GRAPHS.twin, `MATCH (f:Fault) WHERE f.id IN $ids RETURN f.id AS id`, { ids: faultIds });
  const missing = faultIds.filter((f) => !known.some((k) => k.id === f));
  if (missing.length) throw new Error(`Fault(s) not in graph '${GRAPHS.twin}': ${missing.join(', ')}`);
  await rows(db, GRAPHS.twin, WRITE_SCENARIO, { id, fault_ids: faultIds, props: { round, ...props } });
  return id;
}

export async function scenarioFaults(db, scenarioId) {
  const r = await roRows(db, GRAPHS.twin,
    `MATCH (sc:Scenario {id: $id}) OPTIONAL MATCH (sc)-[:CONTAINS]->(f:Fault) RETURN sc.id AS id, collect(f.id) AS faults`, { id: scenarioId });
  if (!r.length || r[0].id === null) throw new Error(`Scenario '${scenarioId}' not in graph '${GRAPHS.twin}'`);
  return [...r[0].faults].sort();
}

// §6.13: write a state snapshot onto the twin (Service.q_est; CALLS p_est/hot_est/open_ticks_est) and a
// (:Snapshot) marker. The state is written as given; observation noise (spec §3.6, seed TBD #10) is the
// orchestrator's job and is not applied here.
export async function writeSnapshot(db, { round, tick, state }) {
  const id = `SNAP:R${round}:T${tick}`;
  await rows(db, GRAPHS.twin, `UNWIND $svc AS s MATCH (n:Service {name: s.name}) SET n.q_est = s.q`,
    { svc: Object.entries(state.q).map(([name, q]) => ({ name, q })) });
  await rows(db, GRAPHS.twin, `
    UNWIND $edges AS e
    MATCH (:Service {name: e.caller})-[c:CALLS]->(:Service {name: e.callee})
    SET c.p_est = e.p, c.hot_est = e.hot, c.open_ticks_est = e.open`,
  { edges: Object.keys(state.p).map((k) => { const [caller, callee] = k.split('>'); return { caller, callee, p: state.p[k], hot: state.hot[k], open: state.open[k] }; }) });
  await rows(db, GRAPHS.twin, `MERGE (s:Snapshot {id: $id}) SET s.tick = $tick, s.round = $round, s.mode = 'reactive'`, { id, tick, round });
  return id;
}

// BLUE's phase context on the Round, so the BLUE tool server (another process) reads it from the graph
// (spec §2: "shared state crosses processes only through FalkorDB").
export async function setBlueContext(db, { scenarioId, futureMode, snapshotId = null }) {
  await rows(db, GRAPHS.twin, `MATCH (r:Round) WITH r ORDER BY r.n DESC LIMIT 1
    SET r.blue_scenario_id = $s, r.blue_future_mode = $m, r.blue_snapshot_id = $snap`, { s: scenarioId, m: futureMode, snap: snapshotId });
}
