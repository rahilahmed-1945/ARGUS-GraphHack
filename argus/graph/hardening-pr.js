// The hardening PR (spec §2.1 step 8, §10.10, §14 "Open hardening PR"): a deterministic YAML artifact generated
// from the ACTUAL graph mutation — the configuration of WORLD and TWIN read before and after APPLY, diffed.
// Nothing in it is typed by hand: if the graph did not change, the PR has no changes and APPLY fails.
import { dump } from 'js-yaml';
import { rows, roRows, GRAPHS } from './db.js';
import { applyDecision } from './hardening.js';
import { readDecision } from './decision.js';
import { readFuture } from './forks.js';

// The configuration an intervention can change (§6.15 templates): service capacity/shedding, call retries/
// breaker, deploy status.
export async function captureConfig(db, graphName) {
  const svc = await roRows(db, graphName, `MATCH (s:Service) RETURN s.name AS n, s.cap_mean AS cap_mean, s.shed AS shed ORDER BY n`);
  const calls = await roRows(db, graphName, `MATCH (a:Service)-[c:CALLS]->(b:Service) RETURN a.name + '>' + b.name AS e, c.retries AS retries, c.breaker AS breaker ORDER BY e`);
  const ces = await roRows(db, graphName, `MATCH (c:ChangeEvent) RETURN c.id AS id, c.status AS status ORDER BY id`);
  return {
    services: Object.fromEntries(svc.map((r) => [r.n, { cap_mean: r.cap_mean, shed: r.shed }])),
    calls: Object.fromEntries(calls.map((r) => [r.e, { retries: r.retries, breaker: r.breaker }])),
    change_events: Object.fromEntries(ces.map((r) => [r.id, { status: r.status }])),
  };
}

export function diffConfig(before, after) {
  const out = [];
  for (const [kind, key] of [['services', 'service'], ['calls', 'edge'], ['change_events', 'change_event']]) {
    for (const id of Object.keys(after[kind]).sort()) {
      for (const field of Object.keys(after[kind][id]).sort()) {
        const b = before[kind][id]?.[field], a = after[kind][id][field];
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ [key]: id, field, before: b, after: a });
      }
    }
  }
  return out;
}

// [IMPL-INTERPRETATION] labels: the spec labels retry removal "emergency mitigation" with a follow-up to restore
// one retry layer with a budget (§10.8); the other labels name the kind of change.
const LABELS = { retries_off: 'emergency mitigation', cap_retries: 'emergency mitigation', breaker: 'resilience', scale_out: 'capacity',
  shed: 'load shedding', block_deploy: 'change freeze' };
const FOLLOW_UP = { retries_off: 'restore one retry layer with a retry budget once the incident risk is addressed' };

/** APPLY a committed decision to WORLD and TWIN and return the PR generated from the observed mutation. */
export async function applyDecisionWithPR(db, decisionId) {
  const d = await readDecision(db, decisionId);
  if (!d) throw new Error(`Decision '${decisionId}' not found`);
  const before = { world: await captureConfig(db, GRAPHS.world), twin: await captureConfig(db, GRAPHS.twin) };
  await applyDecision(db, decisionId);
  const after = { world: await captureConfig(db, GRAPHS.world), twin: await captureConfig(db, GRAPHS.twin) };
  const changes = { world: diffConfig(before.world, after.world), twin: diffConfig(before.twin, after.twin) };
  if (d.selects.length && (!changes.world.length || !changes.twin.length)) throw new Error(`APPLY of ${decisionId} changed nothing`);
  const scenario = (await roRows(db, GRAPHS.twin, `MATCH (sc:Scenario {id:$id})-[:CONTAINS]->(f:Fault) RETURN sc.evidence_path AS ev, collect(f.id) AS faults`, { id: d.scenario }))[0];
  const future = d.selected_future === 'NO_SAFE_ACTION' ? null : await readFuture(db, d.selected_future);
  const kinds = d.selects.map((i) => i.split(':')[0]);
  const pr = {
    kind: 'argus.hardening/v1',
    round: d.round,
    decision: d.id,
    scenario: d.scenario,
    label: [...new Set(kinds.map((k) => LABELS[k] ?? k))].join(', ') || 'no change',
    follow_up: [...new Set(kinds.map((k) => FOLLOW_UP[k]).filter(Boolean))],
    interventions: d.selects,
    selected_future: d.selected_future,
    rule: d.rule,
    minimality: d.minimality,
    proposed_by: d.proposed_by,
    rationale: d.rationale,
    evidence: { attack: [...scenario.faults].sort(), evidence_path: scenario.ev ?? [] },
    prediction: future ? { recovered: `${future.p_recover}/${future.n}`, viol_ticks_p50: future.viol_ticks_p50, p10: future.p10, p90: future.p90 } : null,
    changes,
  };
  const yaml = dump(pr, { sortKeys: false, lineWidth: 120, noRefs: true });
  await rows(db, GRAPHS.twin, `MATCH (d:Decision {id:$id}) SET d.hardening_pr = $yaml`, { id: decisionId, yaml });
  return { pr, yaml, before, after };
}
