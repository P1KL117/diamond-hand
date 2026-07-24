import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MLB = 'https://statsapi.mlb.com';

app.use(express.static(join(__dirname, '../client'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

app.get('/api/schedule', async (req, res) => {
  try {
    const { date } = req.query;
    const url = `${MLB}/api/v1/schedule?sportId=1&date=${date}&hydrate=team,linescore`;
    const data = await fetch(url).then(r => r.json());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/game/:gamePk/feed', async (req, res) => {
  try {
    const url = `${MLB}/api/v1.1/game/${req.params.gamePk}/feed/live`;
    const data = await fetch(url).then(r => r.json());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Daily Lineup pool: all players who batted on a date, grouped by team ──────
// Returns each team's batters with their ordered plate-appearance outcomes,
// defensive position, and season line — the draft pool for Daily Lineup mode.
const dailyPoolCache = new Map(); // date → assembled pool (games are final = immutable)

function extractTeamPools(feed) {
  const box = feed?.liveData?.boxscore?.teams ?? {};
  const plays = feed?.liveData?.plays?.allPlays ?? [];
  const gamePk = feed?.gamePk ?? feed?.gameData?.game?.pk ?? null;

  const meta = side => ({
    id: box[side]?.team?.id ?? null,
    name: box[side]?.team?.name ?? side,
    abbreviation: feed?.gameData?.teams?.[side]?.abbreviation
      ?? box[side]?.team?.abbreviation ?? side.toUpperCase(),
  });
  const away = meta('away'), home = meta('home');

  // Group plate appearances by batter id, in play order
  const pasByBatter = new Map();
  for (const play of plays) {
    if (play.result?.type !== 'atBat') continue;
    const bid = play.matchup?.batter?.id;
    if (!bid) continue;
    if (!pasByBatter.has(bid)) pasByBatter.set(bid, []);
    pasByBatter.get(bid).push({
      eventType: play.result.eventType ?? null,
      event: play.result.event ?? '',
      description: play.result.description ?? '',
      rbi: play.result.rbi ?? 0,
      inning: play.about?.inning ?? 0,
      halfInning: play.about?.halfInning ?? '',
    });
  }

  const buildPlayers = side => {
    const players = box[side]?.players ?? {};
    const out = [];
    for (const key of Object.keys(players)) {
      const p = players[key];
      const id = p.person?.id;
      const pas = id ? pasByBatter.get(id) : null;
      if (!pas || !pas.length) continue; // only players who actually batted
      const bat = p.seasonStats?.batting ?? {};
      out.push({
        id,
        name: p.person?.fullName ?? 'Unknown',
        position: p.position?.abbreviation ?? '?',
        positionName: p.position?.name ?? '',
        positionCode: p.position?.code ?? '',
        battingOrder: p.battingOrder ?? null, // "100","200"... starters are multiples of 100
        season: {
          avg: bat.avg ?? '—', hr: bat.homeRuns ?? 0, rbi: bat.rbi ?? 0,
          ops: bat.ops ?? '—', sb: bat.stolenBases ?? 0,
        },
        pas,
      });
    }
    return out;
  };

  return [
    { ...away, gamePk, opponent: home.abbreviation, players: buildPlayers('away') },
    { ...home, gamePk, opponent: away.abbreviation, players: buildPlayers('home') },
  ];
}

app.get('/api/daily', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    if (dailyPoolCache.has(date)) return res.json(dailyPoolCache.get(date));

    const schedUrl = `${MLB}/api/v1/schedule?sportId=1&date=${date}`;
    const sched = await fetch(schedUrl).then(r => r.json());
    const games = (sched.dates?.[0]?.games ?? [])
      .filter(g => g.status?.abstractGameState === 'Final');

    const feeds = await Promise.all(games.map(g =>
      fetch(`${MLB}/api/v1.1/game/${g.gamePk}/feed/live`)
        .then(r => r.json())
        .catch(() => null)
    ));

    const teams = [];
    for (const feed of feeds) {
      if (!feed) continue;
      for (const team of extractTeamPools(feed)) {
        if (team.players.length) teams.push(team);
      }
    }

    const pool = { date, teamCount: teams.length, teams };
    dailyPoolCache.set(date, pool);
    res.json(pool);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/players/stats', async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.json({});
    const url = `${MLB}/api/v1/people?personIds=${ids}&hydrate=stats(group=hitting,type=season)`;
    const data = await fetch(url).then(r => r.json());
    const stats = {};
    for (const p of data.people ?? []) {
      const split = p.stats
        ?.find(s => s.group?.displayName === 'hitting' && s.type?.displayName === 'season')
        ?.splits?.[0]?.stat;
      if (split) {
        stats[p.id] = {
          goAoRatio: parseFloat(split.groundOutsToAiroutsRatio) || 1.0,
          sbPct:     parseFloat(split.stolenBasePercentage)     || 0.70,
        };
      }
    }
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Diamond Hand → http://localhost:${PORT}`);
});
