// A deterministic stand-in for BLUE's LLM, for tests. It implements complete({system, messages, tools}) →
// {toolCalls} and sees exactly what an LLM would: the rendered objective, the tool schemas, and the transcript of
// its own tool calls and results. It has NO graph access and NO topology, service, intervention or deploy
// constants (enforced by tests/m8-blue.test.js test 12): every candidate comes from a tool result.
// Reasoning, in plain terms:
//   1. Ask for the in-scope candidates (list_candidates), which come with the scenario's faults and evidence path.
//   2. If the outage is already live, measure doing nothing first (is it self-sustaining?).
//   3. If retry interventions exist along the evidence path, the storm is retry-driven: test the runbook answers
//      (capacity on the layer above the trigger, capacity at the trigger), then the retry knobs nearest the trigger
//      (retries off, a breaker), then retries off on every layer of the path.
//      Otherwise (no retry knobs left): stop the deploy that makes the slowdown persistent, put a breaker on the
//      edge into the trigger, and add capacity at the trigger.
//   4. Evaluate three futures per turn; once a green future exists, propose the cheapest one. If the server's rule
//      names a different winner, propose that; if nothing qualifies, propose NO_SAFE_ACTION.
/* MODEL POLICY: this model evaluates three futures per turn (the spec's BLUE run sheet). */
const BATCH = 3;
/* END MODEL POLICY */
const lastResult = (messages, tool) => {
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k];
    if (m.role === 'tool' && m.name === tool) { const r = JSON.parse(m.content); if (!r.error) return r; }
  }
  return null;
};
const key = (ids) => [...ids].sort().join('+');

function evaluated(messages) {
  const calls = new Map(messages.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls).map((c) => [c.id, c]));
  return messages.filter((m) => m.role === 'tool' && m.name === 'fork_and_simulate')
    .map((m) => ({ ids: calls.get(m.toolCallId).args.intervention_ids, r: JSON.parse(m.content) }))
    .filter((x) => !x.r.error);
}

function plan(listed, reactive, maxIv) {
  const scope = listed.ids;
  const path = listed.scenario.evidence_path;
  const faults = listed.scenario.faults;
  const trigger = (faults.find((f) => f.kind === 'cap_degrade') ?? faults[0]).target;
  const t = path.indexOf(trigger);
  const above = t > 0 ? path[t - 1] : null;
  const edges = path.slice(1).map((b, k) => `${path[k]}>${b}`);
  const on = (kind, edge) => scope.find((i) => i.kind === kind && `${i.caller}>${i.callee}` === edge);
  const at = (kind, service) => scope.find((i) => i.kind === kind && i.target === service);
  const knobs = [...edges].reverse().filter((e) => on('retries_off', e));            // nearest the trigger first
  const items = [];
  if (reactive) items.push([]);
  if (knobs.length) {
    items.push([at('scale_out', above)], [at('scale_out', trigger)], [on('retries_off', knobs[0])], [on('breaker', knobs[0])]);
    if (knobs.length > 1) items.push(knobs.slice(0, maxIv).map((e) => on('retries_off', e)));
  } else {
    for (const b of scope.filter((i) => i.kind === 'block_deploy')) items.push([b]);
    const into = [...edges].reverse().find((e) => e.endsWith(`>${trigger}`));
    items.push([into && on('breaker', into)], [at('scale_out', trigger)], [at('scale_out', above)]);
  }
  const seen = new Set();
  return items.filter((xs) => xs.every(Boolean)).map((xs) => xs.map((i) => i.id))
    .filter((ids) => { const k = key(ids); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function createScriptedBlueModel() {
  const transcripts = [];
  return {
    transcripts,
    async complete({ system, messages, tools }) {
      transcripts.push(structuredClone({ system, messages }));
      const offered = new Set(tools.map((x) => x.name));
      const maxIv = Number(system.match(/at most (\d+) interventions/)[1]);
      const reactive = /\(reactive:/.test(messages[0].content);
      const listed = lastResult(messages, 'list_candidates');
      if (!listed) return { toolCalls: [{ name: 'list_candidates', args: {} }].filter((c) => offered.has(c.name)) };

      // a rejected proposal: follow the rule's winner the server named
      const last = messages[messages.length - 1];
      if (last?.role === 'tool' && last.name === 'commit') {
        const winner = JSON.parse(last.content).error?.match(/rule winner (\S+)/)?.[1];
        return { toolCalls: [{ name: 'commit', args: { future_id: winner ?? 'NO_SAFE_ACTION', rationale: 'the selection rule names this winner' } }] };
      }
      const done = evaluated(messages);
      const green = done.filter((x) => x.r.verdict === 'green')
        .sort((a, b) => a.r.cost - b.r.cost || a.r.viol_ticks_p50 - b.r.viol_ticks_p50 || a.r.future_id.localeCompare(b.r.future_id));
      if (green.length) return { toolCalls: [{ name: 'commit', args: { future_id: green[0].r.future_id, rationale: 'cheapest future that recovers within the error budget' } }] };
      const tried = new Set(done.map((x) => key(x.ids)));
      const next = plan(listed, reactive, maxIv).filter((ids) => !tried.has(key(ids))).slice(0, BATCH);
      if (!next.length) return { toolCalls: [{ name: 'commit', args: { future_id: 'NO_SAFE_ACTION', rationale: 'no candidate recovers' } }] };
      return { toolCalls: next.map((ids) => ({ name: 'fork_and_simulate', args: { intervention_ids: ids } })) };
    },
  };
}
