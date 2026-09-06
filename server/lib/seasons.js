// Seasonal decoration config — Christmas, Halloween, Valentine's Day, New
// Year. Each season has a buy window (month/day, inclusive) during which
// its items appear in the Shop and can be purchased. Once today falls
// OUTSIDE that window, the items aren't just un-buyable anymore — any
// ALREADY-OWNED copies (placed on a farm, or still sitting in the Bag)
// are swept away too (see resolveSeasonalExpiry in gameLogic.js), so a
// season's decorations genuinely only last for its window, matching how
// each of the four windows below was specified: a buy window that ends,
// followed immediately (the very next day) by an explicit "expires on"
// date — there's no separate gap to account for between "can't buy
// anymore" and "actually expires", they're the same moment. That's why
// this file only needs ONE date check (isWithinBuyWindow) rather than
// tracking a buy window and an expiry window as two separate things.
//
// New Year's window wraps across the year boundary (Dec 28 -> Jan 5) —
// isWithinBuyWindow handles that case explicitly below.
const SEASONS = {
  christmas: {
    label: '🎄 Christmas',
    buyStart: { month: 11, day: 14 },
    buyEnd: { month: 12, day: 31 },
  },
  halloween: {
    label: '🎃 Halloween',
    buyStart: { month: 10, day: 25 },
    buyEnd: { month: 11, day: 13 },
  },
  valentines: {
    label: '💘 Valentine\'s Day',
    // day: 29 (not 28) so a leap-year Feb 29th still correctly counts as
    // "within the window" instead of reading as one day past it — every
    // other year Feb only has 28 days anyway, so this never over-includes.
    buyStart: { month: 2, day: 1 },
    buyEnd: { month: 2, day: 29 },
  },
  new_year: {
    label: '🎆 New Year',
    buyStart: { month: 12, day: 28 },
    buyEnd: { month: 1, day: 5 },
  },
};

function monthDayValue(month, day) {
  return month * 100 + day;
}

// `now` accepted as a param (rather than always reading the real clock)
// so tests can check specific dates without needing to fake system time.
function isWithinBuyWindow(seasonKey, now = new Date()) {
  const season = SEASONS[seasonKey];
  if (!season) return false;
  const cur = monthDayValue(now.getMonth() + 1, now.getDate());
  const start = monthDayValue(season.buyStart.month, season.buyStart.day);
  const end = monthDayValue(season.buyEnd.month, season.buyEnd.day);
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end; // wraps across the year boundary (New Year)
}

function currentSeasonKeys(now = new Date()) {
  return Object.keys(SEASONS).filter((key) => isWithinBuyWindow(key, now));
}

module.exports = { SEASONS, isWithinBuyWindow, currentSeasonKeys };
