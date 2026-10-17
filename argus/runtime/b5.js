// B5 — the deterministic, non-LLM policy (spec §14.4). It is both the demo's reliability fallback
// (AUTOPILOT) and the research baseline. It drives the SAME tools as the LLM; every decision below is
// taken from what those tools return from FalkorDB, so a different graph state produces a different path.
// It only proposes: M5's decision engine (rule + audit) remains the authority at commit.
import { RED_POLICY } from './tools.js';

/* B5 POLICY CONSTANTS (spec §14.4: "amplification_paths(2)"). Not system-model data. */
export const B5_POLICY = Object.freeze({ AMP_MIN_RISK: 2, MAX_PATH_FIX_EDGES: 2 });
/* END B5 POLICY CONSTANTS */

class B5Failed extends Error {}

function must(r) {
  if (!r.ok) throw new B5Failed(`${r.tool} failed: ${r.summary}`);
  return r.result;
}

// ---------------------------------------------------------------- RED-B5
/**
 * 1. amplification_paths(2). If non-empty: take the top row, simulate its triggers singly in (hops, id)
 *    order, then [trigger, surge:entry] pairs.
 * 2. If empty: rank_nodes('pagerank') → top service s; pending ChangeEvents modifying edges into s (by id);
 *    simulate [degrade:s], then [degrade:s, deploy:c] for each, then [degrade:s, surge:x] for each entry.
 * 3. Stop at the first scenario with ≥ 8/16 sustained and submit it. Repeats of earlier calls are free.
 */
export async function b5Red(tb) {
  const call = (tool, args) => tb.invoke('red', tool, args, 'b5');
  const amp = must(await call('amplification_paths', { min_risk: B5_POLICY.AMP_MIN_RISK }));
  let candidates, evidenceFor;
  if (amp.rows.length) {
    const top = amp.rows[0];
    const triggers = top.triggers.map((t) => t.split('@')[0]);                      // already (hops, id) ordered
    // [IMPL-INTERPRETATION] "surge:entry" = the surge fault on the amplifier's entry service (graph lookup)
    const surge = must(await call('query_graph', {
      cypher: `MATCH (f:Fault {kind:'surge'})-[:APPLIES_TO]->(s:Service {name:$entry}) WHERE coalesce(f.active,true) RETURN f.id AS id`,
      params: { entry: top.amplifier[0] } })).rows.map((r) => r.id);
    candidates = [...triggers.map((t) => [t]), ...triggers.flatMap((t) => surge.map((s) => [t, s]))];
    // evidence: the amplifier path, continued down to the trigger's service along the shortest path
    evidenceFor = async (faults) => {
      const r = must(await call('query_graph', {
        cypher: `MATCH (f:Fault {id:$fault})-[:APPLIES_TO]->(t:Service), (a:Service {name:$target})
                 RETURN CASE WHEN a = t THEN [a.name] ELSE [n IN nodes(shortestPath((a)-[:CALLS*]->(t))) | n.name] END AS path`,
        params: { fault: faults[0], target: top.target } })).rows[0];
      return [...top.amplifier, ...(r ? r.path.slice(1) : [])];
    };
  } else {
    const ranked = must(await call('rank_nodes', { metric: 'pagerank' })).rows;
    const s = ranked[0].service;
    const g = must(await call('query_graph', {
      cypher: `MATCH (d:Fault {kind:'cap_degrade'})-[:APPLIES_TO]->(:Service {name:$s}) WHERE coalesce(d.active,true)
               OPTIONAL MATCH (c:ChangeEvent {status:'pending'})-[m:MODIFIES]->(a:Service)-[:CALLS]->(b:Service {name:$s})
               WHERE m.callee = b.name
               OPTIONAL MATCH (dep:Fault)-[:LANDS]->(c) WHERE coalesce(dep.active,true)
               WITH d, c, a, dep ORDER BY c.id
               WITH d, collect({ce: c.id, deploy: dep.id, caller: a.name}) AS ces
               OPTIONAL MATCH (sf:Fault {kind:'surge'})-[:APPLIES_TO]->(e:Service {entry:true}) WHERE coalesce(sf.active,true)
               WITH d, ces, sf ORDER BY sf.id
               RETURN d.id AS degrade, ces, collect(sf.id) AS surges`,
      params: { s } })).rows[0];
    const deploys = g.ces.filter((x) => x.deploy);
    candidates = [[g.degrade], ...deploys.map((x) => [g.degrade, x.deploy]), ...g.surges.map((x) => [g.degrade, x])];
    // evidence: entry → (deploy caller) → s, along the shortest path
    evidenceFor = async (faults) => {
      const via = deploys.find((x) => faults.includes(x.deploy))?.caller ?? s;
      const r = must(await call('query_graph', {
        cypher: `MATCH (e:Service {entry:true}), (v:Service {name:$via}), (t:Service {name:$s})
                 WITH e, v, t, CASE WHEN v = t THEN [t] ELSE nodes(shortestPath((v)-[:CALLS*]->(t))) END AS tail
                 WITH e, v, tail, nodes(shortestPath((e)-[:CALLS*]->(v))) AS head
                 WHERE size(head) > 0
                 RETURN [n IN head | n.name] + [n IN tail[1..] | n.name] AS path ORDER BY size(path), e.name LIMIT 1`,
        params: { via, s } })).rows[0];
      return r ? r.path : [s];
    };
  }
  for (const faults of candidates) {
    const r = must(await call('simulate', { fault_ids: faults }));
    if (r.sustained >= RED_POLICY.SUSTAINED_MIN) {
      const res = must(await call('commit', { fault_ids: faults, evidence_path: await evidenceFor(faults) }));
      return { scenarioId: res.scenario_id, faults, proposedBy: 'b5' };
    }
  }
  return { scenarioId: null, faults: null, proposedBy: 'b5' };
}

// ---------------------------------------------------------------- BLUE-B5
/**
 * F0 (do nothing). Then, if an amplifier path exists, the path fix: retries_off on every amplifier edge with
 * retries > 0, as one future. Then in-scope singles in ascending cost, one candidate per kind per cost tier:
 * the one whose target is nearest the faulted service (graph hops, then id). Stop at the first green future.
 * Commit through the same rule (M5); if the rule names a different winner, commit that; if none, NO_SAFE_ACTION.
 */
export async function b5Blue(tb) {
  const call = (tool, args) => tb.invoke('blue', tool, args, 'b5');
  const futures = [];
  const evaluate = async (ids) => { const f = must(await call('fork_and_simulate', { intervention_ids: ids })); futures.push(f); return f; };
  const commit = async (proposal) => {
    const r = await call('commit', { future_id: proposal, rationale: 'B5 deterministic policy' });
    if (r.ok) return r.result.decision;
    const winner = r.error?.cause?.rule_winner;
    const next = winner ?? (proposal === 'NO_SAFE_ACTION' ? null : 'NO_SAFE_ACTION');
    if (!next) throw new B5Failed(`commit failed: ${r.summary}`);
    return commit(next);
  };

  await evaluate([]);
  const amp = must(await call('amplification_paths', { min_risk: B5_POLICY.AMP_MIN_RISK }));
  if (amp.rows.length) {
    const edges = amp.rows[0].amplifier.slice(1).map((b, k) => `${amp.rows[0].amplifier[k]}>${b}`);
    const fix = must(await call('query_graph', {
      cypher: `MATCH (i:Intervention {kind:'retries_off'}) WHERE coalesce(i.active,true) AND i.caller + '>' + i.callee IN $edges
               RETURN i.id AS id ORDER BY id`, params: { edges } })).rows.map((r) => r.id);
    // [IMPL-INTERPRETATION] a future holds at most 2 interventions (spec §10.2); a longer amplifier keeps the first 2 by id
    if (fix.length) {
      const f = await evaluate(fix.slice(0, B5_POLICY.MAX_PATH_FIX_EDGES));
      if (f.verdict === 'green') return { decision: await commit(f.future_id), futures, proposedBy: 'b5' };
    }
  }
  const scope = must(await call('list_candidates', {})).ids;
  // [IMPL-INTERPRETATION] "faulted service": the service a fault degrades/surges; for a deploy, the callee of
  // the edge it edits (where the retry load lands). Distance: CALLS hops from an edge's callee (edge kinds)
  // or from the intervention's service (node kinds) down to the nearest faulted service; unreachable = ∞.
  // [IMPL-NOTE] two queries: FalkorDB 6.0.1 drops all rows for `MATCH … WITH collect(…) UNWIND … MATCH (s) WHERE s.name = x`
  const faulted = must(await call('query_graph', {
    cypher: `MATCH (sc:Scenario {id:$scenario})-[:CONTAINS]->(f:Fault)-[:APPLIES_TO]->(t:Service)
             OPTIONAL MATCH (f)-[:LANDS]->(:ChangeEvent)-[m:MODIFIES]->(:Service)
             RETURN DISTINCT CASE WHEN m IS NULL THEN t.name ELSE m.callee END AS service ORDER BY service`,
    params: { scenario: tb.ctx.scenarioId } })).rows.map((r) => r.service);
  const dist = must(await call('query_graph', {
    cypher: `UNWIND $sources AS x
             MATCH (s:Service) WHERE s.name = x
             OPTIONAL MATCH p = (s)-[:CALLS*0..6]->(d:Service) WHERE d.name IN $faulted
             RETURN x AS service, min(length(p)) AS hops ORDER BY service`,
    params: { sources: [...new Set(scope.map((i) => i.callee ?? i.target))].sort(), faulted } })).rows;
  const hops = Object.fromEntries(dist.map((r) => [r.service, r.hops ?? Infinity]));
  const tiers = [...new Set(scope.map((i) => i.cost))].sort((a, b) => a - b);
  for (const cost of tiers) {
    const kinds = [...new Set(scope.filter((i) => i.cost === cost).map((i) => i.kind))];
    const picks = kinds.map((k) => scope.filter((i) => i.cost === cost && i.kind === k)
      .sort((a, b) => hops[a.callee ?? a.target] - hops[b.callee ?? b.target] || a.id.localeCompare(b.id))[0])
      .sort((a, b) => hops[a.callee ?? a.target] - hops[b.callee ?? b.target] || a.id.localeCompare(b.id));
    for (const iv of picks) {
      const f = await evaluate([iv.id]);
      if (f.verdict === 'green') return { decision: await commit(f.future_id), futures, proposedBy: 'b5' };
    }
  }
  return { decision: await commit('NO_SAFE_ACTION'), futures, proposedBy: 'b5' };
}
