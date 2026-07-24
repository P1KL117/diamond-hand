import { fetchDailyPool, REQUIRED_POSITIONS } from './pool.js';
import { createDraft } from './draft.js';
import { playOut } from './playout.js';
import { seqCodes } from './outcomes.js';

// ── Date helpers ────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
function yesterdayStr() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
const params = new URLSearchParams(location.search);
const GAME_DATE = params.get('date') || yesterdayStr();
const FALLBACK_DATE = '2024-09-01'; // used if the target date has no final games

// ── State ───────────────────────────────────────────────────────────────────
let pool = null;
let draft = null;
let activeDate = GAME_DATE;

// draft UI state
let draftSort = 'value';
let draftFilter = 'ALL';
let sel = null; // { playerId, position } — currently selected player awaiting a slot tap

const $ = id => document.getElementById(id);
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  $('home-date').textContent = 'Loading last night\'s games…';
  try {
    pool = await fetchDailyPool(GAME_DATE);
    if (!pool.teams.length && GAME_DATE !== FALLBACK_DATE) {
      pool = await fetchDailyPool(FALLBACK_DATE);
      activeDate = FALLBACK_DATE;
    }
  } catch (e) {
    $('home-date').textContent = `Failed to load: ${e.message}`;
    return;
  }
  renderHome();
}

function fmtDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function renderHome() {
  const label = activeDate === GAME_DATE ? 'Games from' : 'Sample games from';
  $('home-date').textContent = pool.teams.length
    ? `${label} ${fmtDate(activeDate)} · ${pool.teams.length} teams`
    : 'No completed games found for that date.';
  $('btn-start-draft').disabled = !pool.teams.length;
  const best = loadBest(activeDate);
  $('home-best').textContent = best != null ? `Your best today: ${best} runs` : '';
}

// ── Draft ───────────────────────────────────────────────────────────────────
function startDraft() {
  draft = createDraft({ teams: pool.teams, date: activeDate, mode: 'daily' });
  draft.start();
  sel = null; draftFilter = 'ALL';
  renderDraft();
  show('draft');
}

const lastName = n => n.split(' ').slice(-1)[0];
const POS_GROUPS = { IF: ['1B', '2B', '3B', 'SS'], OF: ['LF', 'CF', 'RF'], C: ['C'], DH: ['DH'] };
const FILTERS = ['ALL', 'IF', 'OF', 'C', 'DH'];

function renderDraft() {
  const t = draft.currentTeam;
  $('draft-round-label').textContent = `Round ${Math.min(draft.round + 1, draft.totalRounds)} / ${draft.totalRounds}`;
  $('draft-team-abbr').textContent = t ? t.abbreviation : '—';
  $('draft-vs').textContent = t ? `vs ${t.opponent}` : '';
  const rr = $('btn-reroll');
  rr.textContent = `Reroll (${draft.rerollsLeft})`;
  rr.disabled = !draft.rerollsLeft;

  // position coverage chips
  $('position-tracker').innerHTML = REQUIRED_POSITIONS.map(pos => {
    const f = draft.slots.find(s => s && s.position === pos);
    return `<span class="pos-chip ${f ? 'filled' : ''}">${pos}${f ? `<span class="pos-fill">${lastName(f.name)}</span>` : ''}</span>`;
  }).join('');

  // filter chips + sort
  $('draft-filters').innerHTML = FILTERS.map(f =>
    `<button class="fchip ${draftFilter === f ? 'active' : ''}" data-f="${f}">${f}</button>`).join('');
  $('draft-sort').value = draftSort;

  renderBoard();
  renderTray();
  updateInstr();
}

function matchesFilter(p) {
  if (draftFilter === 'ALL') return true;
  return p.positions.some(pos => (POS_GROUPS[draftFilter] || []).includes(pos));
}

function rowHtml(p) {
  const open = draft.openPositionsFor(p);
  const eligible = open.length > 0;
  const posLabel = (eligible ? open : p.positions).join('/');
  const selected = sel && sel.playerId === p.id;
  const seq = seqCodes(p.results).join(' · ') || '—';
  const s = p.stats;
  const cols = [['AB', s.ab], ['H', s.h], ['HR', s.hr], ['RBI', s.rbi], ['BB', s.bb], ['TB', s.tb]];
  const stats = cols.map(([l, v]) =>
    `<span class="stat"><span class="stat-num ${l === 'HR' && v > 0 ? 'hot' : ''}">${v}</span><span class="stat-lbl">${l}</span></span>`).join('');
  return `<button class="prow ${eligible ? '' : 'disabled'} ${selected ? 'selected' : ''}" data-id="${p.id}" ${eligible ? '' : 'disabled'}>
    <span class="prow-badge">${posLabel}</span>
    <span class="prow-id">
      <span class="prow-name">${p.name}</span>
      <span class="prow-sub">${p.teamAbbr} · ${p.line.summary} · ${seq}</span>
    </span>
    <span class="prow-stats">${stats}</span>
  </button>`;
}

function renderBoard() {
  const t = draft.currentTeam;
  const players = (t ? t.players : []).filter(matchesFilter);
  const board = $('draft-board');
  if (draftSort === 'position') {
    const html = [];
    for (const pos of REQUIRED_POSITIONS) {
      const grp = players.filter(p => p.position === pos).sort((a, b) => b.value - a.value);
      if (!grp.length) continue;
      html.push(`<div class="grp-header">${pos} <span class="grp-count">· ${grp.length}</span></div>`);
      html.push(grp.map(rowHtml).join(''));
    }
    board.innerHTML = html.join('') || '<div class="prow-sub" style="padding:10px">No players match.</div>';
  } else {
    players.sort((a, b) => {
      const ea = draft.isEligible(a), eb = draft.isEligible(b);
      if (ea !== eb) return ea ? -1 : 1;
      if (draftSort === 'name') return a.name.localeCompare(b.name);
      return b.value - a.value;
    });
    board.innerHTML = players.map(rowHtml).join('') || '<div class="prow-sub" style="padding:10px">No players match.</div>';
  }
}

function renderTray() {
  const armed = !!sel;
  $('draft-tray').innerHTML = draft.slots.map((s, i) => {
    if (s) return `<div class="tray-slot filled"><span class="ts-num">${i + 1}</span><span class="ts-pos">${s.position}</span><span class="ts-name">${lastName(s.name)}</span></div>`;
    return `<div class="tray-slot open ${armed ? 'armed' : ''}" data-slot="${i}"><span class="ts-num">${i + 1}</span><span class="ts-empty">open</span></div>`;
  }).join('');
}

function updateInstr() {
  const el = $('draft-instr');
  if (sel) {
    const p = draft.currentTeam.players.find(x => x.id === sel.playerId);
    el.textContent = `Tap an open slot to bat ${p ? p.name : ''} (${sel.position})`;
    el.classList.add('armed');
  } else {
    el.textContent = 'Select a player, then tap an open lineup slot.';
    el.classList.remove('armed');
  }
}

// Select a player (arm the tray). Multi-position players choose a spot first.
function selectPlayer(p) {
  if (sel && sel.playerId === p.id) { sel = null; renderDraft(); return; } // toggle off
  const open = draft.openPositionsFor(p);
  if (open.length > 1) {
    showPositionPicker(p, open, pos => { sel = { playerId: p.id, position: pos }; renderDraft(); });
  } else {
    sel = { playerId: p.id, position: open[0] };
    renderDraft();
  }
}

function showPositionPicker(player, open, onChoose) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">${player.name} played multiple spots</div>
      <div class="modal-subtitle">Which position should they fill?</div>
      <div class="slot-grid">${open.map(pos => `<button class="slot-btn" data-pos="${pos}"><span class="slot-num">${pos}</span></button>`).join('')}</div>
      <div class="modal-actions"><button class="btn-secondary" id="pos-cancel">Cancel</button></div>
    </div>`;
  modal.querySelectorAll('.slot-btn').forEach(b =>
    b.addEventListener('click', () => { modal.remove(); onChoose(b.dataset.pos); }));
  modal.querySelector('#pos-cancel').addEventListener('click', () => modal.remove());
  $('app').appendChild(modal);
}

function placeInSlot(slotIndex) {
  if (!sel) return;
  const r = draft.pick(sel.playerId, slotIndex, sel.position);
  if (!r.ok) return;
  sel = null;
  if (r.done) { renderLineupReview(); show('lineup'); }
  else { draft.rollTeam(); renderDraft(); }
}

// ── Draft event wiring (delegated on static containers) ───────────────────────
$('draft-board').addEventListener('click', e => {
  const row = e.target.closest('.prow:not([disabled])'); if (!row) return;
  const player = draft.currentTeam.players.find(p => p.id === Number(row.dataset.id));
  if (player) selectPlayer(player);
});
$('draft-tray').addEventListener('click', e => {
  const slot = e.target.closest('.tray-slot.open.armed'); if (!slot) return;
  placeInSlot(Number(slot.dataset.slot));
});
$('draft-filters').addEventListener('click', e => {
  const chip = e.target.closest('.fchip'); if (!chip) return;
  draftFilter = chip.dataset.f; renderDraft();
});
$('draft-sort').addEventListener('change', e => { draftSort = e.target.value; renderBoard(); });
$('btn-reroll').addEventListener('click', () => { const r = draft.reroll(); if (r.ok) { sel = null; renderDraft(); } });

$('btn-start-draft').addEventListener('click', startDraft);
$('btn-draft-home').addEventListener('click', () => show('home'));

// ── Lineup review ─────────────────────────────────────────────────────────────
function renderLineupReview() {
  $('lineup-list').innerHTML = draft.lineup().map(p => {
    const hot = p.value >= 4 ? 'hot' : '';
    return `<div class="lineup-row">
      <span class="lr-slot">${p.battingSlot}</span>
      <span class="lr-pos">${p.position}</span>
      <span class="lr-name">${p.name}</span>
      <span class="lr-team">${p.teamAbbr}</span>
      <span class="lr-line ${hot}">${p.line.summary}</span>
    </div>`;
  }).join('');
}
$('btn-lineup-back').addEventListener('click', () => { renderDraft(); show('draft'); });
$('btn-play-game').addEventListener('click', startGameday);

// ── Gameday play-out ──────────────────────────────────────────────────────────
const RESULT_VERB = {
  HR: 'homers', triple: 'triples', double: 'doubles', single: 'singles',
  BB: 'walks', HBP: 'is hit by the pitch', K: 'strikes out', groundout: 'grounds out',
  flyout: 'flies out', lineout: 'lines out', DP: 'grounds into a double play',
  FC: 'reaches on a fielder\'s choice', sac_fly: 'hits a sacrifice fly',
};
let gdState = null;

function startGameday() {
  const lineup = draft.lineup();
  const res = playOut(lineup);
  gdState = { res, lineup, i: 0, speed: 1, timer: null, finished: false };
  // reset visuals
  setBases([false, false, false]);
  setOuts(0);
  setInning(1, true);
  $('gd-runs').textContent = '0';
  $('gd-ticker').innerHTML = '';
  renderScoreboard([], 0);
  $('btn-gd-speed').textContent = '▶ 1×';
  renderGdLineup(0);
  show('gameday');
  scheduleNext();
}

// Live lineup panel: each batter's day sequence + ABs used, current batter hilit
function renderGdLineup(uptoIndex) {
  const log = gdState.res.log;
  const lastSlot = uptoIndex > 0 ? log[uptoIndex - 1].slot : 0;
  const used = Array(9).fill(0);
  for (let k = 0; k < uptoIndex; k++) used[log[k].slot - 1]++;
  $('gd-lineup').innerHTML = gdState.lineup.map((p, idx) => {
    const codes = seqCodes(p.results);
    const u = used[idx], total = codes.length;
    const seq = codes.map((c, j) => {
      const hit = ['1B', '2B', '3B', 'HR'].includes(c);
      const cls = j < u ? `played${hit ? ' hit' : ''}` : j === u ? 'next' : '';
      return `<span class="gdl-code ${cls}">${c}</span>`;
    }).join('');
    const batting = (idx + 1) === lastSlot;
    const done = u >= total;
    return `<div class="gdl-row ${batting ? 'batting' : ''} ${done && !batting ? 'done' : ''}">
      <span class="gdl-slot">${idx + 1}</span>
      <span class="gdl-pos">${p.position}</span>
      <span class="gdl-name">${p.name}</span>
      <span class="gdl-seq">${seq}</span>
      <span class="gdl-abs"><span class="${u < total ? 'abs-hot' : ''}">${u}/${total}</span> ABs</span>
    </div>`;
  }).join('');
}

const SPEED_MS = { 1: 900, 2: 450, 4: 200 };
function scheduleNext() {
  if (!gdState || gdState.finished) return;
  if (gdState.i >= gdState.res.log.length) { finishGameday(); return; }
  gdState.timer = setTimeout(stepGameday, SPEED_MS[gdState.speed]);
}

function stepGameday() {
  const e = gdState.res.log[gdState.i++];
  setInning(e.inning, true);
  setBases(e.basesAfter);
  setOuts(e.outsAfter);
  $('gd-runs').textContent = e.totalRuns;
  renderScoreboard(cumulativeInnings(gdState.i), e.totalRuns);
  const verb = RESULT_VERB[e.result] ?? e.result;
  const runTxt = e.runsScored ? `  +${e.runsScored} run${e.runsScored > 1 ? 's' : ''}` : '';
  addTicker(`${e.player} ${verb}${runTxt}`, e.runsScored ? 'run' : (isHitResult(e.result) ? 'hit' : ''));
  renderGdLineup(gdState.i);
  scheduleNext();
}

function isHitResult(r) { return ['HR', 'triple', 'double', 'single'].includes(r); }

// per-inning cumulative runs up to the play index shown
function cumulativeInnings(uptoIndex) {
  const per = [];
  for (let k = 0; k < uptoIndex; k++) {
    const e = gdState.res.log[k];
    per[e.inning - 1] = (per[e.inning - 1] || 0) + e.runsScored;
  }
  return per;
}

function finishGameday() {
  gdState.finished = true;
  renderResult(gdState.res, gdState.lineup);
  saveBest(activeDate, gdState.res.runs);
  show('result');
}

function skipToScore() {
  if (!gdState) return;
  clearTimeout(gdState.timer);
  gdState.finished = true;
  finishGameday();
}

$('btn-gd-skip').addEventListener('click', skipToScore);
$('btn-gd-speed').addEventListener('click', () => {
  if (!gdState) return;
  gdState.speed = gdState.speed === 1 ? 2 : gdState.speed === 2 ? 4 : 1;
  $('btn-gd-speed').textContent = `▶ ${gdState.speed}×`;
});

// ── Gameday visual helpers ────────────────────────────────────────────────────
function setBases(bases) {
  [['base-1', 'runner-1'], ['base-2', 'runner-2'], ['base-3', 'runner-3']].forEach(([bid, rid], i) => {
    $(bid).style.fill = bases[i] ? '#f59e0b' : '#2a2d3e';
    $(rid).style.opacity = bases[i] ? '1' : '0';
  });
}
function setOuts(n) { for (let i = 0; i < 3; i++) $(`gd-out-${i}`).classList.toggle('filled', i < n); }
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
function setInning(n) { $('gd-inning').textContent = `▲ ${ORD[n] ?? n + 'th'}`; }

function addTicker(text, type = '') {
  const log = $('gd-ticker');
  const el = document.createElement('div');
  el.className = `ticker-entry${type ? ' ' + type : ''}`;
  el.textContent = text;
  log.prepend(el);
  while (log.children.length > 30) log.lastChild.remove();
}

function renderScoreboard(inningRuns, total) {
  const cells = Array.from({ length: 9 }, (_, i) =>
    `<td class="sb-cell">${inningRuns[i] != null ? inningRuns[i] : ''}</td>`).join('');
  $('gd-scoreboard').innerHTML = `
    <table class="sb-table">
      <thead><tr><th class="sb-team-col"></th>${[1,2,3,4,5,6,7,8,9].map(n => `<th class="sb-cell">${n}</th>`).join('')}<th class="sb-r">R</th></tr></thead>
      <tbody><tr><td class="sb-team-col">YOU</td>${cells}<td class="sb-r">${total}</td></tr></tbody>
    </table>`;
}

// ── Result ────────────────────────────────────────────────────────────────────
function renderResult(res, lineup) {
  $('result-runs').textContent = res.runs;
  $('result-sub').textContent = `${res.inningsPlayed} innings · ${res.totalPAs} at-bats · ended on ${res.endedBy === 'innings' ? '9 innings' : 'at-bat exhaustion'}`;

  const per = cumulativeInnings(res.log.length);
  const cells = Array.from({ length: 9 }, (_, i) => `<td class="sb-cell">${per[i] != null ? per[i] : ''}</td>`).join('');
  $('result-line').innerHTML = `
    <table class="sb-table" style="width:100%">
      <thead><tr><th class="sb-team-col"></th>${[1,2,3,4,5,6,7,8,9].map(n => `<th class="sb-cell">${n}</th>`).join('')}<th class="sb-r">R</th></tr></thead>
      <tbody><tr><td class="sb-team-col">YOU</td>${cells}<td class="sb-r">${res.runs}</td></tr></tbody>
    </table>`;

  // box score per player (runs driven in via their result contributions is complex;
  // show their real batting line for the day)
  $('result-lineup').innerHTML = lineup.map(p => {
    const hot = p.value >= 4 ? 'hot' : '';
    return `<div class="rl-box-row">
      <span class="rb-pos">${p.position}</span>
      <span class="rb-name">${p.battingSlot}. ${p.name} <span style="color:var(--muted)">${p.teamAbbr}</span></span>
      <span class="rb-line ${hot}">${p.line.summary}</span>
    </div>`;
  }).join('');
}

$('btn-result-home').addEventListener('click', () => { renderHome(); show('home'); });

$('btn-share').addEventListener('click', () => {
  const res = gdState.res;
  const line = cumulativeInnings(res.log.length);
  const grid = Array.from({ length: 9 }, (_, i) => line[i] != null ? line[i] : '·').join(' ');
  const text = `⚾ Diamond Hand — Daily Lineup ${activeDate}\n${res.runs} RUNS\n${grid}\nDraft your lineup, beat my score!`;
  navigator.clipboard?.writeText(text).then(() => {
    $('btn-share').textContent = '✓ Copied!';
    setTimeout(() => { $('btn-share').textContent = '📋 Copy Result'; }, 1800);
  });
});

// ── Best-score persistence ────────────────────────────────────────────────────
function bestKey(date) { return `dh-best-${date}`; }
function loadBest(date) { const v = localStorage.getItem(bestKey(date)); return v == null ? null : Number(v); }
function saveBest(date, runs) {
  const cur = loadBest(date);
  if (cur == null || runs > cur) localStorage.setItem(bestKey(date), String(runs));
}

boot();
