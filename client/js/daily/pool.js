import { mapPA, battingLine, isHit } from './outcomes.js';

export const REQUIRED_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
const REQ = new Set(REQUIRED_POSITIONS);

// Rough value score for sorting the draft board (total bases + walks that night).
function nightValue(results) {
  const w = { HR: 4, triple: 3, double: 2, single: 1, BB: 0.5, HBP: 0.5 };
  return results.reduce((s, r) => s + (w[r] ?? 0), 0);
}

// That night's box-score line for the draft board's stat columns.
function nightStats(results, pas) {
  const s = { ab: 0, h: 0, hr: 0, dbl: 0, tr: 0, bb: 0, tb: 0, rbi: 0 };
  results.forEach((r, i) => {
    if (r === 'BB' || r === 'HBP') s.bb++;
    else if (r !== 'sac_fly') s.ab++;
    if (r === 'single') { s.h++; s.tb += 1; }
    else if (r === 'double') { s.h++; s.dbl++; s.tb += 2; }
    else if (r === 'triple') { s.h++; s.tr++; s.tb += 3; }
    else if (r === 'HR') { s.h++; s.hr++; s.tb += 4; }
    s.rbi += pas[i]?.rbi || 0;
  });
  return s;
}

// Fetch the day's pool and augment each player with mapped results + a batting line.
// Only players at a standard defensive position are offered (keeps the positional
// draft clean and dead-end-free).
export async function fetchDailyPool(date) {
  const raw = await fetch(`/api/daily?date=${date}`).then(r => r.json());
  if (raw.error) throw new Error(raw.error);

  const teams = (raw.teams ?? []).map(t => ({
    id: t.id, name: t.name, abbreviation: t.abbreviation,
    opponent: t.opponent, gamePk: t.gamePk,
    players: t.players
      .map(p => {
        // Standard fielding positions this player played that night (drops PH/PR/P)
        const eligPositions = [...new Set((p.positions ?? [p.position]).filter(x => REQ.has(x)))];
        if (!eligPositions.length) return null;
        const results = p.pas.map(mapPA);
        return {
          id: p.id, name: p.name,
          position: eligPositions[0],   // primary shown on card
          positions: eligPositions,     // all draftable positions
          teamAbbr: t.abbreviation, teamName: t.name,
          season: p.season,
          pas: p.pas, results,
          line: battingLine(p.pas),
          hits: results.filter(isHit).length,
          value: nightValue(results),
          stats: nightStats(results, p.pas),
        };
      })
      .filter(Boolean),
  })).filter(t => t.players.length);

  return { date: raw.date, teams };
}
