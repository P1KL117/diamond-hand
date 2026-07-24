// Deterministic RNG so a given date produces the same draft for every player.

// Hash a string (e.g. "2026-05-08") to a 32-bit seed.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32 PRNG — fast, deterministic, good enough for game rolls.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns a seeded RNG: { next() → [0,1), int(n) → [0,n), pick(arr), shuffle(arr) }
export function seededRng(seedStr) {
  const seedFn = xmur3(String(seedStr));
  const rand = mulberry32(seedFn());
  const int = n => Math.floor(rand() * n);
  return {
    next: rand,
    int,
    pick: arr => arr[int(arr.length)],
    shuffle: arr => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}
