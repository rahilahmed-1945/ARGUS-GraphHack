// Headless round orchestration (spec §2.2 agent loop): RED → ACT → SNAP → BLUE → APPLY → OBSERVE →
// calibrate → harden → next round. No world clock pacing, UI or LLM here — the runtime foundation that
// later milestones drive. Every step runs from graph state; WORLD and TWIN stay separate.
import { GRAPHS } from '../graph/db.js';
import { writeSnapshot } from '../graph/records.js';
import { writeObservation } from '../graph/observation.js';
import { applyDecision, writeCalibration, openNextRound } from '../graph/hardening.js';
import { readRound } from '../graph/budget.js';
import { readScope } from '../graph/scope.js';
import { scenarioFaults } from '../graph/records.js';
import { World, loadSimModel } from '../sim/contexts.js';
import { calibrate } from '../sim/sim.js';
import { runPhase } from './runtime.js';

/* WORLD SCRIPT CONSTANTS (spec §2.2, §7.7): round-1 ACT ticks 0–29 seed 7; ticks 30–39 seed 8 (the trigger
   removed, held); OBSERVE seed 99; round-2 seed 77. Not system-model data. */
export const WORLD_SCRIPT = Object.freeze({ ACT_SEED: 7, HOLD_SEED: 8, HOLD_TICKS: 10, OBSERVE_SEED: 99, ROUND2_SEED: 77 });
/* END WORLD SCRIPT CONSTANTS */

// Round 1 (reactive): RED on the healthy twin → inject into WORLD → trigger removed → still down → snapshot → BLUE.
export async function runRound1(db, { mode = 'autopilot', red = {}, blue = {} } = {}) {
  const round = await readRound(db);
  const redRun = await runPhase(db, { role: 'red', mode, ...red });
  const scenarioId = redRun.outcome.scenarioId;
  if (!scenarioId) return { redRun, scenarioId: null };
  const faults = await scenarioFaults(db, scenarioId);
  const world = await World.open(db);
  const act = world.advance({ ticks: round.t_off, seed: WORLD_SCRIPT.ACT_SEED, faults });
  const hold = world.advance({ ticks: WORLD_SCRIPT.HOLD_TICKS, seed: WORLD_SCRIPT.HOLD_SEED });
  // [IMPL-INTERPRETATION] the snapshot is the exact world state: observation noise (spec §3.6) has no
  // specified seed yet (build-readiness TBD #10) and R1.11 shows the verdicts do not depend on it.
  const snapshotId = await writeSnapshot(db, { round: round.n, tick: world.tick, state: world.snapshotState() });
  const blueRun = await runPhase(db, { role: 'blue', mode, ctx: { scenarioId, futureMode: 'reactive', snapshotId }, ...blue });
  return { redRun, blueRun, scenarioId, snapshotId, world, act, hold };
}

// APPLY the decision to WORLD and TWIN → OBSERVE the world → Observation → calibrate → regenerate → next Round.
export async function hardenAfterRound(db, { world, decisionId, actTicks }) {
  const round = await readRound(db);
  await applyDecision(db, decisionId);
  // the live world continues from its current state, now running the hardened world graph
  const hardened = new World(await loadSimModel(db, GRAPHS.world));
  hardened.state = world.snapshotState();
  hardened.tick = world.tick;
  const observed = hardened.advance({ ticks: round.horizon_reactive, seed: WORLD_SCRIPT.OBSERVE_SEED });
  const observation = await writeObservation(db, { decisionId, observedTrace: observed });
  const calibrated = [];
  for (const service of hardened.model.order) {
    const result = calibrate(hardened.model, [...actTicks, ...observed], service);
    if (result) calibrated.push(await writeCalibration(db, { observationId: observation.id, service, result }));
  }
  const next = await openNextRound(db);
  return { observation, calibrated, nextRound: next, world: hardened, observed };
}

// Round ≥ 2 (pre-emptive): RED on the hardened twin → BLUE before injection (futures start healthy).
export async function runPreemptiveRound(db, { mode = 'autopilot', red = {}, blue = {} } = {}) {
  const redRun = await runPhase(db, { role: 'red', mode, ...red });
  const scenarioId = redRun.outcome.scenarioId;
  if (!scenarioId) return { redRun, scenarioId: null };
  const blueRun = await runPhase(db, { role: 'blue', mode, ctx: { scenarioId, futureMode: 'preemptive' }, ...blue });
  return { redRun, blueRun, scenarioId, scope: await readScope(db, scenarioId) };
}
