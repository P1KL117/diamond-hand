import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MLB = 'https://statsapi.mlb.com';

app.use(express.static(join(__dirname, '../client')));

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

app.listen(PORT, () => {
  console.log(`Diamond Hand → http://localhost:${PORT}`);
});
