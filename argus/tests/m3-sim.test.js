// M3 acceptance: WORLD/TWIN + executable simulator (spec §3, §7; Appendix A).
// Requires the pinned FalkorDB (`npm run db:up`). Starts from a fresh reset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, rows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { loadTopology } from '../graph/topology.js';
import { World, Twin, loadSimModel } from '../sim/contexts.js';
import { Rng, SHAPE, buildModel, initialState, rollout, calibrate } from '../sim/sim.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXPECTED = JSON.parse(readFileSync(`${ROOT}sim/reference/expected.json`, 'utf8'));
const exp = (key) => EXPECTED[key].expected;
const N = 16;                                   // rollouts per ensemble (spec: 16 seeded rollouts)
const HARD = ['retries_off:gateway>checkout', 'retries_off:checkout>payments'];
const R1_FUTURES = {
  F0: [], F1: ['scale_out:payments'], F2: ['scale_out:ledger-db'], F3: ['retries_off:checkout>payments'],
  F4: ['breaker:checkout>payments'], F5: HARD, R1_13: ['cap_retries:gateway>checkout', 'retries_off:checkout>payments'],
};
let db, ref;

// Round-1 world script (spec §2.2, Appendix A): ACT 0-29 seed 7 with the trigger, ticks 30-39 seed 8 with it removed.
async function round1World() {
  const world = await World.open(db);
  const act1 = world.advance({ ticks: 30, seed: 7, faults: ['degrade:ledger-db'] });
  const act2 = world.advance({ ticks: 10, seed: 8 });
  return { world, act1, act2 };
}

before(async () => {
  db = await connect();
  await reset(db);
  ref = JSON.parse(execFileSync('python', [`${ROOT}sim/reference/dump_traces.py`], { encoding: 'utf8', maxBuffer: 64 << 20 }));
});
after(async () => { await db.close(); });

test('1. the simulator loads its system model from FalkorDB via loadModel()', async () => {
  const twin = await Twin.open(db), world = await World.open(db);
  assert.equal(twin.graph, 'twin');
  assert.equal(world.graph, 'world');
  // processing order is derived from the graph and equals the reference ORDER (random-draw parity)
  assert.deepEqual(twin.model.order, ref.order);
  assert.deepEqual(world.model.lagged, []);
  // Changing graph data changes the simulation (spec Day-2 parameter test): on a scratch fork, set the
  // trigger's Fault.magnitude to 1.0 (no degradation) and the metastable attack disappears.
  const base = twin.ensemble({ faults: ['degrade:ledger-db'], tOff: 30, horizon: 90, tag: 101, n: N });
  assert.equal(base.sustained, exp('R1_3_degrade_ledger_db_sustained'));
  await db.selectGraph('twin').copy('fork:M3:magtest');
  try {
    await rows(db, 'fork:M3:magtest', `MATCH (f:Fault {id:'degrade:ledger-db'}) SET f.magnitude = 1.0`);
    const forked = buildModel({ ...(await (await import('../graph/load-model.js')).loadModel(db, 'fork:M3:magtest')), graph: 'twin' });
    const t2 = new Twin(forked);
    assert.equal(t2.ensemble({ faults: ['degrade:ledger-db'], tOff: 30, horizon: 90, tag: 101, n: N }).sustained, 0);
  } finally {
    await db.selectGraph('fork:M3:magtest').delete();
  }
  // a fault id that is not in the graph is rejected (no hallucinated faults)
  assert.throws(() => twin.ensemble({ faults: ['degrade:redis'], tOff: 30, horizon: 90, tag: 101, n: N }), /not in graph/);
});

test('2. no simulator topology/configuration is duplicated in source', () => {
  const topo = loadTopology();
  const values = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.values(x).forEach(walk); else values.add(x); };
  walk({ services: topo.services, calls: topo.calls, change_events: topo.change_events, world_overrides: topo.world_overrides,
         faults: topo.faults, interventions: topo.interventions, round: topo.round });
  const structural = new Set(['pending', 'transient', 'persistent', 'retries', 'stage', 'degrade', 'surge', 'deploy']);
  const needles = [...values].filter((v) => (typeof v === 'number' && !(Number.isInteger(v) && v >= 0 && v <= 2))
    || (typeof v === 'string' && !structural.has(v)));
  const offenders = [];
  for (const dir of ['graph', 'sim']) {
    for (const file of readdirSync(`${ROOT}${dir}`).filter((f) => f.endsWith('.js'))) {
      const code = readFileSync(`${ROOT}${dir}/${file}`, 'utf8')
        .replace(/\/\* EQUATION-SHAPE CONSTANTS[\s\S]*?END EQUATION-SHAPE CONSTANTS \*\//, '')
        .replace(/\/\* PRNG ALGORITHM[\s\S]*?END PRNG ALGORITHM \*\//, '')
        .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const v of needles) {
        const re = typeof v === 'number' ? new RegExp(`(?<![\\w.])${String(v).replace('.', '\\.')}(?![\\w.])`) : new RegExp(`['"\`]${v}['"\`]`);
        if (re.test(code)) offenders.push(`${dir}/${file}: ${JSON.stringify(v)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  // The only literals allowed in the simulator are the equation-shape constants (decision B#13).
  assert.deepEqual(Object.keys(SHAPE).sort(), ['CALIB_MIN_N', 'CALIB_Q_EPS', 'CALIB_SD_FLOOR', 'CALIB_SEED_BASE',
    'MIN_CAPACITY', 'MS_PER_TICK', 'P_CLAMP', 'RECOVERY_WINDOW', 'SEED_STRIDE', 'SIGMOID_GUARD', 'TIMEOUT_WIDTH']);
});

test('3. healthy world stays healthy (R1.1) and the healthy twin always recovers', async () => {
  const world = await World.open(db);
  const tr = world.advance({ ticks: 150, seed: 7 });
  const minGp = Math.min(...tr.flatMap((o) => Object.values(o.gp)));
  assert.equal(Number(minGp.toFixed(4)), 0.9997);      // reference value, seed 7 (spec gives no seed)
  assert.equal(tr.filter((o) => o.viol).length, 0);
  const twin = await Twin.open(db);
  const e = twin.ensemble({ faults: [], tOff: 30, horizon: 90, tag: 101, n: N });
  assert.equal(e.recovered, N);
  assert.equal(e.median, 0);
});

test('4. degrade:ledger-db produces the metastable failure (R1.2, R1.3, R1.4)', async () => {
  const twin = await Twin.open(db);
  assert.equal(twin.ensemble({ faults: ['degrade:ledger-db'], tOff: 30, horizon: 90, tag: 101, n: N }).sustained,
    exp('R1_3_degrade_ledger_db_sustained'));                                  // 15/16
  assert.equal(twin.ensemble({ faults: ['degrade:payments'], tOff: 30, horizon: 90, tag: 101, n: N }).sustained,
    exp('R1_2_degrade_payments_sustained'));                                   // 0/16
  const others = Object.keys(twin.model.faults).filter((f) => f !== 'degrade:ledger-db');
  const maxOther = Math.max(...others.map((f) => twin.ensemble({ faults: [f], tOff: 30, horizon: 90, tag: 101, n: N }).sustained));
  assert.equal(maxOther, exp('R1_2_other_singles_max_sustained'));             // all 0/16
  const { act1 } = await round1World();
  assert.equal(Number(Math.max(...act1.slice(2).map((o) => o.gp.gateway)).toFixed(3)), exp('R1_4_gateway_goodput_max_ticks_2_29'));
  assert.ok(act1.slice(2).every((o) => o.served.payments === exp('R1_4_payments_served_ticks_2_29')), 'payments pinned at 704');
});

test('5. removing the trigger does not restore the system (R1.5, R1.6)', async () => {
  const { world, act2 } = await round1World();
  assert.ok(act2.every((o) => o.faults.length === 0), 'trigger removed for ticks 30-39');
  assert.equal(Number(Math.max(...act2.map((o) => o.gp.gateway)).toFixed(3)), exp('R1_5_gateway_goodput_max_ticks_30_39'));
  const more = world.withInterventions([]).advance({ ticks: 60, seed: 99, tOff: 0 });
  assert.equal(more.filter((o) => o.viol).length, exp('F0_world_viol'));        // 60 more violated ticks
  const twin = await Twin.open(db);
  const f0 = twin.ensemble({ state0: world.snapshotState(), tOff: 0, horizon: 60, tag: 102, n: N });
  assert.equal(f0.recovered, exp('F0_p_recover'));                              // 0/16: the cascade sustains itself
});

test('6. canonical Round-1 outcomes equal the frozen reference simulator', async () => {
  const r = new Rng(1001);
  assert.deepEqual([r.u32(), r.u32(), r.u32(), r.u32()], exp('P1_prng_seed1001'));

  const { world, act1, act2 } = await round1World();
  // trace-level parity with the Python reference: world ACT segments and the tick-40 state
  const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
  const cmpTrace = (js, py, label) => {
    assert.equal(js.length, py.length);
    js.forEach((o, t) => {
      assert.equal(o.viol, py[t].viol, `${label} t${t} viol`);
      for (const k of ['gp', 'served', 'q']) for (const [n, v] of Object.entries(py[t][k])) close(o[k][n], v, `${label} t${t} ${k}.${n}`);
    });
  };
  cmpTrace(act1, ref.world_act1, 'world ACT 0-29');
  cmpTrace(act2, ref.world_act2, 'world ACT 30-39');
  const s40 = world.snapshotState();
  for (const k of ['q', 'p', 'hot', 'open']) for (const [n, v] of Object.entries(ref.state40[k])) close(s40[k][n], v, `state40.${k}.${n}`);

  // Round-1 futures from the tick-40 snapshot (tag 102) and their world checks (seed 99)
  const twin = await Twin.open(db);
  const observe = {};
  for (const [key, ivs] of Object.entries(R1_FUTURES)) {
    const f = twin.ensemble({ state0: s40, interventions: ivs, tOff: 0, horizon: 60, tag: 102, n: N });
    const wc = world.withInterventions(ivs).advance({ ticks: 60, seed: 99, tOff: 0 });
    observe[key] = wc;
    const actual = {
      [`${key}_p_recover`]: f.recovered, [`${key}_median`]: f.median, [`${key}_p10_p90`]: [f.p10, f.p90],
      [`${key}_world_viol`]: wc.filter((o) => o.viol).length,
      [`${key}_entry_median_gw_mgw`]: [f.entryMedian.gateway, f.entryMedian['mobile-gw']],
    };
    for (const [k, v] of Object.entries(actual)) if (k in EXPECTED) assert.deepEqual(v, exp(k), k);
    if (key === 'F5') {
      assert.deepEqual(f.viol, ref.f5.viol, 'F5 per-rollout violation counts');
      assert.deepEqual(f.violByEntry, ref.f5.by_entry, 'F5 per-entry violation counts');
      cmpTrace(f.traces[0], ref.f5.rollout0, 'F5 rollout 0');
    }
  }
  // calibration (R1.12): ACT ticks 0-39 + OBSERVE ticks with the selected fix (F5)
  const ticks = [...act1, ...act2, ...observe.F5];
  const pay = calibrate(world.model, ticks, 'payments');
  assert.equal(Number(pay.cap_mean.toFixed(1)), exp('R1_12_payments_cap_mean'));
  assert.equal(pay.n, exp('R1_12_payments_n'));
  assert.equal(Number(pay.se.toFixed(1)), exp('R1_12_payments_se'));
  assert.equal(Number((pay.cap_sd * pay.cap_mean).toFixed(1)), exp('R1_12_payments_cap_sd_abs'));
  assert.equal(calibrate(world.model, ticks, 'ledger-db'), exp('R1_12_ledger_db_result'));
});

test('7. twin and world are distinct model/execution contexts', async () => {
  const twin = await Twin.open(db), world = await World.open(db);
  assert.notEqual(twin.model, world.model);
  assert.equal(twin.model.svc.payments.cap, 800);
  assert.equal(world.model.svc.payments.cap, 704);
  assert.equal(twin.model.svc.payments.sd, 0.15);
  assert.ok(Object.values(world.model.svc).every((s) => s.sd === 0));
  assert.throws(() => new Twin(world.model), /requires the 'twin' graph/);
  assert.throws(() => new World(twin.model), /requires the 'world' graph/);
  const twinBefore = structuredClone(twin.model);
  world.advance({ ticks: 30, seed: 7, faults: ['degrade:ledger-db'] });
  world.withInterventions(HARD).advance({ ticks: 10, seed: 8 });
  twin.ensemble({ state0: world.snapshotState(), interventions: HARD, tOff: 0, horizon: 10, tag: 102, n: 2 });
  assert.deepEqual(twin.model, twinBefore, 'running the world or twin ensembles never mutates the twin model');
  assert.equal(world.model.edges.find((e) => e.key === 'checkout>payments').retries, 3, 'withInterventions does not mutate the live world');
  assert.equal(world.tick, 30);
  // the twin only ever sees world state through an explicit copy
  const snap = world.snapshotState();
  snap.q.payments = -1;
  assert.notEqual(world.state.q.payments, -1);
  // the graphs themselves are unchanged by simulation (no ticks written to the graph)
  assert.deepEqual((await loadSimModel(db, 'twin')).svc, twinBefore.svc);
});

test('8. cyclic call graphs are handled by the lagged-edge rule (spec §7.9)', () => {
  const svc = (name, entry, ext) => ({ name, entry, ext_rps: ext, cap_mean: 100, cap_sd: 0, base_ms: 10, queue_s: 2, shed: 0, q_est: 0 });
  const call = (caller, callee) => ({ caller, callee, fanout: 1, retries: 1, timeout_ms: 300, breaker: false, trip_p: 0.5,
    trip_ticks: 5, cooldown: 10, p_est: 0, hot_est: 0, open_ticks_est: 0 });
  const m = buildModel({
    graph: 'test-cycle',
    services: [svc('a', true, 50), svc('b', false, 0), svc('c', false, 0)],
    calls: [call('a', 'b'), call('b', 'c'), call('c', 'b')],
    changeEvents: [], faults: [], interventions: [],
    round: { slo_goodput: 0.99, slo_latency_ms: 800, slo_width_ms: 80, arrival_noise: 0.05, obs_noise: 0.05 },
  });
  assert.deepEqual(m.lagged, ['c>b']);
  assert.deepEqual(m.order, ['a', 'b', 'c']);
  const { trace } = rollout(m, initialState(m), [], Infinity, 200, 1);
  assert.equal(trace.length, 200);
  assert.ok(trace.every((o) => Object.values(o.gp).every(Number.isFinite)), 'no NaN/Infinity over 200 ticks');
});

// Round-2 world counterfactual (spec R2.6, R2.8; reproduce.py G0/G3): the same round-2 attack on the same
// R1-hardened world, from the same healthy state, with the same seed — once without the round-2 fix (G0) and
// once with it (G3). The demo's finale only ever runs the hardened world, so this is the evidence that the
// hardening, not the seed or the start state, is what turns 89 violated ticks into 0.
test('9. round 2 world check: the attack on the unhardened world vs the hardened world, same state and seed (R2.6, R2.8)', async () => {
  const SCEN = ['degrade:ledger-db', 'deploy:CE-42'];
  const run = (ivs, faults) => World.open(db).then((w) => w.withInterventions([...HARD, ...ivs]).advance({ ticks: 90, seed: 77, faults, tOff: 30 }));
  const viol = (tr) => tr.filter((o) => o.viol).length;
  const healed = (tr) => !tr.slice(-SHAPE.RECOVERY_WINDOW).some((o) => o.viol);
  const g0 = await run([], SCEN);
  const g3 = await run(['scale_out:ledger-db'], SCEN);
  // G0: do nothing — the cascade runs the whole horizon and is still violated after the trigger is removed at tick 30
  assert.equal(viol(g0), exp('G0_world_viol'));                                                       // 89 of 90
  assert.ok(g0.slice(30).every((o) => o.faults.length === 0), 'the transient trigger is removed at tick 30');
  assert.equal(healed(g0), false, 'the unhardened world never recovers');
  // G3: the committed fix (scale_out:ledger-db) on the identical world, state and seed — the finale's 0 violated ticks
  assert.equal(viol(g3), exp('G3_world_viol'));                                                       // 0 of 90
  assert.ok(healed(g3));
  assert.equal(viol(g0) - viol(g3), exp('G0_world_viol') - exp('G3_world_viol'), 'violations prevented by the fix');
  // comparable initial conditions: the two worlds differ in exactly one model parameter, ledger-db capacity × 1.5
  const base = await World.open(db);
  const [u, h] = [base.withInterventions(HARD), base.withInterventions([...HARD, 'scale_out:ledger-db'])];
  assert.deepEqual(u.snapshotState(), h.snapshotState(), 'same start state');
  assert.equal(h.model.svc['ledger-db'].cap, u.model.svc['ledger-db'].cap * 1.5);
  for (const s of Object.keys(u.model.svc).filter((n) => n !== 'ledger-db')) assert.equal(h.model.svc[s].cap, u.model.svc[s].cap, s);
  assert.deepEqual(g0.map((o) => o.t), g3.map((o) => o.t), 'same 90 ticks');
  // R2.8: the slowdown alone, without the deploy, is a transient cost that heals — the deploy makes the pair metastable
  const alone = await run([], ['degrade:ledger-db']);
  assert.equal(viol(alone), exp('R2_8_world_trigger_alone_viol'));                                   // 32
  assert.equal(healed(alone), exp('R2_8_world_trigger_alone_recovered'));                            // true
});
