// npm run reset — spec §2.6 / §14.7: delete all graphs (world, twin, fork:*), load the seed,
// regenerate the action-space rules. Target: under 2 s.
import { pathToFileURL } from 'node:url';
import { connect, GRAPHS, FORK_PREFIX } from './db.js';
import { loadTopology, seedFor } from './topology.js';
import { createIndexes, ingestSeed, runActionSpaceRules } from './schema.js';

export async function reset(db, topo = loadTopology()) {
  const existing = await db.list();
  for (const name of existing) {
    if (name === GRAPHS.world || name === GRAPHS.twin || name.startsWith(FORK_PREFIX)) {
      await db.selectGraph(name).delete();
    }
  }
  // Both graphs get the same structure, rules and Round node (build-readiness decision A#2),
  // so loadModel(graph) is single-graph for every graph. They differ only by topology.yaml world_overrides.
  for (const variant of ['twin', 'world']) {
    const name = GRAPHS[variant];
    await createIndexes(db, name, topo.indexes);
    await ingestSeed(db, name, seedFor(topo, variant));
    await runActionSpaceRules(db, name, topo);
  }
  return { deleted: existing.filter((n) => n === GRAPHS.world || n === GRAPHS.twin || n.startsWith(FORK_PREFIX)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t0 = performance.now();
  const db = await connect();
  try {
    const { deleted } = await reset(db);
    const ms = performance.now() - t0;
    console.log(`reset ok in ${ms.toFixed(0)} ms (deleted: ${deleted.join(', ') || 'none'}; created: ${GRAPHS.twin}, ${GRAPHS.world})`);
  } finally {
    await db.close();
  }
}
