// Maps a raw MLB plate-appearance (from /api/daily) to a result string the
// sim engine (client/js/sim.js processAB) understands.

const ET_MAP = {
  home_run: 'HR', triple: 'triple', double: 'double', single: 'single',
  walk: 'BB', intent_walk: 'BB', hit_by_pitch: 'HBP',
  strikeout: 'K', strikeout_double_play: 'K',
  grounded_into_double_play: 'DP', double_play: 'DP', triple_play: 'DP',
  field_out: null, grounded_out: 'groundout', fly_out: 'flyout',
  pop_out: 'flyout', line_out: 'lineout',
  fielders_choice_out: 'FC', fielders_choice: 'FC',
  sac_fly: 'sac_fly', sac_fly_double_play: 'sac_fly',
  sac_bunt: 'groundout', sac_bunt_double_play: 'groundout',
  force_out: 'groundout', bunt_groundout: 'groundout',
  catcher_interf: 'BB', fan_interference: 'BB',
  field_error: 'single',      // reached on error → treat as a single for run-sim purposes
};

// Ordinal quality of an outcome, for UI sorting / summaries (higher = better)
export const RESULT_RANK = {
  HR: 7, triple: 6, double: 5, single: 4, BB: 3, HBP: 3,
  sac_fly: 1, FC: 1, groundout: 0, flyout: 0, lineout: 0, K: 0, DP: -1,
};

export function mapPA(pa) {
  let result = ET_MAP[pa.eventType];
  if (result === null && pa.eventType === 'field_out') {
    const ev = (pa.event ?? '').toLowerCase();
    result = (ev.includes('ground') || ev.includes('bunt') || ev.includes('force'))
      ? 'groundout' : 'flyout';
  }
  return result ?? 'groundout'; // unknown non-hit → conservative out
}

// Is this outcome an out (for box-score display)?
export function isOut(result) {
  return ['K', 'groundout', 'flyout', 'lineout', 'DP', 'FC', 'sac_fly'].includes(result);
}

// Is this outcome a hit (for batting-line display)?
export function isHit(result) {
  return ['HR', 'triple', 'double', 'single'].includes(result);
}

// Build a compact box-score line (e.g. "2-4, HR, 2B") from a player's PAs
export function battingLine(pas) {
  const results = pas.map(mapPA);
  const atBats = results.filter(r => !['BB', 'HBP', 'sac_fly'].includes(r)).length;
  const hits = results.filter(isHit).length;
  const extras = [];
  const hr = results.filter(r => r === 'HR').length;
  const tr = results.filter(r => r === 'triple').length;
  const db = results.filter(r => r === 'double').length;
  const bb = results.filter(r => r === 'BB' || r === 'HBP').length;
  if (hr) extras.push(`${hr} HR`);
  if (tr) extras.push(`${tr} 3B`);
  if (db) extras.push(`${db} 2B`);
  if (bb) extras.push(`${bb} BB`);
  return { atBats, hits, summary: `${hits}-${atBats}${extras.length ? ', ' + extras.join(', ') : ''}` };
}
