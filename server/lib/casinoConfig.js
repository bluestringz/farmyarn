// server/lib/casinoConfig.js
// Casino machine configs (bets, energy costs, prize tiers) plus the
// admin-tunable odds override system — shared by server/routes/casino.js
// (the actual play route) and server/routes/admin.js (the odds-editing
// admin panel screen), so both always agree on the live numbers.

// The 6 colors on the Color Game's drop-box — matches the swatches drawn
// on the physical machine (see game.js's _drawColorGameCabinet). Order
// only matters for the swatch UI, not the odds below.
const COLOR_PALETTE = ['red', 'yellow', 'white', 'pink', 'blue', 'green'];

// The 5 symbols on Lucky 777's reels. 'pp_logo' is the special symbol
// behind the two PP (premium currency) tiers — everything else pays in
// Energy. Order only matters for the reel UI, not the odds below.
const REEL_SYMBOLS = ['seven', 'bar', 'bell', 'cherry', 'pp_logo'];

// ---- Machine configs (DEFAULTS — see getLiveMachines() for the actual
// live numbers, which apply any admin overrides on top of these) ----
// Every machine works the same way under the hood: pay a coin bet PLUS an
// energy cost just to play, then roll against a table of prize tiers
// (each with its own % chance) that pay out in ENERGY or PP. Missing every
// tier means the bet is simply lost — no consolation prize, matching how a
// real carnival/casino game works.
const DEFAULT_MACHINES = {
  // "Color Game" — the player picks ONE color (see COLOR_PALETTE) and a
  // bet amount, then 3 blocks drop. However many of those 3 blocks land
  // on the player's chosen color is the tier — 3 is the max (there are
  // only 3 blocks). Reward is a percentage OF THE BET, paid in Energy.
  // matchCount maps each tier to how many of the 3 revealed blocks show
  // the player's color — used to build the `reveal` array in /bet below
  // so the animation always visually matches the tier that was rolled.
  color_game: {
    label: 'Color Game',
    betOptions: [500, 1000, 1500, 2000],
    energyCostPerBet: 3,
    colorPalette: COLOR_PALETTE,
    tiers: [
      { id: 'three', label: '3 Matching Blocks', chancePercent: 0.6, betMultiplier: 0.10, matchCount: 3 },
      { id: 'two',   label: '2 Matching Blocks', chancePercent: 2,   betMultiplier: 0.08, matchCount: 2 },
      { id: 'one',   label: '1 Matching Block',  chancePercent: 5,   betMultiplier: 0.07, matchCount: 1 },
    ],
  },
  // "Claw Machine" — fixed bet, fixed flat Energy prizes (not a % of the
  // bet like Color Game/Slot — a claw grabbing a prize doesn't scale with
  // how many coins you fed the machine). Also has a separate set of rarer
  // tiers that pay out in PP (premium currency) instead of Energy — think
  // of it as two different prize shelves in the same machine. `icon` is
  // what the claw-grab reveal shows (see /bet below) — null on the
  // implicit "lose" case means the claw came up empty.
  claw_machine: {
    label: 'Claw Machine',
    betOptions: [800],
    energyCostPerBet: 5,
    tiers: [
      { id: 'jackpot', label: 'Big Prize',    chancePercent: 0.07, energyFlat: 500, icon: '🏆' },
      { id: 'big',     label: 'Great Grab',   chancePercent: 1,    energyFlat: 100, icon: '🎁' },
      { id: 'good',    label: 'Nice Grab',    chancePercent: 3,    energyFlat: 80,  icon: '🧸' },
      { id: 'small',   label: 'Small Grab',   chancePercent: 4,    energyFlat: 60,  icon: '⭐' },
      { id: 'tiny',    label: 'Tiny Grab',    chancePercent: 6,    energyFlat: 40,  icon: '🍬' },
      { id: 'pp_7',    label: '💎 7 PP Prize', chancePercent: 0.01, ppFlat: 7, icon: '💎' },
      { id: 'pp_3',    label: '💎 3 PP Prize', chancePercent: 0.02, ppFlat: 3, icon: '💎' },
      { id: 'pp_2',    label: '💎 2 PP Prize', chancePercent: 0.04, ppFlat: 2, icon: '💎' },
      { id: 'pp_1',    label: '💎 1 PP Prize', chancePercent: 0.05, ppFlat: 1, icon: '💎' },
    ],
  },
  // "Lucky 777" slot machine — different shape from the other two: the
  // chance to win ANYTHING at all is set by which BET you choose
  // (winChanceByBet — a bigger bet is a bigger swing, so it's a LOWER
  // chance), and only once a spin actually wins does it roll again among
  // the tiers below (weighted by `weight` — relative rarity to each
  // other, not a standalone %) to decide WHICH prize. Energy cost per
  // spin also scales with the bet (energyCostByBet). `symbol`/`matchCount`
  // drive the 3-reel `reveal` built in /bet below, so the reel animation
  // always visually matches whichever tier was actually rolled.
  slot_777: {
    label: 'Lucky 777',
    betOptions: [1000, 2000, 3000, 5000],
    energyCostByBet: { 1000: 4, 2000: 6, 3000: 9, 5000: 13 },
    winChanceByBet: { 1000: 5, 2000: 3, 3000: 1, 5000: 0.07 },
    reelSymbols: REEL_SYMBOLS,
    tiers: [
      { id: 'jackpot777', label: '🎰 777 Jackpot', weight: 0.01, betMultiplier: 0.50, symbol: 'seven', matchCount: 3 },
      { id: 'triple_bar', label: 'Triple Bar',      weight: 0.05, betMultiplier: 0.25, symbol: 'bar',   matchCount: 3 },
      { id: 'double',     label: 'Double Match',    weight: 0.3,  betMultiplier: 0.12, symbol: 'bell',  matchCount: 2 },
      { id: 'single',     label: 'Single Cherry',   weight: 1.2,  betMultiplier: 0.05, symbol: 'cherry', matchCount: 1 },
      { id: 'pp_logo_3',  label: '💎 3 PP Logo',     weight: 0.01, ppFlat: 10, symbol: 'pp_logo', matchCount: 3 },
      { id: 'pp_logo_2',  label: '💎 2 PP Logo',     weight: 0.08, ppFlat: 1,  symbol: 'pp_logo', matchCount: 2 },
    ],
  },
};

// ---- Admin odds overrides ----
// Stored in the game_settings key/value table (same one the Timers admin
// screen uses — see gameLogic.js's getTimerSetting/DEFAULT_TIMERS). That
// table's value column is INTEGER only, but odds go down to hundredths of
// a percent (0.01%), so every override is stored as "basis points" —
// value*100, rounded — and divided back by 100 on read. All of this
// build's odds already have at most 2 decimal digits, so nothing is lost.
function oddsKey(machineId, tierId, field) {
  return `casino:${machineId}:${tierId}:${field}`;
}

function getOverrideBp(db, key) {
  const row = db.prepare('SELECT value FROM game_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setOverrideBp(db, key, bp) {
  db.prepare('INSERT INTO game_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, bp);
}

function clearOverride(db, key) {
  db.prepare('DELETE FROM game_settings WHERE key = ?').run(key);
}

// Every individually-editable odds knob across all 3 machines, flattened
// into one list — the single source of truth for both the admin GET/POST
// routes (which fields exist, what to label them) and getLiveMachines()
// below (which fields to check for an override). `path` is how to find
// the field, `unit` is 'percent' (chancePercent/winChanceByBet, stored as
// basis points) or 'weight' (slot_777's relative weights — NOT a %, but
// still has decimals, so stored as basis points the same way for the same
// no-precision-loss reason).
function listOddsFields() {
  const fields = [];
  for (const [machineId, config] of Object.entries(DEFAULT_MACHINES)) {
    for (const tier of config.tiers) {
      if (tier.chancePercent !== undefined) {
        fields.push({ machine: machineId, tierId: tier.id, field: 'chancePercent', unit: 'percent', label: tier.label, defaultValue: tier.chancePercent });
      }
      if (tier.weight !== undefined) {
        fields.push({ machine: machineId, tierId: tier.id, field: 'weight', unit: 'weight', label: tier.label, defaultValue: tier.weight });
      }
    }
    if (config.winChanceByBet) {
      for (const bet of Object.keys(config.winChanceByBet)) {
        fields.push({ machine: machineId, tierId: `bet_${bet}`, field: 'winChanceByBet', betAmount: parseInt(bet, 10), unit: 'percent', label: `🪙${bet} bet — win chance`, defaultValue: config.winChanceByBet[bet] });
      }
    }
  }
  return fields;
}

// Deep-clones DEFAULT_MACHINES and applies any admin overrides on top —
// this is what both GET /api/casino/config and POST /api/casino/bet
// actually use, so a live admin edit takes effect immediately and
// consistently for both the displayed numbers and the real roll.
function getLiveMachines(db) {
  const machines = JSON.parse(JSON.stringify(DEFAULT_MACHINES));
  for (const f of listOddsFields()) {
    const bp = getOverrideBp(db, oddsKey(f.machine, f.tierId, f.field));
    if (bp === null) continue;
    const value = bp / 100;
    const config = machines[f.machine];
    if (f.field === 'winChanceByBet') {
      config.winChanceByBet[f.betAmount] = value;
    } else {
      const tier = config.tiers.find((t) => t.id === f.tierId);
      if (tier) tier[f.field] = value;
    }
  }
  return machines;
}

// Rolls one random number against a tier table (percentages need not sum to
// 100 — whatever's left over is simply "no win"). Returns the winning tier
// object, or null if the bet lost. Used by color_game and claw_machine.
function rollTier(tiers) {
  const r = Math.random() * 100;
  let acc = 0;
  for (const tier of tiers) {
    acc += tier.chancePercent;
    if (r < acc) return tier;
  }
  return null;
}

// Lucky 777's two-step roll: first, whether this spin wins ANYTHING at
// all (winChanceByBet[betAmount] — set by the bet size, not the tiers).
// Only if that succeeds does it pick WHICH tier, weighted by each tier's
// relative `weight` (not a standalone %, just relative rarity against the
// other tiers) — so the biggest prizes stay the rarest even among wins.
function rollSlotResult(config, betAmount) {
  const winChance = config.winChanceByBet[betAmount];
  if (Math.random() * 100 >= winChance) return null;
  const totalWeight = config.tiers.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const tier of config.tiers) {
    roll -= tier.weight;
    if (roll <= 0) return tier;
  }
  return config.tiers[config.tiers.length - 1];
}

// The Energy cost to play once — either one flat number for every bet
// (color_game, claw_machine), or looked up per bet amount (slot_777,
// where a bigger bet also burns more Energy per spin).
function energyCostFor(config, betAmount) {
  return config.energyCostByBet ? config.energyCostByBet[betAmount] : config.energyCostPerBet;
}

// Builds the 3 "dropped block" colors shown in Color Game's reveal
// animation: exactly `matchCount` of them are the player's chosen color,
// and the rest are randomly picked from the OTHER colors in the palette
// (never the chosen one, so the visible match count is never accidentally
// higher than what the tier actually awarded).
function buildColorReveal(palette, chosenColor, matchCount) {
  const others = palette.filter((c) => c !== chosenColor);
  const reveal = [];
  for (let i = 0; i < 3; i++) {
    if (i < matchCount) reveal.push(chosenColor);
    else reveal.push(others[Math.floor(Math.random() * others.length)]);
  }
  for (let i = reveal.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [reveal[i], reveal[j]] = [reveal[j], reveal[i]];
  }
  return reveal;
}

// Builds the 3 reel symbols shown in Lucky 777's spin animation. On a WIN
// (winSymbol/matchCount given), exactly matchCount reels show that symbol
// and the rest show a different random symbol. On a LOSE (winSymbol
// null), it shows 3 DISTINCT symbols, and EXCLUDES any symbol that wins
// on its own with just ONE appearance (currently 'cherry' — the "single
// cherry" tier only needs matchCount 1) — a losing spin must never show
// even a single one of those, or it looks like it should have won. Every
// other symbol is safe to show once (they all need 2+ to win), just never
// repeated.
function buildSlotReveal(symbolPool, tiers, winSymbol, matchCount) {
  if (!winSymbol) {
    const singleWinSymbols = new Set(tiers.filter((t) => t.matchCount === 1).map((t) => t.symbol));
    const safePool = symbolPool.filter((s) => !singleWinSymbols.has(s));
    const shuffled = [...safePool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  }
  const others = symbolPool.filter((s) => s !== winSymbol);
  const reveal = [];
  for (let i = 0; i < 3; i++) {
    if (i < matchCount) reveal.push(winSymbol);
    else reveal.push(others[Math.floor(Math.random() * others.length)]);
  }
  for (let i = reveal.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [reveal[i], reveal[j]] = [reveal[j], reveal[i]];
  }
  return reveal;
}

module.exports = {
  DEFAULT_MACHINES, oddsKey, getOverrideBp, setOverrideBp, clearOverride, listOddsFields, getLiveMachines,
  rollTier, rollSlotResult, energyCostFor, buildColorReveal, buildSlotReveal,
};
