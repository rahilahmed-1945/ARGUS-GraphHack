// ARGUS executable simulator — a port of the frozen reference (sim/reference/sim_reference.py,
// spec Appendix A / §7). Pure functions. The ONLY source of system-model data is the output of
// loadModel(graph) (graph/load-model.js); this file holds equations and their shape constants only.

/* EQUATION-SHAPE CONSTANTS (spec §7.1; build-readiness decision B#13). Not system-model data:
   they define the shape of the equations, the seed scheme (§7.7) and the calibration estimator (§3.8). */
export const SHAPE = Object.freeze({
  SIGMOID_GUARD: 50,          // sig(x) saturates beyond ±50 (overflow guard)
  TIMEOUT_WIDTH: 0.1,         // p_timeout = σ((lat − timeout) / (0.1·timeout))
  P_CLAMP: 0.999999,          // expected-attempts formula is singular at p = 1
  MS_PER_TICK: 1000,          // one tick = 1 s; queueing delay = 1000·q/μ ms
  RECOVERY_WINDOW: 10,        // recovered ⇔ no violated tick in the last 10 ticks
  MIN_CAPACITY: 1,            // μ = max(1, …)
  SEED_STRIDE: 1000,          // rollout k of tag t uses seed 1000·t + k
  CALIB_SEED_BASE: 5000,      // observation noise for service i uses seed 5000 + i
  CALIB_MIN_N: 10,            // calibrate only with ≥ 10 clean saturated ticks
  CALIB_SD_FLOOR: 0.03,       // cap_sd ← max(SE, 0.03·mean)
  CALIB_Q_EPS: 1e-6,          // "non-empty queue"
});
/* END EQUATION-SHAPE CONSTANTS */

/* PRNG ALGORITHM: mulberry32 + Box-Muller. Its literals are fixed by the algorithm and verified
   bit-identical to the reference (spec P.1); they are not system-model data. */
export class Rng {
  constructor(seed) { this.a = seed >>> 0; }
  u32() {
    this.a = (this.a + 0x6D2B79F5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0)) >>> 0)) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }
  uni() { return (this.u32() + 0.5) / 4294967296; }
  gauss() {
    const u1 = this.uni(), u2 = this.uni();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
/* END PRNG ALGORITHM */

const sig = (x) => (x > SHAPE.SIGMOID_GUARD ? 1.0 : x < -SHAPE.SIGMOID_GUARD ? 0.0 : 1 / (1 + Math.exp(-x)));
const edgeKey = (a, b) => `${a}>${b}`;
const clone = (x) => structuredClone(x);

// ---------------------------------------------------------------- model construction
// Processing order: DFS from entry services marks back edges as `lagged` (spec §7.9); the remaining
// DAG is ordered with Kahn's algorithm, entries taken in name order and children visited in
// descending name order. On the seed graph this reproduces the reference's fixed ORDER exactly,
// which keeps the random-draw order (and so every seeded number) identical to the reference.
function processingOrder(services, calls) {
  const names = services.map((s) => s.name).sort();
  const out = Object.fromEntries(names.map((n) => [n, []]));
  for (const c of calls) out[c.caller].push(c.callee);
  for (const n of names) out[n].sort();
  const entries = services.filter((s) => s.entry).map((s) => s.name).sort();

  const lagged = new Set();
  const state = {};                                   // undefined | 'active' | 'done'
  const dfs = (n) => {
    state[n] = 'active';
    for (const v of out[n]) {
      if (state[v] === 'active') lagged.add(edgeKey(n, v));
      else if (state[v] === undefined) dfs(v);
    }
    state[n] = 'done';
  };
  for (const e of entries) if (!state[e]) dfs(e);
  for (const n of names) if (!state[n]) dfs(n);    // services unreachable from an entry

  const indeg = Object.fromEntries(names.map((n) => [n, 0]));
  for (const c of calls) if (!lagged.has(edgeKey(c.caller, c.callee))) indeg[c.callee] += 1;
  const queue = names.filter((n) => indeg[n] === 0)
    .sort((a, b) => (entries.includes(b) - entries.includes(a)) || a.localeCompare(b));
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const v of [...out[n]].reverse()) {
      if (lagged.has(edgeKey(n, v))) continue;
      indeg[v] -= 1;
      if (indeg[v] === 0) queue.push(v);
    }
  }
  return { order, lagged };
}

// Build the in-memory model from loadModel(graph) output. Runtime multipliers (surge, degrade)
// start at the identity value 1.
export function buildModel(lm) {
  const svc = {};
  for (const s of lm.services) {
    svc[s.name] = { entry: s.entry, ext: s.ext_rps, cap: s.cap_mean, sd: s.cap_sd, base: s.base_ms,
      qmax_s: s.queue_s, shed: s.shed, surge: 1.0, degrade: 1.0 };
  }
  const edges = lm.calls.map((c) => ({ key: edgeKey(c.caller, c.callee), a: c.caller, b: c.callee, fanout: c.fanout,
    retries: c.retries, timeout: c.timeout_ms, breaker: c.breaker, trip_p: c.trip_p, trip_ticks: c.trip_ticks, cooldown: c.cooldown }));
  const { order, lagged } = processingOrder(lm.services, lm.calls);
  return {
    graph: lm.graph,
    svc,
    edges,
    order,
    lagged: [...lagged].sort(),
    ces: Object.fromEntries(lm.changeEvents.map((c) => [c.id, { caller: c.caller, callee: c.callee, field: c.field, new_value: c.new_value, status: c.status }])),
    faults: Object.fromEntries(lm.faults.map((f) => [f.id, { kind: f.kind, magnitude: f.magnitude, persistence: f.persistence, target: f.target, lands: f.lands }])),
    interventions: Object.fromEntries(lm.interventions.map((i) => [i.id, { kind: i.kind, caller: i.caller, callee: i.callee, factor: i.factor, cost: i.cost, target: i.target, blocks: i.blocks }])),
    rnd: { ...lm.round },
    // snapshot state as stored in the graph (all zero on a freshly seeded graph)
    snapshot: {
      q: Object.fromEntries(lm.services.map((s) => [s.name, s.q_est])),
      p: Object.fromEntries(lm.calls.map((c) => [edgeKey(c.caller, c.callee), c.p_est])),
      hot: Object.fromEntries(lm.calls.map((c) => [edgeKey(c.caller, c.callee), c.hot_est])),
      open: Object.fromEntries(lm.calls.map((c) => [edgeKey(c.caller, c.callee), c.open_ticks_est])),
    },
  };
}

const findEdge = (m, a, b) => {
  const e = m.edges.find((x) => x.a === a && x.b === b);
  if (!e) throw new Error(`no CALLS edge ${a}>${b} in model '${m.graph}'`);
  return e;
};

// Initial state: the snapshot stored in the graph (Appendix A init_state on a fresh graph).
export function initialState(m) {
  return { ...clone(m.snapshot), lag: null };
}

// Healthy state: empty queues, no failures, breakers closed (Appendix A init_state). Used by
// pre-emptive futures, which start healthy and replay the scenario (spec §9 step 4).
export function healthyState(m) {
  const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
  const ek = m.edges.map((e) => e.key);
  return { q: zero(Object.keys(m.svc)), p: zero(ek), hot: zero(ek), open: zero(ek), lag: null };
}

// ---------------------------------------------------------------- faults and interventions
// Fault templates (spec §7.8): transient kinds are reverted at t_off; a landed deploy persists.
export function setFaults(m, faultIds, on) {
  for (const id of faultIds) {
    const f = m.faults[id];
    if (!f) throw new Error(`Fault '${id}' not in graph '${m.graph}'`);
    if (f.kind === 'cap_degrade') m.svc[f.target].degrade = on ? f.magnitude : 1.0;
    else if (f.kind === 'surge') m.svc[f.target].surge = on ? f.magnitude : 1.0;
    else if (f.kind === 'deploy' && on) {
      const ce = m.ces[f.lands];
      if (ce.status === 'pending') { findEdge(m, ce.caller, ce.callee)[ce.field] = ce.new_value; ce.status = 'landed'; }
    }
  }
}

// Intervention templates (spec §6.15 / Appendix A apply_iv), applied to an in-memory model copy.
export function applyInterventions(m0, ivIds) {
  const m = clone(m0);
  for (const id of ivIds) {
    const iv = m.interventions[id];
    if (!iv) throw new Error(`Intervention '${id}' not in graph '${m.graph}'`);
    if (iv.kind === 'retries_off') findEdge(m, iv.caller, iv.callee).retries = 0;
    else if (iv.kind === 'cap_retries') { const e = findEdge(m, iv.caller, iv.callee); e.retries = Math.min(iv.factor, e.retries); }
    else if (iv.kind === 'breaker') findEdge(m, iv.caller, iv.callee).breaker = true;
    else if (iv.kind === 'scale_out') m.svc[iv.target].cap *= iv.factor;
    else if (iv.kind === 'shed') m.svc[iv.target].shed = iv.factor;
    else if (iv.kind === 'block_deploy') m.ces[iv.blocks].status = 'blocked';
    else throw new Error(`unknown intervention kind '${iv.kind}'`);
  }
  return m;
}

// ---------------------------------------------------------------- one tick (Appendix A step)
export function step(m, s, mu, rng) {
  const S = m.svc, R = m.rnd, q = s.q, p = s.p;
  const lagged = new Set(m.lagged);
  const prev = s.lag;                                   // previous tick's flows, for lagged edges only
  const served = {}, dropped = {}, work = {}, arr = {};
  for (const n of m.order) {                            // fixed draw order
    arr[n] = S[n].ext ? S[n].ext * S[n].surge * (1 - S[n].shed) * (1 + R.arrival_noise * rng.gauss()) : 0.0;
  }
  for (const n of m.order) {                            // forward pass
    for (const e of m.edges) {
      if (e.b !== n) continue;
      let A;
      if (s.open[e.key] > 0) A = 0.0;
      else { const pe = Math.min(p[e.key], SHAPE.P_CLAMP); A = (1 - pe ** (e.retries + 1)) / (1 - pe); }
      const srcServed = lagged.has(e.key) ? (prev ? prev.served[e.a] : 0) : served[e.a];
      arr[n] += srcServed * e.fanout * A;
    }
    const w = q[n] + arr[n], sv = Math.min(w, mu[n]), qm = S[n].qmax_s * mu[n];
    q[n] = Math.min(w - sv, qm); dropped[n] = Math.max(0.0, w - sv - qm); served[n] = sv; work[n] = w;
  }
  const lat = {}, ok = {};
  for (const n of [...m.order].reverse()) {             // reverse pass
    let down = 0.0, okp = 1.0;
    for (const e of m.edges) {
      if (e.a !== n) continue;
      const k = e.key;
      let pe, d;
      if (s.open[k] > 0) {
        pe = 1.0; s.open[k] -= 1;
        if (s.open[k] === 0) { pe = 0.0; s.hot[k] = 0; }
        d = 0.0;
      } else {
        const src = lagged.has(k) && prev ? prev : { lat, ok, dropped, work };
        const latB = src.lat[e.b] ?? 0, okB = src.ok[e.b] ?? 1, workB = src.work[e.b] ?? 0, dropB = src.dropped[e.b] ?? 0;
        const pt = sig((latB - e.timeout) / (SHAPE.TIMEOUT_WIDTH * e.timeout));
        const pd = workB > 0 ? dropB / workB : 0.0;
        pe = 1 - (1 - pt) * (1 - pd) * okB; d = Math.min(latB, e.timeout);
        if (e.breaker) {
          s.hot[k] = pe > e.trip_p ? s.hot[k] + 1 : 0;
          if (s.hot[k] >= e.trip_ticks) { s.open[k] = e.cooldown; pe = 1.0; s.hot[k] = 0; }
        }
      }
      p[k] = pe; okp *= (1 - pe ** (e.retries + 1)); down = Math.max(down, d);
    }
    lat[n] = S[n].base + SHAPE.MS_PER_TICK * q[n] / mu[n] + down; ok[n] = okp;
  }
  if (m.lagged.length) s.lag = { served: { ...served }, lat: { ...lat }, ok: { ...ok }, dropped: { ...dropped }, work: { ...work } };
  const gp = {}, ve = {};
  for (const n of Object.keys(S)) {
    if (!S[n].ext) continue;
    gp[n] = (work[n] ? 1 - dropped[n] / work[n] : 1) * ok[n] * (1 - sig((lat[n] - R.slo_latency_ms) / R.slo_width_ms));
    ve[n] = gp[n] < R.slo_goodput;                      // per-entry violation (harm test)
  }
  return { gp, ve, served: { ...served }, q: { ...q }, lat, ok };
}

// ---------------------------------------------------------------- rollouts and ensembles
// One rollout (Appendix A rollout). The model and state are copied; the caller's objects are untouched.
// Returns the per-tick trace and the final state.
export function rollout(m0, state0, faults, tOff, horizon, seed) {
  const m = clone(m0), s = clone(state0), rng = new Rng(seed);
  const baseMu = {};
  for (const n of m.order) {
    baseMu[n] = Math.max(SHAPE.MIN_CAPACITY, m.svc[n].cap + rng.gauss() * m.svc[n].sd * m.svc[n].cap);
  }
  setFaults(m, faults, true);
  const trace = [];
  for (let t = 0; t < horizon; t++) {
    if (t === tOff) setFaults(m, faults, false);
    const mu = {};
    for (const n of Object.keys(m.svc)) mu[n] = baseMu[n] * m.svc[n].degrade;
    const o = step(m, s, mu, rng);
    o.t = t;
    o.viol = Object.values(o.ve).some(Boolean);
    o.deg = Object.fromEntries(Object.keys(m.svc).map((n) => [n, m.svc[n].degrade]));
    trace.push(o);
  }
  return { trace, state: s };
}

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b), h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
};
// Nearest-rank percentile (spec §10.6): v[ceil(q·n) − 1] on the sorted values.
export const percentile = (xs, q) => { const v = [...xs].sort((a, b) => a - b); return v[Math.max(0, Math.ceil(q * v.length) - 1)]; };

// Ensemble of n seeded rollouts with common random numbers: rollout k uses seed 1000·tag + k.
export function ensemble(m, state0, faults, tOff, horizon, tag, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error('ensemble: rollout count n is required');
  const traces = [];
  for (let k = 0; k < n; k++) traces.push(rollout(m, state0, faults, tOff, horizon, SHAPE.SEED_STRIDE * tag + k).trace);
  const viol = traces.map((tr) => tr.filter((o) => o.viol).length);
  const recovered = traces.filter((tr) => !tr.slice(-SHAPE.RECOVERY_WINDOW).some((o) => o.viol)).length;
  const entries = Object.keys(traces[0][0].ve);
  const violByEntry = Object.fromEntries(entries.map((e) => [e, traces.map((tr) => tr.filter((o) => o.ve[e]).length)]));
  return {
    n, tag, recovered, sustained: n - recovered,
    median: median(viol), p10: percentile(viol, 0.10), p90: percentile(viol, 0.90),
    viol, violByEntry, entryMedian: Object.fromEntries(entries.map((e) => [e, median(violByEntry[e])])),
    traces,
  };
}

// Spec §8 harm test: worse than do-nothing on ANY entry (medians).
export function harmful(violByEntryIv, violByEntryNone) {
  return Object.keys(violByEntryIv).some((e) => median(violByEntryIv[e]) > median(violByEntryNone[e]));
}

// ---------------------------------------------------------------- calibration (pure; spec §3.8)
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => { const mu = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1)); };

export function calibrate(m, worldTicks, svcName) {
  const rng = new Rng(SHAPE.CALIB_SEED_BASE + m.order.indexOf(svcName));
  const xs = [];
  for (const o of worldTicks) {
    const g = rng.gauss();                               // one draw per tick, used or not
    if (o.q[svcName] > SHAPE.CALIB_Q_EPS && o.deg[svcName] === 1.0) xs.push(o.served[svcName] * (1 + m.rnd.obs_noise * g));
  }
  if (xs.length < SHAPE.CALIB_MIN_N) return null;     // not enough clean saturated ticks: leave twin alone
  const mu = mean(xs), se = stdev(xs) / Math.sqrt(xs.length);
  return { n: xs.length, cap_mean: mu, se, cap_sd: Math.max(se, SHAPE.CALIB_SD_FLOOR * mu) / mu };
}
