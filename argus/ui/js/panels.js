// Everything around the 3D twin: header stage + status, the twin-belief chip, moment banners, the counterfactual
// futures branches, the live agent activity and the current decision. Each render() reads the event-derived view
// state; nothing here computes or invents a result.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const num = (x) => (x === null || x === undefined ? '—' : Number.isInteger(x) ? String(x) : Number(x).toFixed(1));
const ROLE = { red: 'RED', blue: 'BLUE', server: 'M5', world: 'WORLD' };
const STEP_LABEL = { red: 'RED', world: 'WORLD', blue: 'BLUE', harden: 'HARDEN', observe: 'OBSERVE' };
const path = (names, arrow = '→') => names.map((n) => `<span class="pn">${esc(n)}</span>`).join(`<span class="pa">${arrow}</span>`);

/* DISPLAY CONSTANTS — how long banners stay up (ms at 1×) and how many activity rows are shown. */
const BANNER_MS = { round: 3400, attack: 3400, decision: 3200, hardened: 4400, notice: 2800, safe: Infinity, unsafe: Infinity };
const BANNER_KICKER = { round: 'ROUND', attack: 'RED', decision: 'BLUE', hardened: 'HARDENING', notice: 'WORLD', safe: 'SYSTEM STATUS', unsafe: 'SYSTEM STATUS' };
const ACTIVITY_ROWS = 3;
/* END DISPLAY CONSTANTS */

export function createPanels() {
  let bannerSeq = null;
  let bannerTimer = null;
  let speedOf = () => 1;
  const cards = new Map();

  function header(s) {
    $('#stage-round').textContent = s.round ? `ROUND ${pad(s.round)}  ·  ${s.roundTitle}` : 'ARGUS RUNTIME';
    const [actor, ...rest] = s.stage.title.split(' · ');
    const hasActor = rest.length > 0;
    $('#stage-actor').textContent = hasActor ? actor : '';
    $('#stage-title').textContent = hasActor ? rest.join(' · ') : s.stage.title;
    $('#stage-sub').textContent = s.stage.sub ?? '';
    if (!s.started) { $('#stage-title').textContent = 'READY'; $('#stage-sub').textContent = 'Canonical run · replayed through the live runtime'; }
    const steps = s.steps.filter((x) => x.round === s.round);
    const html = (steps.length ? steps : Object.keys(STEP_LABEL).map((key) => ({ key, state: 'pending' })))
      .map((x) => `<div class="pg ${x.state} k-${x.key}"><i></i><span>${STEP_LABEL[x.key]}</span></div>`).join('');
    const pg = $('#progress-steps');
    if (pg.innerHTML !== html) pg.innerHTML = html;
    $('#status-text').textContent = s.status.label;
  }

  function belief(s) {
    const w = s.world;
    $('#world-seg').textContent = w.segment ?? '';
    $('#world-seg').className = `bl-seg ${w.segment ? `s-${w.segment.toLowerCase()}` : ''}`;
    $('#world-tick').textContent = w.tick === null ? '' : `t ${pad(w.tick, 3)}`;
    const entries = (s.graph?.services ?? []).filter((x) => x.entry);
    const html = entries.map((e) => {
      const bad = w.violatedEntries.includes(e.name);
      const st = w.tick === null ? '' : bad ? 'SLO violated' : 'SLO met';
      return `<div class="bl-entry ${w.tick === null ? '' : bad ? 'bad' : 'ok'}"><i></i><b>${esc(e.name)}</b><span>${st}</span></div>`;
    }).join('');
    if ($('#world-entries').innerHTML !== html) $('#world-entries').innerHTML = html;
    $('#twin-clock').textContent = { paused: '· world frozen while planning', running: '', held: '· held' }[w.clock] ?? '';
    const c = s.calibration.at(-1);
    const truth = c && s.worldGraph?.services?.find((x) => x.name === c.service)?.cap_mean;
    const cal = c
      ? `${esc(c.service)} capacity <span class="v">${num(c.after)}</span> belief · <span class="w">${num(truth)}</span> world${truth !== undefined ? `<span class="d">Δ ${num(Math.abs(c.after - truth))}</span>` : ''}`
      : 'model belief · not yet calibrated';
    if ($('#twin-cal').innerHTML !== cal) $('#twin-cal').innerHTML = cal;
  }

  function banner(s) {
    const el = $('#banner');
    const b = s.banner;
    if (!b) { if (bannerSeq !== null && !['safe', 'unsafe'].includes(el.dataset.kind)) { el.classList.remove('show'); bannerSeq = null; } return; }
    if (b.seq === bannerSeq) return;
    bannerSeq = b.seq;
    el.dataset.kind = b.kind;
    el.className = `banner k-${b.kind}`;
    $('#banner-k').textContent = b.kind === 'round' ? s.roundTitle ?? '' : BANNER_KICKER[b.kind] ?? '';
    $('#banner-title').textContent = b.title;
    $('#banner-sub').textContent = b.kind === 'round' ? '' : b.sub ?? '';
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(bannerTimer);
    const ms = BANNER_MS[b.kind] ?? 2800;
    if (Number.isFinite(ms)) bannerTimer = setTimeout(() => el.classList.remove('show'), ms / Math.max(1, speedOf()));
  }

  // ---------------------------------------------------------------- counterfactual futures (only while an agent simulates)
  function futures(s) {
    const box = $('#futures');
    const f = s.futures;
    const show = f.items.length > 0 && (s.actor === 'red' || s.actor === 'blue');
    box.classList.toggle('show', show);
    box.classList.toggle('attack', f.mode === 'attack');
    box.classList.toggle('defense', f.mode === 'defense');
    $('#fx-mode').textContent = f.mode === 'attack' ? 'ATTACK FUTURES · RED' : f.mode === 'defense' ? 'INTERVENTION FUTURES · BLUE' : 'COUNTERFACTUAL FUTURES';
    $('#fx-root-sub').textContent = f.root?.sub ?? '';
    const row = $('#fx-cards');
    const keep = new Set(f.items.map((it) => `${f.mode}:${it.key}`));
    for (const [k, el] of cards) if (!keep.has(k)) { el.remove(); cards.delete(k); }
    const total = s.rollouts;
    for (const it of f.items) {
      const k = `${f.mode}:${it.key}`;
      let el = cards.get(k);
      if (!el) {
        el = document.createElement('div');
        el.innerHTML = '<div class="fc-top"><span class="fc-id"></span><span class="fc-v"></span></div><div class="fc-label"></div><div class="fc-metric"></div><div class="fc-sub"></div><div class="fc-bar"><i></i></div>';
        row.appendChild(el);
        cards.set(k, el);
      }
      const m = it.metric;
      const sel = !!it.selected;
      const state = it.state === 'measured' ? 'running' : it.state;
      el.className = `fx-card ${state} ${sel ? 'selected' : ''} ${f.converged && !sel ? 'recede' : ''}`;
      $('.fc-id', el).textContent = `F${it.n}`;
      $('.fc-label', el).textContent = it.label;
      let verdict = '', metric = '', sub = '', fill = 0;
      if (f.mode === 'attack') {
        verdict = sel ? 'ATTACK' : it.state === 'qualify' ? 'QUALIFIES' : it.state === 'fail' ? 'FAILS' : '';
        metric = m ? `${m.sustained}/${m.total}<small>sustained</small>` : '…';
        sub = `cost ${num(it.cost)}`;
        fill = m ? m.sustained / Math.max(1, m.total) : 0;
      } else {
        verdict = sel ? 'SELECTED' : m ? m.verdict.toUpperCase() : '';
        metric = m ? `${m.recover}${total ? `/${total}` : ''}<small>recover</small>` : '…';
        sub = m ? `median ${num(m.median)} · cost ${num(m.cost)}` : `cost ${num(it.cost)}`;
        fill = m && total ? m.recover / total : 0;
      }
      $('.fc-v', el).textContent = verdict;
      $('.fc-v', el).style.visibility = verdict ? 'visible' : 'hidden';
      if ($('.fc-metric', el).innerHTML !== metric) $('.fc-metric', el).innerHTML = metric;
      $('.fc-sub', el).textContent = sub;
      if (state !== 'running') $('.fc-bar i', el).style.width = `${Math.round(fill * 100)}%`;
    }
    // connectors: from the CURRENT SYSTEM root to each future
    requestAnimationFrame(() => {
      const svg = $('#fx-links');
      const sb = svg.getBoundingClientRect();
      const rootX = sb.width / 2;
      const paths = f.items.map((it) => {
        const el = cards.get(`${f.mode}:${it.key}`);
        if (!el) return '';
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2 - sb.left;
        const cls = `${it.state === 'measured' ? 'running' : it.state} ${it.selected ? 'selected' : ''}`;
        return `<path class="${cls}" d="M${rootX},0 C${rootX},${sb.height * 0.6} ${x},${sb.height * 0.4} ${x},${sb.height}"/>`;
      }).join('');
      svg.setAttribute('viewBox', `0 0 ${Math.max(1, sb.width)} ${Math.max(1, sb.height)}`);
      if (svg.innerHTML !== paths) svg.innerHTML = paths;
    });
  }

  // ---------------------------------------------------------------- live agent activity: role · action · result
  function activity(s) {
    const list = $('#activity-list');
    const rows = s.activity.slice(-ACTIVITY_ROWS).reverse();
    const keys = rows.map((r) => String(r.seq)).join(',');
    if (list.dataset.keys === keys) return;
    list.dataset.keys = keys;
    const existing = new Map([...list.children].map((el) => [el.dataset.seq, el]));
    list.innerHTML = '';
    for (const r of rows) {
      let li = existing.get(String(r.seq));
      if (!li) {
        li = document.createElement('li');
        li.dataset.seq = r.seq;
        li.className = `act r-${r.role} ${r.ok ? '' : 'bad'}${r.by ? ` by-${r.by}` : ''}`;
        li.innerHTML = `<div class="a-role">${ROLE[r.role] ?? esc(r.role)}</div><div><div class="a-action">${esc(r.action ?? r.title)}${r.by === 'b5' ? '<span class="by">autopilot</span>' : ''}</div>`
          + `<div class="a-result">${resultHtml(r)}</div></div><div class="a-metric ${metricCls(r)}">${metricHtml(r)}</div>`;
      } else li.style.animation = 'none';
      list.appendChild(li);
    }
    $('#activity-empty').style.display = rows.length ? 'none' : '';
  }
  const resultHtml = (r) => (r.data?.path ? `${path(r.data.path)}` : esc(r.result ?? r.detail));
  function metricHtml(r) {
    const d = r.data;
    if (!d) return '';
    if (r.tool === 'amplification_paths') return `${num(d.overload)}×<small>retry load</small>`;
    if (r.tool === 'simulate') return `${d.sustained}/${d.total}<small>sustained</small>`;
    if (r.tool === 'fork_and_simulate' && d.recover !== undefined) return `${d.recover}<small>${esc(d.verdict ?? '')}</small>`;
    if (r.tool === 'commit' && r.role === 'red' && d.sustained !== undefined) return `${d.sustained}<small>sustained</small>`;
    if (r.tool === 'commit' && d.id) return `${esc(d.id)}<small>decision</small>`;
    return '';
  }
  function metricCls(r) {
    const d = r.data;
    if (!d) return '';
    if (r.tool === 'simulate') return d.sustained > d.total / 2 ? 'attack' : 'bad';
    if (r.tool === 'fork_and_simulate') return d.verdict === 'green' ? 'good' : d.verdict === 'amber' ? 'warn' : 'bad';
    if (r.tool === 'amplification_paths') return 'warn';
    return '';
  }

  // ---------------------------------------------------------------- current decision: only what matters for this stage
  function decision(s) {
    const el = $('#decision-body');
    const d = s.decision, o = s.observation, r = s.result;
    const h = s.hardening && s.hardening.round === s.round ? s.hardening : null;
    let html;
    if (r) {
      html = `<div class="dc ${r.safe ? 'safe' : 'unsafe'}"><div class="dc-k">FINAL WORLD OUTCOME</div><div class="dc-big">${r.safe ? 'SAFE' : 'NOT SAFE'}</div>`
        + `<div class="dc-stats"><div class="dc-stat"><div class="l">VIOLATED TICKS</div><div class="v">${r.observed_viol_ticks}</div></div>`
        + `<div class="dc-stat"><div class="l">HORIZON</div><div class="v">${r.ticks}<small>ticks</small></div></div>`
        + `<div class="dc-stat"><div class="l">ERROR BUDGET</div><div class="v">${r.error_budget}</div></div></div></div>`;
    } else if (o && o.round === s.round) {
      html = `<div class="dc obs"><div class="dc-k">PREDICTED vs OBSERVED</div><div class="dc-cmp">`
        + `<div><div class="l">TWIN PREDICTED</div><div class="v">${num(o.predicted)}</div><div class="s">band ${num(o.band[0])}–${num(o.band[1])}</div></div>`
        + `<div><div class="l">WORLD OBSERVED</div><div class="v ${o.withinBand ? 'ok' : 'warn'}">${num(o.observed)}</div><div class="s">violated ticks</div></div>`
        + `<div><div class="l">CALIBRATION</div><div class="s" style="font-size:15px;color:var(--ink);margin-top:2px">${o.withinBand ? 'within the predicted band' : 'outside the predicted band'}</div></div>`
        + '</div></div>';
    } else if (h) {
      html = `<div class="dc hard"><div class="dc-k">SYSTEM HARDENED</div><div class="dc-big">${esc((h.label ?? '').replace(/^./, (c) => c.toUpperCase()))}</div>`
        + h.changes.slice(0, 3).map((c) => `<div class="dc-chg"><span class="e">${esc((c.edge ?? c.service ?? '').replace('>', ' → '))}</span><span class="f">${esc(c.field === 'cap_mean' ? 'capacity' : c.field)}</span><span class="b">${num(c.before)}</span><span class="a">→ ${num(c.after)}</span></div>`).join('')
        + '</div>';
    } else if (d?.kind === 'decision') {
      html = `<div class="dc dec"><div class="dc-k">MINIMUM EFFECTIVE INTERVENTION</div><div class="dc-big">${esc(d.interventions.join(' + ') || 'NO SAFE ACTION')}</div>`
        + `<div class="dc-stats"><div class="dc-stat"><div class="l">RECOVERS</div><div class="v">${num(d.recover)}${s.rollouts ? `<small>/ ${s.rollouts}</small>` : ''}</div></div>`
        + `<div class="dc-stat"><div class="l">PREDICTED</div><div class="v">${num(d.predicted)}<small>violated ticks</small></div></div>`
        + `<div class="dc-stat"><div class="l">COST</div><div class="v">${num(d.cost)}</div></div></div>`
        + `<div class="dc-note">${esc(d.minimality)} · the server audited ${d.auditSims} cheaper-or-equal futures</div></div>`;
    } else if (d?.kind === 'attack') {
      html = `<div class="dc attack"><div class="dc-k">ATTACK IDENTIFIED</div><div class="dc-big">${esc(d.faults.join(' + '))}</div>`
        + (d.evidence?.length ? `<div class="dc-path">${path(d.evidence)}</div>` : '')
        + `<div class="dc-stats"><div class="dc-stat"><div class="l">IMPACT</div><div class="v">${d.sustained}${s.rollouts ? `<small>/ ${s.rollouts} sustained</small>` : ''}</div></div>`
        + `<div class="dc-stat"><div class="l">ATTACKER COST</div><div class="v">${num(d.cost)}</div></div></div></div>`;
    } else {
      html = `<div class="placeholder">${s.started ? 'Waiting for a committed attack or decision' : 'No run yet'}</div>`;
    }
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  return {
    setSpeedSource(f) { speedOf = f; },
    render(s) { header(s); belief(s); banner(s); futures(s); activity(s); decision(s); },
    futuresHeight() { const el = $('#futures'); return el.classList.contains('show') ? el.offsetHeight : 0; },
    clear() {
      cards.forEach((el) => el.remove()); cards.clear();
      const list = $('#activity-list'); list.innerHTML = ''; list.dataset.keys = '';
      bannerSeq = null; $('#banner').className = 'banner';
      $('#fx-links').innerHTML = '';
    },
  };
}
