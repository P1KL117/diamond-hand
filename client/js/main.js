import { fetchSchedule, fetchGameFeed } from './api.js';
import { extractCards, computeSeededSpecials, buildSpecialsFromCounts, buildRandomSpecials, shuffle, ALL_SPECIAL_TYPES, SPECIAL_META, RESULT_LABEL } from './cards.js';
import { processAB, processEvent, hasRunner } from './sim.js';
import {
  state, resetSides, currentSide,
  drawCards, playABCard, canRedraw, doRedraw,
  playSpecialCard, peekAndRemoveDeck, commitMoundVisit,
  draw2ForChoice, commitDraw2, getDiscardSample, commitRecalled,
  commitBattingCoach, commitDiscardOne, commitRetain,
  markEventCardUsed, getActiveEventCards, consumeHitAndRun,
  endHalfInning, isGameOver, addRunsToScore, realGameScore,
} from './state.js';
import {
  showScreen, renderDateDisplay, renderGameList, renderTeamSelect,
  renderConfigScreen, renderConfigMode, updateCustomTotal,
  renderAll, addTickerEntry, renderEndScreen, showPickModal, showChoiceModal, showTagUpModal,
} from './ui.js';

// ── Date ──────────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);
const offsetDate = (d, days) => {
  const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
};

let viewDate = todayStr();
let pickerGames = [];

// ── Config state ──────────────────────────────────────────────────────────────

let configMode = 'game';
let seededSpecials = [];
let customCounts = Object.fromEntries(ALL_SPECIAL_TYPES.map(t => [t, 0]));
let randomCount = 5;
let pendingFeed = null;

// ── Picker ────────────────────────────────────────────────────────────────────

async function loadPicker() {
  renderDateDisplay(viewDate);
  document.getElementById('game-list').innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await fetchSchedule(viewDate);
    pickerGames = (data.dates?.[0]?.games ?? []).map(g => ({
      gamePk: g.gamePk, status: g.status?.abstractGameState,
      awayTeam: { name: g.teams.away.team.name, abbreviation: abbr(g.teams.away.team) },
      homeTeam: { name: g.teams.home.team.name, abbreviation: abbr(g.teams.home.team) },
      awayScore: g.teams.away.score ?? 0,
      homeScore: g.teams.home.score ?? 0,
      awayHits: g.linescore?.teams?.away?.hits ?? 0,
      homeHits: g.linescore?.teams?.home?.hits ?? 0,
    })).filter(g => g.status === 'Final');
    renderGameList(pickerGames);
  } catch (e) {
    document.getElementById('game-list').innerHTML = `<div class="error">Failed: ${e.message}</div>`;
  }
}

function abbr(t) { return t.abbreviation ?? t.teamCode?.toUpperCase() ?? t.name.slice(0, 3).toUpperCase(); }

document.getElementById('btn-prev-day').addEventListener('click', () => { viewDate = offsetDate(viewDate, -1); loadPicker(); });
document.getElementById('btn-next-day').addEventListener('click', () => {
  const next = offsetDate(viewDate, 1);
  if (next > todayStr()) return;
  viewDate = next; loadPicker();
});

document.getElementById('game-list').addEventListener('click', e => {
  const btn = e.target.closest('.game-card'); if (!btn) return;
  const game = pickerGames.find(g => String(g.gamePk) === btn.dataset.pk); if (!game) return;
  state.selectedGame = game;
  renderTeamSelect(game);
  showScreen('team');
});

document.getElementById('btn-back-to-picker').addEventListener('click', () => showScreen('picker'));

// ── Team select → config screen ───────────────────────────────────────────────

document.getElementById('team-options').addEventListener('click', async e => {
  const btn = e.target.closest('.team-btn'); if (!btn) return;
  state.playerSide = btn.dataset.side;

  const overlay = Object.assign(document.createElement('div'), {
    className: 'loading-overlay', textContent: 'Loading game data…',
  });
  document.getElementById('app').appendChild(overlay);

  try {
    const feed = await fetchGameFeed(state.selectedGame.gamePk);
    state.realFeed = feed;
    pendingFeed = feed;
    seededSpecials = computeSeededSpecials(feed, state.playerSide);
    customCounts = Object.fromEntries(ALL_SPECIAL_TYPES.map(t => [t, 0]));
    configMode = 'game';
    renderConfigScreen(state.selectedGame, state.playerSide, seededSpecials);
    showScreen('config');
  } catch (e) {
    alert(`Failed to load game: ${e.message}`);
  } finally {
    overlay.remove();
  }
});

// ── Config screen interactions ────────────────────────────────────────────────

document.getElementById('config-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.mode-tab'); if (!tab) return;
  configMode = tab.dataset.mode;
  renderConfigMode(configMode, seededSpecials, customCounts, randomCount);
});

document.getElementById('config-content').addEventListener('input', e => {
  if (e.target.id === 'random-count-slider') {
    randomCount = parseInt(e.target.value);
    const rv = document.getElementById('rv-random');
    if (rv) rv.textContent = randomCount;
    const total = document.getElementById('random-total-display');
    if (total) total.textContent = `${randomCount} card${randomCount !== 1 ? 's' : ''} — types drawn randomly at game start`;
    return;
  }
  if (!e.target.classList.contains('special-slider')) return;
  const type = e.target.dataset.type;
  const val = parseInt(e.target.value);
  customCounts[type] = val;
  const sv = document.getElementById(`sv-${type}`);
  if (sv) sv.textContent = val;
  const total = updateCustomTotal(customCounts);
  if (total > 8) {
    customCounts[type] = Math.max(0, val - (total - 8));
    e.target.value = customCounts[type];
    if (sv) sv.textContent = customCounts[type];
    updateCustomTotal(customCounts);
  }
});

document.getElementById('btn-start-game').addEventListener('click', () => {
  const specials = configMode === 'game'
    ? seededSpecials
    : configMode === 'custom'
    ? buildSpecialsFromCounts(customCounts)
    : buildRandomSpecials(randomCount);
  startGame(pendingFeed, specials);
});

document.getElementById('btn-config-back').addEventListener('click', () => showScreen('team'));

// ── Game start ────────────────────────────────────────────────────────────────

function startGame(feed, specials) {
  resetSides();
  for (const side of ['away', 'home']) {
    const { abCards, deckEventCards, eventCards, battingOrder } = extractCards(feed, side);
    const sideSpecials = specials.map((c, i) => ({ ...c, id: `${c.id}-${side}-${i}` }));
    state[side].deck        = shuffle([...abCards, ...deckEventCards, ...sideSpecials]);
    state[side].eventCards  = eventCards;
    state[side].battingOrder = battingOrder;
  }
  state.inning = 1; state.isTop = true; state.outs = 0;
  state.bases = [false, false, false];
  state.score = { home: 0, away: 0 };
  state.inningScores = { home: Array(9).fill(null), away: Array(9).fill(null) };
  state.currentInningRuns = 0;
  state.playLog = [];
  state.phase = 'playing';
  state.discardOneMode = false;
  state.battingCoachMode = false;
  state.retainMode = false;

  drawCards('away', 7);
  showScreen('game');
  renderAll();
  addTickerEntry('Play ball!', 'divider');
}

// ── Out meter ─────────────────────────────────────────────────────────────────

const OUT_RESULTS = new Set(['K', 'groundout', 'flyout', 'lineout', 'DP', 'FC', 'sac_fly']);

function checkOutMeter(card) {
  if (card.type !== 'ab') return;
  const side = currentSide();
  const s = state[side];
  if (OUT_RESULTS.has(card.result)) {
    s.consecutiveOuts++;
    if (s.consecutiveOuts >= 5) {
      s.consecutiveOuts = 0;
      const type = ALL_SPECIAL_TYPES[Math.floor(Math.random() * ALL_SPECIAL_TYPES.length)];
      const newCard = { id: `grind-${Date.now()}`, type: 'special', specialType: type };
      s.hand.push(newCard);
      s.pendingRetain = newCard;
      const name = SPECIAL_META[type]?.label ?? type;
      addTickerEntry(`⚡ GRIND — "${name}" earned and retained!`, 'special-play');
    }
  } else {
    s.consecutiveOuts = 0;
  }
}

// ── AB card play ──────────────────────────────────────────────────────────────

function finishABPlay(card, result, opts, note) {
  const { bases, outs, runs } = processAB(result, state.bases, state.outs, opts);
  state.bases = bases; state.outs = outs; addRunsToScore(runs);
  addTickerEntry(`${card.playerName}: ${card.result}${note}${runs > 0 ? `  +${runs}R` : ''}`);
  if (card.description) addTickerEntry(`  "${card.description.slice(0, 80)}"`, 'desc');
  checkOutMeter(card);
  if (state.outs >= 3) { endInning(); return; }
  renderAll();
}

document.getElementById('hand-container').addEventListener('click', e => {
  if (state.phase !== 'playing') return;
  const btn = e.target.closest('[data-id]'); if (!btn) return;
  const cardId = btn.dataset.id;

  // Retain selection
  if (state.retainMode) {
    const specialId = document.getElementById('hand-container').dataset.pendingSpecial;
    if (specialId) { commitRetain(specialId, cardId); addTickerEntry('📌 Card retained — survives next hand dump.', 'special-play'); renderAll(); }
    return;
  }
  // Discard One selection
  if (state.discardOneMode) {
    const specialId = document.getElementById('hand-container').dataset.pendingSpecial;
    if (specialId) { commitDiscardOne(specialId, cardId); addTickerEntry('✕ Card discarded — drew 1 replacement.'); renderAll(); }
    return;
  }
  // Batting Coach selection
  if (state.battingCoachMode) {
    const specialId = document.getElementById('hand-container').dataset.pendingSpecial;
    if (specialId) { commitBattingCoach(specialId, cardId); addTickerEntry('↑↑ Card upgraded one tier.', 'special-play'); renderAll(); }
    return;
  }

  if (btn.dataset.type === 'special') { handleSpecialCard(cardId); return; }

  // Event card in hand (SB, WP, PB)
  if (btn.dataset.type === 'event') {
    if (!btn.classList.contains('playable')) return;
    const side = currentSide();
    const s = state[side];
    const card = s.hand.find(c => c.id === cardId); if (!card) return;
    s.hand = s.hand.filter(c => c.id !== cardId);
    s.burned.push(card);
    const { bases, outs, runs } = processEvent(card.eventType, state.bases, state.outs);
    state.bases = bases; state.outs = outs; addRunsToScore(runs);
    addTickerEntry(`[${card.eventType}] ${card.description}${runs ? `  +${runs}R` : ''}`);
    if (state.outs >= 3) { endInning(); return; }
    renderAll();
    return;
  }

  // Normal AB play
  if (!btn.classList.contains('playable')) return;
  const side = currentSide();
  const hitAndRun = state[side].hitAndRunActive;
  const card = playABCard(cardId); if (!card) return;

  if (hitAndRun && (card.result === 'groundout' || card.result === 'FC')) consumeHitAndRun();

  // Groundout: random DP roll (no player decision)
  if (card.result === 'groundout' && !hitAndRun) {
    const dpPossible = state.bases[0] && state.outs < 2;
    const isDP = dpPossible && Math.random() < 0.5;
    if (isDP) {
      showDPResult(true, () => finishABPlay(card, 'DP', {}, ' [DOUBLE PLAY!]'));
    } else {
      showDPResult(dpPossible ? false : null, () =>
        finishABPlay(card, 'groundout', {}, dpPossible ? ' [no DP]' : ''));
    }
    return;
  }

  // Flyout / lineout: tag-up modal for any occupied base
  if ((card.result === 'flyout' || card.result === 'lineout') && state.outs < 2 && hasRunner(state.bases)) {
    const label = `${card.playerName} — ${RESULT_LABEL[card.result] ?? card.result}`;
    showTagUpModal(state.bases, state.outs, label, decisions => applyFlyoutTagUp(card, decisions));
    return;
  }

  finishABPlay(card, card.result, { hitAndRun }, hitAndRun && (card.result === 'groundout' || card.result === 'FC') ? ' [H&R→single]' : '');
});

// ── Special card routing ──────────────────────────────────────────────────────

function handleSpecialCard(cardId) {
  const result = playSpecialCard(cardId); if (!result) return;

  switch (result.kind) {
    case 'immediate':
      addTickerEntry(result.msg, 'special-play');
      renderAll();
      break;

    case 'balk': {
      const { bases, outs, runs } = processEvent('BALK', state.bases, state.outs);
      state.bases = bases; state.outs = outs; addRunsToScore(runs);
      addTickerEntry(`! BALK — runners advance${runs ? `  +${runs}R` : ''}`, 'special-play');
      if (state.outs >= 3) { endInning(); return; }
      renderAll();
      break;
    }

    case 'mound_visit': {
      const top5 = peekAndRemoveDeck(currentSide(), 5);
      showPickModal({
        title: '◉ MOUND VISIT',
        subtitle: 'Select any cards to take into your hand. The rest go to discard.',
        cards: top5, minPick: 0, maxPick: top5.length, confirmLabel: 'Take Selected',
      }, (taken) => {
        const returned = top5.filter(c => !taken.find(t => t.id === c.id));
        commitMoundVisit(cardId, taken, returned);
        addTickerEntry(`◉ Mound visit — took ${taken.length} card${taken.length !== 1 ? 's' : ''} from deck top`, 'special-play');
        renderAll();
      });
      break;
    }

    case 'draw_2_discard_1': {
      const drawn = draw2ForChoice(currentSide());
      if (!drawn.length) { addTickerEntry('Draw 2 — deck empty', 'special-play'); renderAll(); break; }
      showPickModal({
        title: '⇅ DRAW 2, DISCARD 1',
        subtitle: 'Choose 1 card to keep in your hand. The other goes to discard.',
        cards: drawn, minPick: 1, maxPick: 1, confirmLabel: 'Keep This Card',
      }, (kept) => {
        const keep = kept[0] ?? null;
        const discard = drawn.find(c => c.id !== keep?.id) ?? null;
        commitDraw2(cardId, keep, discard);
        addTickerEntry(`⇅ Drew 2 — kept 1, discarded 1`, 'special-play');
        renderAll();
      });
      break;
    }

    case 'recalled': {
      const sample = getDiscardSample(currentSide(), 6);
      if (!sample.length) { addTickerEntry('Recalled — discard is empty', 'special-play'); renderAll(); break; }
      showPickModal({
        title: '↑ RECALLED FROM MINORS',
        subtitle: 'Choose 1 card to return to your hand from the discard pile.',
        cards: sample, minPick: 1, maxPick: 1, confirmLabel: 'Recall This Card',
      }, (chosen) => {
        commitRecalled(cardId, chosen[0]);
        addTickerEntry(`↑ Recalled — 1 card returned from discard`, 'special-play');
        renderAll();
      });
      break;
    }

    case 'batting_coach': {
      document.getElementById('hand-container').dataset.pendingSpecial = cardId;
      addTickerEntry('↑↑ Batting Coach — select a hand card to upgrade', 'special-play');
      renderAll();
      break;
    }

    case 'discard_one': {
      document.getElementById('hand-container').dataset.pendingSpecial = cardId;
      addTickerEntry('✕ Discard One — select a card from your hand to remove', 'special-play');
      renderAll();
      break;
    }

    case 'retain': {
      document.getElementById('hand-container').dataset.pendingSpecial = cardId;
      addTickerEntry('📌 Hold On — select a card to keep after this half-inning', 'special-play');
      renderAll();
      break;
    }

  }
}

// ── DP roll result modal ──────────────────────────────────────────────────────

function showDPResult(isDP, onContinue) {
  if (isDP === null) { onContinue(); return; } // no DP possible, skip modal
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box modal-choice" style="max-width:340px;text-align:center">
      <div class="modal-title">${isDP ? '⚡ DOUBLE PLAY!' : '🎲 No Double Play'}</div>
      <div class="modal-subtitle">${isDP ? 'Runner on 1st doubled off.' : 'Batter only, runner advances.'}</div>
      <div class="modal-actions" style="justify-content:center">
        <button class="btn-primary" id="dp-ok">Continue</button>
      </div>
    </div>`;
  modal.querySelector('#dp-ok').addEventListener('click', () => { modal.remove(); onContinue(); });
  document.getElementById('app').appendChild(modal);
}

// ── Flyout / lineout tag-up resolution ────────────────────────────────────────

const TAG_PROB = [0.50, 0.65, 0.80]; // 1st→2nd, 2nd→3rd, 3rd→home
const BASE_NAMES = ['1st', '2nd', '3rd'];

function applyFlyoutTagUp(card, decisions) {
  const nb = [...state.bases];
  let extraOuts = 0, runs = 0;
  const notes = [];

  for (let bi = 2; bi >= 0; bi--) {
    if (!state.bases[bi]) continue;
    if (decisions[bi]) {
      nb[bi] = false;
      if (bi === 2) {
        if (Math.random() < TAG_PROB[2]) { runs++; notes.push('3rd scores'); }
        else { extraOuts++; notes.push('3rd thrown out'); }
      } else {
        const targetOccupied = nb[bi + 1]; // check after higher base resolved
        if (targetOccupied) {
          nb[bi] = true; // blocked — auto-hold
          notes.push(`${BASE_NAMES[bi]} holds (base blocked)`);
        } else if (Math.random() < TAG_PROB[bi]) {
          nb[bi + 1] = true;
          notes.push(`${BASE_NAMES[bi]}→${BASE_NAMES[bi + 1]} safe`);
        } else {
          extraOuts++;
          notes.push(`${BASE_NAMES[bi]} thrown out`);
        }
      }
    }
  }

  state.outs += 1 + extraOuts;
  state.bases = nb;
  addRunsToScore(runs);

  const noteStr = notes.length ? ` [${notes.join(', ')}]` : ' [all hold]';
  addTickerEntry(`${card.playerName}: ${RESULT_LABEL[card.result] ?? card.result}${noteStr}${runs > 0 ? `  +${runs}R` : ''}`);
  if (card.description) addTickerEntry(`  "${card.description.slice(0, 80)}"`, 'desc');
  checkOutMeter(card);
  if (state.outs >= 3) { endInning(); return; }
  renderAll();
}

// ── Redraw ────────────────────────────────────────────────────────────────────

document.getElementById('btn-redraw').addEventListener('click', () => {
  if (!canRedraw() || state.phase !== 'playing') return;
  const wasSpecialDump = state[currentSide()].hand.length > 0;
  doRedraw();
  addTickerEntry(wasSpecialDump ? '✕ Specials discarded — new hand drawn' : '↺ New hand drawn', 'divider');
  renderAll();
});

// ── Bonus pool (event cards) ──────────────────────────────────────────────────

document.getElementById('event-pool').addEventListener('click', e => {
  const btn = e.target.closest('.event-card:not(.disabled)');
  if (!btn || state.phase !== 'playing') return;
  const card = getActiveEventCards().find(c => c.id === btn.dataset.id); if (!card) return;
  markEventCardUsed(card.id);
  const { bases, outs, runs } = processEvent(card.eventType, state.bases, state.outs);
  state.bases = bases; state.outs = outs; addRunsToScore(runs);
  addTickerEntry(`[${card.eventType}] ${card.description}${runs ? `  +${runs}R` : ''}`);
  if (state.outs >= 3) { endInning(); return; }
  renderAll();
});

// ── Inning / game end ─────────────────────────────────────────────────────────

function endInning() {
  const half = state.isTop ? 'Top' : 'Bot', inning = state.inning;
  endHalfInning();
  addTickerEntry(`─── End ${half} ${inning} ───`, 'divider');
  if (isGameOver()) { endGame(); return; }
  renderAll();
}

function endGame() {
  state.phase = 'ended';
  renderEndScreen({ ...state.score }, realGameScore(state.realFeed));
  showScreen('end');
}

document.getElementById('btn-play-again').addEventListener('click', () => {
  state.phase = 'picker'; showScreen('picker'); loadPicker();
});

document.getElementById('btn-menu').addEventListener('click', () => {
  state.phase = 'picker'; showScreen('picker'); loadPicker();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
showScreen('picker');
loadPicker();
