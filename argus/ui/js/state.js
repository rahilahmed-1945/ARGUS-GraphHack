// ARGUS view state — a pure reducer over the canonical runtime event stream ({seq, type, round, tick, payload}).
// No DOM, no timers, no randomness. Everything shown on screen is derived here from event payloads; this module
// never knows a service, fault, intervention or result value in advance. It runs unchanged in Node (tests).

const SHORT_KIND = {
  cap_degrade: 'degrade', surge: 'surge', deploy: 'deploy',
  retries_off: 'retries off', cap_retries: 'cap retries', breaker: 'breaker', scale_out: 'scale out', shed: 'shed', block_deploy: 'block deploy',
};
const ROUND_TITLE = { reactive: 'REACTIVE RECOVERY', preemptive: 'PRE-EMPTIVE RESILIENCE' };
const SEGMENT_TITLE = { ACT: 'ATTACK REALIZED', HOLD: 'TRIGGER REMOVED', OBSERVE: 'OBSERVING OUTCOME', FINALE: 'FINALE · ATTACK ON HARDENED SYSTEM' };

export const edgeKey = (caller, callee) => `${caller}>${callee}`;

export function initialState() {
  return {
    seq: 0,
    started: false,
    round: null,
    roundMode: null,
    roundTitle: null,
    actor: null,                       // 'red' | 'blue' | 'world' | 'harden' | null
    stage: { title: 'STANDBY', sub: 'Waiting for the ARGUS runtime' },
    status: { key: 'standby', label: 'STANDBY' },
    banner: null,                      // {seq, kind, title, sub}
    steps: [],                         // timeline: [{round, key, label, state: 'done'|'active'}]
    graph: null,                       // TWIN configuration (belief) from the latest graph snapshot
    worldGraph: null,                  // WORLD configuration (ground truth) from the latest graph snapshot
    nodes: {},                         // name -> {name, entry, cap, capFrom, capSeq, hardened: round|null}
    edges: {},                         // 'a>b' -> {key, caller, callee, retries, retriesFrom, breaker, changeSeq, change: 'hardened'|'landed'|null, hardened: round|null}
    overlay: emptyOverlay(),
    activity: [],                      // newest last
    futures: { mode: null, root: null, items: [], converged: false },
    decision: null,                    // the current decision card
    hardening: null,
    observation: null,
    calibration: [],
    world: { segment: null, tick: null, viol: null, violatedEntries: [], goodput: {}, served: {}, queue: {}, degrade: {}, faults: [], series: [], clock: null },
    takeovers: [],
    rounds: {},                        // round -> {scenario, decision, observation}
    result: null,
    lastCall: null,                    // the TOOL_CALL a TOOL_RESULT answers (calls run one at a time)
    rollouts: null,                    // ensemble size, learned from a simulate result (sustained + recovered)
  };
}

function emptyOverlay() {
  return {
    amp: null,                         // {paths: [[names]], overload, seq}
    probe: null,                       // {role, services, edges, seq} — what is being simulated right now
    attack: null,                      // {faults, services, edges, evidence: [names], seq}
    locked: null,                      // {interventions, services, edges, seq} — committed decision
    pendingEvidence: null,
  };
}

// ---------------------------------------------------------------- graph lookups (from the snapshot, never from id strings)
function faultTargets(graph, ids) {
  const services = new Set(), edges = new Set();
  for (const id of ids ?? []) {
    const f = graph?.faults?.find((x) => x.id === id);
    if (!f) continue;
    if (f.target) services.add(f.target);
    const ce = f.change_event && graph.changeEvents?.find((c) => c.id === f.change_event);
    if (ce) edges.add(edgeKey(ce.caller, ce.callee));
  }
  return { services: [...services], edges: [...edges] };
}

function interventionTargets(graph, ids) {
  const services = new Set(), edges = new Set();
  for (const id of ids ?? []) {
    const iv = graph?.interventions?.find((x) => x.id === id);
    if (!iv) continue;
    if (iv.caller && iv.callee) edges.add(edgeKey(iv.caller, iv.callee));
    else if (iv.change_event) {
      const ce = graph.changeEvents?.find((c) => c.id === iv.change_event);
      if (ce) edges.add(edgeKey(ce.caller, ce.callee));
    } else if (iv.target) services.add(iv.target);
  }
  return { services: [...services], edges: [...edges] };
}

export function describeFault(graph, id) {
  const f = graph?.faults?.find((x) => x.id === id);
  if (!f) return id;
  const ce = f.change_event && graph.changeEvents?.find((c) => c.id === f.change_event);
  return ce ? `${SHORT_KIND[f.kind] ?? f.kind} ${f.change_event} · ${ce.caller}→${ce.callee}` : `${SHORT_KIND[f.kind] ?? f.kind} · ${f.target}`;
}

export function describeIntervention(graph, id) {
  const iv = graph?.interventions?.find((x) => x.id === id);
  if (!iv) return id;
  const kind = SHORT_KIND[iv.kind] ?? iv.kind;
  if (iv.caller && iv.callee) return `${kind} · ${iv.caller}→${iv.callee}`;
  if (iv.change_event) return `${kind} ${iv.change_event}`;
  return `${kind} · ${iv.target}`;
}

const costOf = (list, ids) => (ids ?? []).reduce((a, id) => a + (list?.find((x) => x.id === id)?.cost ?? 0), 0);
const sortedKey = (ids) => [...(ids ?? [])].sort().join('+');
const fmt = (x, d = 1) => (Number.isInteger(x) ? String(x) : Number(x).toFixed(d));
const rowsOf = (summary) => (typeof summary === 'string' ? summary.split(':')[0] : '');

// ---------------------------------------------------------------- graph snapshots
function loadGraphs(s, graphs, seq, { markChanges = false } = {}) {
  if (!graphs?.twin) return;
  s.graph = graphs.twin;
  s.worldGraph = graphs.world ?? s.worldGraph;
  const nodes = {};
  for (const svc of graphs.twin.services) {
    const prev = s.nodes[svc.name];
    const changed = markChanges && prev && prev.cap !== svc.cap_mean;
    nodes[svc.name] = { name: svc.name, entry: svc.entry, cap: svc.cap_mean, capFrom: changed ? prev.cap : prev?.capFrom ?? svc.cap_mean,
      capSeq: changed ? seq : prev?.capSeq ?? 0, hardened: prev?.hardened ?? null };
  }
  const edges = {};
  for (const c of graphs.twin.calls) {
    const key = edgeKey(c.caller, c.callee);
    const prev = s.edges[key];
    const changed = markChanges && prev && prev.retries !== c.retries;
    edges[key] = { key, caller: c.caller, callee: c.callee, retries: c.retries, breaker: c.breaker,
      retriesFrom: changed ? prev.retries : prev?.retriesFrom ?? c.retries, changeSeq: changed ? seq : prev?.changeSeq ?? 0,
      change: changed ? prev.change : prev?.change ?? null, hardened: prev?.hardened ?? null };
  }
  s.nodes = nodes;
  s.edges = edges;
}

// ---------------------------------------------------------------- timeline
const STEP_ORDER = [['red', 'RED'], ['world', 'WORLD'], ['blue', 'BLUE'], ['harden', 'HARDEN'], ['observe', 'OBSERVE']];
function stepTo(s, key) {
  for (const st of s.steps) if (st.state === 'active') st.state = 'done';
  const st = s.steps.find((x) => x.round === s.round && x.key === key && x.state !== 'done');
  if (st) st.state = 'active';
}

// ---------------------------------------------------------------- activity rows
function activityFor(s, p) {
  const r = p.result;
  // `action` is the short verb shown large; `result` is the one-line outcome; `data` carries structured values
  const row = { role: p.role, by: p.by, tool: p.tool, ok: p.ok, title: p.tool.replace(/_/g, ' '), detail: p.summary, emphasis: false,
    action: p.tool.replace(/_/g, ' '), result: p.summary, data: null };
  if (!p.ok) return { ...row, title: `${row.title} · rejected`, detail: p.summary.replace(/^rejected: /, ''), action: `${row.action} rejected`, result: p.summary.replace(/^rejected: /, '') };
  switch (p.tool) {
    case 'amplification_paths':
      if (!r?.rows?.length) return { ...row, title: 'amplification path', detail: 'no amplifier above threshold', action: 'amplification paths', result: 'no amplifier above threshold' };
      return { ...row, title: 'amplification path', emphasis: true, path: r.rows[0].amplifier, action: 'amplification path',
        detail: `${fmt(r.rows[0].overload)}× retry amplification${r.rows.length > 1 ? ` · +${r.rows.length - 1} more` : ''}`,
        result: `${fmt(r.rows[0].overload)}× retry amplification`, data: { path: r.rows[0].amplifier, overload: r.rows[0].overload } };
    case 'query_graph': return { ...row, title: 'graph query', detail: rowsOf(p.summary), action: 'graph query', result: rowsOf(p.summary) };
    case 'list_candidates': return { ...row, action: 'candidates', result: p.summary };
    case 'rank_nodes': return { ...row, action: 'rank nodes', result: p.summary };
    case 'blast_radius': return { ...row, action: 'blast radius', result: p.summary };
    case 'simulate': {
      const faults = (r.fault_ids ?? []).map((f) => describeFault(s.graph, f));
      return { ...row, title: 'simulate', detail: `${faults.join(' + ')} → ${p.summary}`, action: 'simulation', result: faults.join(' + '),
        data: { faults, sustained: r.sustained, total: r.sustained + r.recovered, cached: !!r.cached } };
    }
    case 'fork_and_simulate': {
      const ivs = (p.args ?? []).map((i) => describeIntervention(s.graph, i));
      return { ...row, title: 'fork & simulate', detail: `${ivs.length ? ivs.join(' + ') : 'do nothing'} → ${p.summary}`, action: 'counterfactual future',
        result: ivs.length ? ivs.join(' + ') : 'do nothing', data: { interventions: ivs, recover: r?.p_recover, median: r?.viol_ticks_p50, cost: r?.cost, verdict: r?.verdict } };
    }
    case 'commit':
      if (p.role === 'red') {
        return { ...row, title: 'attack committed', emphasis: true, action: 'attack committed',
          result: (r?.fault_ids ?? []).map((f) => describeFault(s.graph, f)).join(' + '), data: { sustained: r?.sustained, cost: r?.cost } };
      }
      return { ...row, title: 'decision committed', emphasis: true, action: 'decision committed',
        result: (r?.decision?.selects ?? []).map((i) => describeIntervention(s.graph, i)).join(' + ') || 'no safe action', data: { id: r?.decision?.id } };
    default: return row;
  }
}

// ---------------------------------------------------------------- the reducer
export function applyEvent(s, ev) {
  const p = ev.payload ?? {};
  s.seq = ev.seq;
  s.started = true;
  switch (ev.type) {
    case 'ROUND_STARTED': {
      s.round = p.round;
      s.roundMode = p.mode;
      s.roundTitle = ROUND_TITLE[p.mode] ?? String(p.mode).toUpperCase();
      loadGraphs(s, p.graphs, ev.seq);
      s.overlay = emptyOverlay();
      s.futures = { mode: null, root: null, items: [], converged: false };
      s.decision = null;
      s.observation = null;
      s.world.series = [];
      s.actor = null;
      for (const st of s.steps) st.state = 'done';
      s.steps.push(...STEP_ORDER.map(([key, label]) => ({ round: p.round, key, label, state: 'pending' })));
      s.status = p.round === 1 ? { key: 'healthy', label: 'SYSTEM HEALTHY' } : { key: 'hardened', label: 'SYSTEM HARDENED' };
      s.stage = { title: `ROUND ${String(p.round).padStart(2, '0')}`, sub: s.roundTitle };
      s.banner = { seq: ev.seq, kind: 'round', title: `ROUND ${String(p.round).padStart(2, '0')}`, sub: s.roundTitle };
      s.rounds[p.round] = { mode: p.mode };
      break;
    }
    case 'RED_STARTED':
      s.actor = 'red';
      stepTo(s, 'red');
      s.stage = { title: 'RED · ATTACK DISCOVERY', sub: 'How could this system break?' };
      s.futures = { mode: 'attack', root: { label: 'TWIN', sub: `round ${s.round} · attack futures` }, items: [], converged: false };
      s.banner = null;
      break;
    case 'BLUE_STARTED':
      s.actor = 'blue';
      stepTo(s, 'blue');
      s.overlay.probe = null;
      s.stage = { title: 'BLUE · COUNTERFACTUAL DEFENSE', sub: `${p.scenarioId} · ${p.futureMode === 'reactive' ? 'outage live — restore the SLO' : 'before the attack — protect the SLO'}` };
      s.futures = { mode: 'defense', root: { label: p.snapshotId ? 'SNAPSHOT' : 'TWIN', sub: p.snapshotId ?? `round ${s.round} · pre-emptive` }, items: [], converged: false };
      s.banner = null;
      break;
    case 'TOOL_CALL': {
      s.lastCall = { role: p.role, tool: p.tool, args: p.args ?? {} };
      if (p.tool === 'simulate') {
        const t = faultTargets(s.graph, p.args?.fault_ids);
        s.overlay.probe = { role: p.role, ...t, seq: ev.seq };
        const key = sortedKey(p.args?.fault_ids);
        if (!s.futures.items.some((f) => f.key === key)) {
          for (const f of s.futures.items) if (f.state === 'measured') f.state = 'fail';
          s.futures.items.push({ key, n: s.futures.items.length, ids: [...(p.args?.fault_ids ?? [])],
            label: (p.args?.fault_ids ?? []).map((f) => describeFault(s.graph, f)).join(' + '),
            cost: costOf(s.graph?.faults, p.args?.fault_ids), state: 'running', metric: null, seq: ev.seq });
        }
      }
      if (p.tool === 'commit' && p.role === 'red') s.overlay.pendingEvidence = Array.isArray(p.args?.evidence_path) ? p.args.evidence_path : null;
      break;
    }
    case 'TOOL_RESULT': {
      s.activity.push({ seq: ev.seq, ...activityFor(s, { ...p, args: p.tool === 'fork_and_simulate' ? s.lastCall?.args?.intervention_ids ?? [] : undefined }) });
      if (s.activity.length > 40) s.activity.splice(0, s.activity.length - 40);
      if (p.ok && p.tool === 'amplification_paths' && p.result?.rows?.length) {
        s.overlay.amp = { paths: p.result.rows.map((r) => r.amplifier), overload: p.result.rows[0].overload, triggers: p.result.rows[0].triggers, seq: ev.seq };
      }
      if (p.ok && p.tool === 'simulate') {
        const item = s.futures.items.find((f) => f.key === sortedKey(p.result.fault_ids));
        if (item) {
          const total = p.result.sustained + p.result.recovered;
          s.rollouts = total;
          item.metric = { sustained: p.result.sustained, total, median: p.result.median };
          if (item.state === 'running') item.state = 'measured';
          item.seq = ev.seq;
        }
      }
      break;
    }
    case 'ATTACK_DISCOVERED': {
      const item = s.futures.items.find((f) => f.key === sortedKey(p.fault_ids));
      if (item) { item.state = 'qualify'; item.seq = ev.seq; }
      s.status = { key: 'risk', label: 'SYSTEM AT RISK' };
      break;
    }
    case 'SCENARIO_COMMITTED': {
      const t = faultTargets(s.graph, p.fault_ids);
      const evidence = s.overlay.pendingEvidence ?? [];
      s.overlay.attack = { faults: p.fault_ids, ...t, evidence, seq: ev.seq };
      s.overlay.probe = null;
      s.overlay.pendingEvidence = null;
      for (const f of s.futures.items) {
        if (f.key === sortedKey(p.fault_ids)) { f.selected = true; f.state = 'qualify'; } else if (f.state === 'measured') f.state = 'fail';
      }
      s.futures.converged = true;
      s.status = { key: 'risk', label: 'SYSTEM AT RISK' };
      s.decision = { kind: 'attack', round: s.round, scenario: p.scenario_id, faults: p.fault_ids.map((f) => describeFault(s.graph, f)),
        faultIds: p.fault_ids, sustained: p.sustained, cost: p.cost, auditSims: p.audit_sims, scope: p.scope, evidence, by: p.by, seq: ev.seq };
      s.rounds[s.round].scenario = { id: p.scenario_id, faults: p.fault_ids, sustained: p.sustained, evidence };
      s.banner = { seq: ev.seq, kind: 'attack', title: 'ATTACK IDENTIFIED', sub: p.fault_ids.map((f) => describeFault(s.graph, f)).join(' + ') };
      break;
    }
    case 'WORLD_FAULT_INJECTED':
      s.actor = 'world';
      stepTo(s, 'world');
      s.world.faults = p.faults;
      s.status = s.round === 1 ? { key: 'incident', label: 'INCIDENT · SLO AT RISK' } : { key: 'incident', label: 'UNDER ATTACK' };
      s.stage = { title: s.round === 1 ? 'WORLD · ATTACK REALIZED' : 'WORLD · FINALE', sub: `${p.faults.map((f) => describeFault(s.graph, f)).join(' + ')} injected at tick ${p.tick}` };
      s.banner = null;
      break;
    case 'WORLD_FAULT_REMOVED':
      s.world.faults = [];
      s.stage = { title: 'WORLD · TRIGGER REMOVED', sub: `${p.faults.map((f) => describeFault(s.graph, f)).join(' + ')} removed at tick ${p.tick}` };
      s.banner = { seq: ev.seq, kind: 'notice', title: 'TRIGGER REMOVED', sub: `tick ${p.tick} — does the system recover on its own?` };
      break;
    case 'WORLD_TICK': {
      const w = s.world;
      w.segment = p.segment; w.tick = p.tick; w.viol = p.viol; w.violatedEntries = p.violated_entries ?? [];
      w.goodput = p.goodput ?? {}; w.served = p.served ?? {}; w.queue = p.queue ?? {}; w.degrade = p.degrade ?? {}; w.faults = p.faults ?? [];
      w.series.push({ tick: p.tick, viol: p.viol, segment: p.segment });
      if (w.series.length > 240) w.series.shift();
      if (s.actor !== 'world' && (p.segment === 'OBSERVE' || p.segment === 'FINALE')) { s.actor = 'world'; stepTo(s, p.segment === 'OBSERVE' ? 'observe' : 'world'); }
      if (p.segment === 'OBSERVE' || p.segment === 'FINALE' || p.segment === 'HOLD') {
        if (s.stage.title !== `WORLD · ${SEGMENT_TITLE[p.segment]}`) s.stage = { title: `WORLD · ${SEGMENT_TITLE[p.segment]}`, sub: `tick ${p.tick}` };
        else s.stage.sub = `tick ${p.tick}`;
      }
      if (s.banner?.kind !== 'round' && s.banner?.kind !== 'hardened') s.banner = null;
      break;
    }
    case 'SNAPSHOT_TAKEN':
      s.stage = { title: 'TWIN · SNAPSHOT', sub: `world state captured at tick ${p.tick} for counterfactual planning` };
      break;
    case 'CLOCK':
      s.world.clock = p.state;
      break;
    case 'FUTURE_EVALUATION_STARTED': {
      const ids = p.intervention_ids ?? [];
      s.overlay.probe = { role: 'blue', ...interventionTargets(s.graph, ids), seq: ev.seq };
      s.futures.items.push({ key: sortedKey(ids), n: s.futures.items.length, ids, label: ids.length ? ids.map((i) => describeIntervention(s.graph, i)).join(' + ') : 'do nothing',
        cost: costOf(s.graph?.interventions, ids), state: 'running', metric: null, seq: ev.seq });
      break;
    }
    case 'FUTURE_EVALUATION_COMPLETED': {
      const item = [...s.futures.items].reverse().find((f) => f.key === sortedKey(p.intervention_ids) && f.state === 'running')
        ?? s.futures.items.find((f) => f.key === sortedKey(p.intervention_ids));
      if (item) {
        item.futureId = p.future_id;
        item.metric = { recover: p.p_recover, median: p.viol_ticks_p50, p10: p.p10, p90: p.p90, cost: p.cost, verdict: p.verdict };
        item.cost = p.cost;
        item.state = p.verdict === 'green' ? 'qualify' : p.verdict === 'amber' ? 'partial' : 'fail';
        item.seq = ev.seq;
      }
      break;
    }
    case 'DECISION_PROPOSED':
      s.stage = { title: 'BLUE · PROPOSAL', sub: 'submitted to the server rule and audit' };
      break;
    case 'DECISION_AUDITED':
      s.activity.push({ seq: ev.seq, role: 'server', tool: 'audit', ok: p.accepted, emphasis: !p.accepted,
        action: p.accepted ? 'M5 audit · accepted' : 'M5 audit · rejected',
        result: p.accepted ? `${p.audit_sims} cheaper-or-equal futures verified` : `${p.reason}${p.rule_winner ? ` → rule winner ${p.rule_winner}` : ''}`,
        title: p.accepted ? 'M5 audit · accepted' : 'M5 audit · rejected',
        detail: p.accepted ? `${p.audit_sims} cheaper-or-equal futures verified` : `${p.reason}${p.rule_winner ? ` → rule winner ${p.rule_winner}` : ''}` });
      break;
    case 'DECISION_COMMITTED': {
      const d = p.decision;
      const t = interventionTargets(s.graph, d.selects);
      s.overlay.locked = { interventions: d.selects ?? [], ...t, seq: ev.seq };
      s.overlay.probe = null;
      for (const f of s.futures.items) f.selected = f.futureId === d.selected_future;
      s.futures.converged = true;
      const sel = s.futures.items.find((f) => f.selected);
      s.decision = { kind: 'decision', round: s.round, id: d.id, selected: d.selected_future, interventions: (d.selects ?? []).map((i) => describeIntervention(s.graph, i)),
        interventionIds: d.selects ?? [], minimality: d.minimality, rule: d.rule, auditSims: d.audit_sims, agentFutures: d.agent_futures,
        predicted: d.predicted_viol_ticks_p50, band: sel?.metric ? [sel.metric.p10, sel.metric.p90] : null, recover: sel?.metric?.recover ?? null,
        cost: sel?.cost ?? null, errorBudget: d.error_budget, recThreshold: d.rec_threshold, by: d.proposed_by, seq: ev.seq };
      s.rounds[s.round].decision = { id: d.id, selected: d.selected_future, interventions: d.selects };
      s.status = { key: 'mitigating', label: 'INTERVENTION SELECTED' };
      s.banner = { seq: ev.seq, kind: 'decision', title: 'MINIMUM EFFECTIVE INTERVENTION', sub: s.decision.interventions.join(' + ') || 'no safe action' };
      break;
    }
    case 'HARDENING_STARTED':
      s.actor = 'harden';
      stepTo(s, 'harden');
      s.stage = { title: 'HARDENING', sub: `applying ${p.decision} to WORLD and TWIN` };
      break;
    case 'HARDENING_APPLIED': {
      loadGraphs(s, p.graphs, ev.seq, { markChanges: true });
      for (const c of p.changes?.twin ?? []) {
        if (c.edge && s.edges[c.edge]) { s.edges[c.edge].change = 'hardened'; s.edges[c.edge].hardened = s.round; s.edges[c.edge].changeSeq = ev.seq; s.edges[c.edge].retriesFrom = c.before; }
        if (c.service && s.nodes[c.service]) { s.nodes[c.service].hardened = s.round; s.nodes[c.service].capSeq = ev.seq; s.nodes[c.service].capFrom = c.before; }
      }
      s.hardening = { round: s.round, decision: p.decision, label: p.pr?.label, followUp: p.pr?.follow_up ?? [], changes: p.changes?.world ?? [],
        interventions: (p.pr?.interventions ?? []).map((i) => describeIntervention(s.graph, i)), seq: ev.seq };
      s.overlay.locked = null;
      if (s.overlay.attack) s.overlay.attack = { ...s.overlay.attack, resolved: true };
      s.status = { key: 'hardened', label: 'SYSTEM HARDENED' };
      s.stage = { title: 'SYSTEM HARDENED', sub: p.pr?.label ?? '' };
      s.banner = { seq: ev.seq, kind: 'hardened', title: 'SYSTEM HARDENED', sub: p.pr?.label ? p.pr.label.replace(/^./, (c) => c.toUpperCase()) + ' applied' : '' };
      break;
    }
    case 'WORLD_DEPLOY_LANDED': {
      loadGraphs(s, p.graphs, ev.seq, { markChanges: true });
      const e = s.edges[p.edge];
      if (e) { e.change = 'landed'; e.changeSeq = ev.seq; e.retriesFrom = p.before; }
      s.activity.push({ seq: ev.seq, role: 'world', tool: 'deploy', ok: true, emphasis: true, title: `deploy ${p.change_event} landed`,
        action: `deploy ${p.change_event} landed`, result: `${p.edge.replace('>', ' → ')} · ${p.field} ${p.before} → ${p.after}`,
        detail: `${p.edge.replace('>', ' → ')} · ${p.field} ${p.before} → ${p.after}` });
      s.banner = { seq: ev.seq, kind: 'notice', title: `DEPLOY ${p.change_event} LANDED`, sub: `${p.edge.replace('>', ' → ')} ${p.field} ${p.before} → ${p.after}` };
      break;
    }
    case 'WORLD_OBSERVATION':
      s.observation = { round: s.round, decision: p.decision, id: p.id, predicted: p.predicted_viol_ticks_p50, band: [p.predicted_p10, p.predicted_p90],
        observed: p.observed_viol_ticks, ttr: p.observed_ttr, withinBand: p.within_band, error: p.pred_error, seq: ev.seq };
      s.rounds[s.round].observation = s.observation;
      stepTo(s, 'observe');
      s.stage = { title: 'WORLD · OBSERVED', sub: `${p.id} verifies ${p.decision}` };
      break;
    case 'CALIBRATION_UPDATED':
      s.calibration.push({ round: s.round, service: p.service, before: p.before, after: p.after, n: p.n, sd: p.cap_sd, seq: ev.seq });
      break;
    case 'ROUND_COMPLETED':
      for (const st of s.steps) if (st.round === p.round) st.state = 'done';
      break;
    case 'TAKEOVER':
      s.takeovers.push({ role: p.role, reason: p.reason, detail: p.detail, seq: ev.seq });
      s.activity.push({ seq: ev.seq, role: p.role, tool: 'takeover', ok: false, emphasis: true, title: 'autopilot takeover', detail: `${p.reason}: ${p.detail}`, action: 'autopilot takeover', result: p.reason });
      break;
    case 'TOOL_TRANSPORT_FAILOVER':
      s.activity.push({ seq: ev.seq, role: p.role, tool: 'transport', ok: false, title: 'transport failover', detail: `${p.error} → ${p.to}`, action: 'transport failover', result: p.to });
      break;
    case 'DEMO_COMPLETED':
      s.result = { safe: p.safe, ...p.finale, phases: p.phases, seq: ev.seq };
      s.actor = null;
      for (const st of s.steps) st.state = 'done';
      s.overlay = { ...emptyOverlay() };
      s.status = p.safe ? { key: 'safe', label: 'SAFE' } : { key: 'unsafe', label: 'NOT SAFE' };
      s.stage = { title: 'SYSTEM STATUS', sub: p.safe ? 'the WORLD stayed within its error budget' : 'the WORLD exceeded its error budget' };
      s.banner = { seq: ev.seq, kind: p.safe ? 'safe' : 'unsafe', title: p.safe ? 'SAFE' : 'NOT SAFE',
        sub: `${p.finale.observed_viol_ticks} violated ticks · ${p.finale.ticks}-tick horizon · error budget ${p.finale.error_budget}` };
      break;
    default:
      break;
  }
  return s;
}

export function reduceAll(events) {
  const s = initialState();
  for (const ev of events) applyEvent(s, ev);
  return s;
}

// [M11] the view of a graph before any run event (the interactive demo's pre-run preview): the configuration as
// FalkorDB holds it now, and the amplification query's rows drawn as the amber path. Read-only; the reducer is unchanged.
export function previewState(graphs, amplification = []) {
  const s = initialState();
  loadGraphs(s, graphs, 0);
  if (amplification?.length) {
    s.overlay.amp = { paths: amplification.map((r) => r.amplifier), overload: amplification[0].overload, triggers: amplification[0].triggers, seq: 0 };
  }
  return s;
}
