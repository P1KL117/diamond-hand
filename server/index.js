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
