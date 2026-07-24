import { processAB } from '../sim.js';

// Simulate a drafted lineup batting for up to 9 innings.
// lineup: [{ id, name, position, results: [resultStr,...] }, ...] (batting order)
// Each player bats their `results` in order. A player with no results left is
// skipped. The game ends at 9 completed innings (27 outs) OR when every player's
// at-bats are exhausted, whichever comes first. Returns runs, per-inning runs,
// and a play-by-play log for the Gameday-style animation.
export function playOut(lineup) {
  const ptr = lineup.map(() => 0);              // next-PA index per slot
  const hasPA = i => ptr[i] < lineup[i].results.length;
  const anyRemaining = () => lineup.some((_, i) => hasPA(i));

  let bases = [false, false, false];
  let outs = 0, inning = 1, runs = 0;
  let slot = 0, curInningRuns = 0, paThisInning = 0;
  const log = [];
  const inningRuns = [];

  while (inning <= 9 && anyRemaining()) {
    // find next slot (from current) with a remaining PA
    let found = -1;
    for (let t = 0; t < lineup.length; t++) {
      const s = (slot + t) % lineup.length;
      if (hasPA(s)) { found = s; break; }
    }
    if (found === -1) break;
    slot = found;

    const player = lineup[slot];
    let result = player.results[ptr[slot]++];
    if (result === 'DP' && !bases[0]) result = 'groundout'; // no one to double off

    const basesBefore = [...bases];
    const outsBefore = outs;
    const { bases: nb, outs: no, runs: r } = processAB(result, bases, outs, {});
    runs += r; curInningRuns += r; paThisInning++;

    log.push({
      inning, slot: slot + 1, player: player.name, position: player.position,
      result, runsScored: r, outsBefore, basesBefore, basesAfter: [...nb],
      outsAfter: Math.min(no, 3), totalRuns: runs,
    });

    bases = nb; outs = no;

    if (outs >= 3) {
      inningRuns.push(curInningRuns);
      curInningRuns = 0; paThisInning = 0;
      outs = 0; bases = [false, false, false];
      inning++;
      slot = (slot + 1) % lineup.length;
    } else {
      slot = (slot + 1) % lineup.length;
    }
  }

  // record a final partial inning (ended by PA exhaustion mid-inning)
  if (paThisInning > 0) inningRuns.push(curInningRuns);

  return {
    runs,
    inningsPlayed: inningRuns.length,
    inningRuns,          // runs per inning
    endedBy: inning > 9 ? 'innings' : 'at-bats',
    totalPAs: log.length,
    log,
  };
}
