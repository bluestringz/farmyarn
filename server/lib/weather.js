// Rain schedule — the SERVER copy of the exact same algorithm the game
// client uses to draw rain (FarmGame.rainScheduleForDay in public/js/game.js).
// Which hours it rains on a given day is worked out from the Philippine
// calendar date alone (seeded random), so the server and every player agree
// on when it's raining without anything being stored or synced.
//
// KEEP THIS IN SYNC with rainScheduleForDay in public/js/game.js — if one
// changes, change the other the same way, or what players SEE (rain on
// screen) and what the server DOES (rain watering crops) will drift apart.
//
// Each day is either dry or has 1-3 showers of different lengths spread
// across the day. Rainy season (Jun-Nov) gets showers on most days, the rest
// of the year only now and then, and December never rains (snow month).

const PHT_OFFSET_SEC = 8 * 3600;
const rainCache = new Map();

function seededRandom(seed) {
  // mulberry32
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Showers for one Philippine calendar day, as [{ start, end, peak }] in
// hours 0-24.
function rainScheduleForDay(year, month, day) {
  const key = year * 10000 + month * 100 + day;
  const cached = rainCache.get(key);
  if (cached) return cached;

  const showers = [];
  if (month !== 12) {
    const rnd = seededRandom(key * 2654435761);
    const rainySeason = month >= 6 && month <= 11;
    const chanceOfRain = rainySeason ? 0.75 : (month >= 3 && month <= 5 ? 0.2 : 0.35);
    if (rnd() < chanceOfRain) {
      const count = 1 + Math.floor(rnd() * (rainySeason ? 3 : 2));
      const segLen = 24 / count;
      for (let i = 0; i < count; i++) {
        const segStart = i * segLen;
        const start = segStart + rnd() * segLen * 0.5;
        const maxLen = segLen - (start - segStart) - 0.25;
        const length = Math.min(0.5 + rnd() * 2.5, Math.max(0.4, maxLen));
        showers.push({ start, end: Math.min(24, start + length), peak: 0.5 + rnd() * 0.5 });
      }
    }
  }
  if (rainCache.size > 60) rainCache.clear();
  rainCache.set(key, showers);
  return showers;
}

// The first moment (unix seconds) between startSec and endSec (inclusive)
// that it is raining, or null if it stays dry the whole time. If it's
// already raining at startSec, that's startSec itself.
function firstRainBetween(startSec, endSec) {
  if (endSec < startSec) return null;
  // Walk PHT days from the one containing startSec to the one containing endSec.
  const firstDayStart = Math.floor((startSec + PHT_OFFSET_SEC) / 86400) * 86400 - PHT_OFFSET_SEC;
  for (let dayStart = firstDayStart; dayStart <= endSec; dayStart += 86400) {
    const d = new Date((dayStart + PHT_OFFSET_SEC) * 1000);
    const showers = rainScheduleForDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    for (const s of showers) {
      const sAbs = dayStart + s.start * 3600;
      const eAbs = dayStart + s.end * 3600;
      if (eAbs < startSec || sAbs > endSec) continue;
      return Math.floor(Math.max(sAbs, startSec));
    }
  }
  return null;
}

module.exports = { rainScheduleForDay, firstRainBetween };
