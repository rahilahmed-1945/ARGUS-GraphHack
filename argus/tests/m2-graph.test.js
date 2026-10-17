// M2 acceptance: FalkorDB schema + seed (spec §5, §6.1, §6.3, §8.1; build-readiness Phase 2).
// Requires the pinned FalkorDB (`npm run db:up`). Every test starts from a fresh reset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, rows, roRows, GRAPHS } from '../graph/db.js';
import { reset } from '../graph/reset.js';
import { loadTopology, seedFor } from '../graph/topology.js';
import { loadModel } from '../graph/load-model.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const topo = loadTopology();
let db;

before(async () => { db = await connect(); await reset(db); });
after(async () => { await db.close(); });

const count = async (g, cypher) => (await roRows(db, g, cypher))[0].n;
const byKey = (list, key) => Object.fromEntries(list.map((x) => [key(x), x]));

// Full, id-independent dump of a graph: every node and relationship with labels/types and properties.
async function dumpGraph(g) {
  const nodes = await roRows(db, g, `MATCH (n) RETURN labels(n) AS labels, properties(n) AS props`);
  const rels = await roRows(db, g, `MATCH (a)-[r]->(b) RETURN type(r) AS type, properties(r) AS props,
      labels(a) AS al, coalesce(a.name, a.id, toString(a.n)) AS ak, labels(b) AS bl, coalesce(b.name, b.id, toString(b.n)) AS bk`);
  const canon = (x) => JSON.stringify(x, Object.keys(x).sort());
  return {
    nodes: nodes.map((n) => JSON.stringify([n.labels, canon(n.props)])).sort(),
    rels: rels.map((r) => JSON.stringify([r.type, r.al, r.ak, r.bl, r.bk, canon(r.props)])).sort(),
  };
}

function referenceModel(kind) {
  return JSON.parse(execFileSync('python', [`${ROOT}sim/reference/dump_base_model.py`, kind], { encoding: 'utf8' }));
}

test('1. reset is deterministic and recreates twin + world from scratch (also removes fork:* graphs)', async () => {
  const first = { twin: await dumpGraph('twin'), world: await dumpGraph('world') };
  await db.selectGraph('twin').copy('fork:R0:leftover');
  assert.ok((await db.list()).includes('fork:R0:leftover'));
  const t0 = performance.now();
  await reset(db);
  const ms = performance.now() - t0;
  const second = { twin: await dumpGraph('twin'), world: await dumpGraph('world') };
  assert.deepEqual(second, first, 'graph content differs between two resets');
  const graphs = (await db.list()).filter((g) => g === 'twin' || g === 'world' || g.startsWith('fork:')).sort();
  assert.deepEqual(graphs, ['twin', 'world']);
  assert.ok(ms < 2000, `reset took ${ms.toFixed(0)} ms (spec: < 2 s)`);
});

for (const g of [GRAPHS.twin, GRAPHS.world]) {
  test(`2. ${g}: exactly the expected nodes and relationships`, async () => {
    const labelCounts = await roRows(db, g, `MATCH (n) RETURN labels(n)[0] AS l, count(n) AS n ORDER BY l`);
    assert.deepEqual(Object.fromEntries(labelCounts.map((r) => [r.l, r.n])),
      { ChangeEvent: 2, Fault: 10, Intervention: 27, Round: 1, Service: 8 });
    const relCounts = await roRows(db, g, `MATCH ()-[r]->() RETURN type(r) AS t, count(r) AS n ORDER BY t`);
    assert.deepEqual(Object.fromEntries(relCounts.map((r) => [r.t, r.n])),
      { APPLIES_TO: 37, BLOCKS: 2, CALLS: 9, LANDS: 2, MODIFIES: 2 });
    const faultKinds = await roRows(db, g, `MATCH (f:Fault) RETURN f.kind AS k, count(f) AS n ORDER BY k`);
    assert.deepEqual(Object.fromEntries(faultKinds.map((r) => [r.k, r.n])), { cap_degrade: 6, deploy: 2, surge: 2 });
    const ivKinds = await roRows(db, g, `MATCH (i:Intervention) RETURN i.kind AS k, count(i) AS n ORDER BY k`);
    assert.deepEqual(Object.fromEntries(ivKinds.map((r) => [r.k, r.n])),
      { block_deploy: 2, breaker: 9, cap_retries: 2, retries_off: 6, scale_out: 6, shed: 2 });
    // spec §3 count test: 55 scenarios of <= 2 faults; 376 futures of <= 2 interventions
    // (pairs putting both retries_off and cap_retries on the same edge are excluded).
    assert.equal(await count(g, `MATCH (f:Fault) WITH count(f) AS k RETURN k + k*(k-1)/2 AS n`), 55);
    assert.equal(await count(g, `
      MATCH (a:Intervention), (b:Intervention) WHERE a.id < b.id
        AND NOT (a.caller IS NOT NULL AND a.caller = b.caller AND a.callee = b.callee
                 AND ((a.kind = 'retries_off' AND b.kind = 'cap_retries') OR (a.kind = 'cap_retries' AND b.kind = 'retries_off')))
      WITH count(*) AS pairs MATCH (i:Intervention) WITH pairs, count(i) AS singles RETURN pairs + singles AS n`), 376);
    // (FalkorDB 6.0.1 returns null for `RETURN pairs + count(i)`; aggregating in a WITH first works.)
  });

  test(`3. ${g}: seeded topology equals topology.yaml exactly`, async () => {
    const seed = seedFor(topo, g);
    const m = await loadModel(db, g);
    const svcCols = Object.keys(seed.services[0]);
    assert.deepEqual(m.services, [...seed.services].sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => Object.fromEntries(svcCols.map((c) => [c, s[c]]))).map((s) => ({ ...s })));
    const callCols = Object.keys(seed.calls[0]);
    assert.deepEqual(
      m.calls.map((c) => Object.fromEntries(callCols.map((k) => [k, c[k]]))),
      [...seed.calls].sort((a, b) => (a.caller + '>' + a.callee).localeCompare(b.caller + '>' + b.callee))
        .map((c) => Object.fromEntries(callCols.map((k) => [k, c[k]]))));
    assert.deepEqual(m.changeEvents, [...seed.changeEvents].sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, caller, callee, field, new_value, status }) => ({ id, caller, callee, field, new_value, status })));
    const { n, ...roundRest } = m.round;
    assert.deepEqual({ n, ...roundRest }, topo.round);
  });

  test(`4. ${g}: every simulator parameter in the graph equals the verbatim reference simulator (base_model('${g}'))`, async () => {
    const ref = referenceModel(g);
    const m = await loadModel(db, g);
    const svc = byKey(m.services, (s) => s.name);
    assert.deepEqual(Object.keys(svc).sort(), Object.keys(ref.svc).sort());
    for (const [name, r] of Object.entries(ref.svc)) {
      const s = svc[name];
      assert.deepEqual(
        { ext: s.ext_rps, cap: s.cap_mean, base: s.base_ms, sd: s.cap_sd, qmax_s: s.queue_s, shed: s.shed },
        { ext: r.ext, cap: r.cap, base: r.base, sd: r.sd, qmax_s: r.qmax_s, shed: r.shed }, `service ${name}`);
    }
    const edges = byKey(m.calls, (c) => `${c.caller}>${c.callee}`);
    assert.deepEqual(Object.keys(edges).sort(), Object.keys(ref.edges).sort());
    for (const [key, r] of Object.entries(ref.edges)) {
      const e = edges[key];
      assert.deepEqual(
        { fanout: e.fanout, retries: e.retries, timeout: e.timeout_ms, breaker: e.breaker, trip_p: e.trip_p, trip_ticks: e.trip_ticks, cooldown: e.cooldown },
        r, `edge ${key}`);
    }
    const ces = byKey(m.changeEvents, (c) => c.id);
    assert.deepEqual(Object.keys(ces).sort(), Object.keys(ref.ces).sort());
    for (const [id, r] of Object.entries(ref.ces)) {
      assert.deepEqual({ edge: [ces[id].caller, ces[id].callee], retries: ces[id].new_value, status: ces[id].status }, r, `change event ${id}`);
    }
    // mag: Fault.magnitude per id prefix (degrade, surge), one value per kind
    const mag = {};
    for (const f of m.faults.filter((x) => x.magnitude !== null)) {
      const prefix = f.id.split(':')[0];
      assert.ok(mag[prefix] === undefined || mag[prefix] === f.magnitude, `inconsistent magnitude for ${prefix}`);
      mag[prefix] = f.magnitude;
    }
    assert.deepEqual(mag, ref.mag);
    const fac = {};
    for (const i of m.interventions.filter((x) => x.factor !== null)) {
      assert.ok(fac[i.kind] === undefined || fac[i.kind] === i.factor, `inconsistent factor for ${i.kind}`);
      fac[i.kind] = i.factor;
    }
    assert.deepEqual(fac, ref.fac);
    assert.deepEqual(Object.fromEntries(Object.keys(ref.rnd).map((k) => [k, m.round[k]])), ref.rnd);
  });

  test(`5. ${g}: no null properties where the spec requires explicit values`, async () => {
    const m = await loadModel(db, g);
    for (const s of m.services) for (const [k, v] of Object.entries(s)) assert.notEqual(v, null, `Service ${s.name}.${k}`);
    for (const c of m.calls) for (const [k, v] of Object.entries(c)) assert.notEqual(v, null, `CALLS ${c.caller}>${c.callee}.${k}`);
    for (const c of m.changeEvents) for (const [k, v] of Object.entries(c)) assert.notEqual(v, null, `ChangeEvent ${c.id}.${k}`);
    for (const [k, v] of Object.entries(topo.round)) assert.equal(m.round[k], v, `Round.${k}`);
    // Fault / Intervention: every parameter declared for that kind in topology.yaml is present and equal.
    for (const f of m.faults) {
      const p = topo.faults[f.kind];
      for (const k of ['magnitude', 'persistence', 'cost_to_attacker']) if (k in p) assert.equal(f[k], p[k], `${f.id}.${k}`);
      assert.ok(f.id.startsWith(`${p.id_prefix}:`), `${f.id} prefix`);
    }
    for (const i of m.interventions) {
      const p = topo.interventions[i.kind];
      for (const k of ['cost', 'factor']) if (k in p) assert.equal(i[k], p[k], `${i.id}.${k}`);
    }
  });

  test(`6. ${g}: indexes exist and the CALLS graph is a DAG`, async () => {
    const idx = await roRows(db, g, `CALL db.indexes() YIELD label, properties RETURN label, properties ORDER BY label`);
    assert.deepEqual(idx.map((r) => `${r.label}.${r.properties.join(',')}`),
      topo.indexes.map((i) => `${i.label}.${i.property}`).sort());
    assert.equal(await count(g, `MATCH p = (a:Service)-[:CALLS*1..8]->(a) RETURN count(p) AS n`), 0);
  });
}

test('7. world differs from twin exactly by topology.yaml world_overrides (payments cap_mean, all cap_sd)', async () => {
  const [t, w] = [await loadModel(db, 'twin'), await loadModel(db, 'world')];
  const diffs = [];
  const cmp = (a, b, path) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${path}.${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
    }
  };
  t.services.forEach((s, i) => cmp(s, w.services[i], `Service ${s.name}`));
  t.calls.forEach((c, i) => cmp(c, w.calls[i], `CALLS ${c.caller}>${c.callee}`));
  t.changeEvents.forEach((c, i) => cmp(c, w.changeEvents[i], `CE ${c.id}`));
  t.faults.forEach((f, i) => cmp(f, w.faults[i], `Fault ${f.id}`));
  t.interventions.forEach((x, i) => cmp(x, w.interventions[i], `Intervention ${x.id}`));
  cmp(t.round, w.round, 'Round');
  const expected = [];
  for (const s of t.services) {
    const o = { ...topo.world_overrides.all_services, ...(topo.world_overrides.services[s.name] ?? {}) };
    for (const [k, v] of Object.entries(o)) if (s[k] !== v) expected.push(`Service ${s.name}.${k}: ${JSON.stringify(s[k])} -> ${JSON.stringify(v)}`);
  }
  assert.deepEqual(diffs.sort(), expected.sort());
  assert.ok(diffs.includes('Service payments.cap_mean: 800 -> 704'));
});

test('8. spec queries run on the seeded twin: amplifier (§6.4) and PageRank (§6.7)', async () => {
  const amp = await roRows(db, 'twin', `
    MATCH p = (e:Service {entry:true})-[:CALLS*1..5]->(s:Service)
    WITH p, e, s, nodes(p) AS ns, relationships(p) AS rs
    WITH p, s, reduce(L = toFloat(e.ext_rps), i IN range(0, size(rs)-1) |
           (CASE WHEN L > ns[i].cap_mean THEN ns[i].cap_mean ELSE L END)
           * rs[i].fanout
           * (CASE WHEN rs[i].breaker THEN 1 ELSE 1 + rs[i].retries END)
         ) AS worst_load
    WITH p, s, worst_load / s.cap_mean AS overload
    WHERE overload >= $min_risk
    MATCH q = (s)-[:CALLS*0..4]->(d:Service)<-[:APPLIES_TO]-(f:Fault)
    WITH p, s, overload, f, min(length(q)) - 1 AS hops
    ORDER BY overload DESC, hops, f.id
    RETURN [n IN nodes(p) | n.name] AS amplifier, s.name AS target, overload,
           collect(f.id + '@' + toString(hops)) AS triggers
    LIMIT 5`, { min_risk: 2 });
  assert.equal(amp.length, 1);
  assert.deepEqual(amp[0], { amplifier: ['gateway', 'checkout', 'payments'], target: 'payments', overload: 4.5,
    triggers: ['degrade:payments@0', 'degrade:ledger-db@1'] });
  const pr = await roRows(db, 'twin', `CALL algo.pageRank('Service', 'CALLS') YIELD node, score RETURN node.name AS s, score ORDER BY score DESC, s`);
  assert.equal(pr[0].s, 'ledger-db');
  assert.equal(Number(pr[0].score.toFixed(3)), 0.220);
});

test('9. no seed topology/configuration is duplicated in runtime JavaScript', () => {
  const values = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    else values.add(x);
  };
  walk({ services: topo.services, calls: topo.calls, change_events: topo.change_events, world_overrides: topo.world_overrides,
         faults: topo.faults, interventions: topo.interventions, round: topo.round });
  // Literals that are schema/identity, not configuration: booleans, 0-2, and kind/label/enum strings
  // that the spec's rule queries name structurally.
  const structural = new Set(['pending', 'transient', 'persistent', 'retries', 'stage', 'degrade', 'surge', 'deploy']);
  const needles = [...values].filter((v) => (typeof v === 'number' && !(Number.isInteger(v) && v >= 0 && v <= 2))
    || (typeof v === 'string' && !structural.has(v)));
  const offenders = [];
  for (const dir of ['graph']) {
    for (const file of readdirSync(`${ROOT}${dir}`).filter((f) => f.endsWith('.js'))) {
      const code = readFileSync(`${ROOT}${dir}/${file}`, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const v of needles) {
        const re = typeof v === 'number' ? new RegExp(`(?<![\\w.])${String(v).replace('.', '\\.')}(?![\\w.])`) : new RegExp(`['"\`]${v}['"\`]`);
        if (re.test(code)) offenders.push(`${dir}/${file}: ${JSON.stringify(v)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
