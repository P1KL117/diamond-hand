import { REQUIRED_POSITIONS } from './pool.js';
import { seededRng } from './rng.js';

// Pure draft state machine for the Daily Lineup positional draft.
// Each round rolls a team; the player picks one eligible batter (a still-open
// defensive position) and assigns a batting slot.
// Daily (deterministic) → same team rolls for everyone that day. Free Play
// (deterministic:false) → a fresh random roll sequence on every draft.
export function createDraft({ teams, date, style = 'normal', deterministic = true }) {
  const rng = deterministic
    ? seededRng(`${date}:${style}`)
    : seededRng(`${date}:${style}:${Date.now()}:${Math.random()}`);
  const positions = [...REQUIRED_POSITIONS];
  const totalRounds = positions.length; // 9

  const REROLLS_PER_ROUND = 2;
  const filledPositions = new Set();
  const slots = Array(totalRounds).fill(null); // batting order (index 0 = leadoff)
  let round = 0;
  let currentTeam = null;
  let rerollsLeft = REROLLS_PER_ROUND;

  // Pre-DH-era slates (old NL games) have no player who played DH — without this
  // the DH slot can never be filled. When the pool has no natural DH, any batter
  // may fill DH.
  const hasNaturalDH = (teams ?? []).some(t => (t.players ?? []).some(p => (p.positions ?? []).includes('DH')));

  // A player's still-open draftable positions (multi-position players can fill any)
  const openPositionsFor = p => {
    const own = (p.positions ?? [p.position]).filter(pos => !filledPositions.has(pos));
    if (!hasNaturalDH && !filledPositions.has('DH')) own.push('DH');
    return [...new Set(own)];
  };
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

  // Swap two batting slots (for the optional post-draft reorder in Free Play).
  function swapSlots(i, j) {
    const a = slots[i], b = slots[j];
    slots[i] = b; slots[j] = a;
    if (slots[i]) slots[i].battingSlot = i + 1;
    if (slots[j]) slots[j].battingSlot = j + 1;
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
    swapSlots,
    start,
    isComplete: () => round >= totalRounds,
    lineup: () => slots.filter(Boolean), // in batting order
  };
}
