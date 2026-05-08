import { degradeResult, upgradeResult, shuffle } from './cards.js';

const HAND_SIZE = 7;

function makeSide() {
  return {
    deck: [], hand: [], discard: [], burned: [],
    battingOrder: [], batterIndex: 0, eventCards: [],
    deckCycles: 0,
    hitAndRunActive: false,
    lastPlayedABCard: null,
    consecutiveOuts: 0,
    pendingRetain: null,
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
      dumpHandToDiscard();
      drawCards(side, HAND_SIZE);
      return { kind: 'immediate', msg: '⇄ Pitching change — new hand drawn' };
    }

    case 'rain_delay': {
      burnSpecialCard(cardId);
      dumpHandToDiscard();
      s.discard = s.discard.map(c => ({ ...c, result: degradeResult(c.result), degraded: c.degraded + 1 }));
      drawCards(side, HAND_SIZE);
      return { kind: 'immediate', msg: '⛈ Rain delay — discard degraded, new hand drawn' };
    }

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
      drawCards(side, s.hand.length + 1);
      return { kind: 'immediate', msg: '◀◀ Replay review — last AB reversed' };
    }

    case 'mound_visit':
      return { kind: 'mound_visit', cardId };

    case 'draw_2_discard_1':
      return { kind: 'draw_2_discard_1', cardId };

    case 'recalled':
      return { kind: 'recalled', cardId };

    case 'batting_coach':
      state.battingCoachMode = true;
      return { kind: 'batting_coach', cardId };

    case 'discard_one':
      state.discardOneMode = true;
      return { kind: 'discard_one', cardId };

    case 'balk': {
      burnSpecialCard(cardId);
      return { kind: 'balk' };
    }

    case 'hit_and_run': {
      burnSpecialCard(cardId);
      s.hitAndRunActive = true;
      return { kind: 'immediate', msg: '↗ Hit & Run active — next groundout/FC plays as single' };
    }

    default:
      burnSpecialCard(cardId);
      return { kind: 'immediate', msg: 'Special card played' };
  }
}

// ── Mound visit: reveal top 5, player picks which to take ────────────────────

export function peekAndRemoveDeck(side, n) {
  const s = state[side];
  const taken = [];
  for (let i = 0; i < n && s.deck.length; i++) taken.push(s.deck.pop());
  return taken; // temporarily removed; commitMoundVisit will resolve them
}

export function commitMoundVisit(cardId, taken, returned) {
  const side = currentSide();
  const s = state[side];
  s.hand.push(...taken);
  s.discard.push(...returned);
  burnSpecialCard(cardId);
}

// ── Draw 2 Discard 1 ──────────────────────────────────────────────────────────

export function draw2ForChoice(side) {
  const s = state[side];
  const drawn = [];
  for (let i = 0; i < 2 && s.deck.length; i++) drawn.push(s.deck.pop());
  return drawn;
}

export function commitDraw2(cardId, keep, discard) {
  const side = currentSide();
  const s = state[side];
  if (keep) s.hand.push(keep);
  if (discard) s.discard.push(discard);
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

// ── Batting coach: upgrade a hand card one tier ───────────────────────────────

export function commitBattingCoach(specialCardId, targetCardId) {
  const side = currentSide();
  const s = state[side];
  state.battingCoachMode = false;
  burnSpecialCard(specialCardId);
  const card = s.hand.find(c => c.id === targetCardId);
  if (card) { card.result = upgradeResult(card.result); card.upgraded = true; }
}

// ── Discard one ───────────────────────────────────────────────────────────────

export function commitDiscardOne(specialCardId, targetCardId) {
  const side = currentSide();
  const s = state[side];
  if (s.pendingRetain?.id === targetCardId) return; // retained card is protected
  state.discardOneMode = false;
  burnSpecialCard(specialCardId);
  const ti = s.hand.findIndex(c => c.id === targetCardId);
  if (ti !== -1) { const [card] = s.hand.splice(ti, 1); s.discard.push(card); }
  drawCards(side, s.hand.length + 1);
}

// ── Hit & run ─────────────────────────────────────────────────────────────────

export function consumeHitAndRun() { state[currentSide()].hitAndRunActive = false; }

// ── Retain ────────────────────────────────────────────────────────────────────

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
  dumpHandToDiscard();
  const side = currentSide();
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
