import { REQUIRED_POSITIONS } from './pool.js';
import { seededRng } from './rng.js';

// Pure draft state machine for the Daily Lineup positional draft.
// Each round rolls a team (deterministic by date seed); the player picks one
// eligible batter (a still-open defensive position) and assigns a batting slot.
export function createDraft({ teams, date, mode = 'daily' }) {
  const rng = seededRng(`${date}:${mode}`);
  const positions = [...REQUIRED_POSITIONS];
  const totalRounds = positions.length; // 9

  const REROLLS_PER_ROUND = 2;
  const filledPositions = new Set();
  const slots = Array(totalRounds).fill(null); // batting order (index 0 = leadoff)
  let round = 0;
  let currentTeam = null;
  let rerollsLeft = REROLLS_PER_ROUND;

  // A player's still-open draftable positions (multi-position players can fill any)
  const openPositionsFor = p => (p.positions ?? [p.position]).filter(pos => !filledPositions.has(pos));
  const isEligible = p => openPositionsFor(p).length > 0;
  const eligible = team => team.players.filter(isEligible);

  function rollTeam() {
    // advance the seeded roll until a team with an eligible player appears
    for (let i = 0; i < 500; i++) {
      const t = rng.pick(teams);
      if (eligible(t).length) { currentTeam = t; return t; }
    }
    currentTeam = null;
    return null;
  }

  function openSlots() {
    return slots.map((s, i) => (s ? null : i)).filter(i => i !== null);
  }

  function pick(playerId, slotIndex, chosenPosition) {
    if (!currentTeam) return { ok: false, error: 'no team rolled' };
    const player = currentTeam.players.find(p => p.id === playerId);
    if (!player) return { ok: false, error: 'player not on rolled team' };
    const open = openPositionsFor(player);
    if (!open.length) return { ok: false, error: 'position already filled' };
    const pos = chosenPosition && open.includes(chosenPosition) ? chosenPosition : open[0];
    if (slotIndex == null || slots[slotIndex]) return { ok: false, error: 'slot unavailable' };

    slots[slotIndex] = { ...player, position: pos, battingSlot: slotIndex + 1 };
    filledPositions.add(pos);
    round++;
    rerollsLeft = REROLLS_PER_ROUND; // reset for the next round
    return { ok: true, done: round >= totalRounds };
  }

  // Manually roll a fresh team (costs a reroll). Team repeats are allowed.
  function reroll() {
    if (rerollsLeft <= 0) return { ok: false, error: 'no rerolls left' };
    rerollsLeft--;
    rollTeam();
    return { ok: true, rerollsLeft };
  }

  function start() {
    round = 0; filledPositions.clear(); slots.fill(null);
    rerollsLeft = REROLLS_PER_ROUND;
    return rollTeam();
  }

  return {
    get round() { return round; },
    get totalRounds() { return totalRounds; },
    get currentTeam() { return currentTeam; },
    get slots() { return slots; },
    get positions() { return positions; },
    get rerollsLeft() { return rerollsLeft; },
    filledPositions,
    reroll,
    openPositions: () => positions.filter(p => !filledPositions.has(p)),
    openPositionsFor,
    isEligible,
    openSlots,
    eligible,
    rollTeam,
    pick,
    start,
    isComplete: () => round >= totalRounds,
    lineup: () => slots.filter(Boolean), // in batting order
  };
}
