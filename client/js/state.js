import { degradeResult, upgradeResult, shuffle } from './cards.js';

const HAND_SIZE = 3;

function makeSide() {
  return {
    deck: [], hand: [], discard: [], burned: [],
    battingOrder: [], batterIndex: 0, eventCards: [],
    deckCycles: 0,
    hitAndRunActive: false,
    lastPlayedABCard: null,
    consecutiveOuts: 0,
    pendingRetain: null,
    skipNextOut: false,   // pitching change: skip next out drawn
    freeOutActive: false, // hold on: next out doesn't count
  };
}

export const state = {
  phase: 'picker',
  selectedGame: null,
  playerSide: null,
  gameMode: 'solitaire',   // 'solitaire' | 'single'
  playerStats: {},         // playerId → { goAoRatio, sbPct }

  home: makeSide(),
  away: makeSide(),

  inning: 1, isTop: true, outs: 0,
  bases: [false, false, false],
  baseRunners: [null, null, null],   // { playerId, playerName, sbPct } per base
  score: { home: 0, away: 0 },
  inningScores: { home: Array(9).fill(null), away: Array(9).fill(null) },
  currentInningRuns: 0,

  // UI interaction modes
  discardOneMode: false,
  battingCoachMode: false,
  battingCoachTarget: null,  // cardId selected in step 1 of batting coach
  retainMode: false,

  playLog: [],
  realFeed: null,
};

export function resetSides() { state.home = makeSide(); state.away = makeSide(); }
export function currentSide() { return state.isTop ? 'away' : 'home'; }

export function currentBatter() {
  const s = state[currentSide()];
  if (!s.battingOrder.length) return null;
  return s.battingOrder[s.batterIndex % s.battingOrder.length];
}

export function currentBatterSlot() {
  const s = state[currentSide()];
  if (!s.battingOrder.length) return 0;
  return (s.batterIndex % s.battingOrder.length) + 1;
}

// ── Deck / draw ───────────────────────────────────────────────────────────────

export function drawCards(side, n) {
  const s = state[side];
  if (s.pendingRetain) {
    s.hand.push(s.pendingRetain);
    s.pendingRetain = null;
  }
  while (s.hand.length < n) {
    if (!s.deck.length) {
      if (!s.discard.length) break;
      reshuffleDiscard(side);
    }
    if (s.deck.length) s.hand.push(s.deck.pop());
    else break;
  }
}

export function reshuffleDiscard(side) {
  const s = state[side];
  s.deckCycles++;
  s.deck = shuffle([...s.discard]);
  s.discard = [];
}

// Hook: bonus card can trigger clean reshuffle
export function triggerEarlyReshuffle(side, applyDegradation = true) {
  const s = state[side];
  if (applyDegradation) reshuffleDiscard(side);
  else { s.deck = [...s.deck, ...shuffle(s.discard)]; s.discard = []; }
}

// ── AB card play ──────────────────────────────────────────────────────────────

export function playABCard(cardId) {
  const side = currentSide();
  const s = state[side];
  const idx = s.hand.findIndex(c => c.id === cardId);
  if (idx === -1) return null;
  const [card] = s.hand.splice(idx, 1);
  s.discard.push(card);
  s.lastPlayedABCard = card;
  s.batterIndex++;
  return card;
}

export function canRedraw() {
  const hand = state[currentSide()].hand;
  return hand.length === 0 || hand.every(c => c.type !== 'ab');
}
export function doRedraw() {
  if (state[currentSide()].hand.length > 0) dumpHandToDiscard();
  drawCards(currentSide(), HAND_SIZE);
}

export function dumpHandToDiscard() {
  const s = state[currentSide()];
  // Retained card is pulled out before dumping; it stays in pendingRetain for next draw
  if (s.pendingRetain) {
    s.discard.push(...s.hand.filter(c => c !== s.pendingRetain));
  } else {
    s.discard.push(...s.hand);
  }
  s.hand = [];
}

// ── Special cards ─────────────────────────────────────────────────────────────

function burnSpecialCard(cardId) {
  const side = currentSide();
  const s = state[side];
  const idx = s.hand.findIndex(c => c.id === cardId);
  if (idx === -1) return null;
  const [card] = s.hand.splice(idx, 1);
  s.burned.push(card);
  return card;
}

export function playSpecialCard(cardId) {
  const side = currentSide();
  const s = state[side];
  const card = s.hand.find(c => c.id === cardId);
  if (!card || card.type !== 'special') return null;

  switch (card.specialType) {
    case 'pitching_change': {
      burnSpecialCard(cardId);
      s.skipNextOut = true;
      return { kind: 'immediate', msg: '⇄ Pitching change — next out you draw is skipped' };
    }

    case 'rain_delay':
      return { kind: 'rain_delay', cardId };

    case 'replay_review': {
      burnSpecialCard(cardId);
      const last = s.lastPlayedABCard;
      if (last) {
        const di = s.discard.findIndex(c => c.id === last.id);
        if (di !== -1) s.discard.splice(di, 1);
        s.hand.push(last);
        s.lastPlayedABCard = null;
        if (s.batterIndex > 0) s.batterIndex--;
      }
      drawCards(side, HAND_SIZE);
      return { kind: 'immediate', msg: '◀◀ Replay review — last AB returned to hand' };
    }

    case 'mound_visit':
      return { kind: 'mound_visit', cardId };

    case 'draw_2_discard_1':
      return { kind: 'draw_3_keep_2', cardId };

    case 'recalled':
      return { kind: 'recalled', cardId };

    case 'batting_coach':
      state.battingCoachMode = true;
      state.battingCoachTarget = null;
      return { kind: 'batting_coach', cardId };

    case 'discard_one':
      state.discardOneMode = true;
      return { kind: 'exile_one', cardId };

    case 'balk': {
      burnSpecialCard(cardId);
      return { kind: 'balk' };
    }

    case 'hit_and_run': {
      burnSpecialCard(cardId);
      s.hitAndRunActive = true;
      return { kind: 'immediate', msg: '↗ Hit & Run active — next groundout/FC plays as single' };
    }

    case 'retain': {
      burnSpecialCard(cardId);
      s.freeOutActive = true;
      return { kind: 'immediate', msg: '🛡 Hold On — the next out this inning is nullified' };
    }

    default:
      burnSpecialCard(cardId);
      return { kind: 'immediate', msg: 'Special card played' };
  }
}

// ── Mound visit: peek 3, take 1, put 2 back on top of deck ───────────────────

export function peekAndRemoveDeck(side, n) {
  const s = state[side];
  const taken = [];
  for (let i = 0; i < n && s.deck.length; i++) taken.push(s.deck.pop());
  return taken;
}

export function commitMoundVisit(cardId, takenCard, returnedCards) {
  const side = currentSide();
  const s = state[side];
  if (takenCard) s.hand.push(takenCard);
  // Push returned in reverse so original order is preserved (first peeked = top of deck)
  if (returnedCards.length) s.deck.push(...[...returnedCards].reverse());
  burnSpecialCard(cardId);
}

// ── Rain delay: peek 5, reorder, bottom 3 degrade ────────────────────────────

export function commitRainDelay(cardId, reorderedCards) {
  const side = currentSide();
  const s = state[side];
  const processed = reorderedCards.map((c, i) =>
    (i >= 2 && c.type === 'ab')
      ? { ...c, result: degradeResult(c.result), degraded: (c.degraded || 0) + 1 }
      : c
  );
  // Push reversed so index-0 ends up on top (last popped)
  s.deck.push(...[...processed].reverse());
  burnSpecialCard(cardId);
}

// ── Draw 3 Keep 2 ─────────────────────────────────────────────────────────────

export function draw3ForChoice(side) {
  const s = state[side];
  const drawn = [];
  for (let i = 0; i < 3 && s.deck.length; i++) drawn.push(s.deck.pop());
  return drawn;
}

export function commitDraw3(cardId, keepCards, discardCard) {
  const side = currentSide();
  const s = state[side];
  s.hand.push(...keepCards);
  if (discardCard) s.discard.push(discardCard);
  burnSpecialCard(cardId);
}

// ── Recalled from minors ──────────────────────────────────────────────────────

export function getDiscardSample(side, n) {
  return shuffle([...state[side].discard]).slice(0, Math.min(n, state[side].discard.length));
}

export function commitRecalled(cardId, chosen) {
  const side = currentSide();
  const s = state[side];
  burnSpecialCard(cardId);
  const idx = s.discard.findIndex(c => c.id === chosen.id);
  if (idx !== -1) { s.discard.splice(idx, 1); s.hand.push(chosen); }
}

// ── Batting coach: upgrade one card, discard one as fee ──────────────────────

export function commitBattingCoach(specialCardId, upgradeTargetId, costCardId) {
  const side = currentSide();
  const s = state[side];
  state.battingCoachMode = false;
  state.battingCoachTarget = null;
  burnSpecialCard(specialCardId);
  const target = s.hand.find(c => c.id === upgradeTargetId);
  if (target) { target.result = upgradeResult(target.result); target.upgraded = true; }
  const costIdx = s.hand.findIndex(c => c.id === costCardId);
  if (costIdx !== -1) { const [cost] = s.hand.splice(costIdx, 1); s.discard.push(cost); }
}

// ── Exile one (permanent removal) ────────────────────────────────────────────

export function commitExileOne(specialCardId, targetCardId) {
  const side = currentSide();
  const s = state[side];
  state.discardOneMode = false;
  burnSpecialCard(specialCardId);
  const ti = s.hand.findIndex(c => c.id === targetCardId);
  if (ti !== -1) { const [card] = s.hand.splice(ti, 1); s.burned.push(card); } // burned, not discard
}

// ── Hit & run ─────────────────────────────────────────────────────────────────

export function consumeHitAndRun() { state[currentSide()].hitAndRunActive = false; }

// ── (Retain legacy — kept for pendingRetain card persistence) ─────────────────

export function commitRetain(specialCardId, targetCardId) {
  const side = currentSide();
  const s = state[side];
  state.retainMode = false;
  burnSpecialCard(specialCardId);
  const card = s.hand.find(c => c.id === targetCardId);
  if (card) s.pendingRetain = card;
}

// ── Inning / game management ─────────────────────────────────────────────────

export function endHalfInning() {
  const side = currentSide();
  state[side].skipNextOut = false;
  state[side].freeOutActive = false;
  dumpHandToDiscard();
  state.inningScores[side][state.inning - 1] = state.currentInningRuns;
  state.currentInningRuns = 0;
  state.outs = 0;
  state.bases = [false, false, false];
  state.baseRunners = [null, null, null];
  const controlled = s => state.gameMode === 'solitaire' || state.playerSide === s;
  if (state.isTop) { state.isTop = false; if (controlled('home')) drawCards('home', HAND_SIZE); }
  else { state.inning++; state.isTop = true; if (state.inning <= 9 && controlled('away')) drawCards('away', HAND_SIZE); }
}

export function isGameOver() { return state.inning > 9; }
export function addRunsToScore(runs) { state.score[currentSide()] += runs; state.currentInningRuns += runs; }
export function getActiveEventCards() {
  return state[currentSide()].eventCards.filter(c => !c.used);
}

export function markEventCardUsed(cardId) {
  const card = state[currentSide()].eventCards.find(c => c.id === cardId);
  if (card) card.used = true;
}

export function logPlay(text) { state.playLog.unshift(text); }
export function realGameScore(feed) {
  const ls = feed?.liveData?.linescore;
  return { home: ls?.teams?.home?.runs ?? '?', away: ls?.teams?.away?.runs ?? '?' };
}
