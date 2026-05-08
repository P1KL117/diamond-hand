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
};

const SB_ET = new Set(['stolen_base_2b','stolen_base_3b','stolen_base_home','defensive_indiff']);
const CS_ET = new Set(['caught_stealing_2b','caught_stealing_3b','caught_stealing_home']);

export const RESULT_COLOR = {
  HR: 'green', triple: 'green', double: 'green', single: 'green', BB: 'green', HBP: 'green',
  K: 'red', groundout: 'red', flyout: 'red', lineout: 'red', DP: 'red',
  sac_fly: 'yellow', FC: 'yellow',
};

export const RESULT_LABEL = {
  HR: 'HOME RUN', triple: 'TRIPLE', double: 'DOUBLE', single: 'SINGLE',
  BB: 'WALK', HBP: 'HBP', K: 'STRIKEOUT', groundout: 'GROUNDOUT',
  flyout: 'FLY OUT', lineout: 'LINE OUT', DP: 'DOUBLE PLAY',
  sac_fly: 'SAC FLY', FC: "FIELDER'S CHOICE",
};

// Downgrade chain: HR → triple → double → single → groundout → flyout → K
const DEGRADE = {
  HR: 'triple', triple: 'double', double: 'single',
  single: 'groundout', groundout: 'flyout', flyout: 'K',
  lineout: 'flyout', DP: 'groundout', sac_fly: 'flyout', FC: 'groundout',
  K: 'K', BB: 'BB', HBP: 'HBP',
};

// Upgrade chain (batting coach): all outs → single, DP → groundout, hits chain upward
const UPGRADE = {
  K: 'single', flyout: 'single', lineout: 'single',
  groundout: 'single', DP: 'groundout', FC: 'single', sac_fly: 'single',
  single: 'double', double: 'triple', triple: 'HR',
  HR: 'HR', BB: 'BB', HBP: 'HBP',
};

export function degradeResult(result) { return DEGRADE[result] ?? 'K'; }
export function upgradeResult(result) { return UPGRADE[result] ?? result; }

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── AB card extraction ────────────────────────────────────────────────────────

// SB/WP/PB are dealt into the hand deck; CS/ERROR stay in the bonus pool
export function extractCards(feed, side) {
  const wantTop = side === 'away';
  const abCards = [], deckEventCards = [], poolEventCards = [], battingOrder = [];
  const seenBatters = new Set();
  let seq = 0;

  for (const play of feed?.liveData?.plays?.allPlays ?? []) {
    const isTop = play.about?.halfInning === 'top';
    const ourHalf = wantTop ? isTop : !isTop;

    if (play.result?.type === 'atBat' && ourHalf) {
      let result = ET_MAP[play.result.eventType];
      if (result === null && play.result.eventType === 'field_out') {
        // MLB uses field_out generically — disambiguate via result.event
        const ev = (play.result.event ?? '').toLowerCase();
        result = (ev.includes('ground') || ev.includes('bunt') || ev.includes('force'))
          ? 'groundout' : 'flyout';
      }
      if (!result) continue;
      const id = play.matchup?.batter?.id;
      const name = play.matchup?.batter?.fullName ?? 'Unknown';
      if (!id) continue;
      if (!seenBatters.has(id)) { seenBatters.add(id); battingOrder.push({ id, name }); }
      abCards.push({
        id: `ab-${seq++}`, type: 'ab',
        playerId: id, playerName: name, result, originalResult: result,
        description: play.result?.description ?? '',
        inning: play.about?.inning ?? 0, degraded: 0,
      });
    }

    for (const ev of play.playEvents ?? []) {
      if (ev.type !== 'action') continue;
      const et = (ev.details?.eventType ?? '').toLowerCase();
      const desc = ev.details?.description ?? '';
      if (!ourHalf) continue;
      if (SB_ET.has(et))
        deckEventCards.push({ id: `ev-${seq++}`, type: 'event', eventType: 'SB', description: desc || 'Stolen base' });
      else if (et === 'wild_pitch')
        deckEventCards.push({ id: `ev-${seq++}`, type: 'event', eventType: 'WP', description: desc || 'Wild pitch' });
      else if (et === 'passed_ball')
        deckEventCards.push({ id: `ev-${seq++}`, type: 'event', eventType: 'PB', description: desc || 'Passed ball' });
      else if (et === 'error')
        deckEventCards.push({ id: `ev-${seq++}`, type: 'event', eventType: 'ERROR', description: desc || 'Error' });
    }
  }

  return { abCards, deckEventCards, eventCards: poolEventCards, battingOrder };
}

// ── Special cards ─────────────────────────────────────────────────────────────

export const SPECIAL_META = {
  pitching_change:   { label: 'PITCHING CHANGE',    icon: '⇄',  category: 'MANAGER', desc: 'Draw 3 cards, keep 2. Swap out a hand card — it shuffles back into the deck.' },
  rain_delay:        { label: 'RAIN DELAY',          icon: '⛈', category: 'EVENT',   desc: 'Peek next 5 deck cards, reorder freely. Bottom 3 degrade.' },
  replay_review:     { label: 'REPLAY REVIEW',       icon: '◀◀', category: 'MANAGER', desc: 'Pull your last played AB back into your hand.' },
  mound_visit:       { label: 'MOUND VISIT',         icon: '◉',  category: 'MANAGER', desc: 'Peek next 3 deck cards. Take 1, the other 2 go back on top.' },
  draw_2_discard_1:  { label: 'SCOUTING REPORT',     icon: '⇅',  category: 'MANAGER', desc: 'Draw 3 cards. Keep 2 in hand, discard the third.' },
  recalled:          { label: 'RECALLED',            icon: '↑',  category: 'EVENT',   desc: 'Reveal 6 discard cards. Return 1 to hand.' },
  batting_coach:     { label: 'BATTING COACH',       icon: '↑↑', category: 'MANAGER', desc: 'Upgrade one card a tier. Discard one card as the fee.' },
  discard_one:       { label: 'EJECTED',             icon: '✕',  category: 'MANAGER', desc: 'Permanently remove one card from the game.' },
  balk:              { label: 'BALK',                icon: '!',  category: 'EVENT',   desc: 'All runners advance one base. No out.' },
  hit_and_run:       { label: 'HIT & RUN',           icon: '↗',  category: 'MANAGER', desc: 'Next groundout/FC resolves as a single instead.' },
  retain:            { label: "MANAGER'S CHALLENGE", icon: '🛡', category: 'MANAGER', desc: 'The next out this inning doesn\'t count.' },
  momentum:          { label: 'MOMENTUM',            icon: '⚡', category: 'EARNED',  desc: 'Advance any runner one base. Earned by grinding.' },
};

// Lower index = higher priority when trimming to max 9
const SPECIAL_PRIORITY = [
  'pitching_change','mound_visit','rain_delay','replay_review',
  'batting_coach','recalled','draw_2_discard_1','discard_one','hit_and_run','balk',
];

export function computeSeededSpecials(feed, side) {
  const allPlays = feed?.liveData?.plays?.allPlays ?? [];
  const ourFielding = side === 'away' ? 'bottom' : 'top';
  const ourBatting  = side === 'away' ? 'top'    : 'bottom';

  let pitchingChanges = 0, moundVisits = 0;
  let hasReplay = false, hasRainDelay = false, hasSBAttempt = false, hasBalk = false;
  let xbhCount = 0, pinchHitters = 0;
  const seenBatters = new Set();
  const SB_TYPES = ['stolen_base_2b','stolen_base_3b','stolen_base_home',
                    'caught_stealing_2b','caught_stealing_3b','caught_stealing_home'];

  for (const play of allPlays) {
    const half = play.about?.halfInning;

    if (ourBatting === half) {
      const id = play.matchup?.batter?.id;
      if (id) seenBatters.add(id);
      const r = ET_MAP[play.result?.eventType];
      if (r === 'HR' || r === 'triple' || r === 'double') xbhCount++;
    }

    for (const ev of play.playEvents ?? []) {
      if (ev.type !== 'action') continue;
      const et = (ev.details?.eventType ?? '').toLowerCase();
      const desc = (ev.details?.description ?? '').toLowerCase();

      if (half === ourFielding) {
        if (et === 'pitching_substitution') pitchingChanges++;
        if (et === 'mound_visit' || et === 'mound_visit_no_action') moundVisits++;
      }
      if (half === ourBatting) {
        if (et === 'batting_substitution') pinchHitters++;
        if (et === 'balk') hasBalk = true;
        if (SB_TYPES.includes(et)) hasSBAttempt = true;
      }
      if (et === 'manager_challenge' || et === 'umpire_review') hasReplay = true;
      if (et === 'delay' || et === 'weather_delay' ||
          (desc.includes('rain') && desc.includes('delay'))) hasRainDelay = true;
    }
  }

  const counts = {
    pitching_change:  pitchingChanges,                     // exact count from game
    rain_delay:       hasRainDelay ? 1 : 0,
    replay_review:    hasReplay ? 1 : 0,
    mound_visit:      moundVisits,                         // exact count from game
    draw_2_discard_1: seenBatters.size > 9 ? 1 : 0,       // pinch hitters/runners used
    recalled:         seenBatters.size >= 11 ? 1 : 0,      // heavy sub usage
    batting_coach:    xbhCount >= 2 ? 1 : 0,               // team had extra-base pop
    discard_one:      Math.min(pinchHitters, 2),           // pinch hitters used by our team
    balk:             hasBalk ? 1 : 0,
    hit_and_run:      hasSBAttempt ? 1 : 0,
  };

  return buildSpecialsFromCounts(counts);
}

export function buildRandomSpecials(count) {
  let seq = 60000;
  return Array.from({ length: count }, () => {
    const type = ALL_SPECIAL_TYPES[Math.floor(Math.random() * ALL_SPECIAL_TYPES.length)];
    return { id: `sp-${seq++}`, type: 'special', specialType: type };
  });
}

export function buildSpecialsFromCounts(counts) {
  let seq = 50000;
  const specials = [];
  for (const [type, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) specials.push({ id: `sp-${seq++}`, type: 'special', specialType: type });
  }
  // Trim to max 12
  while (specials.length > 12) {
    for (let i = SPECIAL_PRIORITY.length - 1; i >= 0; i--) {
      const type = SPECIAL_PRIORITY[i];
      const idx = [...specials].map(c => c.specialType).lastIndexOf(type);
      if (idx !== -1) { specials.splice(idx, 1); break; }
    }
  }
  return specials;
}

// Configurable types (momentum is generated by meter, not seeded/configured)
export const ALL_SPECIAL_TYPES = Object.keys(SPECIAL_META).filter(t => t !== 'momentum');

// Event cards that can be added to the deck manually (drawn → auto-pool)
export const EVENT_CARD_TYPES = ['SB', 'WP', 'PB', 'ERROR'];
const EVENT_DESCS = { SB: 'Stolen base', WP: 'Wild pitch', PB: 'Passed ball', ERROR: 'Error' };

// Summarise what's in the deck for the config screen display
export function summarizeCards(abCards, deckEventCards) {
  const byResult = {};
  for (const c of abCards) byResult[c.result] = (byResult[c.result] || 0) + 1;
  const byEvent = {};
  for (const c of deckEventCards) byEvent[c.eventType] = (byEvent[c.eventType] || 0) + 1;
  return { byResult, byEvent, abTotal: abCards.length };
}

export function buildEventCardsFromCounts(counts) {
  let seq = 70000;
  const cards = [];
  for (const [eventType, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      cards.push({ id: `ev-${seq++}`, type: 'event', eventType, description: EVENT_DESCS[eventType] ?? eventType });
    }
  }
  return cards;
}
