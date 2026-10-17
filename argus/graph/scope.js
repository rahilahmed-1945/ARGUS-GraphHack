// Server-computed scope of a Scenario (spec §8 "Scope is computed by the server", §6.9).
// The scope is derived from the graph — every entry-to-fault path, following each fault kind's
// propagation direction — and never taken from the agent. It bounds BLUE's candidates and the audit.
import { rows, roRows, GRAPHS } from './db.js';

// §6.9, verbatim (one row per path; nothing is UNWIND-ed, so zero-length paths keep their node).
const SCOPE_QUERIES = [
  // (1) upstream, for every fault: entry → faulted service (zero-length when t is an entry)
  `MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault)-[:APPLIES_TO]->(t:Service)
   MATCH p = (e:Service {entry:true})-[:CALLS*0..6]->(t)
   RETURN [n IN nodes(p) | n.name] AS ns, [r IN relationships(p) | startNode(r).name+'>'+endNode(r).name] AS es`,
  // (2) surge: the entry's downstream closure
  `MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault {kind:'surge'})-[:APPLIES_TO]->(e:Service)
   MATCH p = (e)-[:CALLS*0..6]->(:Service)
   RETURN [n IN nodes(p) | n.name] AS ns, [r IN relationships(p) | startNode(r).name+'>'+endNode(r).name] AS es`,
  // (3) deploy: the edited edge and everything beneath its callee
  `MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault {kind:'deploy'})-[:LANDS]->(:ChangeEvent)-[m:MODIFIES]->(a:Service)
   MATCH (a)-[:CALLS]->(b:Service) WHERE b.name = m.callee
   MATCH p = (b)-[:CALLS*0..6]->(:Service)
   RETURN [a.name] + [n IN nodes(p) | n.name] AS ns,
          [a.name+'>'+b.name] + [r IN relationships(p) | startNode(r).name+'>'+endNode(r).name] AS es`,
];

const INTERVENTIONS = `
MATCH (i:Intervention)-[:APPLIES_TO]->(s:Service) WHERE coalesce(i.active, true)
OPTIONAL MATCH (i)-[:BLOCKS]->(c:ChangeEvent)
RETURN i.id AS id, i.kind AS kind, i.caller AS caller, i.callee AS callee, i.cost AS cost, s.name AS target, c.id AS blocks
ORDER BY id`;

const LANDED_CHANGE_EVENTS = `
MATCH (:Scenario {id:$id})-[:CONTAINS]->(:Fault)-[:LANDS]->(c:ChangeEvent) RETURN c.id AS id`;

// Compute the scope of a scenario, write Scenario.scope_ids, and return the in-scope interventions.
export async function computeScope(db, scenarioId, graphName = GRAPHS.twin) {
  const ns = new Set(), es = new Set();
  for (const q of SCOPE_QUERIES) {
    for (const r of await roRows(db, graphName, q, { id: scenarioId })) {
      r.ns.forEach((n) => ns.add(n));
      r.es.forEach((e) => es.add(e));
    }
  }
  const landed = new Set((await roRows(db, graphName, LANDED_CHANGE_EVENTS, { id: scenarioId })).map((r) => r.id));
  // Edge interventions are in scope when their edge is on a scope path; node interventions when their
  // service is on a scope path; block_deploy for each ChangeEvent the scenario lands (spec §6.9).
  const all = await roRows(db, graphName, INTERVENTIONS);
  const inScope = all.filter((i) => (i.blocks !== null ? landed.has(i.blocks)
    : i.caller !== null ? es.has(`${i.caller}>${i.callee}`)
      : ns.has(i.target)));
  if (inScope.length === 0) throw new Error(`empty scope for scenario '${scenarioId}' (an empty scope is an error, never "audit satisfied")`);
  const ids = inScope.map((i) => i.id).sort();
  await rows(db, graphName, `MATCH (sc:Scenario {id:$id}) SET sc.scope_ids = $ids`, { id: scenarioId, ids });
  return { ids, interventions: inScope, nodes: [...ns].sort(), edges: [...es].sort() };
}

export async function readScope(db, scenarioId, graphName = GRAPHS.twin) {
  const r = await roRows(db, graphName, `MATCH (sc:Scenario {id:$id}) RETURN sc.scope_ids AS ids`, { id: scenarioId });
  if (!r.length) throw new Error(`Scenario '${scenarioId}' not in graph '${graphName}'`);
  if (!r[0].ids) throw new Error(`Scenario '${scenarioId}' has no computed scope`);
  const all = await roRows(db, graphName, INTERVENTIONS);
  return all.filter((i) => r[0].ids.includes(i.id));
}

// A pair may not put both retries_off and cap_retries on the same edge (spec §5.2 Intervention).
export function conflicting(a, b) {
  const retry = (x) => x.kind === 'retries_off' || x.kind === 'cap_retries';
  return retry(a) && retry(b) && a.kind !== b.kind && a.caller === b.caller && a.callee === b.callee;
}

// Every candidate intervention set in scope: do nothing, all singles, all non-conflicting pairs.
export function candidateSets(scopeInterventions) {
  const s = [...scopeInterventions].sort((x, y) => x.id.localeCompare(y.id));
  const sets = [{ ids: [], cost: 0 }];
  for (const i of s) sets.push({ ids: [i.id], cost: i.cost });
  for (let a = 0; a < s.length; a++) {
    for (let b = a + 1; b < s.length; b++) {
      if (!conflicting(s[a], s[b])) sets.push({ ids: [s[a].id, s[b].id], cost: s[a].cost + s[b].cost });
    }
  }
  return sets;
}
