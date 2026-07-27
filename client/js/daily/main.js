import { fetchDailyPool, REQUIRED_POSITIONS } from './pool.js';
import { createDraft } from './draft.js';
import { playOut } from './playout.js';
import { seqCodes } from './outcomes.js';
import { seededRng } from './rng.js';
import { bestDailyDraft } from './bestdraft.js';

// ── Date helpers ────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
function yesterdayStr() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
const offsetDate = (d, days) => {
  const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
};
const params = new URLSearchParams(location.search);
const EXPLICIT_DATE = params.get('date');       // ?date= overrides (for testing)
const GAME_DATE = EXPLICIT_DATE || yesterdayStr();
const FALLBACK_DATE = '2024-09-01'; // last-resort demo slate (deep offseason only)

// ── State ───────────────────────────────────────────────────────────────────
let pool = null;
let draft = null;
let activeDate = GAME_DATE;

// draft UI state
let draftSort = 'tb';
let draftFilter = 'ALL';
let sel = null; // { playerId, position } — currently selected player awaiting a slot tap
let cadence = 'daily'; // 'daily' | 'free'
let style = 'normal';  // 'normal' | 'blind' | 'shuffled'
let dailyDate = null;  // the resolved daily slate (Daily cadence locks to this)
let orderChanges = false;      // free play: can rearrange batting order after drafting
let selectedTeamIds = null;    // free play: Set of team ids to draft from (null = all)

const STYLE_DESC = {
  normal: 'See exactly what each player did — pure lineup construction.',
  blind: 'Stats hidden at the draft — pick on reputation, reveal at game time.',
  shuffled: 'You see the stats, but each player\'s outcomes fire in a random order.',
};
const CADENCE_DESC = {
  daily: 'Today\'s slate · same draft for everyone · counts on the leaderboard.',
  free: 'Random teams · pick any date · unlimited · not ranked.',
};

const $ = id => document.getElementById(id);
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  $('home-date').textContent = 'Loading last night\'s games…';
  try {
    // The server resolves the current daily (yesterday's games, 5am ET rollover,
    // walked back to the most recent complete slate). ?date= overrides for testing.
    pool = await fetchDailyPool(EXPLICIT_DATE || undefined);
    activeDate = pool.date;
    if (!pool.teams.length) { pool = await fetchDailyPool(FALLBACK_DATE); activeDate = pool.date; }
  } catch (e) {
    $('home-date').textContent = `Failed to load: ${e.message}`;
    return;
  }
  dailyDate = activeDate;                 // Daily cadence is locked to this slate
  $('date-picker').value = activeDate;
  renderHome();
  if (!seenIntro()) showHowTo();          // first visit only
}

// ── How to Play (first-run intro + reopenable) ────────────────────────────────
let introSeenSession = false;
function seenIntro(markSeen) {
  const KEY = 'lc-seen-intro';
  if (markSeen) { introSeenSession = true; try { localStorage.setItem(KEY, '1'); } catch {} return; }
  try { if (localStorage.getItem(KEY)) return true; } catch {}
  return introSeenSession; // private mode: don't nag more than once per session
}
const HOWTO_CARDS = [
  { icon: '📋', title: 'The idea', body: 'Each day you build a 9-player lineup from batters who actually played in yesterday\'s MLB games — then watch it play out and try to score the most runs.' },
  { icon: '🎲', title: 'Draft your lineup', body: 'Every round a random team is rolled. Pick one of their players and drop them into an open spot in your batting order. Don\'t like the team? Reroll. Keep going until all 9 spots (C, 1B, 2B … DH) are filled.' },
  { icon: '⚾', title: 'They hit what they really hit', body: 'Then your lineup plays a 9-inning game — and every player\'s real at-bats from that night fire in order. A homer\'s a homer, a strikeout\'s a strikeout. All that matters is who you drafted and where you bat them.' },
  { icon: '🏆', title: 'Beat the league', body: 'Score as many runs as you can and try to out-hit every real team that played that day. Post your score to the daily leaderboard — then share it and see if friends can beat you.' },
];
function showHowTo() {
  seenIntro(true);
  let i = 0;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const render = () => {
    const c = HOWTO_CARDS[i], last = i === HOWTO_CARDS.length - 1;
    modal.innerHTML = `
      <div class="modal-box howto-box">
        <div class="howto-icon">${c.icon}</div>
        <div class="howto-title">${c.title}</div>
        <div class="howto-body">${c.body}</div>
        <div class="howto-dots">${HOWTO_CARDS.map((_, j) => `<span class="howto-dot ${j === i ? 'on' : ''}"></span>`).join('')}</div>
        <div class="modal-actions">
          ${i > 0 ? '<button class="btn-secondary" id="ht-back">Back</button>' : '<button class="btn-secondary" id="ht-skip">Skip</button>'}
          <button class="btn-primary" id="ht-next">${last ? 'Got it ⚾' : 'Next →'}</button>
        </div>
      </div>`;
    modal.querySelector('#ht-next').addEventListener('click', () => { if (last) modal.remove(); else { i++; render(); } });
    modal.querySelector('#ht-back')?.addEventListener('click', () => { i--; render(); });
    modal.querySelector('#ht-skip')?.addEventListener('click', () => modal.remove());
  };
  render();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  $('app').appendChild(modal);
}
$('btn-how-to').addEventListener('click', showHowTo);

function fmtDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function renderHome() {
  const label = activeDate === FALLBACK_DATE ? 'Demo slate —' : 'Games from';
  $('home-date').textContent = pool.teams.length
    ? `${label} ${fmtDate(activeDate)} · ${pool.teams.length} teams`
    : 'No completed games found for that date.';
  $('btn-start-draft').disabled = !pool.teams.length;

  // active chips
  document.querySelectorAll('#cadence-select .mode-chip').forEach(c => c.classList.toggle('active', c.dataset.cadence === cadence));
  document.querySelectorAll('#style-select .mode-chip').forEach(c => c.classList.toggle('active', c.dataset.style === style));
  $('date-group').style.display = cadence === 'free' ? '' : 'none';
  $('mode-desc').textContent = `${CADENCE_DESC[cadence]}  ${STYLE_DESC[style]}`;

  const best = loadBest(activeDate, style);
  $('home-best').textContent = best != null ? `Your best (${style}): ${best} runs` : '';
  renderHomeLeaderboard();
}

$('cadence-select').addEventListener('click', async e => {
  const chip = e.target.closest('.mode-chip'); if (!chip) return;
  cadence = chip.dataset.cadence;
  if (cadence === 'daily' && activeDate !== dailyDate) {
    activeDate = dailyDate; pool = await fetchDailyPool(dailyDate);
  }
  renderHome();
});
$('style-select').addEventListener('click', e => {
  const chip = e.target.closest('.mode-chip'); if (!chip) return;
  style = chip.dataset.style;
  renderHome();
});
$('date-picker').addEventListener('change', async e => {
  const d = e.target.value; if (!d) return;
  $('home-date').textContent = 'Loading…';
  try { pool = await fetchDailyPool(d); activeDate = d; } catch { pool = { teams: [] }; }
  selectedTeamIds = null; // new slate → reset team picks
  renderHome();
});

// ── Draft ───────────────────────────────────────────────────────────────────
// Home "Start" → Daily goes straight to the draft; Free Play goes to the setup screen.
function onStartClick() {
  if (cadence === 'free') { renderSetup(); show('setup'); }
  else { orderChanges = false; selectedTeamIds = null; startDraft(); }
}

function startDraft() {
  let teams = pool.teams;
  if (cadence === 'free' && selectedTeamIds && selectedTeamIds.size) {
    const filtered = teams.filter(t => selectedTeamIds.has(t.id));
    if (filtered.length) teams = filtered;
  }
  draft = createDraft({ teams, date: activeDate, style, deterministic: cadence === 'daily' });
  draft.start();
  sel = null; draftFilter = 'ALL';
  renderDraft();
  show('draft');
}

// ── Free Play setup screen ────────────────────────────────────────────────────
function renderSetup() {
  document.querySelectorAll('#setup-order .mode-chip').forEach(c => c.classList.toggle('active', (c.dataset.order === 'on') === orderChanges));
  $('setup-order-hint').textContent = orderChanges
    ? 'On — after drafting, tap two players in the review to swap their batting spots.'
    : 'Off — batting order is locked as you draft it (like Daily).';
  if (!selectedTeamIds) selectedTeamIds = new Set((pool.teams ?? []).map(t => t.id));
  $('setup-teams').innerHTML = (pool.teams ?? []).map(t =>
    `<button class="team-chip ${selectedTeamIds.has(t.id) ? 'sel' : ''}" data-id="${t.id}">${t.abbreviation}<span class="tc-opp">v ${t.opponent}</span></button>`).join('');
  updateTeamsHint();
}
function updateTeamsHint() {
  const n = selectedTeamIds ? selectedTeamIds.size : 0;
  const el = $('setup-teams-hint');
  el.textContent = n === 0 ? 'Pick at least one team to draft from.'
    : `Every roll comes from your ${n} selected team${n > 1 ? 's' : ''}.`;
  $('btn-setup-start').disabled = n === 0;
}
$('setup-order').addEventListener('click', e => {
  const c = e.target.closest('.mode-chip'); if (!c) return;
  orderChanges = c.dataset.order === 'on'; renderSetup();
});
$('setup-teams').addEventListener('click', e => {
  const c = e.target.closest('.team-chip'); if (!c) return;
  const id = Number(c.dataset.id);
  if (selectedTeamIds.has(id)) selectedTeamIds.delete(id); else selectedTeamIds.add(id);
  c.classList.toggle('sel'); updateTeamsHint();
});
$('setup-teams-all').addEventListener('click', () => { selectedTeamIds = new Set((pool.teams ?? []).map(t => t.id)); renderSetup(); });
$('setup-teams-clear').addEventListener('click', () => { selectedTeamIds = new Set(); renderSetup(); });
$('btn-setup-back').addEventListener('click', () => show('home'));
$('btn-setup-start').addEventListener('click', () => { if (selectedTeamIds && selectedTeamIds.size) startDraft(); });

const lastName = n => n.split(' ').slice(-1)[0];
const POS_GROUPS = { IF: ['1B', '2B', '3B', 'SS'], OF: ['LF', 'CF', 'RF'], C: ['C'], DH: ['DH'] };
const FILTERS = ['ALL', 'IF', 'OF', 'C', 'DH'];
const SORT_NIGHT = [['tb', 'Total bases'], ['hits', 'Hits'], ['avg', 'AVG (night)'], ['position', 'Position'], ['name', 'Name']];
const SORT_SEASON = [['s_ops', 'Season OPS'], ['s_hr', 'Season HR'], ['s_rbi', 'Season RBI'], ['s_avg', 'Season AVG'], ['position', 'Position'], ['name', 'Name']];
// value used by the current sort (night stats normally; season stats in blind)
function sortKey(p) {
  switch (draftSort) {
    case 'hits':  return p.stats.h;
    case 'avg':   return p.stats.ab ? p.stats.h / p.stats.ab : 0;
    case 's_ops': return parseFloat(p.season.ops) || 0;
    case 's_hr':  return p.season.hr;
    case 's_rbi': return p.season.rbi;
    case 's_avg': return parseFloat(p.season.avg) || 0;
    default:      return p.stats.tb; // 'tb'
  }
}

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

  // filter chips + sort. Blind mode sorts by SEASON stats (night stats are hidden).
  $('draft-filters').innerHTML = FILTERS.map(f =>
    `<button class="fchip ${draftFilter === f ? 'active' : ''}" data-f="${f}">${f}</button>`).join('');
  const opts = style === 'blind' ? SORT_SEASON : SORT_NIGHT;
  if (!opts.some(([v]) => v === draftSort)) draftSort = opts[0][0];
  $('draft-sort').innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('draft-sort').value = draftSort;

  renderBoard();
  renderTray();
  updateInstr();
}

function matchesFilter(p) {
  if (draftFilter === 'ALL') return true;
  return p.positions.some(pos => (POS_GROUPS[draftFilter] || []).includes(pos));
}

const SEQ_CLASS = c => ['1B', '2B', '3B', 'HR'].includes(c) ? 'hit'
  : (c === 'BB' || c === 'HBP') ? 'walk'
  : c === 'DP' ? 'dp' : 'out';
const seqChips = codes => codes.map(c => `<span class="seq-chip ${SEQ_CLASS(c)}">${c}</span>`).join('');

function rowHtml(p) {
  const open = draft.openPositionsFor(p);
  const eligible = open.length > 0;
  const posLabel = (eligible ? open : p.positions).join('/');
  const selected = sel && sel.playerId === p.id;
  const blind = style === 'blind';
  const s = p.stats;

  // Right-side stat cluster — a clean, spaced set (fewer columns than before).
  const statCluster = blind
    ? `<span class="pstat"><b>${p.season.avg}</b><i>AVG</i></span>
       <span class="pstat"><b>${p.season.hr}</b><i>HR</i></span>
       <span class="pstat"><b>${p.season.rbi}</b><i>RBI</i></span>
       <span class="pstat"><b>${p.season.ops}</b><i>OPS</i></span>`
    : `<span class="pstat-line">${s.h}-${s.ab}</span>
       <span class="pstat"><b>${s.hr}</b><i>HR</i></span>
       <span class="pstat"><b>${s.rbi}</b><i>RBI</i></span>
       <span class="pstat"><b>${s.tb}</b><i>TB</i></span>`;

  // Day sequence chips fill the middle of the row (hidden in blind mode).
  const seqMid = blind
    ? `<span class="prow-seq blind">hidden — reveal at game time</span>`
    : `<span class="prow-seq">${seqChips(seqCodes(p.results))}</span>`;

  // One player per row, spanning the full width: badge · identity · sequence · stats
  return `<button class="prow ${eligible ? '' : 'disabled'} ${selected ? 'selected' : ''}" data-id="${p.id}" ${eligible ? '' : 'disabled'}>
    <span class="prow-badge">${posLabel}</span>
    <span class="prow-id">
      <span class="prow-name">${p.name}</span>
      <span class="prow-sub">${p.teamAbbr} · vs ${draft.currentTeam?.opponent ?? ''}</span>
    </span>
    ${seqMid}
    <span class="prow-stats">${statCluster}</span>
  </button>`;
}

function renderBoard() {
  const t = draft.currentTeam;
  const players = (t ? t.players : []).filter(matchesFilter);
  const board = $('draft-board');
  if (draftSort === 'position') {
    const html = [];
    for (const pos of REQUIRED_POSITIONS) {
      const grp = players.filter(p => p.position === pos).sort((a, b) => sortKey(b) - sortKey(a));
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
      return sortKey(b) - sortKey(a);
    });
    board.innerHTML = players.map(rowHtml).join('') || '<div class="prow-sub" style="padding:10px">No players match.</div>';
  }
}

function renderTray() {
  const armed = !!sel;
  $('draft-tray').innerHTML = draft.slots.map((s, i) => {
    if (s) {
      const tip = `${s.name} — ${s.line.summary} · ${seqCodes(s.results).join(' ')} (tap to view)`;
      return `<div class="tray-slot filled" data-slot="${i}" title="${tip}"><span class="ts-num">${i + 1}</span><span class="ts-pos">${s.position}</span><span class="ts-name">${lastName(s.name)}</span></div>`;
    }
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
  const filled = e.target.closest('.tray-slot.filled');
  if (filled) { showLineupPlayerModal(draft.slots[Number(filled.dataset.slot)]); return; }
  const slot = e.target.closest('.tray-slot.open.armed'); if (!slot) return;
  placeInSlot(Number(slot.dataset.slot));
});

// Popup: what a drafted player did that day (their at-bats, in order)
function showLineupPlayerModal(p) {
  if (!p) return;
  const s = p.stats;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:420px">
      <div class="modal-title">${p.name} <span style="color:var(--muted2);font-size:.8rem;font-weight:600">${p.position} · ${p.teamAbbr}</span></div>
      <div class="modal-subtitle">${p.line.summary} · these at-bats play in order</div>
      <div class="prow-seq" style="margin:12px 0;justify-content:center">${seqChips(seqCodes(p.results))}</div>
      <div class="prow-stats" style="justify-content:center;gap:16px">
        <span class="pstat"><b>${s.ab}</b><i>AB</i></span>
        <span class="pstat"><b>${s.h}</b><i>H</i></span>
        <span class="pstat"><b>${s.hr}</b><i>HR</i></span>
        <span class="pstat"><b>${s.rbi}</b><i>RBI</i></span>
        <span class="pstat"><b>${s.bb}</b><i>BB</i></span>
        <span class="pstat"><b>${s.tb}</b><i>TB</i></span>
      </div>
      <div class="modal-actions"><button class="btn-primary" id="lp-close">Close</button></div>
    </div>`;
  modal.querySelector('#lp-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  $('app').appendChild(modal);
}
$('draft-filters').addEventListener('click', e => {
  const chip = e.target.closest('.fchip'); if (!chip) return;
  draftFilter = chip.dataset.f; renderDraft();
});
$('draft-sort').addEventListener('change', e => { draftSort = e.target.value; renderBoard(); });
$('btn-reroll').addEventListener('click', () => { const r = draft.reroll(); if (r.ok) { sel = null; renderDraft(); } });

$('btn-start-draft').addEventListener('click', onStartClick);
$('btn-draft-home').addEventListener('click', () => show('home'));

// ── Lineup review ─────────────────────────────────────────────────────────────
let swapSel = null; // index of the first row picked for a reorder swap
function renderLineupReview() {
  const reorder = cadence === 'free' && orderChanges;
  const hint = reorder ? `<div class="lineup-reorder-hint">↕ Tap two players to swap their batting spots.</div>` : '';
  $('lineup-list').innerHTML = hint + draft.lineup().map(p => {
    const hot = p.value >= 4 ? 'hot' : '';
    const i = p.battingSlot - 1;
    return `<div class="lineup-row${reorder ? ' reorderable' : ''}${swapSel === i ? ' swap-sel' : ''}" data-slot="${i}">
      <span class="lr-slot">${p.battingSlot}</span>
      <span class="lr-pos">${p.position}</span>
      <span class="lr-name">${p.name}</span>
      <span class="lr-team">${p.teamAbbr}</span>
      <span class="lr-line ${hot}">${p.line.summary}</span>
    </div>`;
  }).join('');
}
$('lineup-list').addEventListener('click', e => {
  if (!(cadence === 'free' && orderChanges)) return;
  const row = e.target.closest('.lineup-row[data-slot]'); if (!row) return;
  const idx = Number(row.dataset.slot);
  if (swapSel === null) { swapSel = idx; }
  else { if (swapSel !== idx) draft.swapSlots(swapSel, idx); swapSel = null; }
  renderLineupReview();
});
$('btn-lineup-back').addEventListener('click', () => { swapSel = null; renderDraft(); show('draft'); });
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
  let lineup = draft.lineup();
  // Shuffled style: each player's outcomes fire in a random (per-day deterministic) order
  if (style === 'shuffled') {
    lineup = lineup.map(p => ({
      ...p,
      results: seededRng(`${activeDate}:shuffled:${p.id}`).shuffle(p.results),
    }));
  }
  const res = playOut(lineup);
  gdState = { res, lineup, i: 0, speed: 1, timer: null, finished: false, paused: false, lastInning: 0, cadence, style, date: activeDate };
  // reset visuals
  setBases([false, false, false]);
  setOuts(0);
  setInning(1, true);
  $('gd-runs').textContent = '0';
  $('gd-ticker').innerHTML = '';
  renderScoreboard([], 0, 0);
  $('btn-gd-speed').textContent = '1×';
  $('btn-gd-pause').textContent = '⏸';
  ['btn-gd-pause', 'btn-gd-next', 'btn-gd-speed', 'btn-gd-skip'].forEach(id => $(id).style.display = '');
  $('btn-gd-results').style.display = 'none';
  renderGdLineup(0);
  renderNowBatting(res.log[0]);
  show('gameday');
  scheduleNext();
}

// Broadcast-style "at bat" bar for the batter whose result is showing
function renderNowBatting(e) {
  const el = $('gd-now-batting');
  if (!e) { el.innerHTML = ''; return; }
  const p = gdState.lineup[e.slot - 1] ?? {};
  el.innerHTML = `
    <span class="nb-label">AT BAT</span>
    <span class="nb-slot">${e.slot}</span>
    <span class="nb-pos">${p.position ?? ''}</span>
    <span class="nb-name">${e.player}</span>
    <span class="nb-team">${p.teamAbbr ?? ''}</span>
    <span class="nb-line">${p.line?.summary ?? ''}</span>`;
}

// Live lineup panel: each batter's day sequence + ABs used, current batter hilit
function renderGdLineup(uptoIndex) {
  const log = gdState.res.log;
  const lastSlot = uptoIndex > 0 ? log[uptoIndex - 1].slot : 0;
  const used = Array(9).fill(0);   // real ABs consumed (exhausted auto-outs don't count)
  for (let k = 0; k < uptoIndex; k++) if (!log[k].exhausted) used[log[k].slot - 1]++;
  $('gd-lineup').innerHTML = gdState.lineup.map((p, idx) => {
    const codes = seqCodes(p.results);
    const u = used[idx], total = codes.length;
    const seq = codes.map((c, j) => {
      const hit = ['1B', '2B', '3B', 'HR'].includes(c);
      const cls = j < u ? `played${hit ? ' hit' : ''}` : j === u ? 'next' : '';
      return `<span class="gdl-code ${cls}">${c}</span>`;
    }).join('');
    const batting = (idx + 1) === lastSlot;
    const spent = u >= total;
    const absTxt = spent
      ? `<span style="color:var(--muted)">${total}/${total} · spent</span>`
      : `<span class="abs-hot">${u}/${total}</span> ABs`;
    return `<div class="gdl-row ${batting ? 'batting' : ''} ${spent && !batting ? 'done' : ''}">
      <span class="gdl-slot">${idx + 1}</span>
      <span class="gdl-pos">${p.position}</span>
      <span class="gdl-name">${p.name}</span>
      <span class="gdl-seq">${seq}</span>
      <span class="gdl-abs">${absTxt}</span>
    </div>`;
  }).join('');
}

const SPEED_MS = { 1: 900, 2: 450, 4: 200 };
function scheduleNext() {
  if (!gdState || gdState.finished || gdState.paused) return;
  if (gdState.i >= gdState.res.log.length) { onAnimComplete(); return; }
  gdState.timer = setTimeout(stepGameday, SPEED_MS[gdState.speed]);
}

// Manual advance — one plate appearance (works whether playing or paused)
function manualStep() {
  if (!gdState || gdState.finished) return;
  clearTimeout(gdState.timer);
  if (gdState.i >= gdState.res.log.length) { onAnimComplete(); return; }
  stepGameday(); // reschedules only if not paused
}
function togglePause() {
  if (!gdState || gdState.finished) return;
  gdState.paused = !gdState.paused;
  $('btn-gd-pause').textContent = gdState.paused ? '▶' : '⏸';
  if (gdState.paused) clearTimeout(gdState.timer); else scheduleNext();
}

// Reached the last play — stop and wait for an explicit "See Results" click.
function onAnimComplete() {
  gdState.finished = true;
  ['btn-gd-pause', 'btn-gd-next', 'btn-gd-speed', 'btn-gd-skip'].forEach(id => $(id).style.display = 'none');
  $('btn-gd-results').style.display = '';
}

function stepGameday() {
  const e = gdState.res.log[gdState.i++];
  if (e.inning !== gdState.lastInning) {
    addTicker(`─── Inning ${e.inning} ───`, 'inning-divider');
    gdState.lastInning = e.inning;
  }
  renderNowBatting(e);
  setInning(e.inning, true);
  setBases(e.basesAfter);
  setOuts(e.outsAfter);
  const runEl = $('gd-runs');
  runEl.textContent = e.totalRuns;
  if (e.runsScored) { runEl.classList.remove('pop'); void runEl.offsetWidth; runEl.classList.add('pop'); }
  renderScoreboard(cumulativeInnings(gdState.i), e.totalRuns, totalHits(gdState.i));
  const runTxt = e.runsScored ? `  +${e.runsScored} run${e.runsScored > 1 ? 's' : ''}` : '';
  if (e.exhausted) {
    addTicker(`${e.player} out — no at-bats left`, 'exhausted');
  } else if (e.result === 'HR') {
    addTicker(`💥 ${e.player} homers${runTxt}`, 'run hr');
  } else {
    const verb = RESULT_VERB[e.result] ?? e.result;
    addTicker(`${e.player} ${verb}${runTxt}`, e.runsScored ? 'run' : (isHitResult(e.result) ? 'hit' : ''));
  }
  renderGdLineup(gdState.i);
  scheduleNext();
}

function isHitResult(r) { return ['HR', 'triple', 'double', 'single'].includes(r); }
function totalHits(uptoIndex) {
  let h = 0;
  for (let k = 0; k < uptoIndex; k++) if (isHitResult(gdState.res.log[k].result)) h++;
  return h;
}

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
  saveBest(gdState.date, gdState.style, gdState.res.runs);
  show('result');
  renderResultLeaderboard();
}

function skipToScore() {
  if (!gdState) return;
  clearTimeout(gdState.timer);
  gdState.finished = true;
  finishGameday();
}

$('btn-gd-skip').addEventListener('click', skipToScore);
$('btn-gd-results').addEventListener('click', () => finishGameday());
$('btn-gd-pause').addEventListener('click', togglePause);
$('btn-gd-next').addEventListener('click', manualStep);
$('btn-gd-speed').addEventListener('click', () => {
  if (!gdState) return;
  gdState.speed = gdState.speed === 1 ? 2 : gdState.speed === 2 ? 4 : 1;
  $('btn-gd-speed').textContent = `${gdState.speed}×`;
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
  // keep the whole game so the player can scroll back through every at-bat
  while (log.children.length > 300) log.lastChild.remove();
}

function renderScoreboard(inningRuns, total, hits = 0) {
  const cells = Array.from({ length: 9 }, (_, i) =>
    `<td class="sb-cell">${inningRuns[i] != null ? inningRuns[i] : ''}</td>`).join('');
  $('gd-scoreboard').innerHTML = `
    <table class="sb-table">
      <thead><tr><th class="sb-team-col"></th>${[1,2,3,4,5,6,7,8,9].map(n => `<th class="sb-cell">${n}</th>`).join('')}<th class="sb-r">R</th><th class="sb-r">H</th></tr></thead>
      <tbody><tr><td class="sb-team-col">YOU</td>${cells}<td class="sb-r">${total}</td><td class="sb-r">${hits}</td></tr></tbody>
    </table>`;
}

// ── League compare: your runs vs what every real team scored that day ─────────
function leagueCompare(runs) {
  const teams = (pool?.teams ?? []).map(t => ({ abbr: t.abbreviation, runs: t.runs, opp: t.opponent }));
  const wins = teams.filter(t => runs > t.runs).sort((a, b) => b.runs - a.runs);
  const losses = teams.filter(t => runs < t.runs).sort((a, b) => a.runs - b.runs);
  const ties = teams.filter(t => runs === t.runs);
  return { total: teams.length, beaten: wins.length, wins, losses, ties };
}

function showMatchupsModal(runs) {
  const cmp = leagueCompare(runs);
  const teamRow = (t, cls) => `<div class="mu-row ${cls}">
    <span class="mu-team">${t.abbr} <span class="mu-opp">vs ${t.opp}</span></span>
    <span class="mu-score">${runs}<span class="mu-dash">–</span>${t.runs}</span></div>`;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:460px">
      <div class="modal-title">You'd have beaten ${cmp.beaten} of ${cmp.total} teams</div>
      <div class="mu-cols">
        <div class="mu-col">
          <div class="mu-head win">BEAT (${cmp.wins.length})</div>
          ${cmp.wins.map(t => teamRow(t, 'win')).join('') || '<div class="mu-none">—</div>'}
        </div>
        <div class="mu-col">
          <div class="mu-head loss">LOST TO (${cmp.losses.length})</div>
          ${cmp.losses.map(t => teamRow(t, 'loss')).join('') || '<div class="mu-none">—</div>'}
          ${cmp.ties.length ? `<div class="mu-head tie">TIED (${cmp.ties.length})</div>${cmp.ties.map(t => teamRow(t, 'tie')).join('')}` : ''}
        </div>
      </div>
      <div class="modal-actions"><button class="btn-primary" id="mu-close">Close</button></div>
    </div>`;
  modal.querySelector('#mu-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  $('app').appendChild(modal);
}

// ── Result ────────────────────────────────────────────────────────────────────
function renderResult(res, lineup) {
  $('result-runs').textContent = res.runs;
  $('result-sub').textContent = `9 innings · ${res.realPAs} real at-bats used`;

  const cmp = leagueCompare(res.runs);
  $('result-league').innerHTML = cmp.total ? `
    <div class="league-line">You'd have beaten <b>${cmp.beaten}</b> of <b>${cmp.total}</b> teams today</div>
    <button id="btn-matchups" class="btn-secondary league-btn">See matchups →</button>` : '';
  const mb = $('btn-matchups');
  if (mb) mb.addEventListener('click', () => showMatchupsModal(res.runs));

  renderBestDraft(res);

  const per = cumulativeInnings(res.log.length);
  const cells = Array.from({ length: 9 }, (_, i) => `<td class="sb-cell">${per[i] != null ? per[i] : ''}</td>`).join('');
  $('result-line').innerHTML = `
    <table class="sb-table" style="width:100%">
      <thead><tr><th class="sb-team-col"></th>${[1,2,3,4,5,6,7,8,9].map(n => `<th class="sb-cell">${n}</th>`).join('')}<th class="sb-r">R</th></tr></thead>
      <tbody><tr><td class="sb-team-col">YOU</td>${cells}<td class="sb-r">${res.runs}</td></tr></tbody>
    </table>`;

  // MVP banner — this-game line + their real game line
  const mvp = res.mvp;
  const mvpPlayer = lineup.find(p => p.id === mvp?.id);
  $('result-mvp').innerHTML = mvp ? `
    <div class="mvp-card">
      <div class="mvp-tag">★ GAME MVP</div>
      <div class="mvp-name">${mvp.name}</div>
      <div class="mvp-sub">${mvpPlayer?.teamAbbr ?? ''} · ${mvp.position}</div>
      <div class="mvp-stats">
        <div class="mvp-stat"><span class="mvp-stat-lbl">This game</span><span class="mvp-stat-val">${mvp.R} R · ${mvp.RBI} RBI</span></div>
        <div class="mvp-stat"><span class="mvp-stat-lbl">Real life</span><span class="mvp-stat-val">${mvpPlayer?.real?.r ?? 0} R · ${mvpPlayer?.real?.rbi ?? 0} RBI</span></div>
      </div>
    </div>` : '';

  $('result-lineup').innerHTML = boxScoreTable(res, lineup);
}

// Daily-only: how close your draft was to the best achievable one (same tape + rerolls).
// Shown on the result screen after a game — never on the home screen.
function renderBestDraft(res) {
  const el = $('result-best');
  if (!el) return;
  if (gdState.cadence !== 'daily') { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="best-line">Finding the best possible draft…</div>';
  // let the result screen paint first, then crunch
  setTimeout(() => {
    let best;
    try { best = bestDailyDraft(pool, gdState.date, gdState.style); } catch { best = null; }
    if (!best || best.runs < 0) { el.innerHTML = ''; return; }
    const gap = best.runs - res.runs;
    const verdict = gap <= 0
      ? `<span class="best-nailed">🎯 You nailed it — that's the best draft we found.</span>`
      : `you left <b>${gap}</b> run${gap === 1 ? '' : 's'} on the table`;
    const reveal = gap <= 0 ? ''
      : `<button id="btn-ideal" class="btn-secondary best-btn">Show the ideal lineup →</button>`;
    el.innerHTML = `<div class="best-line">Best possible draft: <b>${best.runs}</b> runs · ${verdict}</div>${reveal}`;
    const ib = $('btn-ideal');
    if (ib) ib.addEventListener('click', () => showIdealLineupModal(best));
  }, 30);
}

function showIdealLineupModal(best) {
  const rows = best.lineup.map(p => `<tr>
    <td class="bs-slot">${p.battingSlot}</td><td class="bs-pos">${p.position}</td>
    <td class="bs-name">${p.name}<span class="bs-team">${p.teamAbbr}</span></td>
    <td class="bs-line">${p.line?.summary ?? ''}</td></tr>`).join('');
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:480px">
      <div class="modal-title">Ideal lineup — ${best.runs} runs</div>
      <div class="modal-subtitle">The best draft + order from your daily tape</div>
      <div class="result-lineup" style="margin-top:8px"><table class="boxscore-table"><tbody>${rows}</tbody></table></div>
      <div class="modal-actions"><button class="btn-primary" id="ideal-close">Close</button></div>
    </div>`;
  modal.querySelector('#ideal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  $('app').appendChild(modal);
}

// Box score table (this sim game's AB/R/H/RBI + real day line) — reused by the
// result screen and the "view someone's lineup" modal.
function boxScoreTable(res, lineup) {
  const mvpId = res.mvp?.id;
  const rows = lineup.map(p => {
    const st = res.playerStats[p.id] ?? { AB: 0, R: 0, H: 0, RBI: 0 };
    const isMvp = p.id === mvpId;
    return `<tr class="${isMvp ? 'is-mvp' : ''}">
      <td class="bs-slot">${p.battingSlot}</td>
      <td class="bs-pos">${p.position}</td>
      <td class="bs-name">${p.name}${isMvp ? ' <span class="bs-mvp">★</span>' : ''}<span class="bs-team">${p.teamAbbr}</span></td>
      <td>${st.AB}</td><td>${st.R}</td><td>${st.H}</td><td class="bs-rbi">${st.RBI}</td>
      <td class="bs-line">${p.line.summary}</td>
    </tr>`;
  }).join('');
  return `<table class="boxscore-table">
    <thead><tr>
      <th></th><th></th><th class="bs-name">BATTER</th>
      <th>AB</th><th>R</th><th>H</th><th>RBI</th><th class="bs-line">Last night</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// Rebuild a stored lineup from the current pool and replay it (deterministic).
function findPoolPlayer(id) {
  for (const t of (pool?.teams ?? [])) { const p = t.players.find(x => x.id === id); if (p) return p; }
  return null;
}
function rebuildLineup(spec, styleName) {
  let lineup = spec.map(s => {
    const p = findPoolPlayer(s.id);
    return p ? { ...p, position: s.pos, battingSlot: s.slot } : null;
  }).filter(Boolean).sort((a, b) => a.battingSlot - b.battingSlot);
  if (styleName === 'shuffled') {
    lineup = lineup.map(p => ({ ...p, results: seededRng(`${activeDate}:shuffled:${p.id}`).shuffle(p.results) }));
  }
  return lineup;
}

// Read-only modal: show what another player's lineup did.
function showLineupModal(ini, dateStr, styleName, lineupRaw) {
  let spec; try { spec = JSON.parse(decodeURIComponent(lineupRaw)); } catch { return; }
  if (!Array.isArray(spec) || !spec.length) return;
  if (dateStr !== (pool?.date)) return; // can only replay the currently-loaded daily
  const lineup = rebuildLineup(spec, styleName);
  if (lineup.length < spec.length) return;
  const res = playOut(lineup);
  const cmp = leagueCompare(res.runs);
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:560px">
      <div class="modal-title">${ini}'s lineup — ${res.runs} runs</div>
      <div class="modal-subtitle">${styleName} · beat ${cmp.beaten} of ${cmp.total} teams</div>
      <div class="result-lineup" style="margin-top:8px">${boxScoreTable(res, lineup)}</div>
      <div class="modal-actions"><button class="btn-primary" id="vl-close">Close</button></div>
    </div>`;
  modal.querySelector('#vl-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  $('app').appendChild(modal);
}

// Delegated: click a leaderboard row to view that player's lineup
function onBoardClick(e) {
  const tr = e.target.closest('tr[data-lineup]'); if (!tr) return;
  if (!tr.dataset.lineup) return;
  showLineupModal(tr.dataset.ini, tr.dataset.date, tr.dataset.style, tr.dataset.lineup);
}
$('result-leaderboard').addEventListener('click', onBoardClick);
$('home-leaderboard').addEventListener('click', onBoardClick);

$('btn-result-home').addEventListener('click', () => { renderHome(); show('home'); });

$('btn-share').addEventListener('click', () => {
  const res = gdState.res;
  const line = cumulativeInnings(res.log.length);
  const grid = Array.from({ length: 9 }, (_, i) => line[i] != null ? line[i] : '·').join(' ');
  const cmp = leagueCompare(res.runs);
  const mvpTxt = res.mvp ? `\nMVP: ${res.mvp.name} (${res.mvp.RBI} RBI)` : '';
  const beatTxt = cmp.total ? ` · beat ${cmp.beaten}/${cmp.total} teams` : '';
  const text = `⚾ Lineup Card — ${activeDate}\n${res.runs} runs${beatTxt}\n${grid}${mvpTxt}\n\nFill the card, beat my score ⚾\n${location.origin}`;
  navigator.clipboard?.writeText(text).then(() => {
    $('btn-share').textContent = '✓ Copied!';
    setTimeout(() => { $('btn-share').textContent = '📋 Copy Result'; }, 1800);
  });
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
async function fetchLeaderboard(date, sty) {
  try { return await fetch(`/api/leaderboard?date=${date}&style=${sty}`).then(r => r.json()); }
  catch { return { enabled: false, scores: [] }; }
}
async function submitScore(date, sty, initials, runs, mvp, lineup) {
  try {
    return await fetch('/api/leaderboard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, style: sty, initials, runs, mvp, lineup }),
    }).then(r => r.json());
  } catch { return { enabled: false }; }
}
// Compact lineup spec stored with a score so it can be replayed for viewing.
function lineupPayload(lineup) {
  return JSON.stringify(lineup.map(p => ({ id: p.id, slot: p.battingSlot, pos: p.position })));
}
// Submit guard keyed by the server "reset generation" — an admin reset bumps
// the generation, which invalidates these keys so nobody is locked out.
const subKey = (gen, d, s) => `dh-sub-${gen}-${d}-${s}`;
const hasSubmitted = (gen, d, s) => localStorage.getItem(subKey(gen, d, s));
const markSubmitted = (gen, d, s, ini) => localStorage.setItem(subKey(gen, d, s), ini);

// Structured MVP payload stored on the leaderboard (JSON in the mvp text column)
function mvpPayload(res, lineup) {
  const m = res.mvp; if (!m) return '';
  const p = lineup.find(x => x.id === m.id);
  return JSON.stringify({ n: m.name, p: m.position, r: m.R, rbi: m.RBI, rr: p?.real?.r ?? 0, rrbi: p?.real?.rbi ?? 0 });
}
function mvpCell(raw) {
  if (!raw) return '<td class="lb-mvp"></td>';
  let m; try { m = JSON.parse(raw); } catch { return `<td class="lb-mvp">${raw}</td>`; }
  const real = m.rr !== undefined
    ? `real ${m.rrbi} RBI · ${m.rr} R`
    : (m.real ? `real ${m.real}` : '');
  return `<td class="lb-mvp">
    <div class="lb-mvp-name">${m.n} <span class="lb-mvp-pos">${m.p}</span></div>
    <div class="lb-mvp-det">this game <b>${m.rbi} RBI · ${m.r} R</b>${real ? ` <span class="lb-mvp-real">· ${real}</span>` : ''}</div>
  </td>`;
}

// Show the top 10. If `opts.myInitials`/`myRuns` identify the current player and
// they're outside the top 10, pin their row below so they always see their result.
function boardTable(scores, ctx = {}, opts = {}) {
  if (!scores.length) return '<div class="lb-empty">No scores yet — be the first!</div>';
  const total = (pool?.teams ?? []).length;
  const viewable = ctx.date && ctx.date === pool?.date; // can replay only the loaded daily
  const myIdx = (opts.myInitials != null && opts.myRuns != null)
    ? scores.findIndex(s => s.initials === opts.myInitials && s.runs === opts.myRuns)
    : -1;
  const rowHtml = (s, i) => {
    const me = i === myIdx ? 'me' : '';
    const beaten = total ? leagueCompare(s.runs).beaten : 0;
    const canView = viewable && s.lineup;
    const data = canView ? `data-lineup="${encodeURIComponent(s.lineup)}" data-ini="${s.initials}" data-date="${ctx.date}" data-style="${ctx.style}"` : '';
    return `<tr class="${me} ${canView ? 'lb-clickable' : ''}" ${data}><td class="lb-rank">${i + 1}</td><td class="lb-ini">${s.initials}</td><td class="lb-runs">${s.runs}</td><td class="lb-beat">${total ? `${beaten}/${total}` : '—'}</td>${mvpCell(s.mvp)}</tr>`;
  };
  let body = scores.slice(0, 10).map((s, i) => rowHtml(s, i)).join('');
  if (myIdx >= 10) body += `<tr class="lb-sep"><td colspan="5">· · ·</td></tr>` + rowHtml(scores[myIdx], myIdx);
  return `<table class="lb-table">
    <thead><tr>
      <th class="lb-rank">#</th><th class="lb-ini">WHO</th>
      <th class="lb-runs">RUNS</th><th class="lb-beat">BEAT</th><th class="lb-mvp">GAME MVP</th>
    </tr></thead>
    <tbody>${body}</tbody></table>`;
}

async function renderResultLeaderboard() {
  const el = $('result-leaderboard');
  const { cadence: cad, style: sty, date, res } = gdState;
  if (cad !== 'daily') { el.innerHTML = '<div class="lb-note">Free Play — not ranked. Switch to Daily to compete.</div>'; return; }
  el.innerHTML = '<div class="lb-note">Loading leaderboard…</div>';
  const data = await fetchLeaderboard(date, sty);
  if (!data.enabled) { el.innerHTML = '<div class="lb-note">Leaderboard coming soon.</div>'; return; }
  const gen = data.gen ?? 0;

  const title = `<div class="lb-title">DAILY LEADERBOARD · ${sty.toUpperCase()}</div>`;
  // Only treat you as "already submitted" if the board actually has scores — an
  // empty board (fresh day or post-reset) always offers the submit box, so a
  // reset can never leave anyone locked out.
  const ctx = { date, style: sty };
  if (data.scores.length && hasSubmitted(gen, date, sty)) {
    el.innerHTML = title + boardTable(data.scores, ctx, { myInitials: hasSubmitted(gen, date, sty), myRuns: res.runs });
    return;
  }
  el.innerHTML = `${title}
    <div class="lb-submit">
      <span>Your <b>${res.runs}</b> runs — enter initials:</span>
      <input id="lb-initials" maxlength="3" placeholder="AAA" class="lb-input" autocomplete="off">
      <button id="lb-submit-btn" class="btn-primary">Submit</button>
    </div>
    ${boardTable(data.scores, ctx)}`;
  const input = $('lb-initials');
  input.focus();
  input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') $('lb-submit-btn').click(); });
  $('lb-submit-btn').addEventListener('click', async () => {
    const ini = input.value.slice(0, 3);
    if (!ini) { input.focus(); return; }
    $('lb-submit-btn').disabled = true;
    const out = await submitScore(date, sty, ini, res.runs, mvpPayload(res, gdState.lineup), lineupPayload(gdState.lineup));
    if (out.enabled) {
      markSubmitted(out.gen ?? gen, date, sty, ini);
      el.innerHTML = `${title}<div class="lb-rank-line">You're #${out.rank}!</div>${boardTable(out.scores, ctx, { myInitials: ini, myRuns: res.runs })}`;
    } else {
      $('lb-submit-btn').disabled = false;
    }
  });
}

// Home peek: today's top scores for the selected daily style (always shown for Daily)
async function renderHomeLeaderboard() {
  const el = $('home-leaderboard');
  if (!el) return;
  if (cadence !== 'daily') { el.innerHTML = ''; return; }
  const reqDate = activeDate, reqStyle = style;
  el.innerHTML = `<div class="lb-title">TODAY'S TOP · ${reqStyle.toUpperCase()}</div><div class="lb-note">loading…</div>`;
  const data = await fetchLeaderboard(reqDate, reqStyle);
  if (reqDate !== activeDate || reqStyle !== style || cadence !== 'daily') return; // selection changed
  if (!data.enabled) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="lb-title">TODAY'S TOP · ${reqStyle.toUpperCase()}</div>${boardTable(data.scores, { date: reqDate, style: reqStyle })}`;
}

// ── Best-score persistence (per date + style) ─────────────────────────────────
function bestKey(date, sty) { return `dh-best-${date}-${sty}`; }
function loadBest(date, sty) { const v = localStorage.getItem(bestKey(date, sty)); return v == null ? null : Number(v); }
function saveBest(date, sty, runs) {
  const cur = loadBest(date, sty);
  if (cur == null || runs > cur) localStorage.setItem(bestKey(date, sty), String(runs));
}

boot();
