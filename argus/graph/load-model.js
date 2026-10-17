// loadModel(graph): the simulator's ONLY input (spec §7.2). Reads everything from FalkorDB.
// Returns graph-native property names; no defaults or constants are supplied here.
import { roRows } from './db.js';

const SERVICES = `
MATCH (s:Service)
RETURN s.name AS name, s.entry AS entry, s.ext_rps AS ext_rps, s.cap_mean AS cap_mean, s.cap_sd AS cap_sd,
       s.base_ms AS base_ms, s.queue_s AS queue_s, s.shed AS shed, s.q_est AS q_est
ORDER BY name`;

const CALLS = `
MATCH (a:Service)-[c:CALLS]->(b:Service)
RETURN a.name AS caller, b.name AS callee, c.fanout AS fanout, c.retries AS retries, c.timeout_ms AS timeout_ms,
       c.breaker AS breaker, c.trip_p AS trip_p, c.trip_ticks AS trip_ticks, c.cooldown AS cooldown,
       c.p_est AS p_est, c.hot_est AS hot_est, c.open_ticks_est AS open_ticks_est
ORDER BY caller, callee`;

const CHANGE_EVENTS = `
MATCH (ce:ChangeEvent)-[m:MODIFIES]->(a:Service)
RETURN ce.id AS id, a.name AS caller, m.callee AS callee, ce.field AS field, ce.new_value AS new_value, ce.status AS status
ORDER BY id`;

const FAULTS = `
MATCH (f:Fault)-[:APPLIES_TO]->(s:Service) WHERE coalesce(f.active, true)
OPTIONAL MATCH (f)-[:LANDS]->(ce:ChangeEvent)
RETURN f.id AS id, f.kind AS kind, f.magnitude AS magnitude, f.persistence AS persistence,
       f.cost_to_attacker AS cost_to_attacker, s.name AS target, ce.id AS lands
ORDER BY id`;

const INTERVENTIONS = `
MATCH (i:Intervention)-[:APPLIES_TO]->(s:Service) WHERE coalesce(i.active, true)
OPTIONAL MATCH (i)-[:BLOCKS]->(ce:ChangeEvent)
RETURN i.id AS id, i.kind AS kind, i.caller AS caller, i.callee AS callee, i.factor AS factor, i.cost AS cost,
       s.name AS target, ce.id AS blocks
ORDER BY id`;

const ROUND = `MATCH (r:Round) RETURN properties(r) AS round ORDER BY r.n DESC LIMIT 1`;

export async function loadModel(db, graphName) {
  const q = (cypher) => roRows(db, graphName, cypher);
  const [services, calls, changeEvents, faults, interventions, round] = await Promise.all(
    [SERVICES, CALLS, CHANGE_EVENTS, FAULTS, INTERVENTIONS, ROUND].map(q),
  );
  if (services.length === 0) throw new Error(`loadModel('${graphName}'): graph has no services`);
  if (round.length === 0) throw new Error(`loadModel('${graphName}'): graph has no Round node`);
  return { graph: graphName, services, calls, changeEvents, faults, interventions, round: round[0].round };
}
