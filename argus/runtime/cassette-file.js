// Cassette file format (spec §14.3; format TBD #17 → this document):
// {
//   "format": "argus.cassette/v1",
//   "key": "sha256(canonical {role, round, turn, history})",   // runtime.js cassetteKey; no timings anywhere
//   "source": "<free text: which model/provider produced the decisions>",
//   "entries": { "<key>": <decision: {tool,args} | {calls:[...]} | {unusable:...}> , ... }   // keys sorted
//   "provenance": { "live": bool, "provider", "model", "ceiling_ms", "phases": [{role, round, proposedBy, takeover, turns}],
//                   "late_decisions": n }                                                      // optional (live recordings)
// }
// A decision is what the agent adapter returned for that observation (already mapped from the provider's
// tool calls), so replay never contacts a provider. Keys cover every role and round of a run. `entries` holds
// only decisions the run actually used: a reply that arrived after a takeover is counted in
// provenance.late_decisions and never stored (runtime.js createCassette), so replay takes over at that turn too.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCassette } from './runtime.js';

export const CASSETTE_FORMAT = 'argus.cassette/v1';

export function saveCassette(path, cassette, { source, provenance = null }) {
  const entries = cassette.toJSON();
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ format: CASSETTE_FORMAT, key: 'sha256(canonical {role, round, turn, history})', source,
    ...(provenance ? { provenance } : {}), entries: sorted }, null, 2)}\n`);
  return Object.keys(sorted).length;
}

export function loadCassette(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.format !== CASSETTE_FORMAT) throw new Error(`${path}: not an ${CASSETTE_FORMAT} file`);
  return { cassette: createCassette(data.entries), source: data.source, size: Object.keys(data.entries).length, provenance: data.provenance ?? null };
}

// One line per phase of a run, e.g. "R1 RED llm · R1 BLUE b5 (turn_ceiling)": who decided, and why B5 if it did.
export const phaseSummary = (phases = []) => phases.map((p) => `R${p.round} ${String(p.role).toUpperCase()} ${p.proposedBy}${p.takeover ? ` (${p.takeover.reason})` : ''}`).join(' · ');
