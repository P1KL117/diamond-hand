// Identity-aware baseball play-out for the Daily Lineup game.
// Tracks which runner is on each base so we can credit runs (R) and RBIs to
// specific players, and estimates each player's run value (RE24 x leverage)
// to award an MVP. Ends after a full 9 innings (27 outs); exhausted batters
// make automatic outs rather than being skipped.

// Run-expectancy by base-out state (approx 2010s MLB). Index by outs then by
// base bitmask: bit0=1st, bit1=2nd, bit2=3rd.
const RE = {
  0: [0.48, 0.85, 1.10, 1.44, 1.35, 1.75, 1.96, 2.29],
  1: [0.25, 0.50, 0.65, 0.87, 0.90, 1.13, 1.35, 1.54],
  2: [0.10, 0.22, 0.31, 0.43, 0.35, 0.48, 0.58, 0.75],
};
const baseMask = occ => (occ[0] ? 1 : 0) | (occ[1] ? 2 : 0) | (occ[2] ? 4 : 0);
const runExp = (occ, outs) => outs > 2 ? 0 : RE[outs][baseMask(occ)];

// Move runners for a plate-appearance result. occ = [1st,2nd,3rd] player ids
// (or null). Returns new occupants, the ids that scored, and outs added.
function advanceRunners(result, occ, outsBefore, batterId) {
  const [a, b, c] = occ;
  const under2 = outsBefore < 2;
  const S = [];
  const push = x => { if (x != null) S.push(x); };

  switch (result) {
    case 'HR': push(c); push(b); push(a); push(batterId); return { occ: [null, null, null], scorers: S, outsAdded: 0 };
    case 'triple': push(c); push(b); push(a); return { occ: [null, null, batterId], scorers: S, outsAdded: 0 };
    case 'double': push(c); push(b); return { occ: [null, batterId, a], scorers: S, outsAdded: 0 };
    case 'single': push(c); return { occ: [batterId, a, b], scorers: S, outsAdded: 0 };
    case 'BB': case 'HBP': {
      const n = [batterId, null, null];
      if (a != null && b != null && c != null) { push(c); n[1] = a; n[2] = b; }
      else if (a != null && b != null) { n[1] = a; n[2] = b; }
      else if (a != null) { n[1] = a; n[2] = c; }
      else { n[1] = b; n[2] = c; }
      return { occ: n, scorers: S, outsAdded: 0 };
    }
    case 'K': case 'flyout': case 'lineout': return { occ: [a, b, c], scorers: S, outsAdded: 1 };
    case 'DP': return { occ: [null, b, c], scorers: S, outsAdded: 2 }; // batter + lead runner
    case 'FC': return { occ: [batterId, b, c], scorers: S, outsAdded: 1 }; // 1st runner erased
    case 'sac_fly': {
      if (c != null && under2) { push(c); return { occ: [a, b, null], scorers: S, outsAdded: 1 }; }
      return { occ: [a, b, c], scorers: S, outsAdded: 1 };
    }
    case 'groundout': default: {
      // batter out; force chain if runner on 1st, contact-play run from 3rd
      let n1 = null, n2 = b, n3 = c;
      if (a != null) {         // force 1st -> 2nd
        n2 = a;
        if (b != null) {       // force 2nd -> 3rd
          if (c != null && under2) { push(c); } // 3rd forced home (<2 outs)
          n3 = c != null && !under2 ? c : b;
          if (c != null && under2) n3 = b;
        } else {
          n3 = c;
        }
      } else if (c != null && under2) { // no force, grounder plates the runner from 3rd
        push(c); n3 = null;
      }
      return { occ: [n1, n2, n3], scorers: S, outsAdded: 1 };
    }
  }
}

export function playOut(lineup) {
  const ptr = lineup.map(() => 0);
  const byId = {};
  for (const p of lineup) byId[p.id] = { id: p.id, name: p.name, position: p.position, AB: 0, H: 0, R: 0, RBI: 0, rv: 0 };
  const isHit = r => r === 'HR' || r === 'triple' || r === 'double' || r === 'single';

  let occ = [null, null, null]; // player ids on 1st,2nd,3rd
  let outs = 0, inning = 1, runs = 0, slot = 0, curInningRuns = 0;
  const log = [];
  const inningRuns = [];

  while (inning <= 9) {
    const player = lineup[slot];
    const exhausted = ptr[slot] >= player.results.length;
    // A phantom (out-of-ABs) batter is a clean out — no runner advances.
    let result = exhausted ? 'K' : player.results[ptr[slot]++];
    // A double play needs a runner on first to double off, and can't happen with
    // 2 outs already — otherwise it's just a single (inning-ending) out.
    if (result === 'DP' && (occ[0] == null || outs >= 2)) result = 'groundout';

    const reBefore = runExp(occ, outs);
    const basesBefore = occ.map(x => x != null);
    const { occ: newOcc, scorers, outsAdded } = advanceRunners(result, occ, outs, player.id);
    const r = scorers.length;
    const newOuts = outs + outsAdded;

    // credit runs, RBIs, at-bats & hits
    for (const sid of scorers) if (byId[sid]) byId[sid].R++;
    if (!exhausted) {
      const st = byId[player.id];
      if (result !== 'DP') st.RBI += r;
      if (result !== 'BB' && result !== 'HBP' && result !== 'sac_fly') st.AB++;
      if (isHit(result)) st.H++;
    }

    // run value (RE24) x leverage, credited to the batter
    const reAfter = newOuts >= 3 ? 0 : runExp(newOcc, newOuts);
    const runnersBefore = basesBefore.filter(Boolean).length;
    const leverage = 1 + (inning - 1) * 0.08 + runnersBefore * 0.15;
    if (!exhausted) byId[player.id].rv += ((reAfter - reBefore) + r) * leverage;

    runs += r; curInningRuns += r;
    log.push({
      inning, slot: slot + 1, player: player.name, position: player.position,
      result, exhausted, runsScored: r, basesBefore, basesAfter: newOcc.map(x => x != null),
      outsAfter: Math.min(newOuts, 3), totalRuns: runs,
    });

    occ = newOcc; outs = newOuts;
    if (outs >= 3) { inningRuns.push(curInningRuns); curInningRuns = 0; outs = 0; occ = [null, null, null]; inning++; }
    slot = (slot + 1) % lineup.length;
  }

  const players = Object.values(byId);
  // MVP = most RBIs, tiebreak by runs scored, then situational run value.
  const mvp = [...players].sort((x, y) => y.RBI - x.RBI || y.R - x.R || y.rv - x.rv)[0];

  return {
    runs, inningsPlayed: inningRuns.length, inningRuns, endedBy: 'innings',
    totalPAs: log.length, realPAs: ptr.reduce((a, b) => a + b, 0),
    playerStats: byId, mvp, log,
  };
}
