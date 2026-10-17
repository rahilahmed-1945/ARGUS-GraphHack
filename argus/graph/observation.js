// Predicted-vs-observed record (spec §3.7, §6.21): what WORLD actually did after a decision,
// against what the selected Future predicted. Applying the intervention to the world and calibrating
// the twin (hardening) are later milestones; this records the comparison for a given world trace.
import { rows, roRows, GRAPHS } from './db.js';
import { readDecision } from './decision.js';
import { readFuture } from './forks.js';
import { SHAPE } from '../sim/sim.js';

// observed_ttr: ticks from the start of the observation to the start of the final violation-free run
// of at least RECOVERY_WINDOW ticks; -1 when the world never recovers [build-readiness decision B#5].
export function timeToRecovery(trace) {
  let start = trace.length;
  while (start > 0 && !trace[start - 1].viol) start -= 1;
  return trace.length - start >= SHAPE.RECOVERY_WINDOW ? start : -1;
}

export async function writeObservation(db, { decisionId, observedTrace }) {
  const d = await readDecision(db, decisionId);
  if (!d) throw new Error(`Decision '${decisionId}' not found`);
  const predicted = d.selected_future === 'NO_SAFE_ACTION' ? null : await readFuture(db, d.selected_future);
  const observed = observedTrace.filter((o) => o.viol).length;
  const props = {
    observed_viol_ticks: observed,
    observed_ttr: timeToRecovery(observedTrace),
    predicted_viol_ticks_p50: predicted ? predicted.viol_ticks_p50 : -1,
    predicted_p10: predicted ? predicted.p10 : -1,
    predicted_p90: predicted ? predicted.p90 : -1,
    pred_error: predicted ? observed - predicted.viol_ticks_p50 : 0,          // observed − predicted median (B#5)
    within_band: predicted ? observed >= predicted.p10 && observed <= predicted.p90 : false,
    observed_goodput: JSON.stringify(observedTrace.map((o) => Math.min(...Object.values(o.gp)))),
    ticks: observedTrace.length,
  };
  const id = decisionId.replace(/^D:/, 'O:');
  await rows(db, GRAPHS.twin, `
    MATCH (d:Decision {id:$decision_id})
    MERGE (o:Observation {id:$id}) SET o += $props
    MERGE (o)-[:VERIFIES]->(d)`, { id, decision_id: decisionId, props });
  const r = await roRows(db, GRAPHS.twin, `MATCH (o:Observation {id:$id}) RETURN properties(o) AS p`, { id });
  return { id, ...r[0].p, observed_goodput: JSON.parse(r[0].p.observed_goodput) };
}
