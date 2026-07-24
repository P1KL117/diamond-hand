import { fetchDailyPool, REQUIRED_POSITIONS } from './pool.js';
import { createDraft } from './draft.js';
import { playOut } from './playout.js';

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
  renderDraft();
  show('draft');
}

const POS_LABEL = { C: 'C', '1B': '1B', '2B': '2B', '3B': '3B', SS: 'SS', LF: 'LF', CF: 'CF', RF: 'RF', DH: 'DH' };

function renderDraft() {
  $('draft-round-label').textContent = `Round ${Math.min(draft.round + 1, draft.totalRounds)} / ${draft.totalRounds}`;

  // position tracker
  $('position-tracker').innerHTML = REQUIRED_POSITIONS.map(pos => {
    const filledPlayer = draft.slots.find(s => s && s.position === pos);
    const cls = filledPlayer ? 'filled' : 'open';
    const fill = filledPlayer ? `<span class="pos-fill">${filledPlayer.name.split(' ').slice(-1)[0]}</span>` : '';
    return `<span class="pos-chip ${cls}">${POS_LABEL[pos]}${fill}</span>`;
  }).join('');

  // rolled team
  const t = draft.currentTeam;
  $('draft-rolled').innerHTML = t
    ? `<span class="roll-label">YOU ROLLED</span>
       <span class="roll-team">${t.abbreviation}</span>
       <span class="roll-vs">${t.name} vs ${t.opponent}</span>
       <button id="btn-reroll" class="btn-secondary reroll-btn" ${draft.rerollsLeft ? '' : 'disabled'}>
         🎲 Reroll (${draft.rerollsLeft} left)</button>`
    : '<span class="roll-label">No eligible team — draft complete</span>';

  // player board — all rolled-team batters; ineligible (positions filled) greyed out
  const roster = t ? [...t.players] : [];
  roster.sort((a, b) => {
    const ea = draft.isEligible(a), eb = draft.isEligible(b);
    if (ea !== eb) return ea ? -1 : 1;         // eligible first
    return b.value - a.value;                  // then by night value
  });
  $('draft-board').innerHTML = roster.map(p => {
    const open = draft.openPositionsFor(p);
    const eligible = open.length > 0;
    const hot = p.value >= 4 ? 'hot' : '';
    const posLabel = (eligible ? open : p.positions).join('/');
    return `<button class="player-card ${eligible ? '' : 'disabled'}" data-id="${p.id}" ${eligible ? '' : 'disabled'}>
      <span class="pc-pos">${posLabel}</span>
      <span class="pc-name">${p.name}</span>
      <span class="pc-team">${p.teamAbbr} vs ${t.opponent}${eligible ? '' : ' · position filled'}</span>
      <span class="pc-line ${hot}">${p.line.summary}</span>
      <span class="pc-season">Season: ${p.season.avg} avg · ${p.season.hr} HR · ${p.season.ops} OPS</span>
    </button>`;
  }).join('');

  // mini lineup
  $('draft-lineup-mini').innerHTML = draft.slots.map((s, i) =>
    `<span class="mini-slot ${s ? 'set' : ''}">${i + 1}. ${s ? s.position : '—'}</span>`).join('');
}

$('draft-board').addEventListener('click', e => {
  const btn = e.target.closest('.player-card:not([disabled])'); if (!btn) return;
  const player = draft.currentTeam.players.find(p => p.id === Number(btn.dataset.id)); if (!player) return;
  const open = draft.openPositionsFor(player);
  if (open.length > 1) showPositionPicker(player, open);
  else showSlotPicker(player, open[0]);
});

function showPositionPicker(player, open) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">${player.name} played multiple spots</div>
      <div class="modal-subtitle">Which position should they fill?</div>
      <div class="slot-grid">${open.map(pos =>
        `<button class="slot-btn" data-pos="${pos}"><span class="slot-num">${pos}</span></button>`).join('')}</div>
      <div class="modal-actions"><button class="btn-secondary" id="pos-cancel">Cancel</button></div>
    </div>`;
  modal.querySelectorAll('.slot-btn').forEach(b =>
    b.addEventListener('click', () => { modal.remove(); showSlotPicker(player, b.dataset.pos); }));
  modal.querySelector('#pos-cancel').addEventListener('click', () => modal.remove());
  $('app').appendChild(modal);
}

$('draft-rolled').addEventListener('click', e => {
  if (!e.target.closest('#btn-reroll')) return;
  const r = draft.reroll();
  if (r.ok) renderDraft();
});

function showSlotPicker(player, chosenPosition) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const slotBtns = draft.slots.map((s, i) => `
    <button class="slot-btn" data-slot="${i}" ${s ? 'disabled' : ''}>
      <span class="slot-num">${i + 1}</span>
      <span class="slot-occ">${s ? s.position : 'open'}</span>
    </button>`).join('');
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">Bat ${player.name} where?</div>
      <div class="modal-subtitle">${chosenPosition} · ${player.teamAbbr} · ${player.line.summary}</div>
      <div class="slot-grid">${slotBtns}</div>
      <div class="modal-actions"><button class="btn-secondary" id="slot-cancel">Cancel</button></div>
    </div>`;
  modal.querySelectorAll('.slot-btn:not([disabled])').forEach(b =>
    b.addEventListener('click', () => {
      const slotIdx = Number(b.dataset.slot);
      const r = draft.pick(player.id, slotIdx, chosenPosition);
      modal.remove();
      if (!r.ok) return;
      if (r.done) { renderLineupReview(); show('lineup'); }
      else { draft.rollTeam(); renderDraft(); }
    }));
  modal.querySelector('#slot-cancel').addEventListener('click', () => modal.remove());
  $('app').appendChild(modal);
}

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
  show('gameday');
  scheduleNext();
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
