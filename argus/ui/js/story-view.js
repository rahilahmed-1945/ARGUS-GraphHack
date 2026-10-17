// The storytelling screen around the twin: the causal-chain strip and chapter title (header), the Story panel that
// answers the six questions in plain English (left), the judge's two actions (Control mode), the what-if cards
// (bottom), the Evidence column — plain sentences first, the technical record collapsed behind ▸ query (right) —
// and the closing frame. It renders the pure story model (story.js); nothing here computes or invents a result.
import { CAST } from './story.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WHO = { you: 'YOU', red: 'RED', blue: 'BLUE', verifier: 'ARGUS', argus: 'ARGUS', live: 'LIVE' };
const DB = '<svg class="db" viewBox="0 0 12 14" aria-label="FalkorDB operation"><ellipse cx="6" cy="3" rx="5" ry="2"/><path d="M1 3v8c0 1.1 2.2 2 5 2s5-.9 5-2V3"/><path d="M1 7c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg>';
const ROWS = [['now', 'WHAT ARGUS IS DOING'], ['why', 'WHY'], ['graph', 'WHAT THE GRAPH SAID'], ['result', 'WHAT HAPPENED'], ['proves', 'WHAT THIS PROVES']];

function clock(at) {
  if (!at) return '';
  const d = new Date(at);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const setHtml = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };

export function createStoryView({ onChoose, onAttackAgain, onReset = () => {} }) {
  let busy = false;
  const rows = new Map();               // evidence key → <li> (kept, so an opened ▸ query stays open)

  $('#cast-legend').innerHTML = CAST.map((c) => `<div class="cl k-${c.key}"><b>${esc(c.title)}</b><span>${esc(c.text)}</span></div>`).join('');
  $('#story-actions').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || busy) return;
    if (b.dataset.choice) { busy = true; onChoose(b.dataset.choice); }
    if (b.id === 'attack-again') { b.disabled = true; onAttackAgain(); }
  });
  $('#story-notice').addEventListener('click', (e) => { if (e.target.closest('button#notice-reset')) onReset(); });

  // a refusal, a failed run or a lost connection, said in the Story panel (the server's reason, never invented), with
  // the way out when there is one; '' clears it
  function notice(text, { reset = false } = {}) {
    setHtml($('#story-notice'), text ? `${esc(text)}${reset ? '<button id="notice-reset">RESET AND START AGAIN</button>' : ''}` : '');
  }
  // forget the rendered actions so the next render re-enables buttons a click had disabled
  function refreshActions() { busy = false; $('#story-actions').dataset.html = ''; }

  function head(m) {
    setHtml($('#chain'), m.chain.map((label, i) => `<li class="${i < m.step ? 'done' : i === m.step ? 'on' : ''}">${esc(label)}</li>`).join(''));
    $('#chapter-title').textContent = m.title;
    $('#chapter-title').dataset.chapter = m.chapter;
  }

  function panel(m) {
    $('#story-problem').textContent = m.problem;
    setHtml($('#story-rows'), ROWS.map(([k, label]) => `<div class="sr ${m.panel[k] ? '' : 'empty'}" data-row="${k}"><div class="sr-k">${label}</div><div class="sr-v">${esc(m.panel[k] || '…')}</div></div>`).join(''));
  }

  function actions(m, { choices, canChoose, canAttack }) {
    let html = '';
    if (m.mode === 'control' && m.chapter === 'choose') {
      html = `<div class="sa-k">YOUR MOVE</div>${(choices ?? []).map((c) => `<button class="choice" data-choice="${esc(c.id)}" ${canChoose ? '' : 'disabled'}><b>${esc(c.label)}</b><span>${esc(c.detail)}</span></button>`).join('')}`;
    } else if (m.awaiting) {
      html = `<div class="sa-k">YOUR MOVE</div><button id="attack-again" class="again" ${canAttack ? '' : 'disabled'}>&#9654;&nbsp;&nbsp;ATTACK AGAIN</button>`;
    }
    if ($('#story-actions').dataset.html !== html) busy = false;
    setHtml($('#story-actions'), html);
  }

  function whatif(m) {
    const w = m.whatif;
    const el = $('#whatif');
    el.classList.toggle('show', !!w);
    el.dataset.kind = w?.kind ?? '';
    if (!w) return;
    setHtml(el, `<div class="wi-k">${esc(w.label)}</div><div class="wi-cards">${w.cards.map((c) => `<div class="wi t-${c.tone} ${c.chosen ? 'chosen' : ''}">`
      + `<div class="wi-q">${esc(c.question)}</div><div class="wi-a">${esc(c.answer)}${c.chosen ? ' <i>✓ chosen</i>' : ''}</div><div class="wi-d">${esc(c.detail)}</div></div>`).join('')}</div>`);
  }

  function evidence(m) {
    const list = $('#ev-list');
    for (const r of m.evidence) {
      let li = rows.get(r.key);
      if (!li) {
        li = document.createElement('li');
        li.className = `ev w-${r.who} ${r.ok === false ? 'bad' : ''}`;
        li.innerHTML = `<div class="ev-top"><span class="ev-who">${WHO[r.who] ?? esc(r.who)}</span>${r.db ? DB : ''}<span class="ev-text"></span></div>`
          + '<details class="ev-tech"><summary>▸ query</summary><div class="ev-meta"></div><code class="ev-cy"></code></details>';
        $('.ev-text', li).textContent = r.text;
        list.prepend(li);                                   // newest first
        rows.set(r.key, li);
      }
      const meta = `${r.tech.label}${r.tech.detail ? ` · ${r.tech.detail}` : ''}${r.tech.at ? ` · ${clock(r.tech.at)}` : ''}`;
      if ($('.ev-meta', li).textContent !== meta) $('.ev-meta', li).textContent = meta;
      const cy = (r.tech.cypher ?? '').trim();
      if ($('.ev-cy', li).textContent !== cy) { $('.ev-cy', li).textContent = cy; $('.ev-cy', li).style.display = cy ? '' : 'none'; }
    }
    $('#ev-empty').style.display = m.evidence.length ? 'none' : '';
  }

  function final(m) {
    const f = m.final;
    const el = $('#final');
    el.classList.toggle('show', !!f);
    if (!f) return;
    setHtml(el, `<div class="fn-big ${f.safe ? 'ok' : 'bad'}">${f.safe ? 'SAFE' : 'NOT SAFE'}</div><div class="fn-line">${esc(f.line)}</div>`
      + `<div class="fn-sub">${f.violated} bad moments out of ${f.ticks} on the live system · allowed limit ${f.budget}</div>`
      + `<div class="fn-cols">${f.columns.map((c) => `<div class="fn-col k-${c.kind}"><div class="fc-k">${esc(c.k)}</div><div class="fc-a">${esc(c.a)}</div><div class="fc-b">${esc(c.b)}</div>${c.c ? `<div class="fc-c">${esc(c.c)}</div>` : ''}</div>`).join('<div class="fn-arrow">→</div>')}</div>`);
  }

  return {
    render(m, ctx) { head(m); panel(m); actions(m, ctx); whatif(m); evidence(m); final(m); },
    notice,
    refreshActions,
    clear() {
      busy = false;
      rows.clear();
      $('#ev-list').innerHTML = '';
      for (const id of ['#whatif', '#final', '#story-actions', '#story-notice']) { $(id).innerHTML = ''; $(id).dataset.html = ''; }   // markup and its cache together
    },
  };
}
