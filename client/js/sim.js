// bases = [bool, bool, bool]  →  [1st, 2nd, 3rd]

export function processAB(result, bases, outs, { hitAndRun = false, sendRunner3rd, advance2nd } = {}) {
  const effective = (hitAndRun && (result === 'groundout' || result === 'FC')) ? 'single' : result;
  const b = [...bases];
  const o = outs;

  switch (effective) {
    case 'HR':
      return { bases: [false, false, false], outs: o, runs: b.filter(Boolean).length + 1 };

    case 'triple':
      return { bases: [false, false, true], outs: o, runs: b.filter(Boolean).length };

    case 'double': {
      const runs = (b[1] ? 1 : 0) + (b[2] ? 1 : 0);
      return { bases: [false, true, b[0]], outs: o, runs };
    }

    case 'single': {
      const runs = b[2] ? 1 : 0;
      return { bases: [true, b[0], b[1]], outs: o, runs };
    }

    case 'BB':
    case 'HBP': {
      const runs = (b[0] && b[1] && b[2]) ? 1 : 0;
      return { bases: [true, b[0] ? true : b[1], (b[0] && b[1]) ? true : b[2]], outs: o, runs };
    }

    case 'K':
      return { bases: b, outs: o + 1, runs: 0 };

    case 'groundout': {
      // DP is handled externally — caller passes result='DP' if the roll triggered it.
      const nb = [...b];
      let runs = 0;
      let extraOuts = 0;

      // Resolve runner on 3rd first (player decision: send home or hold)
      if (b[2] && o < 2) {
        if (sendRunner3rd === 'safe') { runs++; nb[2] = false; }
        else if (sendRunner3rd === 'out') { extraOuts++; nb[2] = false; }
        else if (sendRunner3rd === 'hold' || sendRunner3rd === false) { /* hold */ }
        else { runs++; nb[2] = false; } // no 3rd decision — auto-score
      }

      if (b[0] && b[1]) {
        // Force chain: both bases occupied → 1st→2nd, 2nd→3rd (mandatory)
        nb[0] = false; // nb[1] stays true (1st runner arrives at 2nd)
        if (!nb[2]) {
          nb[2] = true; // 2nd runner advances to now-vacant 3rd
        } else {
          // 3rd still occupied (held) — 2nd runner is forced out at 3rd
          extraOuts++;
        }
      } else if (b[0]) {
        nb[0] = false; nb[1] = true; // runner on 1st forced to 2nd
      }

      // Optional voluntary advance from 2nd (only when 1st was empty)
      if (advance2nd !== undefined && b[1] && !b[0]) {
        nb[1] = false;
        if (advance2nd === 'safe') nb[2] = true;
        else extraOuts++;
      }
      return { bases: nb, outs: o + 1 + extraOuts, runs };
    }

    case 'flyout':
    case 'lineout':
      // Runner tag-up decisions are resolved in main.js before this is called
      return { bases: b, outs: o + 1, runs: 0 };

    case 'sac_fly': {
      const nb = [...b];
      let runs = 0;
      if (b[2]) { runs++; nb[2] = false; }                 // runner on 3rd always scores
      if (b[1] && o < 2) { nb[1] = false; nb[2] = true; } // runner on 2nd → 3rd with <2 outs
      return { bases: nb, outs: o + 1, runs };
    }

    case 'DP':
      return { bases: [false, b[1], b[2]], outs: o + 2, runs: 0 };

    case 'FC':
      if (b[0]) return { bases: [true, b[1], b[2]], outs: o + 1, runs: 0 };
      return { bases: [true, b[1], b[2]], outs: o + 1, runs: 0 };

    default:
      return { bases: b, outs: o + 1, runs: 0 };
  }
}

export function processEvent(eventType, bases, outs) {
  const b = [...bases];
  let runs = 0;

  switch (eventType) {
    case 'SB':
      if (b[1] && !b[2]) { b[1] = false; b[2] = true; }
      else if (b[0])       { b[0] = false; b[1] = true; }
      return { bases: b, outs, runs };

    case 'CS':
      if (b[2]) b[2] = false;
      else if (b[1]) b[1] = false;
      else if (b[0]) b[0] = false;
      return { bases: b, outs: outs + 1, runs };

    case 'WP': case 'PB': case 'BALK':
      if (b[2]) runs++;
      return { bases: [false, b[0], b[1]], outs, runs };

    case 'ERROR':
      if (b[2]) runs++;
      return { bases: [true, b[0], b[1]], outs, runs };

    default:
      return { bases: b, outs, runs };
  }
}

export function hasRunner(bases) { return bases[0] || bases[1] || bases[2]; }
