// WORLD and TWIN execution contexts (spec §3). Each is built only from loadModel(<its own graph>).
//   Twin  — the model ARGUS reasons over: seeded ensembles of counterfactual rollouts.
//   World — the hidden ground truth: one live state advanced tick by tick; faults are injected into it.
// Graph writes (snapshot, APPLY, calibration) belong to later milestones and are not done here.
import { loadModel } from '../graph/load-model.js';
import { GRAPHS } from '../graph/db.js';
import { buildModel, initialState, rollout, ensemble, applyInterventions } from './sim.js';

export async function loadSimModel(db, graphName) {
  return buildModel(await loadModel(db, graphName));
}

export class Twin {
  constructor(model) {
    if (model.graph !== GRAPHS.twin) throw new Error(`Twin context requires the '${GRAPHS.twin}' graph, got '${model.graph}'`);
    this.model = Object.freeze(model);
  }
  static async open(db) { return new Twin(await loadSimModel(db, GRAPHS.twin)); }
  get graph() { return this.model.graph; }
  initialState() { return initialState(this.model); }

  // Counterfactual ensemble: optional interventions applied to a copy of the twin model.
  ensemble({ state0 = this.initialState(), faults = [], interventions = [], tOff, horizon, tag, n }) {
    const m = interventions.length ? applyInterventions(this.model, interventions) : this.model;
    return ensemble(m, state0, faults, tOff, horizon, tag, n);
  }
}

export class World {
  constructor(model) {
    if (model.graph !== GRAPHS.world) throw new Error(`World context requires the '${GRAPHS.world}' graph, got '${model.graph}'`);
    this.model = model;
    this.state = initialState(model);
    this.tick = 0;
    this.history = [];
  }
  static async open(db) { return new World(await loadSimModel(db, GRAPHS.world)); }
  get graph() { return this.model.graph; }

  // Advance the live world by `ticks` ticks from its current state (one reference rollout segment).
  // `faults` are injected at the start of the segment and transient ones removed at segment tick `tOff`.
  advance({ ticks, seed, faults = [], tOff = Infinity }) {
    const { trace, state } = rollout(this.model, this.state, faults, tOff, ticks, seed);
    const start = this.tick;
    const out = trace.map((o) => ({ ...o, t: start + o.t, faults: o.t < tOff ? [...faults] : [] }));
    this.state = state;
    this.tick += ticks;
    this.history.push(...out);
    return out;
  }

  // Ground-truth state at the current tick (a copy; the world's own state is never exposed by reference).
  snapshotState() { return structuredClone(this.state); }

  // A separate world copy with interventions applied, continuing from the same live state (a world check).
  withInterventions(interventionIds) {
    const w = new World(applyInterventions(this.model, interventionIds));
    w.state = structuredClone(this.state);
    w.tick = this.tick;
    return w;
  }
}
