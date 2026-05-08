export async function fetchSchedule(date) {
  const res = await fetch(`/api/schedule?date=${date}`);
  if (!res.ok) throw new Error('Schedule fetch failed');
  return res.json();
}

export async function fetchGameFeed(gamePk) {
  const res = await fetch(`/api/game/${gamePk}/feed`);
  if (!res.ok) throw new Error('Feed fetch failed');
  return res.json();
}

export async function fetchPlayerStats(ids) {
  if (!ids.length) return {};
  const res = await fetch(`/api/players/stats?ids=${ids.join(',')}`);
  return res.ok ? res.json() : {};
}

export function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
