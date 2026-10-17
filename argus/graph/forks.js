// Counterfactual futures as real FalkorDB graph forks (spec §4.2–4.4, §6.14–6.18, §9).
// Lifecycle: twin → GRAPH.COPY → fork:R<round>:<label> → apply intervention(s) on the fork
//            → loadModel(fork) → seeded rollouts → (:Future) recorded on twin → GRAPH.DELETE fork.
// The canonical twin is only ever read here, except for the (:Future) commit-point write.
import { rows, roRows, GRAPHS, FORK_PREFIX } from './db.js';
import { loadModel } from './load-model.js';
import { scenarioFaults } from './records.js';
import { buildModel, initialState, healthyState, ensemble, percentile } from '../sim/sim.js';

/* SEED SCHEME (spec §7.7, §7.8): all futures of round r use ensemble tag 100·r + 2 (common random
   numbers); every ensemble has 16 rollouts. Not system-model data. */
export const SEED_SCHEME = Object.freeze({ ROUND_TAG_STRIDE: 100, FUTURE_TAG_OFFSET: 2, ROLLOUTS: 16 });
/* END SEED SCHEME */

export const MAX_INTERVENTIONS = 2;                // "each with at most 2 interventions" (spec §10.2)
export const futureId = (round, label) => `${FORK_PREFIX}R${round}:${label}`;

// §6.15 intervention templates, run ON THE FORK. Values come from the Intervention node (factor),
// never from code (spec §6.15 IMPL-NOTE). Each returns the number of graph elements changed.
// [IMPL-NOTE] FalkorDB 6.0.1 rejects a variable from an earlier MATCH inside a later MATCH's inline
// property map ("Variable i not found"), so the spec's `{name:$caller}` form is written with WHERE.
const TEMPLATES = {
  retries_off: `MATCH (i:Intervention {id:$id}) MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name = i.caller AND b.name = i.callee
                SET c.retries = 0 RETURN count(c) AS n`,
  cap_retries: `MATCH (i:Intervention {id:$id}) MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name = i.caller AND b.name = i.callee
                SET c.retries = CASE WHEN c.retries > i.factor THEN i.factor ELSE c.retries END RETURN count(c) AS n`,
  breaker:     `MATCH (i:Intervention {id:$id}) MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name = i.caller AND b.name = i.callee
                SET c.breaker = true RETURN count(c) AS n`,
  scale_out:   `MATCH (i:Intervention {id:$id})-[:APPLIES_TO]->(s:Service) SET s.cap_mean = s.cap_mean * i.factor RETURN count(s) AS n`,
  shed:        `MATCH (i:Intervention {id:$id})-[:APPLIES_TO]->(s:Service) SET s.shed = i.factor RETURN count(s) AS n`,
  block_deploy:`MATCH (i:Intervention {id:$id})-[:BLOCKS]->(c:ChangeEvent) SET c.status = 'blocked' RETURN count(c) AS n`,
};

// §6.18: the Future node is the commit point, written last in one query.
const WRITE_FUTURE = `
MATCH (sc:Scenario {id: $scenario_id})
OPTIONAL MATCH (snap:Snapshot {id: $snapshot_id})
MERGE (fu:Future {id: $id})
  SET fu += $props
MERGE (sc)-[:PRODUCES]->(fu)
FOREACH (_ IN CASE WHEN snap IS NULL THEN [] ELSE [1] END | MERGE (fu)-[:FROM]->(snap))
WITH fu
OPTIONAL MATCH (i:Intervention) WHERE i.id IN $intervention_ids
FOREACH (_ IN CASE WHEN i IS NULL THEN [] ELSE [1] END | MERGE (fu)-[:TESTS]->(i))
RETURN fu.id AS id`;

// Apply intervention templates to a graph (a fork here; world and twin when a decision is APPLIED, spec §10.10).
export async function applyTemplates(db, graphName, interventionIds, known) {
  if (!known) {
    known = await roRows(db, graphName, `MATCH (i:Intervention) WHERE i.id IN $ids RETURN i.id AS id, i.kind AS kind`, { ids: interventionIds });
  }
  for (const iv of [...interventionIds].sort()) {
    const k = known.find((x) => x.id === iv);
    if (!k) throw new Error(`Intervention '${iv}' not in graph '${graphName}'`);
    const r = await rows(db, graphName, TEMPLATES[k.kind], { id: iv });
    if (!r.length || r[0].n !== 1) throw new Error(`intervention template '${k.kind}' did not apply to exactly one element on ${graphName}`);
  }
}

export async function deleteGraphIfExists(db, name) {
  if ((await db.list()).includes(name)) await db.selectGraph(name).delete();
}

export async function listForks(db) {
  return (await db.list()).filter((g) => g.startsWith(FORK_PREFIX)).sort();
}

// Delete every fork of a round (or every fork when round is omitted).
export async function cleanupForks(db, round) {
  const prefix = round === undefined ? FORK_PREFIX : `${FORK_PREFIX}R${round}:`;
  const victims = (await listForks(db)).filter((g) => g.startsWith(prefix));
  for (const g of victims) await db.selectGraph(g).delete();
  return victims;
}

export async function readFuture(db, id) {
  const r = await roRows(db, GRAPHS.twin, `
    MATCH (fu:Future {id: $id})
    OPTIONAL MATCH (fu)-[:TESTS]->(i:Intervention)
    OPTIONAL MATCH (fu)-[:FROM]->(snap:Snapshot)
    OPTIONAL MATCH (sc:Scenario)-[:PRODUCES]->(fu)
    RETURN properties(fu) AS props, collect(DISTINCT i.id) AS interventions, snap.id AS snapshot, sc.id AS scenario`, { id });
  if (!r.length) return null;
  const { props, interventions, snapshot, scenario } = r[0];
  return { ...props, viol_by_entry: JSON.parse(props.viol_by_entry), viol: JSON.parse(props.viol), bands: JSON.parse(props.bands),
    interventions: [...interventions].sort(), snapshot, scenario };
}

// Per-tick predicted band for the predicted-vs-observed overlay [IMPL-INTERPRETATION: the spec stores
// "bands(json)" but does not name the metric; the lowest entry goodput per tick is used].
function goodputBands(traces) {
  const ticks = traces[0].length;
  const at = (t) => traces.map((tr) => Math.min(...Object.values(tr[t].gp)));
  const series = (q) => Array.from({ length: ticks }, (_, t) => percentile(at(t), q));
  return { metric: 'min_entry_goodput', p10: series(0.10), p50: series(0.50), p90: series(0.90) };
}

// Verdict from the Round's explicit safety constraint (spec §10.6). The per-entry harm test needs
// the do-nothing reference and is applied by the decision engine at commit, not here.
function verdict(e, round) {
  if (e.recovered < round.rec_threshold) return 'red';
  return e.median <= round.error_budget ? 'green' : 'amber';
}

/**
 * Evaluate one counterfactual future on a real graph fork.
 * @param {object} opts
 * @param {string} opts.scenarioId    Scenario on the twin whose faults are evaluated.
 * @param {string} opts.label         Future label, e.g. 'F5' → graph and id 'fork:R<round>:F5'.
 * @param {string[]} opts.interventionIds  0..2 Intervention ids (0 = do nothing).
 * @param {'reactive'|'preemptive'} opts.mode  reactive: start from the twin's Snapshot (faults already
 *        removed); preemptive: start healthy and replay the scenario (spec §9 step 4).
 * @param {string} [opts.snapshotId]  required for reactive mode.
 * @param {boolean} [opts.retainFork=false]  keep the fork after recording (spec §9 step 7 Q&A use).
 * @param {boolean} [opts.audit=false]  true when the server's audit (not the agent) evaluated this future.
 * @param {function} [opts.onForked]  test hook, called with the fork name after GRAPH.COPY.
 */
export async function runFuture(db, { scenarioId, label, interventionIds = [], mode, snapshotId, retainFork = false, audit = false, onForked }) {
  const roundRows = await roRows(db, GRAPHS.twin, `MATCH (r:Round) RETURN properties(r) AS r ORDER BY r.n DESC LIMIT 1`);
  const round = roundRows[0].r;
  const id = futureId(round.n, label);

  // Step 0: idempotent — an already recorded future is returned without re-simulating.
  const existing = await readFuture(db, id);
  if (existing && existing.scenario !== scenarioId) {
    throw new Error(`Future '${id}' already belongs to scenario '${existing.scenario}' (future ids are per round)`);
  }
  if (existing) return { ...existing, reused: true };

  // Step 1: validate against the canonical twin before touching any graph.
  if (mode !== 'reactive' && mode !== 'preemptive') throw new Error(`mode must be 'reactive' or 'preemptive'`);
  if (mode === 'reactive' && !snapshotId) throw new Error('reactive futures require a snapshotId');
  if (interventionIds.length > MAX_INTERVENTIONS) throw new Error(`at most ${MAX_INTERVENTIONS} interventions per future`);
  if (new Set(interventionIds).size !== interventionIds.length) throw new Error('duplicate intervention ids');
  const faults = await scenarioFaults(db, scenarioId);
  const known = await roRows(db, GRAPHS.twin,
    `MATCH (i:Intervention) WHERE i.id IN $ids AND coalesce(i.active, true) RETURN i.id AS id, i.kind AS kind, i.caller AS caller, i.callee AS callee, i.cost AS cost`,
    { ids: interventionIds });
  const missing = interventionIds.filter((x) => !known.some((k) => k.id === x));
  if (missing.length) throw new Error(`Intervention(s) not in graph '${GRAPHS.twin}': ${missing.join(', ')}`);
  const retryEdits = known.filter((k) => k.kind === 'retries_off' || k.kind === 'cap_retries').map((k) => `${k.caller}>${k.callee}`);
  if (new Set(retryEdits).size !== retryEdits.length) throw new Error('retries_off and cap_retries on the same edge cannot be combined');
  if (mode === 'reactive') {
    const s = await roRows(db, GRAPHS.twin, `MATCH (s:Snapshot {id: $id}) RETURN s.id AS id`, { id: snapshotId });
    if (!s.length) throw new Error(`Snapshot '${snapshotId}' not in graph '${GRAPHS.twin}'`);
  }

  // Step 2: delete-then-copy (GRAPH.COPY errors if the destination exists).
  await deleteGraphIfExists(db, id);
  await db.selectGraph(GRAPHS.twin).copy(id);
  let recorded = false;
  try {
    if (onForked) await onForked(id);
    // Step 3: apply the fixed templates to the fork.
    await applyTemplates(db, id, interventionIds, known);
    // Step 4: the simulator's only input is loadModel(fork).
    const model = buildModel(await loadModel(db, id));
    const tag = SEED_SCHEME.ROUND_TAG_STRIDE * round.n + SEED_SCHEME.FUTURE_TAG_OFFSET;
    const run = mode === 'reactive'
      ? { state0: initialState(model), faults: [], tOff: 0, horizon: round.horizon_reactive }
      : { state0: healthyState(model), faults, tOff: round.t_off, horizon: round.horizon_preemptive };
    // Step 5: seeded rollouts in memory (no ticks written to the graph).
    const e = ensemble(model, run.state0, run.faults, run.tOff, run.horizon, tag, SEED_SCHEME.ROLLOUTS);
    // Step 6: record the summary on the twin (commit point).
    const cost = known.reduce((a, k) => a + k.cost, 0);
    const props = {
      graph: id, label, round: round.n, mode, p_recover: e.recovered, n: e.n, viol_ticks_p50: e.median, p10: e.p10, p90: e.p90,
      viol: JSON.stringify(e.viol), viol_by_entry: JSON.stringify(e.violByEntry), bands: JSON.stringify(goodputBands(e.traces)),
      cost, verdict: verdict(e, round), audit, tag, horizon: run.horizon, t_off: run.tOff,
    };
    await rows(db, GRAPHS.twin, WRITE_FUTURE, { id, scenario_id: scenarioId, snapshot_id: mode === 'reactive' ? snapshotId : '', props, intervention_ids: interventionIds });
    recorded = true;
    return { ...(await readFuture(db, id)), reused: false };
  } finally {
    // Step 7: GRAPH.DELETE the fork — always on failure, and on success unless it is retained.
    if (!recorded || !retainFork) await deleteGraphIfExists(db, id);
  }
}
