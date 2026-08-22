const express = require('express');
const { addEnergy, resolveEnergy, spendEnergy } = require('../lib/gameLogic');
const {
  getLiveMachines, rollTier, rollSlotResult, energyCostFor, buildColorReveal, buildSlotReveal,
} = require('../lib/casinoConfig');

module.exports = function casinoRoutes(db) {
  const router = express.Router();

  // GET /api/casino/config — bet options, energy costs, and prize tiers
  // for every machine, so the client never hand-copies these numbers.
  // Reflects any live admin odds overrides (see server/lib/casinoConfig.js
  // and the admin panel's Casino Odds screen) — never the hardcoded
  // defaults if an admin has changed something.
  router.get('/config', (req, res) => {
    res.json(getLiveMachines(db));
  });

  // POST /api/casino/bet { machine, bet, color } — places one bet on one
  // machine. Coins (the bet) and Energy (the per-play cost — see
  // energyCostFor, since it varies by bet for Lucky 777) are deducted
  // together up front, win or lose. A win credits Energy or PP back
  // (Energy capped at MAX_ENERGY). `color` is required for color_game
  // (which swatch the player tapped) — the ROLL itself is still the same
  // weighted-tier system as every other machine (the player's choice
  // never changes the odds), but the response's `reveal`/`icon` is built
  // to visually match whichever tier was actually rolled, so the
  // animation always shows exactly what the tier awarded.
  router.post('/bet', (req, res) => {
    const { machine, bet, color } = req.body || {};
    const config = getLiveMachines(db)[machine];
    if (!config) return res.status(400).json({ error: 'Unknown machine' });

    const betAmount = parseInt(bet, 10);
    if (!config.betOptions.includes(betAmount)) {
      return res.status(400).json({ error: `Bet must be one of: ${config.betOptions.join(', ')}` });
    }
    if (config.colorPalette && !config.colorPalette.includes(color)) {
      return res.status(400).json({ error: `Pick a color: ${config.colorPalette.join(', ')}` });
    }
    const energyCost = energyCostFor(config, betAmount);

    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    if (!user || user.coins < betAmount) {
      return res.status(400).json({ error: `Not enough coins — need ${betAmount}` });
    }
    const currentEnergy = resolveEnergy(db, req.userId);
    if (currentEnergy === null || currentEnergy < energyCost) {
      return res.status(400).json({ error: `Not enough energy — need ${energyCost}` });
    }

    // Deduct the coin bet and the energy cost together — both are spent
    // whether this bet wins or loses, same as any carnival game.
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(betAmount, req.userId);
    spendEnergy(db, req.userId, energyCost);

    const tier = config.winChanceByBet ? rollSlotResult(config, betAmount) : rollTier(config.tiers);
    let energyReward = 0;
    let ppReward = 0;
    let gmReward = 0;
    if (tier) {
      if (tier.gmFlat != null) {
        gmReward = tier.gmFlat;
        db.prepare('UPDATE users SET gm_points = gm_points + ? WHERE id = ?').run(gmReward, req.userId);
      } else if (tier.ppFlat != null) {
        ppReward = tier.ppFlat;
        db.prepare('UPDATE users SET premium_currency = premium_currency + ? WHERE id = ?').run(ppReward, req.userId);
      } else {
        energyReward = tier.energyFlat != null
          ? tier.energyFlat
          : Math.round(betAmount * tier.betMultiplier);
        addEnergy(db, req.userId, energyReward);
      }
    }

    const updated = db.prepare('SELECT coins, energy, premium_currency, gm_points FROM users WHERE id = ?').get(req.userId);
    const response = {
      ok: true,
      machine,
      bet: betAmount,
      energyCost,
      win: !!tier,
      tier: tier ? { id: tier.id, label: tier.label } : null,
      energyReward,
      ppReward,
      gmReward,
      coins: updated.coins,
      energy: updated.energy,
      premiumCurrency: updated.premium_currency,
      gmPoints: updated.gm_points,
    };
    if (config.colorPalette) {
      response.color = color;
      response.reveal = buildColorReveal(config.colorPalette, color, tier ? tier.matchCount : 0);
    } else if (config.reelSymbols) {
      response.reveal = buildSlotReveal(config.reelSymbols, config.tiers, tier ? tier.symbol : null, tier ? tier.matchCount : 0);
    } else if (machine === 'claw_machine') {
      response.icon = tier ? tier.icon : null;
    }
    res.json(response);
  });

  return router;
};
