import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const MLB = 'https://statsapi.mlb.com';

// ── Leaderboard storage ───────────────────────────────────────────────────────
// Railway Postgres in production; an ephemeral in-memory store for local dev
// (resets on restart). Same API surface either way — always "enabled".
const STYLES = new Set(['normal', 'blind', 'shuffled']);
let db = null;
const memScores = []; // { date, style, initials, runs, mvp, created_at }

if (process.env.DATABASE_URL) {
  db = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  db.query(`CREATE TABLE IF NOT EXISTS scores (
    id serial primary key,
    date text not null,
    style text not null,
    initials text not null,
    runs int not null,
    mvp text,
    created_at timestamptz default now()
  )`).then(() => db.query(`CREATE TABLE IF NOT EXISTS meta (key text primary key, val int)`))
    .then(() => db.query(`INSERT INTO meta (key,val) VALUES ('reset_gen',0) ON CONFLICT (key) DO NOTHING`))
    .then(() => db.query(`SELECT val FROM meta WHERE key='reset_gen'`))
    .then(({ rows }) => { resetGen = rows[0]?.val ?? 0; console.log('Leaderboard DB ready (Postgres), gen', resetGen); })
    .catch(e => { console.error('DB init failed:', e.message); db = null; });
} else {
  console.log('No DATABASE_URL — using in-memory leaderboard (ephemeral, local dev)');
}

// Reset generation: bumped on every admin reset so that clients' one-per-day
// submit guards (keyed by gen) are invalidated and nobody is locked out.
let resetGen = 0;
async function bumpGen() {
  resetGen++;
  if (db) await db.query(`UPDATE meta SET val=$1 WHERE key='reset_gen'`, [resetGen]);
}

async function boardTop(date, style) {
  if (db) {
    const { rows } = await db.query(
      `SELECT initials, runs, mvp, created_at FROM scores
       WHERE date=$1 AND style=$2 ORDER BY runs DESC, created_at ASC LIMIT 25`, [date, style]);
    return rows;
  }
  return memScores.filter(s => s.date === date && s.style === style)
    .sort((a, b) => b.runs - a.runs || a.created_at - b.created_at).slice(0, 25);
}
async function boardInsert(row) {
  if (db) {
    await db.query(`INSERT INTO scores (date, style, initials, runs, mvp) VALUES ($1,$2,$3,$4,$5)`,
      [row.date, row.style, row.initials, row.runs, row.mvp]);
  } else {
    memScores.push({ ...row, created_at: Date.now() });
  }
}
async function boardRank(date, style, runs) {
  if (db) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS ahead FROM scores WHERE date=$1 AND style=$2 AND runs > $3`, [date, style, runs]);
    return rows[0].ahead + 1;
  }
  return memScores.filter(s => s.date === date && s.style === style && s.runs > runs).length + 1;
}

// Landing page is the v2 Daily Lineup game; the v1 "Classic" game stays at /classic
app.get('/', (_req, res) => res.sendFile(join(__dirname, '../client/daily.html')));
app.get('/classic', (_req, res) => res.sendFile(join(__dirname, '../client/index.html')));

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { date, style } = req.query;
    if (!date || !STYLES.has(style)) return res.status(400).json({ error: 'date and valid style required' });
    res.json({ enabled: true, gen: resetGen, scores: await boardTop(date, style) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const { date, style, initials, runs, mvp } = req.body ?? {};
    const ini = String(initials ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    const r = Number(runs);
    if (!date || !STYLES.has(style) || !ini || !Number.isInteger(r) || r < 0 || r > 200)
      return res.status(400).json({ error: 'invalid submission' });
    // Only the currently-active daily accepts new scores — old dailies are frozen.
    // (Enforced in production; dev/in-memory stays permissive for testing.)
    if (db && date !== currentDailyDate && date !== baseDailyDate())
      return res.status(403).json({ error: 'submissions closed for this date' });
    await boardInsert({ date, style, initials: ini, runs: r, mvp: String(mvp ?? '').slice(0, 200) });
    res.json({ enabled: true, gen: resetGen, scores: await boardTop(date, style), rank: await boardRank(date, style, r) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: clear leaderboard scores. Protected by the ADMIN_SECRET env var.
// POST /api/admin/reset?secret=XXX   body: {} | {date} | {date,style}
app.post('/api/admin/reset', async (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'forbidden' });
  const { date, style } = req.body ?? {};
  try {
    if (db) {
      if (date && style) await db.query('DELETE FROM scores WHERE date=$1 AND style=$2', [date, style]);
      else if (date) await db.query('DELETE FROM scores WHERE date=$1', [date]);
      else await db.query('DELETE FROM scores');
    } else {
      const keep = memScores.filter(s => !((!date || s.date === date) && (!style || s.style === style)));
      memScores.length = 0; memScores.push(...keep);
    }
    await bumpGen(); // frees everyone's submit guard so nobody is locked out post-reset
    res.json({ ok: true, gen: resetGen, scope: date ? (style ? `${date}/${style}` : date) : 'all' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ── Daily date resolution (server-authoritative, shared by all players) ───────
// The daily uses yesterday's games and rolls to a new day at 5:00 AM US Eastern.
function etNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +(p.hour === '24' ? 0 : p.hour) };
}
function baseDailyDate() {
  const { y, m, d, h } = etNow();
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  if (h < 5) dt.setUTCDate(dt.getUTCDate() - 1); // before 5am ET → previous day
  dt.setUTCDate(dt.getUTCDate() - 1);            // daily = yesterday's games
  return dt.toISOString().slice(0, 10);
}
async function slateComplete(date) {
  try {
    const sched = await fetch(`${MLB}/api/v1/schedule?sportId=1&date=${date}`).then(r => r.json());
    const games = sched.dates?.[0]?.games ?? [];
    const playable = games.filter(g => !['Postponed', 'Cancelled'].includes(g.status?.detailedState));
    const final = playable.filter(g => g.status?.abstractGameState === 'Final');
    return playable.length > 0 && final.length === playable.length;
  } catch { return false; }
}
let currentDailyDate = baseDailyDate();
async function resolveDailyDate() {
  let d = baseDailyDate();
  for (let i = 0; i < 10; i++) {
    if (await slateComplete(d)) { currentDailyDate = d; return d; }
    const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); d = dt.toISOString().slice(0, 10);
  }
  currentDailyDate = baseDailyDate();
  return currentDailyDate;
}

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
      const g = p.stats?.batting ?? {}; // that night's actual box-score line
      const allPos = (p.allPositions ?? []).map(x => x.abbreviation).filter(Boolean);
      out.push({
        id,
        name: p.person?.fullName ?? 'Unknown',
        position: p.position?.abbreviation ?? '?',
        positions: allPos.length ? [...new Set(allPos)] : [p.position?.abbreviation ?? '?'],
        positionName: p.position?.name ?? '',
        positionCode: p.position?.code ?? '',
        battingOrder: p.battingOrder ?? null, // "100","200"... starters are multiples of 100
        season: {
          avg: bat.avg ?? '—', hr: bat.homeRuns ?? 0, rbi: bat.rbi ?? 0,
          ops: bat.ops ?? '—', sb: bat.stolenBases ?? 0,
        },
        real: { r: g.runs ?? 0, rbi: g.rbi ?? 0, h: g.hits ?? 0, ab: g.atBats ?? 0, hr: g.homeRuns ?? 0 },
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
    // No date → the server-resolved current daily (yesterday's games, 5am ET rollover,
    // walked back to the most recent fully-complete slate).
    const date = req.query.date || await resolveDailyDate();
    if (dailyPoolCache.has(date)) return res.json(dailyPoolCache.get(date));

    const schedUrl = `${MLB}/api/v1/schedule?sportId=1&date=${date}`;
    const sched = await fetch(schedUrl).then(r => r.json());
    const allGames = sched.dates?.[0]?.games ?? [];
    const playable = allGames.filter(g => !['Postponed', 'Cancelled'].includes(g.status?.detailedState));
    const finalGames = playable.filter(g => g.status?.abstractGameState === 'Final');
    // The slate is "complete" only when every playable game is final — used to
    // decide when a new daily can begin. The team order is stable (sorted by id)
    // so the seeded daily draft is identical for everyone and survives resets.
    const complete = playable.length > 0 && finalGames.length === playable.length;

    const feeds = await Promise.all(finalGames.map(g =>
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
    teams.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)); // stable, deterministic order

    const pool = { date, complete, teamCount: teams.length, teams };
    if (complete) dailyPoolCache.set(date, pool); // only cache a finished slate
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
