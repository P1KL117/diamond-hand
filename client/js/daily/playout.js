import { processAB } from '../sim.js';

// Simulate a drafted lineup batting a full 9 innings (27 outs).
// lineup: [{ id, name, position, results: [resultStr,...] }, ...] (batting order)
// Each player bats their `results` in order. Once a batter has used all their
// real at-bats, they still come up in the order but make an automatic out
// (flagged `exhausted`) — they are never skipped. The game ends after 9 innings.
export function playOut(lineup) {
  const ptr = lineup.map(() => 0); // next real-PA index per slot

  let bases = [false, false, false];
  let outs = 0, inning = 1, runs = 0;
  let slot = 0, curInningRuns = 0;
  const log = [];
  const inningRuns = [];

  while (inning <= 9) {
    const player = lineup[slot];
    const exhausted = ptr[slot] >= player.results.length;
    let result = exhausted ? 'groundout' : player.results[ptr[slot]++];
    if (result === 'DP' && !bases[0]) result = 'groundout'; // no one to double off

    const basesBefore = [...bases];
    const outsBefore = outs;
    const { bases: nb, outs: no, runs: r } = processAB(result, bases, outs, {});
    runs += r; curInningRuns += r;

    log.push({
      inning, slot: slot + 1, player: player.name, position: player.position,
      result, exhausted, runsScored: r, outsBefore, basesBefore, basesAfter: [...nb],
      outsAfter: Math.min(no, 3), totalRuns: runs,
    });

    bases = nb; outs = no;

    if (outs >= 3) {
      inningRuns.push(curInningRuns);
      curInningRuns = 0;
      outs = 0; bases = [false, false, false];
      inning++;
    }
    slot = (slot + 1) % lineup.length;
  }

  return {
    runs,
    inningsPlayed: inningRuns.length,
    inningRuns,          // runs per inning (9 entries)
    endedBy: 'innings',
    totalPAs: log.length,
    realPAs: ptr.reduce((a, b) => a + b, 0),
    log,
  };
}
