// Seed ingest and action-space rules. Spec §5 (schema), §6.1 (seed), §6.3 (rules).
// Query structure only; every value is a parameter taken from config/topology.yaml.
import { rows } from './db.js';

// §6.1. Every property is written explicitly: in Cypher `NOT null` is null, so a missing property
// would silently drop rows from later WHERE clauses (spec §5.1).
const INGEST_SERVICES = `
UNWIND $services AS s
CREATE (:Service {name: s.name, entry: s.entry, ext_rps: s.ext_rps, cap_mean: s.cap_mean, cap_sd: s.cap_sd,
                  base_ms: s.base_ms, queue_s: s.queue_s, shed: s.shed, q_est: s.q_est})`;

const INGEST_CALLS = `
UNWIND $calls AS e
MATCH (a:Service {name: e.caller}), (b:Service {name: e.callee})
CREATE (a)-[:CALLS {fanout: e.fanout, retries: e.retries, timeout_ms: e.timeout_ms, breaker: e.breaker,
                    trip_p: e.trip_p, trip_ticks: e.trip_ticks, cooldown: e.cooldown,
                    p_est: e.p_est, hot_est: e.hot_est, open_ticks_est: e.open_ticks_est}]->(b)`;

// MODIFIES points to the CALLER; `callee` names the CALLS edge's target (spec §5.3).
const INGEST_CHANGE_EVENTS = `
UNWIND $changeEvents AS c
MATCH (a:Service {name: c.caller})
CREATE (:ChangeEvent {id: c.id, field: c.field, new_value: c.new_value, status: c.status})-[:MODIFIES {callee: c.callee}]->(a)`;

const INGEST_ROUND = `CREATE (r:Round) SET r += $round`;

// §6.3 rules, verbatim structure; literals replaced by parameters from topology.yaml.
const FAULT_RULES = {
  cap_degrade: `
MATCH (s:Service) WHERE coalesce(s.entry,false) = false
MERGE (f:Fault {id: $id_prefix + ':' + s.name})
  SET f.kind = $kind, f.magnitude = $magnitude, f.persistence = $persistence, f.cost_to_attacker = $cost_to_attacker, f.active = true
MERGE (f)-[:APPLIES_TO]->(s)`,
  surge: `
MATCH (s:Service) WHERE coalesce(s.entry,false) = true
MERGE (f:Fault {id: $id_prefix + ':' + s.name})
  SET f.kind = $kind, f.magnitude = $magnitude, f.persistence = $persistence, f.cost_to_attacker = $cost_to_attacker, f.active = true
MERGE (f)-[:APPLIES_TO]->(s)`,
  deploy: `
MATCH (c:ChangeEvent {status:'pending'})-[:MODIFIES]->(s:Service)
MERGE (f:Fault {id: $id_prefix + ':' + c.id})
  SET f.kind = $kind, f.persistence = $persistence, f.cost_to_attacker = $cost_to_attacker, f.active = true
MERGE (f)-[:APPLIES_TO]->(s) MERGE (f)-[:LANDS]->(c)`,
};

const INTERVENTION_RULES = {
  retries_off: `
MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE coalesce(c.retries,0) >= 1
MERGE (i:Intervention {id: $kind + ':' + a.name + '>' + b.name})
  SET i.kind = $kind, i.caller = a.name, i.callee = b.name, i.cost = $cost, i.active = true
MERGE (i)-[:APPLIES_TO]->(a)`,
  cap_retries: `
MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE coalesce(c.retries,0) > 1
MERGE (i:Intervention {id: $kind + ':' + a.name + '>' + b.name})
  SET i.kind = $kind, i.caller = a.name, i.callee = b.name, i.cost = $cost, i.factor = $factor, i.active = true
MERGE (i)-[:APPLIES_TO]->(a)`,
  breaker: `
MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE coalesce(c.breaker,false) = false
MERGE (i:Intervention {id: $kind + ':' + a.name + '>' + b.name})
  SET i.kind = $kind, i.caller = a.name, i.callee = b.name, i.cost = $cost, i.active = true
MERGE (i)-[:APPLIES_TO]->(a)`,
  scale_out: `
MATCH (s:Service) WHERE coalesce(s.entry,false) = false
MERGE (i:Intervention {id: $kind + ':' + s.name})
  SET i.kind = $kind, i.factor = $factor, i.cost = $cost, i.active = true
MERGE (i)-[:APPLIES_TO]->(s)`,
  shed: `
MATCH (s:Service) WHERE coalesce(s.entry,false) = true
MERGE (i:Intervention {id: $kind + ':' + s.name})
  SET i.kind = $kind, i.factor = $factor, i.cost = $cost, i.active = true
MERGE (i)-[:APPLIES_TO]->(s)`,
  block_deploy: `
MATCH (c:ChangeEvent {status:'pending'})-[:MODIFIES]->(s:Service)
MERGE (i:Intervention {id: $kind + ':' + c.id})
  SET i.kind = $kind, i.cost = $cost, i.active = true
MERGE (i)-[:APPLIES_TO]->(s) MERGE (i)-[:BLOCKS]->(c)`,
};

export async function createIndexes(db, graphName, indexes) {
  for (const { label, property } of indexes) {
    await rows(db, graphName, `CREATE INDEX FOR (n:${label}) ON (n.${property})`);
  }
}

export async function ingestSeed(db, graphName, seed) {
  await rows(db, graphName, INGEST_SERVICES, { services: seed.services });
  await rows(db, graphName, INGEST_CALLS, { calls: seed.calls });
  await rows(db, graphName, INGEST_CHANGE_EVENTS, { changeEvents: seed.changeEvents });
  await rows(db, graphName, INGEST_ROUND, { round: seed.round });
}

// Regenerate the action spaces after hardening (spec §6.3 "the rules run at ingest and again after every
// hardening"; build-readiness decision B#8): every Fault/Intervention is first marked inactive, then the
// rules re-mark the ones still valid. Stale nodes are kept (inactive) so history edges (TESTS, SELECTS,
// CONTAINS) survive; every action-space query reads active nodes only.
export async function regenerateActionSpaces(db, graphName, topo) {
  await rows(db, graphName, `MATCH (f:Fault) SET f.active = false`);
  await rows(db, graphName, `MATCH (i:Intervention) SET i.active = false`);
  await runActionSpaceRules(db, graphName, topo);
}

// Runs every rule; kinds come from topology.yaml, so a kind without a rule (or vice versa) is an error.
export async function runActionSpaceRules(db, graphName, topo) {
  for (const [kinds, rules, label] of [[topo.faults, FAULT_RULES, 'fault'], [topo.interventions, INTERVENTION_RULES, 'intervention']]) {
    const missing = Object.keys(rules).filter((k) => !(k in kinds)).concat(Object.keys(kinds).filter((k) => !(k in rules)));
    if (missing.length) throw new Error(`${label} kinds without a rule or parameters: ${missing.join(', ')}`);
    for (const [kind, params] of Object.entries(kinds)) {
      await rows(db, graphName, rules[kind], { kind, ...params });
    }
  }
}
