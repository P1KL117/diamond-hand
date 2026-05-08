import { fetchSchedule, fetchGameFeed, fetchPlayerStats } from './api.js';
import { extractCards, computeSeededSpecials, buildSpecialsFromCounts, buildRandomSpecials, shuffle, ALL_SPECIAL_TYPES, SPECIAL_META, RESULT_LABEL, upgradeResult } from './cards.js';
import { processAB, processEvent, hasRunner } from './sim.js';
import {
  state, resetSides, currentSide,
  drawCards, playABCard, canRedraw, doRedraw,
  playSpecialCard, peekAndRemoveDeck, commitPitchingChange, commitMoundVisit, commitRainDelay,
  draw3ForChoice, commitDraw3, getDiscardSample, commitRecalled,
  commitBattingCoach, commitExileOne,
  markEventCardUsed, getActiveEventCards, consumeHitAndRun,
  endHalfInning, isGameOver, addRunsToScore, realGameScore,
} from './state.js';
import {
  showScreen, renderDateDisplay, renderGameList, renderTeamSelect,
  renderConfigScreen, renderConfigMode, updateCustomTotal,
  renderAll, addTickerEntry, clearTicker, renderEndScreen, showPickModal, showChoiceModal, showTagUpModal,
  showRainDelayModal,
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
  state.gameMode  = btn.dataset.mode ?? 'solitaire';
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
  state.playerStats = {};

  for (const side of ['away', 'home']) {
    const { abCards, deckEventCards, eventCards, battingOrder } = extractCards(feed, side);
    const isControlled = state.gameMode === 'solitaire' || side === state.playerSide;
    const sideSpecials = isControlled ? specials.map((c, i) => ({ ...c, id: `${c.id}-${side}-${i}` })) : [];
    // Opponent deck: ordered (no shuffle) so auto-play replays game sequence; no specials
    state[side].deck        = isControlled
      ? shuffle([...abCards, ...deckEventCards, ...sideSpecials])
      : [...abCards].reverse(); // reversed so deck.pop() gives first AB
    state[side].eventCards  = eventCards;
    state[side].battingOrder = battingOrder;
  }

  state.inning = 1; state.isTop = true; state.outs = 0;
  state.bases = [false, false, false];
  state.baseRunners = [null, null, null];
  state.score = { home: 0, away: 0 };
  state.inningScores = { home: Array(9).fill(null), away: Array(9).fill(null) };
  state.currentInningRuns = 0;
  state.playLog = [];
  state.phase = 'playing';
  state.discardOneMode = false;
  state.battingCoachMode = false;
  state.retainMode = false;

  // Fetch player stats in background for DP/SB probability
  const allPlays = feed?.liveData?.plays?.allPlays ?? [];
  const ids = [...new Set(allPlays.map(p => p.matchup?.batter?.id).filter(Boolean))];
  if (ids.length) fetchPlayerStats(ids).then(s => { state.playerStats = s; });

  // Only draw for player-controlled sides — opponent pops from deck directly
  if (state.gameMode === 'solitaire' || state.playerSide === 'away') drawCards('away', 3);
  showScreen('game');
  renderAll();
  clearTicker();
  addTickerEntry('Play ball!', 'divider');

  // If away team is opponent, start auto-play immediately
  if (state.gameMode === 'single' && state.playerSide === 'home') {
    setTimeout(autoPlayOpponentAB, 900);
  }
}

// ── Runner tracking ───────────────────────────────────────────────────────────
// Keeps state.baseRunners in sync with state.bases after each AB.
// Must be called with the OLD bases/outs (before processAB updates state).

function runnerInfo(card) {
  return {
    playerId: card.playerId ?? null,
    playerName: card.playerName ?? '?',
    sbPct: state.playerStats[card.playerId]?.sbPct ?? 0.70,
  };
}

function moveRunners(result, oldOuts, oldBases, bInfo, opts = {}) {
  const r = state.baseRunners; // current runners (about to be replaced)
  switch (result) {
    case 'HR':
      state.baseRunners = [null, null, null]; break;
    case 'triple':
      state.baseRunners = [null, null, bInfo]; break;
    case 'double':
      state.baseRunners = [null, bInfo, oldBases[0] ? r[0] : null]; break;
    case 'single':
      state.baseRunners = [bInfo, oldBases[0] ? r[0] : null, oldBases[1] ? r[1] : null]; break;
    case 'BB': case 'HBP': {
      if (!oldBases[0])                         state.baseRunners = [bInfo, r[1], r[2]];
      else if (!oldBases[1])                    state.baseRunners = [bInfo, r[0], r[2]];
      else if (!oldBases[2])                    state.baseRunners = [bInfo, r[0], r[1]];
      else /* loaded */                         state.baseRunners = [bInfo, r[0], r[1]]; // r[2] scores
      break;
    }
    case 'K':
      break; // no change
    case 'groundout': {
      const adv2  = opts.advance2nd;    // 'safe' | 'out' | undefined
      const send3 = opts.sendRunner3rd; // 'safe' | 'out' | 'hold' | undefined(auto)
      // 3rd runner: vacates unless explicitly held
      const held3rd = send3 === 'hold' || send3 === false;
      // New 3rd: runner from 2nd if they advanced safely; else old 3rd if held; else null
      const new3rd = adv2 === 'safe' ? r[1] : (held3rd ? r[2] : null);
      // New 2nd: null if runner left (advance attempt); else forced from 1st or stays
      const new2nd = (adv2 !== undefined && oldBases[1] && !oldBases[0])
        ? null
        : (oldBases[0] ? r[0] : r[1]);
      state.baseRunners = [null, new2nd, new3rd];
      break;
    }
    case 'DP':
      state.baseRunners = [null, r[1], r[2]]; break;
    case 'FC':
      state.baseRunners = [bInfo, r[1], r[2]]; break;
    case 'sac_fly':
      state.baseRunners = [null, null, (oldBases[1] && oldOuts < 2) ? r[1] : null]; break;
    case 'flyout': case 'lineout':
      break; // resolved by applyFlyoutTagUp
    default: break;
  }
}

// Shift runners forward one base (WP / PB / BALK) — r[2] scores, others advance
function shiftRunnersOneBase() {
  const r = state.baseRunners;
  state.baseRunners = [null, r[0], r[1]]; // r[2] scored
}

function applyEventRunnerShift(eventType, oldBases) {
  const r = state.baseRunners;
  switch (eventType) {
    case 'WP': case 'PB': case 'BALK':
      shiftRunnersOneBase(); break;
    case 'SB':
      if (oldBases[1] && !oldBases[2]) state.baseRunners = [r[0], null, r[1]]; // 2nd→3rd
      else if (oldBases[0])            state.baseRunners = [null, r[0], r[2]]; // 1st→2nd
      break;
    case 'CS':
      if (oldBases[2])      state.baseRunners = [r[0], r[1], null];
      else if (oldBases[1]) state.baseRunners = [r[0], null, r[2]];
      else if (oldBases[0]) state.baseRunners = [null, r[1], r[2]];
      break;
    case 'ERROR':
      state.baseRunners = [{ playerId: null, playerName: '?', sbPct: 0.70 }, r[0], r[1]];
      break;
    default: break;
  }
}

// ── Draw-one refill (called after every AB/special play) ─────────────────────

function drawAndRefill() {
  drawCards(currentSide(), 3); // HAND_SIZE = 3
}

// Speed-adjusted groundout advancement probabilities
const GROUNDOUT_3RD_BASE = 0.68; // 3rd → home on groundout
const GROUNDOUT_ADV_BASE = 0.55; // 2nd → 3rd on groundout

function computeGroundout3rdProb(runner) {
  const sbPct = runner?.sbPct ?? 0.70;
  return Math.min(0.90, Math.max(0.25, GROUNDOUT_3RD_BASE * (sbPct / 0.70)));
}
function computeGroundoutAdvProb(runner) {
  const sbPct = runner?.sbPct ?? 0.70;
  return Math.min(0.85, Math.max(0.20, GROUNDOUT_ADV_BASE * (sbPct / 0.70)));
}

function showGroundoutRunnerModal({ title, runnerName, pct, holdLabel, sendLabel }, onDecide) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const showDecision = () => {
    modal.innerHTML = `
      <div class="modal-box modal-choice" style="max-width:360px;text-align:center">
        <div class="modal-title">${title}</div>
        <div class="modal-subtitle">${runnerName} — ${pct}% chance</div>
        <div class="modal-actions">
          <button class="btn-secondary" id="go-hold">${holdLabel}</button>
          <button class="btn-primary"   id="go-send">${sendLabel} 🎲</button>
        </div>
      </div>`;
    modal.querySelector('#go-hold').addEventListener('click', () => { modal.remove(); onDecide('hold'); });
    modal.querySelector('#go-send').addEventListener('click', () => {
      const roll = Math.random();
      const success = roll < pct / 100;
      modal.innerHTML = `
        <div class="modal-box modal-choice" style="max-width:360px;text-align:center">
          <div class="modal-title">${success ? '✓ Safe!' : '✗ Thrown out!'}</div>
          <div class="modal-subtitle">Rolled ${Math.round(roll * 100)} — needed ${pct} or less</div>
          <div class="modal-actions" style="justify-content:center">
            <button class="btn-primary" id="go-ok">Continue</button>
          </div>
        </div>`;
      modal.querySelector('#go-ok').addEventListener('click', () => { modal.remove(); onDecide(success ? 'safe' : 'out'); });
    });
  };
  showDecision();
  document.getElementById('app').appendChild(modal);
}

function showGroundoutAdvModal(runner, prob, onDecide) {
  showGroundoutRunnerModal({
    title: '⚡ Runner on 2nd',
    runnerName: runner?.playerName ?? 'Runner',
    pct: Math.round(prob * 100),
    holdLabel: 'Hold at 2nd',
    sendLabel: 'Send to 3rd',
  }, onDecide);
}

function showGroundout3rdModal(runner, prob, onDecide) {
  showGroundoutRunnerModal({
    title: '🏃 Runner on 3rd',
    runnerName: runner?.playerName ?? 'Runner',
    pct: Math.round(prob * 100),
    holdLabel: 'Hold at 3rd',
    sendLabel: 'Send Home',
  }, onDecide);
}

// Speed-adjusted tag-up probability for a runner on base index bi
const BASE_TAG_PROB = [0.50, 0.65, 0.80]; // 1st→2nd, 2nd→3rd, 3rd→home
function computeTagProb(bi, runner) {
  const sbPct = runner?.sbPct ?? 0.70;
  const speedFactor = sbPct / 0.70;
  return Math.min(0.93, Math.max(0.15, BASE_TAG_PROB[bi] * speedFactor));
}

// ── Out meter ─────────────────────────────────────────────────────────────────

const OUT_RESULTS_METER = new Set(['K', 'groundout', 'flyout', 'lineout', 'DP', 'FC', 'sac_fly']);

function checkOutMeter(card) {
  if (card.type !== 'ab') return;
  const side = currentSide();
  const s = state[side];
  if (OUT_RESULTS_METER.has(card.result)) {
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
  const oldBases = [...state.bases];
  const oldOuts = state.outs;
  const { bases, outs, runs } = processAB(result, state.bases, state.outs, opts);
  moveRunners(result, oldOuts, oldBases, runnerInfo(card), opts);

  // Hold On: absorb 1 out if active
  let finalOuts = outs;
  if (state[currentSide()].freeOutActive && outs > oldOuts) {
    finalOuts = outs - 1;
    state[currentSide()].freeOutActive = false;
    note += ' [out nullified]';
  }

  state.bases = bases; state.outs = finalOuts; addRunsToScore(runs);
  addTickerEntry(`${card.playerName}: ${card.result}${note}${runs > 0 ? `  +${runs}R` : ''}`);
  if (card.description) addTickerEntry(`  "${card.description.slice(0, 80)}"`, 'desc');
  checkOutMeter(card);
  drawAndRefill();
  if (state.outs >= 3) { endInning(); return; }
  renderAll();
}

document.getElementById('hand-container').addEventListener('click', e => {
  if (state.phase !== 'playing') return;
  const btn = e.target.closest('[data-id]'); if (!btn) return;
  const cardId = btn.dataset.id;

  // Exile One selection
  if (state.discardOneMode) {
    const specialId = document.getElementById('hand-container').dataset.pendingSpecial;
    if (specialId) {
      commitExileOne(specialId, cardId);
      addTickerEntry('✕ Card permanently exiled.');
      drawAndRefill();
      renderAll();
    }
    return;
  }
  // Batting Coach — two-step: pick upgrade target, then pick discard fee
  if (state.battingCoachMode) {
    if (!state.battingCoachTarget) {
      // Step 1: select the card to upgrade
      state.battingCoachTarget = cardId;
      addTickerEntry('↑↑ Upgrade target set — now select a card to discard as the fee.', 'special-play');
      renderAll();
    } else {
      // Step 2: select cost card (can't be same card)
      if (cardId === state.battingCoachTarget) return;
      const specialId = document.getElementById('hand-container').dataset.pendingSpecial;
      if (specialId) {
        commitBattingCoach(specialId, state.battingCoachTarget, cardId);
        addTickerEntry('↑↑ Card upgraded — fee paid.', 'special-play');
        drawAndRefill();
        renderAll();
      }
    }
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
    const oldBases = [...state.bases];
    const { bases, outs, runs } = processEvent(card.eventType, state.bases, state.outs);
    applyEventRunnerShift(card.eventType, oldBases);
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

  // Groundout: DP roll, then optional runner advancement from 2nd
  if (card.result === 'groundout' && !hitAndRun) {
    const dpPossible = state.bases[0] && state.outs < 2;
    const goAo = state.playerStats[card.playerId]?.goAoRatio ?? 1.0;
    const dpChance = Math.min(0.75, Math.max(0.20, goAo * 0.45));
    const isDP = dpPossible && Math.random() < dpChance;
    const resolvedResult = isDP ? 'DP' : 'groundout';
    const dpNote = isDP ? ' [DOUBLE PLAY!]' : (dpPossible ? ' [no DP]' : '');

    showDPResult(isDP ? true : (dpPossible ? false : null), () => {
      const runner3 = state.baseRunners[2];
      const runner2 = state.baseRunners[1];
      const can3rd  = !isDP && state.bases[2] && state.outs < 2;

      // After all runner decisions, call finishABPlay with combined opts
      const finish = (send3, adv2) => {
        const notes = [];
        if (send3 === 'safe')  notes.push('3rd scores');
        if (send3 === 'out')   notes.push('3rd thrown out at home');
        if (send3 === 'hold')  notes.push('3rd holds');
        if (adv2 === 'safe')   notes.push('2nd→3rd ✓');
        if (adv2 === 'out')    notes.push('2nd→3rd ✗ out');
        const runnerNote = notes.length ? ` [${notes.join(', ')}]` : '';
        const opts = {};
        if (send3 !== undefined) opts.sendRunner3rd = send3;
        if (adv2  !== undefined) opts.advance2nd    = adv2;
        finishABPlay(card, resolvedResult, opts, dpNote + runnerNote);
      };

      // Decision for runner on 2nd (depends on whether 3rd is available after 3rd decision)
      const decide2nd = (send3) => {
        const thirdWillVacate = send3 === 'safe' || send3 === 'out';
        const thirdAvail = !state.bases[2] || thirdWillVacate;
        const canAdv2 = !isDP && state.bases[1] && !state.bases[0] && state.outs < 2 && thirdAvail;
        if (canAdv2) {
          const prob = computeGroundoutAdvProb(runner2);
          showGroundoutAdvModal(runner2, prob, result => finish(send3, result));
        } else {
          finish(send3, undefined);
        }
      };

      // Decision for runner on 3rd first, then chain to 2nd
      if (can3rd) {
        const prob = computeGroundout3rdProb(runner3);
        showGroundout3rdModal(runner3, prob, result => decide2nd(result));
      } else {
        decide2nd(undefined);
      }
    });
    return;
  }

  // Flyout / lineout: tag-up modal for any occupied base
  if ((card.result === 'flyout' || card.result === 'lineout') && state.outs < 2 && hasRunner(state.bases)) {
    const label = `${card.playerName} — ${RESULT_LABEL[card.result] ?? card.result}`;
    const tagProbs = [0, 1, 2].map(bi => computeTagProb(bi, state.baseRunners[bi]));
    showTagUpModal(state.bases, state.outs, label, state.baseRunners, tagProbs, decisions => applyFlyoutTagUp(card, decisions, tagProbs));
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
      drawAndRefill();
      renderAll();
      break;

    case 'pitching_change': {
      const drawn = draw3ForChoice(currentSide());
      if (!drawn.length) { addTickerEntry('⇄ Pitching Change — deck empty', 'special-play'); drawAndRefill(); renderAll(); break; }
      const keepN = Math.min(2, drawn.length);
      showPickModal({
        title: '⇄ PITCHING CHANGE',
        subtitle: keepN < 2 ? 'Pick the card to bring in.' : 'Pick 2 cards from the top of the deck to bring in.',
        cards: drawn, minPick: keepN, maxPick: keepN, confirmLabel: keepN < 2 ? 'Take This Card' : 'Keep These 2',
      }, (chosen) => {
        const others = drawn.filter(c => !chosen.find(k => k.id === c.id));
        const side = currentSide();
        const handCards = state[side].hand.filter(c => c.id !== cardId && c.type !== 'special');
        if (!handCards.length) {
          commitPitchingChange(cardId, chosen, null, others);
          addTickerEntry('⇄ Pitching Change — cards added to hand', 'special-play');
          drawAndRefill(); renderAll(); return;
        }
        showPickModal({
          title: '⇄ PITCHING CHANGE',
          subtitle: 'Select a hand card to shuffle back into the deck.',
          cards: handCards, minPick: 1, maxPick: 1, confirmLabel: 'Swap Out',
        }, (swapOut) => {
          commitPitchingChange(cardId, chosen, swapOut[0]?.id ?? null, others);
          addTickerEntry('⇄ Pitching Change — kept 2 deck picks, hand card shuffled back in', 'special-play');
          drawAndRefill(); renderAll();
        });
      });
      break;
    }

    case 'balk': {
      const oldBases = [...state.bases];
      const { bases, outs, runs } = processEvent('BALK', state.bases, state.outs);
      applyEventRunnerShift('BALK', oldBases);
      state.bases = bases; state.outs = outs; addRunsToScore(runs);
      addTickerEntry(`! BALK — runners advance${runs ? `  +${runs}R` : ''}`, 'special-play');
      drawAndRefill();
      if (state.outs >= 3) { endInning(); return; }
      renderAll();
      break;
    }

    case 'rain_delay': {
      const top5 = peekAndRemoveDeck(currentSide(), 5);
      if (!top5.length) { addTickerEntry('⛈ Rain delay — deck empty', 'special-play'); drawAndRefill(); renderAll(); break; }
      showRainDelayModal(top5, (ordered) => {
        commitRainDelay(cardId, ordered);
        addTickerEntry('⛈ Rain delay — cards reordered, bottom 3 degraded', 'special-play');
        drawAndRefill();
        renderAll();
      });
      break;
    }

    case 'mound_visit': {
      const top3 = peekAndRemoveDeck(currentSide(), 3);
      if (!top3.length) { addTickerEntry('◉ Mound visit — deck empty', 'special-play'); drawAndRefill(); renderAll(); break; }
      showPickModal({
        title: '◉ MOUND VISIT',
        subtitle: 'Take 1 card into your hand. The other 2 go back on top of the deck.',
        cards: top3, minPick: 1, maxPick: 1, confirmLabel: 'Take This Card',
      }, (taken) => {
        const returned = top3.filter(c => c.id !== taken[0]?.id);
        commitMoundVisit(cardId, taken[0] ?? null, returned);
        addTickerEntry(`◉ Mound visit — took 1 card, 2 returned to deck top`, 'special-play');
        drawAndRefill();
        renderAll();
      });
      break;
    }

    case 'draw_3_keep_2': {
      const drawn = draw3ForChoice(currentSide());
      if (!drawn.length) { addTickerEntry('⇅ Draw 3 — deck empty', 'special-play'); drawAndRefill(); renderAll(); break; }
      const keepN = Math.min(2, drawn.length);
      showPickModal({
        title: '⇅ DRAW 3, KEEP 2',
        subtitle: keepN < 2 ? 'Keep the card. The rest go to discard.' : 'Choose 2 cards to keep. The third goes to discard.',
        cards: drawn, minPick: keepN, maxPick: keepN, confirmLabel: `Keep ${keepN === 2 ? 'These 2' : 'This 1'}`,
      }, (kept) => {
        const discard = drawn.find(c => !kept.find(k => k.id === c.id)) ?? null;
        commitDraw3(cardId, kept, discard);
        addTickerEntry(`⇅ Drew 3 — kept ${kept.length}, discarded ${discard ? 1 : 0}`, 'special-play');
        renderAll();
      });
      break;
    }

    case 'recalled': {
      const sample = getDiscardSample(currentSide(), 6);
      if (!sample.length) { addTickerEntry('↑ Recalled — discard is empty', 'special-play'); drawAndRefill(); renderAll(); break; }
      showPickModal({
        title: '↑ RECALLED FROM MINORS',
        subtitle: 'Choose 1 card to return to your hand from the discard pile.',
        cards: sample, minPick: 1, maxPick: 1, confirmLabel: 'Recall This Card',
      }, (chosen) => {
        commitRecalled(cardId, chosen[0]);
        addTickerEntry(`↑ Recalled — 1 card returned from discard`, 'special-play');
        drawAndRefill();
        renderAll();
      });
      break;
    }

    case 'batting_coach': {
      document.getElementById('hand-container').dataset.pendingSpecial = cardId;
      addTickerEntry('↑↑ Batting Coach — select a card to upgrade, then a card to discard as the fee', 'special-play');
      renderAll();
      break;
    }

    case 'exile_one': {
      document.getElementById('hand-container').dataset.pendingSpecial = cardId;
      addTickerEntry('✕ Exile — select a card to permanently remove from the game', 'special-play');
      renderAll();
      break;
    }

  }
}

// ── Opponent auto-play (single team mode) ─────────────────────────────────────

function resolveOpponentAB(card) {
  const b = state.bases, o = state.outs;
  let result = card.result;

  // DP roll using batter stats
  if (result === 'groundout' && b[0] && o < 2) {
    const goAo = state.playerStats[card.playerId]?.goAoRatio ?? 1.0;
    if (Math.random() < Math.min(0.75, Math.max(0.20, goAo * 0.45))) result = 'DP';
  }

  const nb = [...b]; let runs = 0;
  switch (result) {
    case 'HR':      return { bases:[false,false,false], outs:o,   runs:b.filter(Boolean).length+1, result };
    case 'triple':  return { bases:[false,false,true],  outs:o,   runs:b.filter(Boolean).length,   result };
    case 'double': { const r=(b[1]?1:0)+(b[2]?1:0); return { bases:[false,true,b[0]], outs:o, runs:r, result }; }
    case 'single':  return { bases:[true,b[0],b[1]],   outs:o,   runs:b[2]?1:0, result };
    case 'BB': case 'HBP': {
      const r=(b[0]&&b[1]&&b[2])?1:0;
      return { bases:[true,b[0]||false,(b[0]&&b[1])?true:b[2]], outs:o, runs:r, result };
    }
    case 'K':  return { bases:b, outs:o+1, runs:0, result };
    case 'DP': return { bases:[false,b[1],b[2]], outs:o+2, runs:0, result };
    case 'FC': return { bases:[true,b[1],b[2]],  outs:o+1, runs:0, result };
    case 'sac_fly': {
      if (nb[2]) { runs++; nb[2]=false; }
      return { bases:nb, outs:o+1, runs, result };
    }
    case 'groundout': {
      if (nb[2]&&o<2){ runs++; nb[2]=false; }
      if (nb[0]){ nb[0]=false; nb[1]=true; }
      return { bases:nb, outs:o+1, runs, result };
    }
    case 'flyout': case 'lineout': {
      if (nb[2]&&o<2){ runs++; nb[2]=false; }
      else if (nb[1]&&o<2){ nb[1]=false; nb[2]=true; }
      return { bases:nb, outs:o+1, runs, result };
    }
    default: return { bases:b, outs:o+1, runs:0, result };
  }
}

function autoPlayOpponentAB() {
  if (state.phase !== 'playing') return;
  if (state.gameMode !== 'single') return;
  const side = currentSide();
  if (side === state.playerSide) return; // player's turn now

  if (state.outs >= 3) { endInning(); return; }

  const s = state[side];
  const card = s.deck.pop();
  if (!card) { endInning(); return; }
  s.discard.push(card);
  s.batterIndex++;

  const { bases, outs, runs, result } = resolveOpponentAB(card);
  state.bases = bases; state.outs = outs; addRunsToScore(runs);

  const dpNote = result === 'DP' && card.result !== 'DP' ? ' [DP]' : '';
  addTickerEntry(`  ${card.playerName}: ${RESULT_LABEL[result] ?? result}${dpNote}${runs > 0 ? `  +${runs}R` : ''}`, 'auto-play');

  renderAll();

  if (state.outs >= 3) setTimeout(endInning, 600);
  else setTimeout(autoPlayOpponentAB, 720);
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

const BASE_NAMES = ['1st', '2nd', '3rd'];

function applyFlyoutTagUp(card, decisions, tagProbs) {
  const nb = [...state.bases];
  const nr = [...state.baseRunners];
  let extraOuts = 0, runs = 0;
  const notes = [];

  for (let bi = 2; bi >= 0; bi--) {
    if (!state.bases[bi]) continue;
    if (decisions[bi]) {
      nb[bi] = false;
      const prob = tagProbs ? tagProbs[bi] : BASE_TAG_PROB[bi];
      if (bi === 2) {
        if (Math.random() < prob) { runs++; nr[2] = null; notes.push('3rd scores'); }
        else { extraOuts++; nr[2] = null; notes.push('3rd thrown out'); }
      } else {
        const targetOccupied = nb[bi + 1]; // check after higher base resolved
        if (targetOccupied) {
          nb[bi] = true; // blocked — auto-hold
          notes.push(`${BASE_NAMES[bi]} holds (base blocked)`);
        } else if (Math.random() < prob) {
          nb[bi + 1] = true; nr[bi + 1] = nr[bi]; nr[bi] = null;
          notes.push(`${BASE_NAMES[bi]}→${BASE_NAMES[bi + 1]} safe`);
        } else {
          extraOuts++; nr[bi] = null;
          notes.push(`${BASE_NAMES[bi]} thrown out`);
        }
      }
    }
  }
  state.baseRunners = nr;

  state.outs += 1 + extraOuts;
  state.bases = nb;
  addRunsToScore(runs);

  const noteStr = notes.length ? ` [${notes.join(', ')}]` : ' [all hold]';
  addTickerEntry(`${card.playerName}: ${RESULT_LABEL[card.result] ?? card.result}${noteStr}${runs > 0 ? `  +${runs}R` : ''}`);
  if (card.description) addTickerEntry(`  "${card.description.slice(0, 80)}"`, 'desc');
  checkOutMeter(card);
  drawAndRefill();
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

  // ERROR: upgrade any hand card 1 level
  if (card.eventType === 'ERROR') {
    const side = currentSide();
    const handCards = state[side].hand.filter(c => c.type === 'ab');
    if (!handCards.length) return;
    showPickModal({
      title: '⬆ ERROR — UPGRADE',
      subtitle: 'Opponent\'s error — upgrade one of your hand cards one level.',
      cards: handCards, minPick: 1, maxPick: 1, confirmLabel: 'Upgrade',
    }, (chosen) => {
      markEventCardUsed(card.id);
      const target = state[side].hand.find(c => c.id === chosen[0]?.id);
      if (target) { target.result = upgradeResult(target.result); target.upgraded = true; }
      addTickerEntry(`⬆ Error — ${target?.playerName ?? '?'} upgraded to ${target?.result ?? '?'}`, 'special-play');
      renderAll();
    });
    return;
  }

  // SB / WP / PB — advance runners
  markEventCardUsed(card.id);
  const oldBases = [...state.bases];
  const { bases, outs, runs } = processEvent(card.eventType, state.bases, state.outs);
  applyEventRunnerShift(card.eventType, oldBases);
  state.bases = bases; state.outs = outs; addRunsToScore(runs);
  addTickerEntry(`[${card.eventType}] ${card.description}${runs ? `  +${runs}R` : ''}`);
  if (state.outs >= 3) { endInning(); return; }
  renderAll();
});

// ── Inning / game end ─────────────────────────────────────────────────────────

function endInning() {
  const half = state.isTop ? 'Top' : 'Bot', inning = state.inning;
  const skipBottom = state.isTop && state.inning === 9 && state.score.home > state.score.away;
  endHalfInning();
  addTickerEntry(`─── End ${half} ${inning} ───`, 'divider');
  if (skipBottom) { addTickerEntry('─── Home leads — no bottom 9th ───', 'divider'); endGame(); return; }
  if (isGameOver()) { endGame(); return; }
  renderAll();
  if (state.gameMode === 'single' && currentSide() !== state.playerSide) {
    setTimeout(autoPlayOpponentAB, 900);
  }
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
