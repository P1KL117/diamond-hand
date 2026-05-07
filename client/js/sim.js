// bases = [bool, bool, bool]  →  [1st, 2nd, 3rd]

export function processAB(result, bases, outs, { hitAndRun = false, sendRunner3rd, holdRunner3rd } = {}) {
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
      if (b[2] && o < 2) {
        if (sendRunner3rd === true) {
          if (Math.random() < 0.6) { runs++; nb[2] = false; } // 60% scores
          else nb[2] = false;                                   // thrown out at home
        } else if (sendRunner3rd === false) {
          // hold — runner stays on 3rd
        } else {
          runs++; nb[2] = false; // legacy default: auto-score
        }
      }
      if (b[0]) { nb[0] = false; nb[1] = true; } // runner on 1st advances
      return { bases: nb, outs: o + 1, runs };
    }

    case 'flyout': {
      const nb = [...b];
      let runs = 0;
      if (b[2] && o < 2) {
        if (holdRunner3rd) {
          // runner freezes at 3rd; runner on 2nd can't advance (base blocked)
        } else {
          runs++; nb[2] = false;                              // tag up and score
          if (b[1]) { nb[1] = false; nb[2] = true; }         // runner on 2nd tags to 3rd
        }
      } else {
        if (b[1] && o < 2) { nb[1] = false; nb[2] = true; }  // no runner on 3rd — 2nd advances
      }
      return { bases: nb, outs: o + 1, runs };
    }

    case 'lineout': {
      const nb = [...b];
      let runs = 0;
      if (b[2] && o < 2) { runs++; nb[2] = false; }
      if (b[1] && o < 2) { nb[1] = false; nb[2] = true; }
      return { bases: nb, outs: o + 1, runs };
    }

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
