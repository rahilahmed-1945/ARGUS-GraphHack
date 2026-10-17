// The canonical ARGUS run, end to end (spec §2.1 three acts, §2.2 sequence):
//   Round 1 (reactive):   RED → inject into WORLD → trigger removed (hold) → still down → SNAP → BLUE → M5 decision
//                         → APPLY (hardening PR) → OBSERVE → Observation → calibration → regenerate → Round 2
//   Round 2 (pre-emptive): RED (changed graph → changed attack) → BLUE before injection → M5 decision → APPLY
//                         → WORLD finale: the slowdown is injected AND the pending deploy lands → OBSERVE → safe?
// Agents act only through their tool transport (MCP in the demo); WORLD is touched only here, by the orchestrator
// (admin identity), through the real simulator and the real `world` graph. Every step emits a canonical event.
import { GRAPHS, roRows } from '../graph/db.js';
import { readRound } from '../graph/budget.js';
import { writeSnapshot, scenarioFaults, setBlueContext } from '../graph/records.js';
import { writeObservation } from '../graph/observation.js';
import { writeCalibration, openNextRound, landDeploy } from '../graph/hardening.js';
import { applyDecisionWithPR } from '../graph/hardening-pr.js';
import { World, loadSimModel } from '../sim/contexts.js';
import { calibrate } from '../sim/sim.js';
import { runPhase } from './runtime.js';
import { WORLD_SCRIPT } from './orchestrator.js';

// TWIN and WORLD as the UI needs them (configuration only; live world state travels in WORLD_TICK events)
export async function graphState(db, graphName) {
  const services = await roRows(db, graphName, `MATCH (s:Service) RETURN s.name AS name, s.entry AS entry, s.cap_mean AS cap_mean, s.cap_sd AS cap_sd ORDER BY name`);
  const calls = await roRows(db, graphName, `MATCH (a:Service)-[c:CALLS]->(b:Service) RETURN a.name AS caller, b.name AS callee, c.retries AS retries, c.breaker AS breaker, c.timeout_ms AS timeout_ms ORDER BY caller, callee`);
  const changeEvents = await roRows(db, graphName, `MATCH (c:ChangeEvent)-[m:MODIFIES]->(a:Service) RETURN c.id AS id, a.name AS caller, m.callee AS callee, c.status AS status ORDER BY id`);
  // [M10] the action spaces, so a viewer can place a fault/intervention id on the graph without parsing ids (read-only)
  const faults = await roRows(db, graphName, `MATCH (f:Fault) OPTIONAL MATCH (f)-[:APPLIES_TO]->(s:Service) OPTIONAL MATCH (f)-[:LANDS]->(c:ChangeEvent)
    RETURN f.id AS id, f.kind AS kind, s.name AS target, c.id AS change_event, f.cost_to_attacker AS cost, coalesce(f.active, true) AS active ORDER BY id`);
  const interventions = await roRows(db, graphName, `MATCH (i:Intervention) OPTIONAL MATCH (i)-[:APPLIES_TO]->(x) OPTIONAL MATCH (i)-[:BLOCKS]->(c:ChangeEvent)
    RETURN i.id AS id, i.kind AS kind, i.cost AS cost, i.caller AS caller, i.callee AS callee, coalesce(x.name, x.id) AS target,
      c.id AS change_event, coalesce(i.active, true) AS active ORDER BY id`);
  return { graph: graphName, services, calls, changeEvents, faults, interventions };
}
const bothGraphs = async (db) => ({ twin: await graphState(db, GRAPHS.twin), world: await graphState(db, GRAPHS.world) });

async function reloadWorld(db, world) {
  const next = new World(await loadSimModel(db, GRAPHS.world));
  next.state = world.snapshotState();
  next.tick = world.tick;
  return next;
}

/**
 * @param {object} db                     admin connection (orchestrator)
 * @param {object} o
 * @param {'live'|'replay'|'autopilot'} o.mode
 * @param {{red?: object, blue?: object}} [o.adapters]   LLM adapters (live: provider-backed; replay: cassette players)
 * @param {object} o.events               event bus (runtime/events.js)
 * @param {object} o.clock                world clock (runtime/clock.js)
 * @param {{red?: function, blue?: function, fallback?: function}} [o.toolboxes]  transport factories (MCP); fallback(role, ctx)
 * @param {number} [o.ceilingMs]
 * @param {function} [o.gate]          optional; awaited before round 2 (the interactive demo's ATTACK AGAIN). Absent → no pause.
 */
export async function runCanonicalDemo(db, { mode, adapters = {}, events, clock, toolboxes = {}, ceilingMs, gate = null } = {}) {
  const runs = [];
  const phase = async (role, ctx = {}) => {
    events.emit(role === 'red' ? 'RED_STARTED' : 'BLUE_STARTED', { role, mode, ...ctx });
    clock.pause(`${role.toUpperCase()} deciding`);
    const r = await runPhase(db, { role, mode, adapter: adapters[role] ?? null, ctx, events, ...(ceilingMs ? { ceilingMs } : {}),
      toolboxFactory: toolboxes[role] ? () => toolboxes[role](ctx) : null,
      fallbackToolboxFactory: toolboxes.fallback ? () => toolboxes.fallback(role, ctx) : null });
    runs.push({ role, round: (await readRound(db)).n, proposedBy: r.proposedBy, takeover: r.takeover, turns: r.turns, transport: r.transport });
    return r;
  };
  const release = async (trace, { segment, faults = [], removeAt = null }) => {
    clock.run(segment);
    for (const [k, o] of trace.entries()) {
      if (removeAt !== null && k === removeAt) events.emit('WORLD_FAULT_REMOVED', { segment, faults, tick: o.t });
      await clock.tick();
      events.emit('WORLD_TICK', { segment, tick: o.t, viol: o.viol, goodput: o.gp, violated_entries: Object.keys(o.ve).filter((e) => o.ve[e]),
        served: o.served, queue: o.q, degrade: o.deg, faults: o.faults });
    }
  };
  const harden = async (decisionId) => {
    events.emit('HARDENING_STARTED', { decision: decisionId });
    const pr = await applyDecisionWithPR(db, decisionId);
    events.emit('HARDENING_APPLIED', { decision: decisionId, pr: pr.pr, yaml: pr.yaml, changes: pr.pr.changes, graphs: await bothGraphs(db) });
    return pr;
  };
  const observeAndCalibrate = async (world, decisionId, observed, calibrationTicks) => {
    const observation = await writeObservation(db, { decisionId, observedTrace: observed });
    events.emit('WORLD_OBSERVATION', { decision: decisionId, ...observation });
    const calibrated = [];
    for (const service of world.model.order) {
      const result = calibrate(world.model, calibrationTicks, service);
      if (!result) continue;
      const c = await writeCalibration(db, { observationId: observation.id, service, result });
      calibrated.push({ ...c, n: result.n, se: result.se, cap_sd: result.cap_sd });
      events.emit('CALIBRATION_UPDATED', { observation: observation.id, ...c, n: result.n, se: result.se, cap_sd: result.cap_sd });
    }
    return { observation, calibrated };
  };

  // ======================================================== Round 1 (reactive)
  let round = await readRound(db);
  events.emit('ROUND_STARTED', { round: round.n, mode: 'reactive', graphs: await bothGraphs(db) });
  const red1 = await phase('red');
  const s1 = red1.outcome.scenarioId;
  if (!s1) throw new Error('round 1: no attack scenario was found');
  const faults1 = await scenarioFaults(db, s1);
  let world = await World.open(db);
  events.emit('WORLD_FAULT_INJECTED', { scenario: s1, faults: faults1, tick: world.tick });
  const act = world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults: faults1 });
  await release(act, { segment: 'ACT' });
  events.emit('WORLD_FAULT_REMOVED', { segment: 'ACT', faults: faults1, tick: world.tick });
  await clock.hold('TRIGGER REMOVED');
  const hold = world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  await release(hold, { segment: 'HOLD' });
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  events.emit('SNAPSHOT_TAKEN', { snapshot: snapshotId, tick: world.tick });
  const ctx1 = { scenarioId: s1, futureMode: 'reactive', snapshotId };
  await setBlueContext(db, ctx1);
  const blue1 = await phase('blue', ctx1);
  const d1 = blue1.outcome.decision;
  const pr1 = await harden(d1.id);
  world = await reloadWorld(db, world);
  const observed1 = world.advance({ ticks: round.horizon_reactive, seed: WORLD_SCRIPT.OBSERVE_SEED });
  await release(observed1, { segment: 'OBSERVE' });
  const r1 = await observeAndCalibrate(world, d1.id, observed1, [...act, ...hold, ...observed1]);
  const next = await openNextRound(db);
  events.emit('ROUND_COMPLETED', { round: round.n, scenario: s1, decision: d1.id, selected: d1.selected_future, observation: r1.observation.id, next_round: next });
  if (gate) await gate({ round: next });

  // ======================================================== Round 2 (pre-emptive)
  round = await readRound(db);
  events.emit('ROUND_STARTED', { round: round.n, mode: 'preemptive', graphs: await bothGraphs(db) });
  const red2 = await phase('red');
  const s2 = red2.outcome.scenarioId;
  if (!s2) throw new Error('round 2: no attack scenario was found');
  const ctx2 = { scenarioId: s2, futureMode: 'preemptive', snapshotId: null };
  await setBlueContext(db, ctx2);
  const blue2 = await phase('blue', ctx2);
  const d2 = blue2.outcome.decision;
  const pr2 = await harden(d2.id);

  // WORLD finale: inject the scenario anyway — the transient slowdown AND the persistent deploy landing
  const faults2 = await scenarioFaults(db, s2);
  const deploys = await roRows(db, GRAPHS.twin, `MATCH (f:Fault)-[:LANDS]->(c:ChangeEvent) WHERE f.id IN $ids RETURN c.id AS id ORDER BY id`, { ids: faults2 });
  const transient = faults2.filter((f) => !f.startsWith('deploy:'));
  events.emit('WORLD_FAULT_INJECTED', { scenario: s2, faults: faults2, tick: world.tick });
  for (const { id } of deploys) {
    const landed = await landDeploy(db, GRAPHS.world, id);
    // [IMPL-INTERPRETATION] a merged deploy is observable config, so the twin learns it too (build-readiness B#14)
    await landDeploy(db, GRAPHS.twin, id);
    events.emit('WORLD_DEPLOY_LANDED', { change_event: id, ...landed, graphs: await bothGraphs(db) });
  }
  world = await reloadWorld(db, world);
  const finale = world.advance({ ticks: round.horizon_preemptive, seed: WORLD_SCRIPT.ROUND2_SEED, faults: transient, tOff: round.t_off });
  await release(finale, { segment: 'FINALE', faults: transient, removeAt: round.t_off });
  const r2 = await observeAndCalibrate(world, d2.id, finale, finale);
  events.emit('ROUND_COMPLETED', { round: round.n, scenario: s2, decision: d2.id, selected: d2.selected_future, observation: r2.observation.id });

  const safe = r2.observation.observed_viol_ticks <= round.error_budget && r2.observation.observed_ttr >= 0;
  const result = {
    safe,
    finale: { observed_viol_ticks: r2.observation.observed_viol_ticks, predicted_viol_ticks_p50: r2.observation.predicted_viol_ticks_p50,
      error_budget: round.error_budget, observed_ttr: r2.observation.observed_ttr, ticks: finale.length },
    rounds: [
      { round: 1, scenario: s1, decision: d1.selected_future, observation: r1.observation, calibrated: r1.calibrated, pr: pr1.pr },
      { round: 2, scenario: s2, decision: d2.selected_future, observation: r2.observation, calibrated: r2.calibrated, pr: pr2.pr },
    ],
    phases: runs,
    virtual_ms: clock.virtualMs,
  };
  events.emit('DEMO_COMPLETED', { safe, finale: result.finale, phases: runs });
  return result;
}
