// Decision trace: every tool call is persisted as a (:Step) (spec §4.8, §5.2 Step, §6.20).
// Steps are chained by NEXT in call order and linked to the services they touched (TOUCHED).
// `round` on Step is build-readiness decision A#6. `ms` is the only volatile field.
import { rows, roRows, GRAPHS } from './db.js';

const NEXT_INDEX = `MATCH (s:Step) RETURN coalesce(max(s.i), 0) AS i`;

const WRITE_STEP = `
CREATE (st:Step {i:$i, round:$round, role:$role, by:$by, tool:$tool, args:$args, cypher:$cypher,
                 summary:$summary, ok:$ok, ms:$ms, call_id:$call_id})
WITH st
OPTIONAL MATCH (prev:Step {i:$prev})
FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | MERGE (prev)-[:NEXT]->(st))
WITH st
MATCH (s:Service) WHERE s.name IN $touched
MERGE (st)-[:TOUCHED]->(s)`;

export async function writeStep(db, { round, role, by, tool, args, cypher, summary, ok, ms, callId, touched }) {
  const i = (await roRows(db, GRAPHS.twin, NEXT_INDEX))[0].i + 1;
  await rows(db, GRAPHS.twin, WRITE_STEP, {
    i, prev: i - 1, round, role, by, tool, args: JSON.stringify(args), cypher, summary, ok, ms, call_id: callId, touched,
  });
  return i;
}

export async function readSteps(db, { round, role } = {}) {
  const r = await roRows(db, GRAPHS.twin, `
    MATCH (st:Step)
    WHERE ($round IS NULL OR st.round = $round) AND ($role IS NULL OR st.role = $role)
    OPTIONAL MATCH (st)-[:TOUCHED]->(s:Service)
    WITH st, s ORDER BY s.name
    RETURN properties(st) AS p, collect(s.name) AS touched ORDER BY st.i`, { round: round ?? null, role: role ?? null });
  return r.map((x) => ({ ...x.p, args: JSON.parse(x.p.args), touched: x.touched }));
}

// Link a Decision to the BLUE steps it was based on (spec §5.3 BASED_ON).
export async function linkDecisionSteps(db, decisionId, round) {
  await rows(db, GRAPHS.twin, `
    MATCH (d:Decision {id:$id}), (st:Step {round:$round, role:'blue'})
    MERGE (d)-[:BASED_ON]->(st)`, { id: decisionId, round });
}
