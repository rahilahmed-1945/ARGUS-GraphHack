// M4 acceptance: counterfactual futures as real FalkorDB graph forks (spec §4.2–4.4, §6.13–6.18, §9).
// Requires the pinned FalkorDB (`npm run db:up`). Starts from a fresh reset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, rows, roRows } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { writeScenario, writeSnapshot } from '../graph/records.js';
import { runFuture, readFuture, listForks, cleanupForks, futureId } from '../graph/forks.js';
import { loadModel } from '../graph/load-model.js';
import { World, Twin } from '../sim/contexts.js';
import { dumpGraph, dumpDiff } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXPECTED = JSON.parse(readFileSync(`${ROOT}sim/reference/expected.json`, 'utf8'));
const exp = (key) => EXPECTED[key].expected;
const HARD = ['retries_off:gateway>checkout', 'retries_off:checkout>payments'];
const R1 = {
  F0: [], F1: ['scale_out:payments'], F2: ['scale_out:ledger-db'], F3: ['retries_off:checkout>payments'],
  F4: ['breaker:checkout>payments'], F5: HARD, R1_13: ['cap_retries:gateway>checkout', 'retries_off:checkout>payments'],
};
let db, snapshotId, worldState40;

// Fresh reset → round-1 world ACT (trigger, then removed) → Scenario S:R1 + tick-40 Snapshot on the twin.
async function setupRound1() {
  await reset(db);
  const world = await World.open(db);
  world.advance({ ticks: 30, seed: 7, faults: ['degrade:ledger-db'] });
  world.advance({ ticks: 10, seed: 8 });
  worldState40 = world.snapshotState();
  await writeScenario(db, { id: 'S:R1', round: 1, faultIds: ['degrade:ledger-db'] });
  snapshotId = await writeSnapshot(db, { round: 1, tick: 40, state: worldState40 });
  return world;
}
const future = (label, interventionIds, extra = {}) =>
  runFuture(db, { scenarioId: 'S:R1', label, interventionIds, mode: 'reactive', snapshotId, ...extra });

before(async () => { db = await connect(); await setupRound1(); });
after(async () => { await cleanupForks(db); await db.close(); });

test('1. fork creation: GRAPH.COPY creates fork:R1:<label> and a Future is recorded on the twin', async () => {
  const f = await future('T1', [], { retainFork: true });
  assert.equal(f.id, 'fork:R1:T1');
  assert.equal(f.graph, 'fork:R1:T1');
  assert.ok((await listForks(db)).includes('fork:R1:T1'));
  const linked = await roRows(db, 'twin', `
    MATCH (sc:Scenario {id:'S:R1'})-[:PRODUCES]->(fu:Future {id:'fork:R1:T1'})-[:FROM]->(s:Snapshot {id:$snap})
    RETURN count(fu) AS n`, { snap: snapshotId });
  assert.equal(linked[0].n, 1);
  await cleanupForks(db);
});

test('2. a fork contains the complete twin state the simulator needs (config + snapshot)', async () => {
  const twinBefore = await dumpGraph(db, 'twin');
  await future('T2', [], { retainFork: true });
  const fork = await dumpGraph(db, 'fork:R1:T2');
  assert.deepEqual(fork, twinBefore, 'fork is an exact copy of the twin at fork time');
  const [mf, mt] = [await loadModel(db, 'fork:R1:T2'), await loadModel(db, 'twin')];
  for (const k of ['services', 'calls', 'changeEvents', 'faults', 'interventions', 'round']) assert.deepEqual(mf[k], mt[k], k);
  assert.ok(mf.services.find((s) => s.name === 'payments').q_est > 0, 'snapshot state (q_est) is in the fork');
  await cleanupForks(db);
});

test('3. mutating a fork does not affect the twin', async () => {
  const twinBefore = await dumpGraph(db, 'twin');
  await future('T3', [], { retainFork: true });
  const afterFuture = await dumpGraph(db, 'twin');
  await rows(db, 'fork:R1:T3', `MATCH (s:Service) SET s.cap_mean = 1, s.q_est = 0`);
  await rows(db, 'fork:R1:T3', `MATCH ()-[c:CALLS]->() SET c.retries = 9`);
  await rows(db, 'fork:R1:T3', `MATCH (f:Fault) DETACH DELETE f`);
  assert.deepEqual(await dumpGraph(db, 'twin'), afterFuture);
  // the only twin change caused by running the future is its (:Future) record and its edges
  const d = dumpDiff(twinBefore, afterFuture);
  assert.deepEqual(d.removed, []);
  assert.ok(d.added.every((x) => x.includes('Future') || x.includes('fork:R1:T3')), JSON.stringify(d.added));
  await cleanupForks(db);
});

test('4. applying interventions changes only the fork, exactly where the template says', async () => {
  const twinBefore = await dumpGraph(db, 'twin');
  await future('T4', HARD, { retainFork: true });
  const fork = await dumpGraph(db, 'fork:R1:T4');
  const d = dumpDiff(twinBefore, fork);
  const touched = (x) => JSON.parse(x).slice(0, 5).join(' ');
  assert.deepEqual(d.removed.map(touched).sort(), ['CALLS Service checkout Service payments', 'CALLS Service gateway Service checkout']);
  assert.deepEqual(d.added.map(touched).sort(), ['CALLS Service checkout Service payments', 'CALLS Service gateway Service checkout']);
  const retries = await roRows(db, 'fork:R1:T4', `MATCH (a:Service)-[c:CALLS]->(b:Service) WHERE a.name+'>'+b.name IN ['gateway>checkout','checkout>payments'] RETURN c.retries AS r`);
  assert.deepEqual(retries.map((x) => x.r), [0, 0]);
  const twinRetries = await roRows(db, 'twin', `MATCH (a:Service {name:'checkout'})-[c:CALLS]->(b:Service {name:'payments'}) RETURN c.retries AS r`);
  assert.equal(twinRetries[0].r, 3, 'twin unchanged');
  // other intervention kinds edit the right element on their fork only
  for (const [label, iv, q, want] of [
    ['T4b', ['scale_out:ledger-db'], `MATCH (s:Service {name:'ledger-db'}) RETURN s.cap_mean AS v`, 825],
    ['T4c', ['breaker:orders>ledger-db'], `MATCH (:Service {name:'orders'})-[c:CALLS]->(:Service {name:'ledger-db'}) RETURN c.breaker AS v`, true],
    ['T4d', ['block_deploy:CE-42'], `MATCH (c:ChangeEvent {id:'CE-42'}) RETURN c.status AS v`, 'blocked'],
  ]) {
    await future(label, iv, { retainFork: true });
    assert.equal((await roRows(db, futureId(1, label), q))[0].v, want, `${label} fork`);
    assert.notEqual((await roRows(db, 'twin', q))[0].v, want, `${label} twin unchanged`);
  }
  await cleanupForks(db);
});

test('5. rollout results are deterministic and recorded futures are reused, not recomputed', async () => {
  const a = await future('T5a', HARD);
  const b = await future('T5b', HARD);
  for (const k of ['p_recover', 'viol_ticks_p50', 'p10', 'p90', 'viol', 'viol_by_entry', 'bands', 'cost', 'verdict', 'tag']) assert.deepEqual(a[k], b[k], k);
  const again = await future('T5a', HARD);
  assert.equal(again.reused, true);
  assert.deepEqual({ ...again, reused: false }, a);
  assert.deepEqual(await listForks(db), [], 'no fork created for a reused future');
  // and identical to the in-memory twin ensemble on the same snapshot (M3)
  const twin = await Twin.open(db);
  const mem = twin.ensemble({ state0: worldState40, interventions: HARD, tOff: 0, horizon: 60, tag: a.tag, n: a.n });
  assert.deepEqual(a.viol, mem.viol);
});

test('6. multiple forks remain isolated from each other', async () => {
  await future('T6a', ['breaker:checkout>payments'], { retainFork: true });
  await future('T6b', ['scale_out:payments'], { retainFork: true });
  const q = {
    breaker: `MATCH (:Service {name:'checkout'})-[c:CALLS]->(:Service {name:'payments'}) RETURN c.breaker AS v`,
    cap: `MATCH (s:Service {name:'payments'}) RETURN s.cap_mean AS v`,
  };
  const val = async (g, k) => (await roRows(db, g, q[k]))[0].v;
  assert.deepEqual([await val('fork:R1:T6a', 'breaker'), await val('fork:R1:T6a', 'cap')], [true, 800]);
  assert.deepEqual([await val('fork:R1:T6b', 'breaker'), await val('fork:R1:T6b', 'cap')], [false, 1200]);
  await rows(db, 'fork:R1:T6a', `MATCH (s:Service {name:'payments'}) SET s.cap_mean = 5`);
  assert.equal(await val('fork:R1:T6b', 'cap'), 1200);
  assert.equal(await val('twin', 'cap'), 800);
  await cleanupForks(db);
});

test('7. cleanup: forks are deleted after recording, on failure, and by cleanupForks/reset', async () => {
  const twinBefore = await dumpGraph(db, 'twin');
  const worldBefore = await dumpGraph(db, 'world');
  // default lifecycle ends with GRAPH.DELETE
  await future('T7a', ['scale_out:ledger-db']);
  assert.deepEqual(await listForks(db), []);
  // failure after GRAPH.COPY: the fork is deleted and no Future is recorded
  let seen;
  await assert.rejects(future('T7b', HARD, { onForked: async (g) => { seen = g; throw new Error('injected failure'); } }), /injected failure/);
  assert.equal(seen, 'fork:R1:T7b');
  assert.deepEqual(await listForks(db), []);
  assert.equal(await readFuture(db, 'fork:R1:T7b'), null);
  // failure inside the fork (a template that cannot apply): fork deleted, nothing recorded
  await assert.rejects(future('T7c', [], { onForked: async (g) => { await rows(db, g, `MATCH (s:Service) DETACH DELETE s`); } }), /no services/);
  assert.deepEqual(await listForks(db), []);
  assert.equal(await readFuture(db, 'fork:R1:T7c'), null);
  // invalid requests are rejected before any fork is created
  await assert.rejects(future('T7d', ['retries_off:redis>db']), /not in graph/);
  await assert.rejects(future('T7e', ['retries_off:checkout>payments', 'cap_retries:checkout>payments']), /same edge/);
  await assert.rejects(future('T7f', ['scale_out:auth', 'scale_out:orders', 'scale_out:payments']), /at most 2/);
  assert.deepEqual(await listForks(db), []);
  // the only twin change is the one recorded Future; the world is untouched
  const d = dumpDiff(twinBefore, await dumpGraph(db, 'twin'));
  assert.deepEqual(d.removed, []);
  assert.ok(d.added.length > 0 && d.added.every((x) => x.includes('fork:R1:T7a')), JSON.stringify(d.added));
  assert.deepEqual(await dumpGraph(db, 'world'), worldBefore);
  // retained forks are removed by cleanupForks(round) and by reset
  await future('T7g', [], { retainFork: true });
  assert.deepEqual(await cleanupForks(db, 1), ['fork:R1:T7g']);
  await future('T7h', [], { retainFork: true });
  await setupRound1();
  assert.deepEqual(await listForks(db), []);
});

test('8. canonical F0–F5 (and the single-layer option) reproduce through real forks', async () => {
  const world = await setupRound1();
  const worldBefore = await dumpGraph(db, 'world');
  for (const [label, ivs] of Object.entries(R1)) {
    const f = await future(label, ivs);
    const actual = { [`${label}_p_recover`]: f.p_recover, [`${label}_median`]: f.viol_ticks_p50, [`${label}_p10_p90`]: [f.p10, f.p90],
      [`${label}_entry_median_gw_mgw`]: [f.viol_by_entry.gateway, f.viol_by_entry['mobile-gw']].map((v) => {
        const s = [...v].sort((x, y) => x - y); return (s[7] + s[8]) / 2; }) };
    for (const [k, v] of Object.entries(actual)) if (k in EXPECTED) assert.deepEqual(v, exp(k), k);
    // enough recorded to compare predicted vs observed later: the world check for the same intervention
    const wc = world.withInterventions(ivs).advance({ ticks: f.horizon, seed: 99, tOff: 0 });
    if (`${label}_world_viol` in EXPECTED) assert.equal(wc.filter((o) => o.viol).length, exp(`${label}_world_viol`), `${label}_world_viol`);
    assert.equal(f.bands.p50.length, f.horizon);
    assert.deepEqual(f.interventions, [...ivs].sort());
  }
  const verdicts = Object.fromEntries((await roRows(db, 'twin', `MATCH (f:Future) RETURN f.label AS l, f.verdict AS v`)).map((r) => [r.l, r.v]));
  assert.deepEqual(verdicts, { F0: 'red', F1: 'red', F2: 'red', F3: 'red', F4: 'amber', F5: 'green', R1_13: 'green' });
  assert.deepEqual(await listForks(db), []);
  assert.deepEqual(await dumpGraph(db, 'world'), worldBefore, 'futures never touch the world graph');
});
