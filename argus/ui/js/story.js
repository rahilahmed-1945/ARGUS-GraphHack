// The storytelling layer: one pure model of "what is happening, and why" over the canonical events presented so
// far. It answers the same six questions at every stage — the problem, what ARGUS is doing now, why, what the graph
// told it, what happened, and what that proves — in plain English, and keeps the technical record (tool calls,
// Cypher, fork names) as supporting evidence only. No DOM, no timers, no randomness, no generated text: every
// sentence is fixed copy filled with values read from event payloads, the graph snapshot in the view state, or the
// server's side channels. It never knows a service, fault or result in advance. Runs unchanged in Node (tests).

/* STORY COPY — fixed presentation text. */
export const PROBLEM = "An online payment system. A slowdown in one service can spread through retries and take the whole purchase flow down. ARGUS's job: find that failure before it happens, and find the smallest fix.";
export const CAST = Object.freeze([
  { key: 'twin', title: 'THE SYSTEM TWIN', text: 'The graph contains the services, dependencies, failure mechanisms and possible interventions. ARGUS uses this graph to decide what it can investigate and change.' },
  { key: 'red', title: 'RED — FIND THE FAILURE', text: 'Try to break the system.' },
  { key: 'blue', title: 'BLUE — FIND THE FIX', text: 'Find the smallest safe intervention.' },
  { key: 'live', title: 'THE LIVE SYSTEM', text: 'A separate copy that plays the role of production. ARGUS never reasons on it; it is where we check whether ARGUS was right.' },
]);
export const FINAL_LINE = 'The graph changed, so the agent changed its reasoning.';
export const CHAINS = Object.freeze({
  control: ['You change the graph', 'ARGUS sees the change', 'A new failure is found', 'Fixes are tested', 'Cheapest safe fix proven', 'System hardened', 'Attack again', 'Different reasoning', 'SAFE'],
  guided: ['ARGUS reads the graph', 'A failure is found', 'Fixes are tested', 'Cheapest safe fix proven', 'System hardened', 'Attack again', 'Different reasoning', 'SAFE'],
});
/* the fixed narration beats (the ledger keys speech by run + round + beat; several events share one beat) */
export const BEATS = Object.freeze(['your_move', 'graph_changed', 'red_search', 'red_attack_found', 'world_attack', 'blue_search', 'verifier',
  'intervention_selected', 'hardening', 'world_observation', 'round2', 'finale', 'safe']);
/* END STORY COPY */

const changes = (n) => (n === 1 ? 'one change' : n === 2 ? 'two changes' : `${n} changes`);
const num = (x) => (x === null || x === undefined ? '—' : Number.isInteger(x) ? String(x) : Number(x).toFixed(1));
const arrow = (s) => String(s ?? '').replace('>', ' → ');
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const times = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- plain-English names, from the graph snapshot
function faultOf(g, id) { return g?.faults?.find((x) => x.id === id) ?? null; }
function ceOf(g, id) { return g?.changeEvents?.find((c) => c.id === id) ?? null; }
/** "a slowdown in X" / "the pending deploy D (a change to A → B)" */
export function faultProse(g, id) {
  const f = faultOf(g, id);
  if (!f) return 'an unknown failure';
  if (f.change_event) { const ce = ceOf(g, f.change_event); return `the pending deploy ${f.change_event}${ce ? ` (a change to ${ce.caller} → ${ce.callee})` : ''}`; }
  return { cap_degrade: `a slowdown in ${f.target}`, surge: `a traffic surge at ${f.target}` }[f.kind] ?? `a failure in ${f.target}`;
}
/** the clause after "What if …": "X slows down", "deploy D lands" */
function faultClause(g, id) {
  const f = faultOf(g, id);
  if (!f) return 'something fails';
  if (f.change_event) return `deploy ${f.change_event} lands`;
  return { cap_degrade: `${f.target} slows down`, surge: `traffic surges at ${f.target}` }[f.kind] ?? `${f.target} fails`;
}
export const attackProse = (g, ids) => (ids ?? []).map((id) => faultProse(g, id)).join(' plus ');
export const attackQuestion = (g, ids) => `What if ${list((ids ?? []).map((id) => faultClause(g, id)))}?`;
const ACTION = {
  retries_off: (i) => `disable the retry from ${i.caller} to ${i.callee}`,
  cap_retries: (i) => `limit the retries from ${i.caller} to ${i.callee}`,
  breaker: (i) => `add a circuit breaker between ${i.caller} and ${i.callee}`,
  scale_out: (i) => `add capacity to ${i.target}`,
  shed: (i) => `shed excess load at ${i.target}`,
  block_deploy: (i) => `block the pending deploy ${i.change_event}`,
};
/** "disable the retry from A to B" — the plain action an intervention takes */
export function action(g, id) {
  const i = g?.interventions?.find((x) => x.id === id);
  if (!i) return 'an unknown change';
  return (ACTION[i.kind] ?? (() => `apply ${String(i.kind).replace(/_/g, ' ')} to ${i.target ?? `${i.caller} → ${i.callee}`}`))(i);
}
/** "What if we do nothing?" / "What if we add capacity to X?" */
export const fixQuestion = (g, ids) => ((ids ?? []).length ? `What if we ${list(ids.map((id) => action(g, id)))}?` : 'What if we do nothing?');
const fixProse = (g, ids) => ((ids ?? []).length ? list(ids.map((id) => action(g, id))) : 'do nothing');
const cap = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

function newRound(n) {
  return { n, amp: null, ampEmpty: null, rank: null, deploys: null, redTests: [], attack: null, evidence: null, blueOptions: null,
    futures: [], proposedNone: false, rejected: false, verified: null, fix: null, hardened: [], observation: null,
    act: { bad: 0, ticks: 0, entries: new Set() }, hold: { bad: 0, ticks: 0 }, removed: false, injected: false,
    finale: { bad: 0, ticks: 0 }, deploy: null };
}

// ---------------------------------------------------------------- facts: one pass over the presented events
function facts(events, g, judge, traces) {
  const rounds = {};
  const evidence = [];
  let round = 0;
  let lastCall = null;
  let result = null;
  let pendingFork = null;    // a fork-and-simulate step, reported together with its outcome
  let last = null;           // the latest event that moves the story
  const mark = (ev) => { last = ev; };
  if (judge) {
    for (const e of judge.edits) {
      const [a, b] = e.edge.split('>');
      evidence.push({ key: `judge:${e.edge}`, who: 'you', text: `You changed the graph: ${a} → ${b} retries ${e.before} → ${e.after}, in the twin and the live system.`,
        tech: { label: 'FalkorDB write', detail: `${e.graphs.join(' + ')}`, cypher: e.cypher, at: judge.at ?? null }, db: true });
    }
    const amp = (rows) => (rows?.length ? `yes, ${num(rows[0].overload)}× along ${rows[0].amplifier.join(' → ')}` : 'none');
    evidence.push({ key: 'judge:amp', who: 'you', text: `ARGUS's first question, "is there a retry storm?": before ${amp(judge.amplification.before)}; after ${amp(judge.amplification.after)}.`,
      tech: { label: 'amplification query (re-run)', detail: '', cypher: null, at: judge.at ?? null }, db: false });
  }
  for (const ev of events) {
    const p = ev.payload ?? {};
    if (ev.type === 'ROUND_STARTED') { round = p.round; rounds[round] = newRound(round); }
    const r = rounds[round];
    if (!r) continue;
    switch (ev.type) {
      case 'RED_STARTED': case 'BLUE_STARTED': case 'SCENARIO_COMMITTED': case 'DECISION_AUDITED': case 'DECISION_COMMITTED':
      case 'HARDENING_APPLIED': case 'WORLD_OBSERVATION': case 'ROUND_COMPLETED': case 'WORLD_FAULT_INJECTED': case 'WORLD_FAULT_REMOVED':
      case 'WORLD_DEPLOY_LANDED': case 'DEMO_COMPLETED': case 'ROUND_STARTED':
        mark(ev);
        break;
      default: break;
    }
    switch (ev.type) {
      case 'TOOL_CALL':
        lastCall = p;
        break;
      case 'TOOL_RESULT': {
        const t = traces.get(ev.seq);
        const res = p.result ?? {};
        let text = null;
        if (p.role === 'red') {
          if (p.tool === 'amplification_paths') {
            if (r.ampEmpty === null) { r.ampEmpty = !res.rows?.length; r.amp = res.rows?.[0] ?? null; }
            text = res.rows?.length ? `RED asked the graph: "is there a retry storm?" Yes: ${num(res.rows[0].overload)}× the load along ${res.rows[0].amplifier.join(' → ')}.` : 'RED asked the graph: "is there a retry storm?" None.';
          } else if (p.tool === 'list_candidates') text = `RED asked the graph which failures are possible: ${times(res.ids?.length ?? 0, 'option', 'options')}.`;
          else if (p.tool === 'rank_nodes') { r.rank = res.rows?.[0]?.service ?? null; text = `RED asked which service everything depends on most: ${r.rank ?? 'none'}.`; }
          else if (p.tool === 'query_graph') {
            r.deploys = (res.rows ?? []).filter((x) => x.ce);
            text = r.deploys.length ? `RED asked the graph for pending deploys: ${r.deploys.map((d) => `${d.ce} (${d.caller} → ${d.target})`).join(', ')}.` : `RED queried the graph: ${times(res.rows?.length ?? 0, 'row', 'rows')}.`;
          } else if (p.tool === 'simulate' && p.ok) {
            const total = res.sustained + res.recovered;
            r.redTests.push({ ids: res.fault_ids, sustained: res.sustained, total, seq: ev.seq });
            text = `RED tested ${attackProse(g, res.fault_ids)} on a scratch copy of the graph: broken in ${res.sustained} of ${total} runs.`;
          } else if (p.tool === 'commit') text = p.ok ? 'RED submitted the attack; ARGUS re-checked it independently.' : 'RED submitted an attack; ARGUS rejected it.';
        } else if (p.role === 'blue') {
          if (p.tool === 'list_candidates') { r.blueOptions = res.ids?.length ?? null; text = `BLUE asked the graph which fixes are possible here: ${times(r.blueOptions ?? 0, 'option', 'options')}.`; }
          else if (p.tool === 'fork_and_simulate' && p.ok) { pendingFork = { summary: String(p.summary ?? ''), cypher: t?.cypher ?? null, at: t?.at ?? null }; break; }   // one line, with its outcome
          else if (p.tool === 'commit') text = p.ok ? 'BLUE committed its fix; ARGUS verified it.' : 'BLUE proposed an answer; ARGUS rejected it.';
        }
        evidence.push({ key: `s${ev.seq}`, seq: ev.seq, who: p.role, text: text ?? `${p.role.toUpperCase()} used ${p.tool.replace(/_/g, ' ')}.`, ok: p.ok,
          tech: { label: p.tool, detail: String(p.summary ?? ''), cypher: t?.cypher ?? null, at: t?.at ?? null }, db: false });
        break;
      }
      case 'SCENARIO_COMMITTED':
        r.attack = { ids: p.fault_ids, sustained: p.sustained, deploy: p.fault_ids.some((f) => faultOf(g, f)?.change_event) };
        r.evidence = lastCall?.tool === 'commit' && Array.isArray(lastCall.args?.evidence_path) ? lastCall.args.evidence_path : null;
        break;
      case 'WORLD_FAULT_INJECTED':
        r.injected = true;
        break;
      case 'WORLD_FAULT_REMOVED':
        if (p.segment === 'ACT') r.removed = true;
        break;
      case 'WORLD_TICK': {
        const seg = p.segment === 'ACT' ? r.act : p.segment === 'HOLD' ? r.hold : p.segment === 'FINALE' ? r.finale : null;
        if (seg) { seg.ticks += 1; if (p.viol) seg.bad += 1; if (seg.entries) for (const e of p.violated_entries ?? []) seg.entries.add(e); }
        break;
      }
      case 'FUTURE_EVALUATION_COMPLETED':
        r.futures.push({ ids: p.intervention_ids ?? [], verdict: p.verdict, recover: p.p_recover, futureId: p.future_id });
        evidence.push({ key: `f${ev.seq}`, seq: ev.seq, who: 'blue', text: `BLUE copied the graph and tried: ${fixQuestion(g, p.intervention_ids)} ${answerOf(p.verdict, p.p_recover).answer}.`,
          tech: { label: 'GRAPH.COPY + fork_and_simulate', detail: `twin → ${p.future_id} · ${pendingFork?.summary ?? p.verdict}`, cypher: pendingFork?.cypher ?? null, at: pendingFork?.at ?? null }, db: true });
        pendingFork = null;
        break;
      case 'DECISION_PROPOSED':
        if (p.future_id === 'NO_SAFE_ACTION') r.proposedNone = true;
        break;
      case 'DECISION_AUDITED':
        if (!p.accepted) r.rejected = true; else r.verified = { alternatives: p.audit_sims };
        evidence.push({ key: `a${ev.seq}`, seq: ev.seq, who: 'verifier', ok: !!p.accepted,
          text: p.accepted ? `ARGUS verified the fix: it checked ${p.audit_sims} other possible fixes; none cheaper works.` : 'ARGUS rejected BLUE\'s answer: the graph shows a cheaper safe fix exists.',
          tech: { label: 'server audit', detail: p.accepted ? `accepted · audit ${p.audit_sims}` : String(p.reason ?? ''), cypher: null, at: null }, db: false });
        break;
      case 'DECISION_COMMITTED': {
        const ids = p.decision?.selects ?? [];
        r.fix = { ids, count: ids.length, predicted: p.decision?.predicted_viol_ticks_p50 };
        break;
      }
      case 'HARDENING_APPLIED':
        for (const c of p.changes?.world ?? []) {
          const line = c.edge ? `${arrow(c.edge)}: retries ${num(c.before)} → ${num(c.after)}` : `${c.service}: capacity ${num(c.before)} → ${num(c.after)}`;
          r.hardened.push(line);
          evidence.push({ key: `h${ev.seq}:${line}`, seq: ev.seq, who: 'argus', text: `ARGUS wrote the fix into the twin and the live system: ${line}.`,
            tech: { label: 'FalkorDB write', detail: `${c.field} · twin + world`, cypher: null, at: null }, db: true });
        }
        break;
      case 'WORLD_DEPLOY_LANDED':
        r.deploy = { ce: p.change_event, edge: p.edge, before: p.before, after: p.after };
        evidence.push({ key: `d${ev.seq}`, seq: ev.seq, who: 'live', text: `The pending deploy ${p.change_event} landed on the live system: ${arrow(p.edge)} retries ${p.before} → ${p.after}.`,
          tech: { label: 'FalkorDB write', detail: 'world + twin', cypher: null, at: null }, db: true });
        break;
      case 'WORLD_OBSERVATION':
        r.observation = { predicted: p.predicted_viol_ticks_p50, observed: p.observed_viol_ticks, within: p.within_band };
        break;
      case 'DEMO_COMPLETED':
        result = { safe: p.safe, violated: p.finale?.observed_viol_ticks, ticks: p.finale?.ticks, budget: p.finale?.error_budget };
        break;
      default: break;
    }
  }
  return { rounds, evidence, round, last, result };
}

function answerOf(verdict, recover, total) {
  const runs = `recovers in ${recover}${total ? ` of ${total}` : ''} runs`;
  if (verdict === 'green') return { answer: 'Works', tone: 'good', detail: `${runs}, few bad moments` };
  if (verdict === 'amber') return { answer: 'Helps, but not enough', tone: 'partial', detail: `${runs}, but too many bad moments` };
  return { answer: recover > 0 ? 'Mostly still broken' : 'Still broken', tone: 'bad', detail: runs };
}

// ---------------------------------------------------------------- chapters
function chapterOf(f, mode, judge) {
  const ev = f.last;
  if (f.result) return 'safe';
  if (!ev) return mode === 'control' ? (judge ? 'changed' : 'choose') : 'ready';
  const r = f.rounds[f.round];
  const two = f.round >= 2;
  switch (ev.type) {
    case 'ROUND_STARTED': return two ? 'again' : mode === 'control' ? 'changed' : 'ready';
    case 'RED_STARTED': return two ? 'red2' : 'red';
    case 'SCENARIO_COMMITTED': return two ? 'red2' : 'red';
    case 'WORLD_FAULT_INJECTED': return two ? 'finale' : 'real';
    case 'WORLD_FAULT_REMOVED': return two ? 'finale' : 'real';
    case 'BLUE_STARTED': case 'DECISION_AUDITED': return two ? 'blue2' : 'blue';
    case 'DECISION_COMMITTED': return two ? 'proven2' : 'proven';
    case 'HARDENING_APPLIED': return two ? 'proven2' : 'hardened';
    case 'WORLD_OBSERVATION': return two ? 'finale' : 'hardened';
    case 'ROUND_COMPLETED': return two ? 'finale' : 'again';
    case 'WORLD_DEPLOY_LANDED': return 'finale';
    default: return r ? 'red' : 'ready';
  }
}
const STEP = {
  control: { choose: 0, changed: 0, ready: 0, red: 1, real: 2, blue: 3, proven: 4, hardened: 5, again: 6, red2: 7, blue2: 7, proven2: 7, finale: 8, safe: 8 },
  guided: { ready: 0, red: 0, real: 1, blue: 2, proven: 3, hardened: 4, again: 5, red2: 6, blue2: 6, proven2: 6, finale: 7, safe: 7 },
};
const TITLE = {
  choose: 'YOUR MOVE', changed: 'YOU CHANGED THE GRAPH', ready: 'THE SYSTEM TWIN', red: 'RED — FIND THE FAILURE', real: 'MAKE IT REAL',
  blue: 'BLUE — FIND THE FIX', proven: 'CHEAPEST SAFE FIX PROVEN', hardened: 'SYSTEM HARDENED', again: 'ATTACK AGAIN',
  red2: 'RED — FIND A NEW FAILURE', blue2: 'BLUE — FIND THE FIX', proven2: 'CHEAPEST SAFE FIX PROVEN', finale: 'THE REAL TEST', safe: 'RESULT',
};
const STATUS = {
  choose: ['healthy', 'Healthy'], changed: ['healthy', 'Healthy'], ready: ['healthy', 'Healthy'], red: ['risk', 'At risk'], real: ['incident', 'Under attack'],
  blue: ['mitigating', 'Fixing'], proven: ['mitigating', 'Fixing'], hardened: ['hardened', 'Fixed'], again: ['hardened', 'Fixed'],
  red2: ['risk', 'Testing again'], blue2: ['mitigating', 'Fixing'], proven2: ['hardened', 'Fixed'], finale: ['incident', 'Under attack'],
};

/**
 * @param {object[]} events   canonical events presented so far, in order
 * @param {object} state      the reducer's view state after them
 * @param {object} [o]
 * @param {'control'|'guided'} [o.mode]
 * @param {object} [o.judge]  the 'judge' side-channel message of this session (control mode)
 * @param {Map} [o.traces]    'trace' messages by event seq ({cypher, at})
 * @param {boolean} [o.awaiting]   the run is paused before round 2 and the presentation has caught up
 * @param {object[]} [o.amplification]   the amplification query's rows on the graph as it is now (the pre-run preview)
 */
export function storyModel(events, state, { mode = 'guided', judge = null, traces = new Map(), awaiting = false, amplification = null } = {}) {
  const g = state.graph;
  const f = facts(events, g, judge, traces);
  const chapter = chapterOf(f, mode, judge);
  const r1 = f.rounds[1], r2 = f.rounds[2];
  const r = f.rounds[f.round] ?? null;
  const total = state.rollouts ?? null;
  const edit = judge?.edits?.[0] ?? null;
  const [ea, eb] = edit ? edit.edge.split('>') : [];
  const ampBefore = judge?.amplification?.before?.[0] ?? amplification?.[0] ?? null;
  const storm = (row) => `${row.amplifier[0]} → ${row.amplifier[1]} retries multiply the load ${num(row.overload)}× along ${row.amplifier.join(' → ')}`;
  const p = { now: '', why: '', graph: '', result: '', proves: '' };

  const redGraph = (x) => {
    const parts = [];
    if (x.ampEmpty === true) parts.push('No retry storm anywhere.');
    if (x.ampEmpty === false && x.amp) parts.push(`A retry storm: ${storm(x.amp)}.`);
    if (x.rank) parts.push(`${x.rank} is the service everything depends on most.`);
    if (x.deploys?.length) parts.push(`A pending deploy, ${x.deploys[0].ce}, is about to change ${x.deploys[0].caller} → ${x.deploys[0].target}.`);
    return parts.join(' ') || 'RED is reading the graph…';
  };
  const redResult = (x) => {
    if (x.attack) return `Failure found: ${attackProse(g, x.attack.ids)}. It breaks the system in ${x.attack.sustained} of ${total ?? '?'} simulated runs.`;
    const t = x.redTests.at(-1);
    return t ? `Tested ${attackProse(g, t.ids)}: broken in ${t.sustained} of ${t.total} runs. Still searching…` : 'Searching…';
  };

  switch (chapter) {
    case 'choose':
      p.now = 'Nothing is running yet. ARGUS is waiting for your decision.';
      p.why = 'You configure the system first. ARGUS will then attack whatever you choose; it has no script for your choice.';
      p.graph = ampBefore ? `There is a retry storm: ${storm(ampBefore)} (highlighted on the graph).` : 'Reading the graph…';
      p.result = 'Choose one of the two settings below.';
      break;
    case 'changed':
      p.now = edit ? 'Your change was written into the system twin and the live system.' : 'Your choice is set. The system stays as it is.';
      p.why = 'ARGUS only knows what the graph tells it. Whatever you set is what it will reason about.';
      p.graph = edit ? (judge.amplification.after.length ? `The retry storm is still there: ${storm(judge.amplification.after[0])}.` : 'ARGUS\'s first question, "is there a retry storm?", now finds nothing. The highlighted path on the graph is gone.')
        : (ampBefore ? `The retry storm is still there: ${storm(ampBefore)}.` : '');
      p.result = edit ? `${ea} no longer retries failed calls to ${eb} (retries ${edit.before} → ${edit.after}).` : 'Nothing changed. ARGUS will attack the system as it is.';
      p.proves = edit ? 'The graph is live: ARGUS will see your change, not a pre-recorded answer.' : 'ARGUS starts from the configuration you chose.';
      break;
    case 'ready':
      p.now = 'ARGUS is about to start.';
      p.why = 'It will look for the failure before it happens, then for the smallest fix.';
      p.graph = 'The graph holds every service, every dependency, and how retries multiply load between them.';
      break;
    case 'red':
      p.now = r1.attack ? 'RED has found a way to break the system.' : 'RED is trying to break the system, on the twin, not on the real thing.';
      p.why = r1.ampEmpty === true ? 'Its usual clue, a retry storm, is gone. So RED asks the graph a different question: which service does everything depend on?'
        : r1.ampEmpty === false ? 'A retry storm is the classic way a small slowdown becomes an outage, so RED follows it.'
          : 'RED starts by asking the graph where a small slowdown could grow into an outage.';
      p.graph = redGraph(r1);
      p.result = redResult(r1);
      if (r1.attack) p.proves = mode === 'control' ? 'There is a real weakness in the system you configured, and RED found it from the graph.' : 'This system has a real weakness, and RED found it by reading the graph.';
      break;
    case 'real':
      p.now = r1.removed ? 'The slowdown has been removed. Does the system recover on its own?' : `Making it real: ${attackProse(g, r1.attack?.ids)} hits the live system.`;
      p.why = 'A simulation is only a prediction. The live system shows whether the failure really happens.';
      p.graph = r1.evidence?.length > 1 ? `The graph predicted the failure would travel ${r1.evidence.join(' → ')}.` : r1.evidence?.length ? `The graph pointed at ${r1.evidence[0]}.` : '';
      p.result = r1.removed
        ? `Still broken: ${r1.hold.bad} of ${r1.hold.ticks} moments since the removal were bad.`
        : r1.act.entries.size ? `${list([...r1.act.entries])} ${r1.act.entries.size === 1 ? 'is' : 'are'} failing for users (${r1.act.bad} of ${r1.act.ticks} moments bad).` : 'Watching the live system…';
      if (r1.removed && r1.hold.ticks && r1.hold.bad === r1.hold.ticks) p.proves = 'This failure sticks. Waiting will not fix it; the system needs a change.';
      break;
    case 'blue': case 'blue2': {
      const x = chapter === 'blue' ? r1 : r2;
      p.now = x.rejected ? 'ARGUS is checking BLUE\'s answer against the graph.' : 'BLUE is testing fixes, each on its own copy of the graph, before touching the live system.';
      p.why = chapter === 'blue' ? 'Changing a live system blindly is risky. A copy shows what each fix would do, safely.'
        : 'This time the attack has not happened yet, so ARGUS can prevent it instead of reacting to it.';
      p.graph = x.blueOptions ? `The graph offers ${times(x.blueOptions, 'possible fix', 'possible fixes')} near this failure.` : 'BLUE asks the graph which fixes are possible…';
      const lastF = x.futures.at(-1);
      p.result = x.rejected ? 'BLUE said "I found no safe fix." ARGUS rejected that answer: the graph shows a cheaper safe fix exists.'
        : x.proposedNone ? 'BLUE says: "I found no safe fix."'
          : lastF ? `${fixQuestion(g, lastF.ids)} ${answerOf(lastF.verdict, lastF.recover, total).answer}. (${times(x.futures.length, 'fix', 'fixes')} tried so far.)` : 'Preparing the first test…';
      break;
    }
    case 'proven': case 'proven2': {
      const x = chapter === 'proven' ? r1 : r2;
      p.now = x.rejected ? 'ARGUS overruled BLUE with a cheaper fix that it proved works.' : 'ARGUS double-checked BLUE\'s choice.';
      p.why = 'The agent proposes; the graph decides. ARGUS never applies a fix it has not proven.';
      p.graph = x.verified ? `ARGUS tested ${x.verified.alternatives} other possible fixes on copies of the graph. None cheaper works.` : '';
      p.result = x.fix ? `Chosen fix: ${fixProse(g, x.fix.ids)} (${changes(x.fix.count)}).${x.hardened.length ? ` Applied: ${x.hardened.join('; ')}.` : ''}` : '';
      p.proves = x.rejected ? 'The fix is the cheapest one that works: proven by the graph, not guessed by the agent.' : 'BLUE\'s fix is the cheapest one that works, and the graph proves it.';
      break;
    }
    case 'hardened':
      p.now = r1.observation ? 'Comparing the twin\'s prediction with what really happened.' : 'The fix is applied to the twin and the live system. Now we watch what really happens.';
      p.why = 'A fix only counts if reality agrees with the prediction.';
      p.graph = r1.hardened.length ? `Changed in the graph: ${r1.hardened.join('; ')}.` : '';
      p.result = r1.observation ? `Predicted ${num(r1.observation.predicted)} bad moments, observed ${num(r1.observation.observed)}: ${r1.observation.within ? 'within the predicted range' : 'outside the predicted range'}.`
        : r1.fix?.predicted !== undefined ? `The twin predicts about ${num(r1.fix.predicted)} bad moments before the system recovers.` : '';
      if (r1.observation) p.proves = r1.observation.within ? 'The twin\'s predictions match reality, so its next prediction can be trusted.' : 'The twin was off; ARGUS updates its model from what really happened.';
      break;
    case 'again':
      p.now = mode === 'control' ? (awaiting ? 'Your move: attack the hardened system.' : 'Starting the second attack.') : 'ARGUS attacks again.';
      p.why = 'Can ARGUS find a new way to break the system now that the first weakness is closed?';
      p.graph = r1?.hardened.length ? `The first weakness is closed: ${r1.hardened.join('; ')}.` : '';
      p.result = mode === 'control' && awaiting ? 'Press ATTACK AGAIN.' : '';
      if (r1?.observation) {
        p.proves = `The first fix worked, and the twin saw it coming: predicted ${num(r1.observation.predicted)} bad moments, observed ${num(r1.observation.observed)}.`;
      }
      break;
    case 'red2':
      p.now = r2.attack ? 'RED found a different way to break the system.' : 'RED attacks the hardened system.';
      p.why = r2.ampEmpty === true ? 'The retry storm it could use before is gone, so it cannot repeat the old attack. It looks for something new.' : 'It looks for a weakness the first fix did not cover.';
      p.graph = redGraph(r2);
      p.result = r2.attack ? `${cap(redResult(r2))}${r2.redTests.length > 1 ? ` (Alone, ${attackProse(g, r2.redTests[0].ids)} broke it in only ${r2.redTests[0].sustained} of ${r2.redTests[0].total}.)` : ''}` : redResult(r2);
      if (r2.attack) p.proves = 'ARGUS changed its attack because the graph changed.';
      break;
    case 'finale': {
      const x = r2 ?? r1;
      p.now = 'The real test: the attack runs on the live system, and the risky deploy really lands.';
      p.why = 'Only reality can show whether the fix holds.';
      p.graph = x.deploy ? `Deploy ${x.deploy.ce} landed: ${arrow(x.deploy.edge)} retries ${x.deploy.before} → ${x.deploy.after}.` : x.hardened.length ? `Fix in place: ${x.hardened.join('; ')}.` : '';
      p.result = x.finale.ticks ? `${x.finale.bad} bad moments so far, out of ${x.finale.ticks}.` : 'The attack begins…';
      break;
    }
    case 'safe':
      p.now = 'Done.';
      p.why = 'The live system faced the second attack, with the risky deploy really landing.';
      p.graph = 'The graph changed twice: once by the first fix, once by the deploy. Each time, ARGUS reasoned from the graph as it was.';
      p.result = `${f.result.violated} bad moments out of ${f.result.ticks}, within the allowed limit of ${f.result.budget}.`;
      p.proves = f.result.safe ? FINAL_LINE : 'The fix did not hold; the system exceeded its allowed limit.';
      break;
    default: break;
  }

  // what-if cards: RED's tests while RED works, BLUE's futures while BLUE works
  let whatif = null;
  if ((chapter === 'red' || chapter === 'red2') && r?.redTests.length) {
    whatif = { kind: 'red', label: "RED'S TESTS: what if…", cards: r.redTests.map((t) => ({ key: `r${t.seq}`, question: attackQuestion(g, t.ids),
      answer: t.sustained > t.total / 2 ? 'It breaks the system' : 'The system copes', tone: t.sustained > t.total / 2 ? 'bad' : 'good',
      detail: `broken in ${t.sustained} of ${t.total} runs`, chosen: !!r.attack && t.ids.join('+') === r.attack.ids.join('+') })) };
  } else if (['blue', 'blue2', 'proven', 'proven2'].includes(chapter) && r?.futures.length) {
    const fixKey = r.fix ? [...r.fix.ids].sort().join('+') : null;
    const cards = r.futures.map((x) => ({ key: x.futureId, question: fixQuestion(g, x.ids), ...answerOf(x.verdict, x.recover, total), chosen: fixKey !== null && [...x.ids].sort().join('+') === fixKey }));
    if (r.fix && !cards.some((c) => c.chosen)) cards.push({ key: 'proven', question: fixQuestion(g, r.fix.ids), answer: 'Works: found by ARGUS', tone: 'good', detail: `proven against ${r.verified?.alternatives ?? '?'} alternatives`, chosen: true });
    whatif = { kind: 'blue', label: "BLUE'S WHAT-IF FUTURES: each tested on its own copy of the graph", cards };
  }

  const status = f.result ? (f.result.safe ? ['safe', 'SAFE'] : ['unsafe', 'NOT SAFE']) : STATUS[chapter] ?? ['healthy', 'Healthy'];
  const chain = CHAINS[mode];
  return {
    mode, chapter, title: TITLE[chapter] ?? '', chain, step: STEP[mode][chapter] ?? 0, status: { key: status[0], label: status[1] },
    problem: PROBLEM, panel: p, whatif, evidence: f.evidence, speech: speechFor(chapter, f, g, { mode, judge, awaiting, total }),
    final: f.result ? finalFrame(f, g, judge) : null, rounds: f.rounds, awaiting: chapter === 'again' && mode === 'control' && awaiting,
  };
}

// ---------------------------------------------------------------- the spoken line of the latest speech moment
function speechFor(chapter, f, g, { mode, judge, awaiting }) {
  const r1 = f.rounds[1], r2 = f.rounds[2];
  const at = (round, beat, text) => ({ round, beat, text });
  // one change is named; several are counted (the Story panel lists them) so the line ends before the next beat
  const fixSpeech = (x) => (x.fix.count === 1 ? fixProse(g, x.fix.ids) : `${changes(x.fix.count)}, listed on screen`);
  switch (chapter) {
    case 'choose': return at(0, 'your_move', 'This is a live model of an online payment system, stored as a graph. Before ARGUS starts, you decide how it is configured. Choose one of the two settings.');
    case 'changed': return judge ? at(0, 'graph_changed', judge.edits.length ? 'That was a real change to the graph. The retry storm ARGUS would normally look for is gone.' : 'You kept the retries. ARGUS will attack the system as it is.') : null;
    case 'ready': return null;
    case 'red':
      if (r1.attack) {
        const how = r1.ampEmpty === true ? ' Because the retry storm was gone, it found this by asking which service everything depends on.' : r1.ampEmpty === false ? ' It followed the retry storm in the graph.' : '';
        return at(1, 'red_attack_found', `RED found a failure: ${attackProse(g, r1.attack.ids)}.${how}`);
      }
      return at(1, 'red_search', "RED's job is to find the failure. It searches the graph for a way to break this system.");
    case 'real':
      return r1.removed ? at(1, 'world_attack', 'This happened on the live system. Now the slowdown is removed. Watch whether the system recovers on its own.') : at(1, 'red_attack_found', `RED found a failure: ${attackProse(g, r1.attack?.ids)}.`);
    case 'blue':
      return r1.rejected ? at(1, 'verifier', 'BLUE found no safe fix. ARGUS checks that answer against the graph.')
        : at(1, 'blue_search', "BLUE's job is to find the fix. It tries each fix on its own copy of the graph, before touching the live system.");
    case 'proven':
      return r1.rejected ? at(1, 'intervention_selected', `ARGUS found a cheaper fix that works: ${fixSpeech(r1)}.`)
        : at(1, 'intervention_selected', `Verified. The cheapest fix that works: ${fixSpeech(r1)}.`);
    case 'hardened':
      if (r1.observation) return at(1, 'world_observation', `Predicted ${num(r1.observation.predicted)} bad moments, observed ${num(r1.observation.observed)}. ${r1.observation.within ? 'The twin and reality agree.' : 'ARGUS updates its model.'}`);
      return at(1, 'hardening', 'The fix is applied. Now we compare the twin\'s prediction with what really happens.');
    case 'again':
      if (mode === 'control') return awaiting ? at(2, 'round2', 'Your turn again. Press Attack Again, and see whether ARGUS can find a new way in.') : null;
      return at(2, 'round2', 'Now ARGUS attacks the hardened system again.');
    case 'red2':
      if (r2.attack) return at(2, 'red_attack_found', `New attack: ${attackProse(g, r2.attack.ids)}.${r2.attack.deploy ? ' RED found the deploy with a graph query.' : ''} BLUE now tests fixes before the attack happens.`);
      return at(2, 'red_search', 'RED attacks again. The old weakness is closed, so it has to reason differently.');
    case 'blue2':
      return r2.attack ? at(2, 'red_attack_found', `New attack: ${attackProse(g, r2.attack.ids)}.`) : null;
    case 'proven2':
      return r2.fix ? at(2, 'intervention_selected', `Verified. The cheapest fix that works: ${fixSpeech(r2)}.`) : null;
    case 'finale': return at(2, 'finale', 'The real test. The attack runs on the live system, and the risky deploy actually lands.');
    case 'safe': return f.result.safe ? at(2, 'safe', `Safe. ${f.result.violated} bad moments. ${FINAL_LINE}`) : at(2, 'safe', 'Not safe. The fix did not hold.');
    default: return null;
  }
}

// ---------------------------------------------------------------- the closing frame
function finalFrame(f, g, judge) {
  const columns = [];
  if (judge) {
    const e = judge.edits[0];
    columns.push({ kind: 'you', k: 'YOUR CHANGE', a: judge.label, b: e ? `${arrow(e.edge)} retries ${e.before} → ${e.after}` : 'the system as it was', c: '' });
  }
  for (const n of [1, 2]) {
    const x = f.rounds[n];
    if (!x?.attack) continue;
    const cause = x.attack.deploy ? 'found by asking the graph for pending deploys'
      : x.ampEmpty === false ? 'found by following the retry storm in the graph'
        : 'found by asking which service everything depends on';
    columns.push({ kind: 'round', k: `ATTACK ${n} → FIX ${n}`, a: cap(attackProse(g, x.attack.ids)), b: cause,
      c: x.fix ? `Fix: ${fixProse(g, x.fix.ids)} (${changes(x.fix.count)}) · ${x.rejected ? 'found by the verifier' : 'proven by the graph'}` : '' });
  }
  return { safe: f.result.safe, line: f.result.safe ? FINAL_LINE : 'The fix did not hold.', violated: f.result.violated, ticks: f.result.ticks, budget: f.result.budget, columns };
}
