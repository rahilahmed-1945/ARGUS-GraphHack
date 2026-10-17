// A deterministic stand-in for RED's LLM, for tests. It implements the LLM interface
// (complete({system, messages, tools}) → {toolCalls}) and sees exactly what an LLM would: the rendered
// objective, the tool schemas, and the transcript of its own tool calls and results. It has NO graph
// access and NO topology knowledge (enforced by tests/m7-red.test.js test 12): every choice it makes is a
// function of earlier tool results, so different graph state → different results → a different path.
// Reasoning, in plain terms:
//   1. Look for retry amplifiers and learn which faults exist (amplification_paths ∥ list_candidates).
//   2. If an amplifier exists, attack the faults beneath it, nearest first; otherwise find the most
//      depended-on service (rank_nodes) and look for pending deploys into it that could amplify a slowdown.
//   3. Simulate candidates in order; submit the first that meets the objective's threshold.
const lastResult = (messages, tool) => {
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k];
    if (m.role === 'tool' && m.name === tool) { const r = JSON.parse(m.content); if (!r.error) return r; }
  }
  return null;
};
const simulated = (messages) => {
  const calls = new Map(messages.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls).map((c) => [c.id, c]));
  return messages.filter((m) => m.role === 'tool' && m.name === 'simulate')
    .map((m) => ({ faults: calls.get(m.toolCallId).args.fault_ids, result: JSON.parse(m.content) }));
};
const call = (name, args = {}) => ({ name, args });

// The deploys-into-a-service lookup an LLM would write for query_graph (spec §9.8 query, parameterised).
const PENDING_DEPLOYS_INTO = `MATCH (c:ChangeEvent {status:'pending'})-[m:MODIFIES]->(a:Service)-[:CALLS]->(b:Service {name:$s})
WHERE m.callee = b.name RETURN c.id AS ce, a.name AS caller, b.name AS target ORDER BY ce`;

export function createScriptedRedModel({ minRisk = 2 } = {}) {
  const transcripts = [];
  return {
    transcripts,
    async complete({ system, messages, tools }) {
      transcripts.push(structuredClone({ system, messages }));
      const offered = new Set(tools.map((t) => t.name));
      const [, need] = system.match(/at least (\d+) of (\d+) rollouts/).map(Number);
      const amp = lastResult(messages, 'amplification_paths');
      const listed = lastResult(messages, 'list_candidates');
      if (!amp || !listed) return { toolCalls: [call('amplification_paths', { min_risk: minRisk }), call('list_candidates')].filter((c) => offered.has(c.name)) };
      const faults = listed.ids;
      const byId = new Map(faults.map((f) => [f.id, f]));

      // candidate attacks, derived only from tool results
      let plan;
      if (amp.rows.length) {
        const top = amp.rows[0];
        const triggers = top.triggers.map((t) => t.split('@')[0]).filter((f) => byId.has(f));
        plan = triggers.map((f) => ({
          faults: [f],
          evidence: [...top.amplifier, ...(byId.get(f).target === top.target ? [] : [byId.get(f).target])],
        }));
      } else {
        const ranked = lastResult(messages, 'rank_nodes');
        if (!ranked) return { toolCalls: [call('rank_nodes', { metric: 'pagerank' })] };
        const hub = ranked.rows[0].service;
        const deploys = lastResult(messages, 'query_graph');
        if (!deploys) return { toolCalls: [call('query_graph', { cypher: PENDING_DEPLOYS_INTO, params: { s: hub } })] };
        const slow = faults.find((f) => f.kind === 'cap_degrade' && f.target === hub);
        if (!slow) return { text: `no way to slow down ${hub}` };
        const deployFaults = deploys.rows.map((r) => ({ r, f: faults.find((f) => f.kind === 'deploy' && f.target === r.caller) })).filter((x) => x.f);
        plan = [{ faults: [slow.id], evidence: [hub] },
          ...deployFaults.map(({ r, f }) => ({ faults: [slow.id, f.id], evidence: [r.caller, r.target] }))];
      }
      const tried = simulated(messages);
      const hit = tried.find((t) => t.result.sustained >= need);
      if (hit) {
        const p = plan.find((x) => JSON.stringify([...x.faults].sort()) === JSON.stringify([...hit.faults].sort()));
        return { toolCalls: [call('commit', { fault_ids: hit.faults, evidence_path: p ? p.evidence : [] })] };
      }
      const next = plan.find((x) => !tried.some((t) => JSON.stringify([...t.faults].sort()) === JSON.stringify([...x.faults].sort())));
      if (!next) return { text: 'no attack found within the candidates I considered' };
      return { toolCalls: [call('simulate', { fault_ids: next.faults })] };
    },
  };
}
