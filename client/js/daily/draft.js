import { REQUIRED_POSITIONS } from './pool.js';
import { seededRng } from './rng.js';

// Pure draft state machine for the Daily Lineup positional draft.
//
// Daily (deterministic=true) → a FIXED TAPE of 11 teams, the same for everyone
//   that day+style. You start on tape[0]; a reroll advances to the next team on
//   the tape and costs one of a shared budget of 2 (not per-round); a pick also
//   advances the tape. So you only ever encounter teams #1–#11 (9 picks + ≤2
//   skips). A team that can't fill any open position costs a reroll to pass.
// Free Play (deterministic=false) → a fresh random roll each time, 2 rerolls
//   per round (unchanged).
export function createDraft({ teams, date, style = 'normal', deterministic = true }) {
  const rng = deterministic
    ? seededRng(`${date}:${style}`)
    : seededRng(`${date}:${style}:${Date.now()}:${Math.random()}`);
  const positions = [...REQUIRED_POSITIONS];
  const totalRounds = positions.length; // 9

  const tapeMode = deterministic;                 // Daily uses the fixed tape
  const REROLLS_PER_ROUND = 2;                    // Free Play budget (per round)
  const TAPE_LEN = 11, TAPE_BUDGET = 2;           // Daily: 9 picks + 2 skips
  const tape = tapeMode ? rng.shuffle(teams).slice(0, Math.min(TAPE_LEN, teams.length)) : [];
  let pointer = 0;

  const filledPositions = new Set();
  const slots = Array(totalRounds).fill(null); // batting order (index 0 = leadoff)
  let round = 0;
  let currentTeam = null;
  let rerollsLeft = tapeMode ? TAPE_BUDGET : REROLLS_PER_ROUND;

  // Pre-DH-era slates (old NL games) have no player who played DH. To avoid a
  // dead-end, ONLY when DH is the last unfilled slot AND the pool has no natural
  // DH, any remaining batter may fill it. Otherwise DH is never offered to a
  // non-DH player (so cards never read "1B/DH").
  const hasNaturalDH = (teams ?? []).some(t => (t.players ?? []).some(p => (p.positions ?? []).includes('DH')));

  const openPositionsFor = p => {
    const own = (p.positions ?? [p.position]).filter(pos => !filledPositions.has(pos));
    const onlyDHLeft = !filledPositions.has('DH') && filledPositions.size === totalRounds - 1;
    if (!hasNaturalDH && onlyDHLeft && own.length === 0) own.push('DH');
    return [...new Set(own)];
  };
  const isEligible = p => openPositionsFor(p).length > 0;
  const eligible = team => team.players.filter(isEligible);

  function rollTeam() {
    if (tapeMode) {
      currentTeam = tape[pointer] ?? null;
      // safety: a dead team costs a reroll to pass, but if you're out of budget
      // don't soft-lock — free-advance to the next team that can fill something
      while (currentTeam && !eligible(currentTeam).length && rerollsLeft <= 0 && pointer < tape.length - 1) {
        pointer++; currentTeam = tape[pointer];
      }
      return currentTeam;
    }
    // Free Play: advance the random roll until a team with an eligible player appears
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
    if (tapeMode) pointer++;                      // a pick consumes a tape slot; budget is shared
    else rerollsLeft = REROLLS_PER_ROUND;         // Free Play resets rerolls per round
    return { ok: true, done: round >= totalRounds };
  }

  // Manually reroll (costs a reroll). Daily → advance the fixed tape; Free Play → new random team.
  function reroll() {
    if (rerollsLeft <= 0) return { ok: false, error: 'no rerolls left' };
    if (tapeMode && pointer >= tape.length - 1) return { ok: false, error: 'end of tape' };
    rerollsLeft--;
    if (tapeMode) { pointer++; currentTeam = tape[pointer] ?? null; }
    else rollTeam();
    return { ok: true, rerollsLeft };
  }

  function start() {
    round = 0; filledPositions.clear(); slots.fill(null);
    pointer = 0;
    rerollsLeft = tapeMode ? TAPE_BUDGET : REROLLS_PER_ROUND;
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
