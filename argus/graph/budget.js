// Graph-held, charge-once budgets (spec §5 / §11.3, §6.11).
// Every budgeted call is charged once per logical call, keyed by call_id = sha256(round, role, tool,
// canonical args); a retried or repeated identical call is free. Budgets live on (:Round) as graph data.
import { createHash } from 'node:crypto';
import { rows, roRows, GRAPHS } from './db.js';

export class BudgetExhausted extends Error {
  constructor(counter, round) { super(`budget exhausted: ${counter} (round ${round})`); this.counter = counter; }
}

// Canonical JSON: sorted object keys, so the same logical arguments always hash the same.
const canonical = (x) => (Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`
    : JSON.stringify(x));

export function callId({ round, role, tool, args }) {
  return createHash('sha256').update(canonical({ round, role, tool, args })).digest('hex');
}

// Cypher cannot parameterise a property name, so the server holds one fixed query string per counter
// (spec §6.11; per-role tool budgets per build-readiness decision A#7). The Charge node id is
// `<call_id>:<counter>` because one call can charge two counters (e.g. tool + fork budget).
const chargeQuery = (counter) => `
MATCH (r:Round {n:$n})
OPTIONAL MATCH (c:Charge {id:$charge_id})
WITH r, c WHERE c IS NOT NULL OR r.${counter} > 0
MERGE (k:Charge {id:$charge_id})
  ON CREATE SET k.call_id = $call_id, k.tool = $tool, k.round = $n, k.counter = '${counter}', r.${counter} = r.${counter} - 1
RETURN r.${counter} AS remaining, c IS NULL AS charged`;

const CHARGE = Object.freeze({
  sim_budget: chargeQuery('sim_budget'),
  fork_budget: chargeQuery('fork_budget'),
  red_tool_budget: chargeQuery('red_tool_budget'),
  blue_tool_budget: chargeQuery('blue_tool_budget'),
  autopilot_reserve: chargeQuery('autopilot_reserve'),
});
export const TOOL_COUNTER = Object.freeze({ red: 'red_tool_budget', blue: 'blue_tool_budget' });

// Charge `counter` once for this call. Returns { charged, remaining }; throws BudgetExhausted.
// FalkorDB runs queries on one graph serially, so the check-and-charge is atomic.
export async function charge(db, { round, counter, callId: id, tool }) {
  if (!CHARGE[counter]) throw new Error(`unknown budget counter '${counter}'`);
  const r = await rows(db, GRAPHS.twin, CHARGE[counter], { n: round, charge_id: `${id}:${counter}`, call_id: id, tool });
  if (r.length === 0) throw new BudgetExhausted(counter, round);
  return { charged: r[0].charged, remaining: r[0].remaining };
}

// The server's verification work is counted, never charged to the agent (spec §13.2).
export async function addAuditSims(db, round, k) {
  if (k > 0) await rows(db, GRAPHS.twin, `MATCH (r:Round {n:$n}) SET r.audit_sims = r.audit_sims + $k`, { n: round, k });
}

export async function readRound(db) {
  const r = await roRows(db, GRAPHS.twin, `MATCH (r:Round) RETURN properties(r) AS r ORDER BY r.n DESC LIMIT 1`);
  if (!r.length) throw new Error('no Round node on the twin');
  return r[0].r;
}
