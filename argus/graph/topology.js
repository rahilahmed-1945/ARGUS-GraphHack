// Loads config/topology.yaml (the single source of seed data) and derives the twin and world variants.
// No topology values live in this file: everything is read from the YAML.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

export const TOPOLOGY_PATH = fileURLToPath(new URL('../config/topology.yaml', import.meta.url));

export function loadTopology(path = TOPOLOGY_PATH) {
  const topo = parseYaml(readFileSync(path, 'utf8'));
  for (const key of ['services', 'calls', 'change_events', 'initial_state', 'world_overrides', 'faults', 'interventions', 'round', 'indexes']) {
    if (topo[key] === undefined || topo[key] === null) throw new Error(`topology.yaml: missing section '${key}'`);
  }
  return topo;
}

// Rows ready for ingest into one graph ('twin' or 'world').
export function seedFor(topo, variant) {
  if (variant !== 'twin' && variant !== 'world') throw new Error(`unknown graph variant '${variant}'`);
  const overrides = variant === 'world' ? topo.world_overrides : { all_services: {}, services: {} };
  const services = topo.services.map((s) => ({
    ...s,
    ...topo.initial_state.service,
    ...(overrides.all_services ?? {}),
    ...((overrides.services ?? {})[s.name] ?? {}),
  }));
  const calls = topo.calls.edges.map((e) => ({ ...topo.calls.defaults, ...topo.initial_state.calls, ...e }));
  return { services, calls, changeEvents: topo.change_events, round: topo.round };
}
