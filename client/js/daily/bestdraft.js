// "Best possible daily draft" benchmark.
//
// The daily draft draws from a fixed 11-team tape with a shared 2-reroll budget,
// so the achievable drafts are small: pick 9 of the first 11 tape teams (skipping
// ≤2), one player per team filling 9 distinct positions, in any batting order.
// We enumerate the reachable team subsequences, build a strong lineup for each
// (value-greedy position assignment), then optimize the batting order with the
// exact runs-only simulator. Returns the best runs found + that lineup.
//
// It's a strong benchmark, not a proof of the absolute maximum.
import { seededRng } from './rng.js';
import { simRuns } from './playout.js';
import { REQUIRED_POSITIONS } from './pool.js';

const TAPE_LEN = 11;

// Reachable 9-team pick sequences: choose ≤2 tape positions to skip (reroll).
function reachableTeamSeqs(tape) {
  const n = tape.length;
  const seqs = [];
  const add = skipSet => {
    const picks = [];
    for (let i = 0; i < n && picks.length < 9; i++) if (!skipSet.has(i)) picks.push(tape[i]);
    if (picks.length === 9) seqs.push(picks);
  };
  add(new Set());                                             // 0 skips
  for (let a = 0; a < n; a++) add(new Set([a]));              // 1 skip
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) add(new Set([a, b])); // 2 skips
  return seqs;
}

// Build a strong 9-player lineup for a team sequence: assign each team one of the
// 9 positions (value-greedy), taking that team's best player at the position.
function bestLineupForSeq(seq, hasNaturalDH) {
  const opts = [];
  seq.forEach((team, ti) => {
    for (const pos of REQUIRED_POSITIONS) {
      let best = null;
      for (const p of team.players) {
        const natural = (p.positions ?? [p.position]).includes(pos);
        const dhFlex = pos === 'DH' && !hasNaturalDH; // pre-DH slate: any batter can DH
        if (natural || dhFlex) { if (!best || p.value > best.value) best = p; }
      }
      if (best) opts.push({ ti, pos, player: best, value: best.value });
    }
  });
  opts.sort((a, b) => b.value - a.value);
  const usedTeam = new Set(), usedPos = new Set(), assign = {};
  for (const o of opts) {
    if (usedTeam.has(o.ti) || usedPos.has(o.pos)) continue;
    usedTeam.add(o.ti); usedPos.add(o.pos); assign[o.pos] = o;
  }
  // fallback: fill any leftover positions with unused teams' best bat
  if (Object.keys(assign).length < 9) {
    for (const pos of REQUIRED_POSITIONS) {
      if (assign[pos]) continue;
      for (let ti = 0; ti < seq.length; ti++) {
        if (usedTeam.has(ti)) continue;
        const p = [...seq[ti].players].sort((a, b) => b.value - a.value)[0];
        if (p) { assign[pos] = { ti, pos, player: p }; usedTeam.add(ti); break; }
      }
    }
  }
  if (Object.keys(assign).length < 9) return null;
  return REQUIRED_POSITIONS.map(pos => ({ ...assign[pos].player, position: pos }));
}

// 2-opt on the batting order using exact sim runs; converges to a local optimum.
function optimizeOrder(lineup) {
  let order = [...lineup].sort((a, b) => b.value - a.value); // sensible start
  let best = simRuns(order);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < 9; i++) for (let j = i + 1; j < 9; j++) {
      [order[i], order[j]] = [order[j], order[i]];
      const r = simRuns(order);
      if (r > best) { best = r; improved = true; }
      else [order[i], order[j]] = [order[j], order[i]]; // revert
    }
  }
  return { runs: best, order: order.map((p, i) => ({ ...p, battingSlot: i + 1 })) };
}

export function bestDailyDraft(pool, date, style) {
  const teams = pool?.teams ?? [];
  if (teams.length < 9) return null;
  const tape = seededRng(`${date}:${style}`).shuffle(teams).slice(0, Math.min(TAPE_LEN, teams.length));
  const hasNaturalDH = teams.some(t => (t.players ?? []).some(p => (p.positions ?? []).includes('DH')));
  const shuffleFor = style === 'shuffled'
    ? p => ({ ...p, results: seededRng(`${date}:shuffled:${p.id}`).shuffle(p.results) })
    : p => p;

  let best = { runs: -1, lineup: null };
  const seen = new Set();
  for (const seq of reachableTeamSeqs(tape)) {
    const lineup = bestLineupForSeq(seq, hasNaturalDH);
    if (!lineup) continue;
    const key = lineup.map(p => p.id).sort().join(',');
    if (seen.has(key)) continue; // skip duplicate player-sets
    seen.add(key);
    const simLineup = lineup.map(shuffleFor);
    const { runs, order } = optimizeOrder(simLineup);
    if (runs > best.runs) best = { runs, lineup: order };
  }
  return best;
}
