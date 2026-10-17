// Hardening persistence between rounds (spec §2.2 APPLY/OBSERVE, §3.8 calibration, §6.3 regeneration,
// §10.10). After a decision: apply its interventions to WORLD and TWIN with the same templates the forks
// use, record calibration on the twin, regenerate both action spaces, and open the next Round.
import { rows, roRows, GRAPHS } from './db.js';
import { applyTemplates } from './forks.js';
import { readDecision } from './decision.js';
import { regenerateActionSpaces } from './schema.js';
import { loadTopology } from './topology.js';

// APPLY: the decision's interventions on both graphs (spec §2.2: "applies the Intervention to world AND twin").
export async function applyDecision(db, decisionId) {
  const d = await readDecision(db, decisionId);
  if (!d) throw new Error(`Decision '${decisionId}' not found`);
  for (const g of [GRAPHS.world, GRAPHS.twin]) await applyTemplates(db, g, d.selects);
  await rows(db, GRAPHS.twin, `MATCH (d:Decision {id:$id}) SET d.applied = true`, { id: decisionId });
  return d.selects;
}

// §3.8: write a calibration result onto the twin service and record it on the Observation.
// `result` is sim.js calibrate() output (cap_sd is a fraction of cap_mean).
export async function writeCalibration(db, { observationId, service, result }) {
  const before = (await roRows(db, GRAPHS.twin, `MATCH (s:Service {name:$n}) RETURN s.cap_mean AS c`, { n: service }))[0].c;
  await rows(db, GRAPHS.twin, `
    MATCH (o:Observation {id:$obs}), (s:Service {name:$n})
    SET s.cap_mean = $after, s.cap_sd = $sd
    MERGE (o)-[c:CALIBRATED]->(s)
    SET c.before = $before, c.after = $after, c.n = $count, c.se = $se`,
  { obs: observationId, n: service, after: result.cap_mean, sd: result.cap_sd, before, count: result.n, se: result.se });
  return { service, before, after: result.cap_mean };
}

// Regenerate both action spaces and open Round n+1 with fresh budgets (round template from topology.yaml).
export async function openNextRound(db, topo = loadTopology()) {
  const n = (await roRows(db, GRAPHS.twin, `MATCH (r:Round) RETURN max(r.n) AS n`))[0].n;
  for (const g of [GRAPHS.twin, GRAPHS.world]) {
    await regenerateActionSpaces(db, g, topo);
    await rows(db, g, `CREATE (r:Round) SET r += $round`, { round: { ...topo.round, n: n + 1 } });
  }
  return n + 1;
}

// A pending ChangeEvent lands on a graph (spec §6.16, round-2 finale: "let CE-42 merge anyway").
// The edited CALLS edge takes the deploy's new value and the ChangeEvent becomes 'landed'.
export async function landDeploy(db, graphName, changeEventId) {
  const r = await rows(db, graphName, `
    MATCH (ce:ChangeEvent {id:$id, status:'pending'})-[m:MODIFIES]->(a:Service)-[c:CALLS]->(b:Service)
    WHERE b.name = m.callee
    WITH ce, c, a, b, c.retries AS before
    SET c.retries = ce.new_value, ce.status = 'landed'
    RETURN a.name + '>' + b.name AS edge, ce.field AS field, before, c.retries AS after`, { id: changeEventId });
  if (r.length !== 1) throw new Error(`ChangeEvent '${changeEventId}' is not pending on '${graphName}'`);
  return r[0];
}
