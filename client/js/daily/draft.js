import { REQUIRED_POSITIONS } from './pool.js';
import { seededRng } from './rng.js';

// Pure draft state machine for the Daily Lineup positional draft.
// Each round rolls a team (deterministic by date seed); the player picks one
// eligible batter (a still-open defensive position) and assigns a batting slot.
export function createDraft({ teams, date, mode = 'daily' }) {
  const rng = seededRng(`${date}:${mode}`);
  const positions = [...REQUIRED_POSITIONS];
  const totalRounds = positions.length; // 9

  const filledPositions = new Set();
  const slots = Array(totalRounds).fill(null); // batting order (index 0 = leadoff)
  let round = 0;
  let currentTeam = null;

  const eligible = team => team.players.filter(p => !filledPositions.has(p.position));

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

  function pick(playerId, slotIndex) {
    if (!currentTeam) return { ok: false, error: 'no team rolled' };
    const player = currentTeam.players.find(p => p.id === playerId);
    if (!player) return { ok: false, error: 'player not on rolled team' };
    if (filledPositions.has(player.position)) return { ok: false, error: 'position already filled' };
    if (slotIndex == null || slots[slotIndex]) return { ok: false, error: 'slot unavailable' };

    slots[slotIndex] = { ...player, battingSlot: slotIndex + 1 };
    filledPositions.add(player.position);
    round++;
    return { ok: true, done: round >= totalRounds };
  }

  function start() { round = 0; filledPositions.clear(); slots.fill(null); return rollTeam(); }

  return {
    get round() { return round; },
    get totalRounds() { return totalRounds; },
    get currentTeam() { return currentTeam; },
    get slots() { return slots; },
    get positions() { return positions; },
    filledPositions,
    openPositions: () => positions.filter(p => !filledPositions.has(p)),
    openSlots,
    eligible,
    rollTeam,
    pick,
    start,
    isComplete: () => round >= totalRounds,
    lineup: () => slots.filter(Boolean), // in batting order
  };
}
