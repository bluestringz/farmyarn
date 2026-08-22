// public/js/ui.js
// Pure(ish) rendering helpers for panels/popovers/toasts. main.js owns state
// and wires these render functions to data + event handlers.

const UI = (() => {
  function toast(message) {
    const stack = document.getElementById('toast-stack');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    stack.appendChild(el);
    // During a fast run of actions (e.g. harvesting several crops in a
    // row) these could pile up into a tower tall enough to block the
    // screen — cap how many stay visible at once, clearing the oldest
    // immediately instead of waiting out its full timer.
    const MAX_VISIBLE = 4;
    while (stack.children.length > MAX_VISIBLE) {
      stack.removeChild(stack.firstElementChild);
    }
    setTimeout(() => el.remove(), 3200);
  }

  function openPanel(title) {
    document.getElementById('side-panel-title').textContent = title;
    document.getElementById('side-panel').classList.remove('hidden');
  }
  function closePanel() {
    document.getElementById('side-panel').classList.add('hidden');
  }
  function panelBody() {
    return document.getElementById('side-panel-body');
  }

  function formatDuration(seconds) {
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const hours = seconds / 3600;
    if (hours < 24) return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
    const days = hours / 24;
    return `${days % 1 === 0 ? days : days.toFixed(1)}d`;
  }

  // Short "what is this for" text shown on every shop card. Kept here on the
  // client rather than in the database — it's static copy that never
  // varies per-user, so there's no reason to add yet another schema column
  // (and risk of a migration bug) just to store a sentence of flavor text.
  // Preset wall-color choices for House and Mansion, shown as a swatch
  // picker in the Shop card before buying. House swatches are CSS colors
  // (matches server's BUILDING_COLOR_OPTIONS hex values exactly — the
  // server rejects anything not in that list). Mansion swatches are
  // instead small thumbnails of the actual illustrated art per color
  // (public/assets/buildings/mansion_<key>.png) — there's no hex tint
  // involved, each color is a genuinely different piece of art, so the
  // picker shows that art directly instead of a flat color circle.
  const BUILDING_COLOR_OPTIONS = {
    farmhouse: ['#f6ecd2', '#dceaf0', '#e3f0dc', '#f5dbe6', '#e8e2f5', '#fbe8cf'],
  };
  const MANSION_COLOR_OPTIONS = ['orange', 'green', 'teal', 'blue', 'purple', 'pink', 'red', 'white'];

  const ITEM_DESCRIPTIONS = {
    // crops (seeds)
    wheat: 'Fast, cheap starter crop — good for quick coins while you level up.',
    rice: 'A step up from wheat, takes a bit longer but pays more.',
    corn: 'Solid mid-tier crop with a few hours\' growth time.',
    carrot: 'Good coin-per-hour once you\'ve unlocked it at level 2.',
    potato: 'Slow grower (15 hours) but a big payout when it\'s ready.',
    tomato: 'Long growth time, strong payout — great for planting before you log off.',
    strawberry: 'A full day to grow, but one of the best sell prices in the game.',
    pumpkin: 'The ultimate crop — 2 full days to grow, huge payout when harvested.',
    // buildings
    farmhouse: 'Your home — given free at signup. Walk in to decorate the inside. Can be removed, and rebought here if you do.',
    barn: 'Tap to go inside — houses Pigs and Sheep. Each barn you build has its own separate room.',
    silo: 'Tap it to turn wheat into animal feed — feed your animals here before you can collect from them.',
    well: 'Classic farm decoration — a water source for the homestead look.',
    market_stall: 'A rentable stall in the shared Marketplace — sell goods to other players.',
    storage_shed: 'Tap it to store extra Bag items and keep your Bag tidy — take them back out anytime.',
    chicken_coop: 'Tap to go inside — houses Chickens only. Each coop you build has its own separate room.',
    cow_barn: 'Tap to go inside — houses Cows only. Each cow barn you build has its own separate room.',
    workshop: 'Tap it to craft furniture from Wood (chop trees for logs) — crafted pieces can be sold at a Marketplace stall, unlike store-bought furniture.',
    // decorations
    fence: 'Blocks walking — fences auto-connect to neighboring fence tiles, and you can route your farm paths around them.',
    tree: 'Plant it and water it — takes 2 days to grow into a full tree you can chop for logs.',
    flower: 'Purely decorative flower bed to brighten up your farm.',
    bush: 'Purely decorative shrub for landscaping your farm.',
    hay_bale: 'Purely decorative — classic farm scenery.',
    bench: 'Tap it while outdoors to sit — regenerates Energy faster while seated, just like a chair indoors.',
    lamp: 'Purely decorative lamp post.',
    sign: 'Purely decorative sign — rotate it to face any direction.',
    path: 'Walkable paved ground tile — lay these down as a proper walkway.',
    pond: 'Decorative water feature, 2×2 tiles.',
    // animals
    chicken: 'Produces an Egg every 10 minutes — tap to collect once ready.',
    cow: 'Produces Milk every 30 minutes — tap to collect once ready.',
    sheep: 'Produces Wool every 25 minutes — tap to collect once ready.',
    pig: 'Produces a Truffle every 20 minutes — tap to collect once ready.',
    // outfits
    classic_overalls: 'Your default starting look — free, always available.',
    green_flannel: 'A green-shirt variant with its own matching in-game sprite.',
    red_flannel: 'A color variant — currently shown with the classic sprite in-game.',
    blue_dungarees: 'A color variant — currently shown with the classic sprite in-game.',
    meadow_dress: 'A dress-style outfit for female characters.',
    sunflower_dress: 'A dress-style outfit for female characters.',
    straw_worker: 'A worker-themed color variant.',
    harvest_gold: 'A premium color variant, unlocks at level 5.',
    // animal products & materials
    egg: 'Sell it, or one day cook with it once cooking is added.',
    milk: 'Sell it, or one day cook with it once cooking is added.',
    wool: 'Sell it — a cow/sheep product with no other use yet.',
    truffle: 'A rare, high-value pig product — sell for good coins.',
    log: 'Chopped from a mature tree — sell it, or save it for a future firewood/cooking system.',
    // interiors (house furniture)
    rug: 'Floor decoration for your house interior.',
    table: 'Dining table for your house interior.',
    chair: 'Tap it while indoors to sit — regenerates Energy faster while seated.',
    cabinet: 'Storage furniture for your house interior.',
    bed: 'Tap it while indoors to lie down — regenerates Energy faster while resting.',
    potted_plant: 'Small decorative plant for your house interior.',
    painting: 'Wall art for your house interior.',
    fireplace: 'Cozy centerpiece for your house interior.',
    bookshelf: 'Bookshelf for your house interior.',
    stove: 'Tap it to cook harvested crops into food — eating food restores the Energy you need to plow/plant/water.',
  };

  function renderShop(catalog, activeCategory, player, onBuy, onCategoryChange, onChangeName) {
    const body = panelBody();
    const categories = [
      { key: 'crops', label: 'Seeds' },
      { key: 'buildings', label: 'Buildings' },
      { key: 'animals', label: 'Animals' },
      { key: 'decorations', label: 'Decor' },
      { key: 'interiors', label: 'Interior' },
      { key: 'outfits', label: 'Outfits' },
      { key: 'special_outfits', label: '⭐ Special' },
    ];
    const tabs = categories.map((c) =>
      `<button class="shop-tab ${c.key === activeCategory ? 'active' : ''}" data-cat="${c.key}">${c.label}</button>`
    ).join('');

    // Shared card markup for both the regular Outfits tab (Premium Points,
    // 7-day rental) and the Special Outfits tab (GM Points, 14-day rental,
    // admin-granted currency only) — same shape, different currency/cost
    // labels, so this one function covers both instead of duplicating the
    // whole template.
    function renderOutfitCard(item, opts) {
      const locked = player.level < item.required_level;
      const owned = item.owned;
      const equipped = item.equipped;
      const balance = opts.balance;
      const affordable = balance >= item.cost;
      const isRental = item.cost > 0;
      let expiryLine = '';
      if (isRental && item.expiresAt) {
        const daysLeft = Math.max(0, Math.ceil((item.expiresAt * 1000 - Date.now()) / 86400000));
        expiryLine = owned
          ? `<div class="shop-level">Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</div>`
          : `<div class="shop-level" style="color:#c0392b">Rental expired</div>`;
      }
      return `
        <div class="shop-card">
          <canvas class="outfit-preview" width="70" height="90" data-preview-outfit="${item.id}"></canvas>
          <div class="shop-name">${item.name}</div>
          <div class="shop-price">${isRental ? `${opts.icon} ${item.cost} for ${item.rental_days} days` : 'Free'}</div>
          ${expiryLine}
          ${locked ? `<div class="shop-level">Requires Lvl ${item.required_level}</div>` : ''}
          ${ITEM_DESCRIPTIONS[item.id] ? `<div class="shop-desc">${ITEM_DESCRIPTIONS[item.id]}</div>` : ''}
          <button data-item="${item.id}" ${(locked || (!owned && !affordable) || (equipped && owned)) ? 'disabled' : ''}>
            ${equipped && owned ? 'Equipped' : owned ? 'Wear' : locked ? 'Locked' : isRental ? `Rent (${item.rental_days} days)` : 'Wear'}
          </button>
        </div>`;
    }

    if (activeCategory === 'special_outfits') {
      const items = (catalog.outfits || [])
        .filter((o) => o.gender === 'unisex' || o.gender === player.gender)
        .filter((o) => o.currency === 'gm_points');
      const cards = items.map((item) => renderOutfitCard(item, { icon: '🎖️', balance: player.gmPoints || 0 })).join('')
        || `<div class="empty-state">Nothing here yet.</div>`;
      body.innerHTML = `<div class="shop-tabs">${tabs}</div>
        <p class="panel-hint">🎖️ ${player.gmPoints || 0} GM Points — a rare currency only an admin can grant you. Special Outfits are 14-day rentals costing GM Points, never Premium Points.</p>
        <div class="shop-grid">${cards}</div>`;

      body.querySelectorAll('canvas[data-preview-outfit]').forEach((canvas) => {
        const outfit = items.find((o) => o.id === canvas.dataset.previewOutfit);
        if (window.drawMiniCharacter) window.drawMiniCharacter(canvas, player.gender, outfit, outfit.equipped ? player.dyeColor : null);
      });
      body.querySelectorAll('.shop-tab').forEach((btn) => {
        btn.addEventListener('click', () => onCategoryChange(btn.dataset.cat));
      });
      body.querySelectorAll('.shop-card button[data-item]').forEach((btn) => {
        btn.addEventListener('click', () => onBuy('special_outfits', btn.dataset.item));
      });
      return;
    }

    if (activeCategory === 'outfits') {
      // These items never got real matching artwork (they just fell back to
      // showing the classic look), which made them pointless/misleading —
      // hidden here now that real illustrated costumes exist. Not removed
      // from the database, so anyone who already owns/wears one keeps it.
      const PLACEHOLDER_OUTFITS = new Set(['red_flannel', 'blue_dungarees', 'straw_worker', 'harvest_gold', 'meadow_dress', 'sunflower_dress']);
      const items = (catalog.outfits || [])
        .filter((o) => o.gender === 'unisex' || o.gender === player.gender)
        .filter((o) => !PLACEHOLDER_OUTFITS.has(o.id))
        .filter((o) => o.currency !== 'gm_points'); // those live on the Special tab instead
      const cards = items.map((item) => renderOutfitCard(item, { icon: '💎', balance: player.premiumCurrency || 0 })).join('')
        || `<div class="empty-state">Nothing here yet.</div>`;

      const changeNameSection = `
        <div class="panel-section-title">Change your profile name</div>
        <div class="shop-card" style="width:100%; max-width:none;">
          <div class="shop-icon">✏️</div>
          <div class="shop-name">Currently: ${player.displayName || player.username}</div>
          <input type="text" id="shop-change-name-input" maxlength="20" placeholder="New profile name" style="width:100%; box-sizing:border-box; padding:8px 10px; border:2px solid var(--cream-dark); border-radius:8px; margin:6px 0; font-family:inherit;">
          <div class="shop-price">💎 200</div>
          <button id="shop-change-name-btn" ${(player.premiumCurrency || 0) < 200 ? 'disabled' : ''}>Change Name</button>
        </div>
      `;

      body.innerHTML = `<div class="shop-tabs">${tabs}</div><p class="panel-hint">Costumes are 7-day rentals paid in 💎 Premium Points — you can rent a new one once the current 7 days runs out.</p><div class="shop-grid">${cards}</div>${changeNameSection}`;


      body.querySelectorAll('canvas[data-preview-outfit]').forEach((canvas) => {
        const outfit = items.find((o) => o.id === canvas.dataset.previewOutfit);
        if (window.drawMiniCharacter) window.drawMiniCharacter(canvas, player.gender, outfit, outfit.equipped ? player.dyeColor : null);
      });
      body.querySelectorAll('.shop-tab').forEach((btn) => {
        btn.addEventListener('click', () => onCategoryChange(btn.dataset.cat));
      });
      body.querySelectorAll('.shop-card button[data-item]').forEach((btn) => {
        btn.addEventListener('click', () => onBuy('outfits', btn.dataset.item));
      });
      const changeNameBtn = body.querySelector('#shop-change-name-btn');
      if (changeNameBtn) {
        changeNameBtn.addEventListener('click', () => {
          const input = body.querySelector('#shop-change-name-input');
          const name = input.value.trim();
          if (!name) { toast('Enter a new name first.'); return; }
          onChangeName(name);
        });
      }
      return;
    }

    const catalogKey = activeCategory === 'interiors' ? 'interiors' : activeCategory;
    const buyCategory = activeCategory === 'interiors' ? 'interior'
      : activeCategory === 'buildings' ? 'building'
      : activeCategory === 'animals' ? 'animal'
      : activeCategory === 'decorations' ? 'decoration'
      : 'crops';
    const items = (catalog[catalogKey] || []).filter((item) =>
      // Workshop-crafted furniture (crafted_bench, crafted_bed, etc.) is
      // never bought here with coins — it's made at the Workshop from
      // Wood instead (cost: 0 in the catalog is the tell). Filtering it
      // out of Decor/Interior here keeps the Shop from showing something
      // that would look free but can't actually be bought this way.
      !item.id.startsWith('crafted_'));
    const isCrops = activeCategory === 'crops';
    const cards = items.map((item) => {
      const cost = item.seed_cost ?? item.cost;
      const locked = player.level < item.required_level;
      const affordable = player.coins >= cost;
      const glyphMap = { crops: '🌱', buildings: '🏗️', animals: '🐾', decorations: '🌷', interiors: '🛋️' };
      const durationLine = isCrops ? `<div class="shop-level">⏱ ${formatDuration(item.growth_seconds)} to harvest</div>` : '';
      // Seeds are the one thing people buy in bulk (to plant a whole field
      // at once) — give them a quantity field instead of one-click-at-a-time,
      // plus a MAX button that fills in exactly as many as their coins can
      // cover so they're not stuck guessing/doing the division themselves.
      const maxAffordable = Math.max(1, Math.min(99, Math.floor(player.coins / cost)));
      const qtyRow = isCrops && !locked
        ? `<div class="qty-row"><input type="number" class="qty-input" min="1" max="99" value="1" data-qty-for="${item.id}"><button type="button" class="qty-max-btn" data-max-for="${item.id}" data-max-value="${maxAffordable}">MAX</button></div>`
        : '';
      const colorOptions = BUILDING_COLOR_OPTIONS[item.id];
      const isMansion = item.id === 'mansion';
      const colorSwatches = isMansion
        ? `<div class="color-swatch-row" data-swatches-for="${item.id}">
            ${MANSION_COLOR_OPTIONS.map((c, i) => `<button type="button" class="color-swatch mansion-swatch ${i === 0 ? 'selected' : ''}" data-color="${c}" style="background-image:url('/assets/buildings/mansion_${c}.png')"></button>`).join('')}
          </div>`
        : colorOptions ? `
        <div class="color-swatch-row" data-swatches-for="${item.id}">
          ${colorOptions.map((c, i) => `<button type="button" class="color-swatch ${i === 0 ? 'selected' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
        </div>` : '';
      return `
        <div class="shop-card">
          <div class="shop-icon">${glyphMap[activeCategory]}</div>
          <div class="shop-name">${item.name}</div>
          <div class="shop-price">🪙 ${cost}${isCrops ? ' each' : ''}</div>
          ${durationLine}
          ${locked ? `<div class="shop-level">Requires Lvl ${item.required_level}</div>` : ''}
          ${ITEM_DESCRIPTIONS[item.id] ? `<div class="shop-desc">${ITEM_DESCRIPTIONS[item.id]}</div>` : ''}
          ${colorSwatches}
          ${qtyRow}
          <button data-item="${item.id}" ${(locked || !affordable) ? 'disabled' : ''}>
            ${locked ? 'Locked' : isCrops ? 'Buy Seeds' : 'Buy'}
          </button>
        </div>`;
    }).join('') || `<div class="empty-state">Nothing here yet.</div>`;

    const hint = isCrops
      ? '<p class="panel-hint">Buy seeds here, then use the 🌱 Plant tool to put them in the ground.</p>'
      : activeCategory === 'interiors'
      ? '<p class="panel-hint">Buy furniture here, then use the Decorate tool inside your house to place it.</p>'
      : '<p class="panel-hint">Buy here, then use the 🏗️ Build tool to place it — you can preview and rotate before confirming.</p>';

    body.innerHTML = `<div class="shop-tabs">${tabs}</div>${hint}<div class="shop-grid">${cards}</div>`;

    body.querySelectorAll('.shop-tab').forEach((btn) => {
      btn.addEventListener('click', () => onCategoryChange(btn.dataset.cat));
    });
    body.querySelectorAll('.color-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.color-swatch-row');
        row.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
    body.querySelectorAll('.shop-card button[data-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="${btn.dataset.item}"]`);
        const qty = qtyInput ? Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1)) : 1;
        const swatchRow = body.querySelector(`.color-swatch-row[data-swatches-for="${btn.dataset.item}"]`);
        const selectedSwatch = swatchRow ? swatchRow.querySelector('.color-swatch.selected') : null;
        onBuy(buyCategory, btn.dataset.item, qty, selectedSwatch ? selectedSwatch.dataset.color : undefined);
      });
    });
    body.querySelectorAll('.qty-max-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = body.querySelector(`input[data-qty-for="${btn.dataset.maxFor}"]`);
        if (input) input.value = btn.dataset.maxValue;
      });
    });
  }

  function renderInventory(items, catalog, onSell, onEat) {
    const body = panelBody();
    if (!items.length) {
      body.innerHTML = `<div class="empty-state">Your bag is empty. Buy seeds from the Shop!</div>`;
      return;
    }
    const seeds = items.filter((r) => r.item_id.startsWith('seed_'));
    const placeablePrefixes = ['building_', 'decoration_', 'animal_', 'interior_'];
    const placeables = items.filter((r) => placeablePrefixes.some((p) => r.item_id.startsWith(p)));
    const FOOD_ITEMS = { bread: 5, rice_bowl: 6, corn_soup: 7, carrot_stew: 8, mashed_potato: 10, tomato_soup: 11, strawberry_cake: 14, pumpkin_pie: 17, fried_egg: 6, milkshake: 10, truffle_dish: 18, ice_cream: 5, hotdog: 8 };
    const food = items.filter((r) => FOOD_ITEMS[r.item_id] !== undefined);
    const produce = items.filter((r) => !r.item_id.startsWith('seed_') && !placeablePrefixes.some((p) => r.item_id.startsWith(p)) && FOOD_ITEMS[r.item_id] === undefined);

    const nameFor = (id) => {
      const crop = catalog.crops.find((c) => c.id === id);
      if (crop) return { name: crop.name, price: crop.sell_price, icon: '🌾' };
      const item = (catalog.items || []).find((i) => i.id === id);
      return { name: item ? item.name : id, price: item ? item.sell_price : 0, icon: '🥚' };
    };
    const placeableNameFor = (invId) => {
      for (const prefix of placeablePrefixes) {
        if (invId.startsWith(prefix)) {
          const cat = prefix.slice(0, -1);
          const list = cat === 'building' ? catalog.buildings : cat === 'decoration' ? catalog.decorations
            : cat === 'animal' ? catalog.animals : catalog.interiors;
          const def = (list || []).find((d) => d.id === invId.slice(prefix.length));
          return { name: def ? def.name : invId, tool: cat === 'interior' ? 'Decorate' : 'Build' };
        }
      }
      return { name: invId, tool: 'Build' };
    };

    let html = '';
    if (seeds.length) {
      html += '<div class="panel-section-title">Seeds ready to plant</div>';
      html += seeds.map((row) => {
        const cropId = row.item_id.slice(5);
        const meta = nameFor(cropId);
        return `
          <div class="list-row">
            <div class="row-icon">🌱</div>
            <div class="row-main">
              <div class="row-title">${meta.name} seeds × ${row.quantity}</div>
              <div class="row-sub">Plant tool to sow • sell these at a Marketplace stall, set your own price</div>
            </div>
          </div>`;
      }).join('');
    }
    if (placeables.length) {
      html += '<div class="panel-section-title">Ready to place</div>';
      html += placeables.map((row) => {
        const meta = placeableNameFor(row.item_id);
        return `
          <div class="list-row">
            <div class="row-icon">📦</div>
            <div class="row-main">
              <div class="row-title">${meta.name} × ${row.quantity}</div>
              <div class="row-sub">Use the ${meta.tool} tool to place ${row.quantity > 1 ? 'one' : 'it'}</div>
            </div>
          </div>`;
      }).join('');
    }
    if (produce.length) {
      html += '<div class="panel-section-title">Harvest & goods</div>';
      html += produce.map((row) => {
        const meta = nameFor(row.item_id);
        return `
          <div class="list-row">
            <div class="row-icon">${meta.icon}</div>
            <div class="row-main">
              <div class="row-title">${meta.name} × ${row.quantity}</div>
              <div class="row-sub">Sells for 🪙 ${meta.price} each</div>
            </div>
            <div class="row-actions">
              <button data-item="${row.item_id}" data-qty="1">Sell 1</button>
              ${row.quantity > 1 ? `<button data-item="${row.item_id}" data-qty="${row.quantity}">Sell All (${row.quantity})</button>` : ''}
            </div>
          </div>`;
      }).join('');
    }
    if (food.length) {
      html += '<div class="panel-section-title">Cooked food</div>';
      html += food.map((row) => {
        const meta = nameFor(row.item_id);
        return `
          <div class="list-row">
            <div class="row-icon">🍽️</div>
            <div class="row-main">
              <div class="row-title">${meta.name} × ${row.quantity}</div>
              <div class="row-sub">Eat for ⚡+${FOOD_ITEMS[row.item_id]} energy</div>
            </div>
            <div class="row-actions">
              <button data-eat="${row.item_id}">Eat 1</button>
            </div>
          </div>`;
      }).join('');
    }
    body.innerHTML = html;
    body.querySelectorAll('button[data-item]').forEach((btn) => {
      btn.addEventListener('click', () => onSell(btn.dataset.item, parseInt(btn.dataset.qty, 10) || 1));
    });
    body.querySelectorAll('button[data-eat]').forEach((btn) => {
      btn.addEventListener('click', () => onEat(btn.dataset.eat));
    });
  }

  // Focused single-stall panel — opened by tapping a stall in the walkable
  // Marketplace plaza. Shows rent/list/buy/cancel/leave depending on whether
  // this is your own stall, someone else's, or an empty one.
  function renderStallDetail(stall, catalog, player, handlers) {
    const body = panelBody();
    const nameFor = (id) => {
      const crop = catalog.crops.find((c) => c.id === id);
      if (crop) return crop.name;
      if (id.startsWith('seed_')) {
        const cropForSeed = catalog.crops.find((c) => c.id === id.slice(5));
        if (cropForSeed) return `${cropForSeed.name} Seeds`;
      }
      // Workshop-crafted furniture is the one placeable-category thing
      // that's sellable here (see the sellable filter below) — its
      // inventory id is "interior_<id>" or "decoration_<id>", so strip
      // that prefix and look it up in the matching catalog list.
      if (id.startsWith('interior_')) {
        const interior = (catalog.interiors || []).find((i) => i.id === id.slice('interior_'.length));
        if (interior) return interior.name;
      }
      if (id.startsWith('decoration_')) {
        const deco = (catalog.decorations || []).find((d) => d.id === id.slice('decoration_'.length));
        if (deco) return deco.name;
      }
      const outfit = (catalog.outfits || []).find((o) => o.id === id);
      if (outfit) return `${outfit.name} Costume`;
      const item = (catalog.items || []).find((i) => i.id === id);
      return item ? item.name : id;
    };
    // "3d 4h", "6h", "42m" — short countdown for a costume listing's
    // remaining rental time, same idea as UI.formatDuration but framed as
    // a countdown rather than a flat duration label.
    const timeLeft = (expiresAt) => {
      if (expiresAt === null || expiresAt === undefined) return 'never expires';
      const secs = expiresAt - Math.floor(Date.now() / 1000);
      if (secs <= 0) return 'expired';
      return formatDuration(secs) + ' left';
    };

    let html = '';
    const listings = stall.listings || [];

    if (!stall.renterId) {
      html = `
        <div class="list-row">
          <div class="row-icon">🏪</div>
          <div class="row-main">
            <div class="row-title">Empty stall</div>
            <div class="row-sub">Rent it for 🪙100 (24 hours) and sell your own goods here</div>
          </div>
        </div>
        <button class="btn btn-primary" id="mkt-rent-btn" style="width:100%">Rent this stall</button>
      `;
    } else if (stall.isMine) {
      html += `
        <div class="list-row">
          <div class="row-icon">🧑‍🌾</div>
          <div class="row-main">
            <div class="row-title">This is your stall</div>
            <div class="row-sub">Rented until ${new Date(stall.rentedUntil * 1000).toLocaleString()}</div>
          </div>
        </div>`;
      if (listings.length) {
        html += '<div class="panel-section-title">Currently listed</div>';
        html += listings.map((l) => `
          <div class="list-row">
            <div class="row-icon">${l.listingType === 'outfit' ? '👕' : '🏷️'}</div>
            <div class="row-main">
              <div class="row-title">${nameFor(l.itemId)}${l.listingType === 'outfit' ? '' : ` × ${l.quantity}`}</div>
              <div class="row-sub">🪙 ${l.price}${l.listingType === 'outfit' ? ` — ${timeLeft(l.expiresAt)}` : ' each'}</div>
            </div>
            <div class="row-actions"><button class="secondary" data-remove-listing="${l.id}">Remove</button></div>
          </div>`).join('');
      }
      html += `
        <div class="panel-section-title">List something for sale</div>
        <div id="mkt-list-form" class="mkt-form">
          <select id="mkt-list-item"></select>
          <input id="mkt-list-qty" type="number" min="1" placeholder="Quantity">
          <input id="mkt-list-price" type="number" min="1" placeholder="Price each (coins)">
          <button id="mkt-list-submit">List for sale</button>
        </div>`;
      html += `<button class="btn btn-small" id="mkt-leave" style="width:100%;margin-top:8px;background:var(--barn-red);color:#fff;">Leave this stall</button>`;
    } else {
      html = `
        <div class="list-row">
          <div class="row-icon">🧑‍🌾</div>
          <div class="row-main">
            <div class="row-title">${stall.renterUsername}'s stall</div>
            <div class="row-sub">Lvl ${stall.renterLevel}</div>
          </div>
        </div>`;
      if (listings.length) {
        html += listings.map((l) => `
          <div class="list-row">
            <div class="row-icon">${l.listingType === 'outfit' ? '👕' : '🏷️'}</div>
            <div class="row-main">
              <div class="row-title">${nameFor(l.itemId)}${l.listingType === 'outfit' ? '' : ` × ${l.quantity} available`}</div>
              <div class="row-sub">🪙 ${l.price}${l.listingType === 'outfit' ? ` — ${timeLeft(l.expiresAt)} if you buy now` : ' each'}</div>
            </div>
          </div>
          <div class="mkt-form">
            ${l.listingType === 'outfit'
              ? `<button data-buy-listing="${l.id}">Buy</button>`
              : `<input type="number" class="mkt-buy-qty" data-buy-qty-for="${l.id}" min="1" max="${l.quantity}" value="1">
                 <button data-buy-listing="${l.id}">Buy</button>`}
          </div>`).join('');
      } else {
        html += `<div class="empty-state">Nothing for sale here right now.</div>`;
      }
    }

    body.innerHTML = html;

    const rentBtn = document.getElementById('mkt-rent-btn');
    if (rentBtn) rentBtn.addEventListener('click', handlers.onRent);
    const leaveBtn = document.getElementById('mkt-leave');
    if (leaveBtn) leaveBtn.addEventListener('click', handlers.onLeave);

    body.querySelectorAll('button[data-remove-listing]').forEach((btn) => {
      btn.addEventListener('click', () => handlers.onRemoveListing(btn.dataset.removeListing));
    });
    body.querySelectorAll('button[data-buy-listing]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-buy-qty-for="${btn.dataset.buyListing}"]`);
        const qty = qtyInput ? parseInt(qtyInput.value, 10) || 1 : 1;
        handlers.onBuy(btn.dataset.buyListing, qty);
      });
    });

    const listForm = document.getElementById('mkt-list-form');
    if (listForm) {
      const qtyInput = document.getElementById('mkt-list-qty');
      Promise.all([handlers.getInventory(), handlers.getOwnedOutfits()]).then(([inv, outfits]) => {
        // Seeds ARE sellable here — this is the one place they can be sold
        // at all (the Shop won't buy them back, on purpose, so they hold
        // real value — see server/routes/farm.js's /sell route). Only
        // placeable-category items (buildings/decorations/animals/interior)
        // are excluded, since those go through Build/Decorate, not selling
        // — EXCEPT Workshop-crafted furniture (interior_crafted_* /
        // decoration_crafted_*), which is deliberately sellable: that's
        // the whole point of crafting it instead of just buying it.
        const isCraftedFurniture = (id) => id.includes('_crafted_');
        const sellable = inv.filter((r) =>
          isCraftedFurniture(r.item_id) ||
          !['building_', 'decoration_', 'animal_', 'interior_'].some((p) => r.item_id.startsWith(p)));
        const select = document.getElementById('mkt-list-item');
        // Costumes you own (and aren't already listed) show up in the SAME
        // picker as ordinary items — its 7-day rental clock keeps running
        // the whole time it sits here (see the server route), so an
        // expiring-soon one is flagged right in the option label.
        const listedOutfitIds = new Set(listings.filter((l) => l.listingType === 'outfit').map((l) => l.itemId));
        const sellableOutfits = outfits.filter((o) => o.owned && o.cost > 0 && !listedOutfitIds.has(o.id));
        select.innerHTML = [
          ...sellable.map((r) => `<option value="${r.item_id}" data-qty-max="${r.quantity}">${nameFor(r.item_id)} (have ${r.quantity})</option>`),
          ...sellableOutfits.map((o) => `<option value="${o.id}" data-outfit="1">${o.name} Costume (${timeLeft(o.expiresAt)})</option>`),
        ].join('') || '<option value="">Nothing to sell</option>';

        const syncQtyField = () => {
          const opt = select.options[select.selectedIndex];
          const isOutfit = opt && opt.dataset.outfit === '1';
          qtyInput.disabled = isOutfit;
          qtyInput.value = isOutfit ? '1' : qtyInput.value;
          qtyInput.placeholder = isOutfit ? 'Quantity (always 1)' : 'Quantity';
        };
        select.addEventListener('change', syncQtyField);
        syncQtyField();
      });
      document.getElementById('mkt-list-submit').addEventListener('click', () => {
        const select = document.getElementById('mkt-list-item');
        const itemId = select.value;
        const opt = select.options[select.selectedIndex];
        const isOutfit = opt && opt.dataset.outfit === '1';
        const qty = isOutfit ? 1 : parseInt(qtyInput.value, 10);
        const price = parseInt(document.getElementById('mkt-list-price').value, 10);
        if (!itemId || !qty || !price) { toast('Fill in item, quantity, and price'); return; }
        handlers.onList(itemId, qty, price);
      });
    }
  }

  function renderFriends(data, onlineSet, handlers) {
    const body = panelBody();
    let html = '<div class="friend-search"><input id="friend-search-input" placeholder="Search players..."><button id="friend-search-btn">🔍</button></div>';
    html += '<div id="friend-search-results"></div>';

    if (data.incomingRequests.length) {
      html += '<div class="panel-section-title">Requests</div>';
      html += data.incomingRequests.map((r) => `
        <div class="list-row">
          <div class="row-icon">🧑‍🌾</div>
          <div class="row-main"><div class="row-title">${r.username}</div><div class="row-sub">Lvl ${r.level}</div></div>
          <div class="row-actions">
            <button data-accept="${r.request_id}">Accept</button>
            <button class="secondary" data-decline="${r.request_id}">Decline</button>
          </div>
        </div>`).join('');
    }

    html += '<div class="panel-section-title">Neighbors</div>';
    html += data.friends.length ? data.friends.map((f) => {
      const online = onlineSet.has(f.id);
      return `
        <div class="list-row">
          <div class="row-icon">🧑‍🌾</div>
          <div class="row-main">
            <div class="row-title"><span class="online-dot ${online ? 'online' : ''}"></span>${f.username}</div>
            <div class="row-sub">Lvl ${f.level}</div>
          </div>
          <div class="row-actions">
            <button data-visit="${f.id}">Visit</button>
            <button class="outline" data-remove="${f.id}">✕</button>
          </div>
        </div>`;
    }).join('') : '<div class="empty-state">No neighbors yet. Search above to add friends!</div>';

    body.innerHTML = html;

    document.getElementById('friend-search-btn').addEventListener('click', async () => {
      const q = document.getElementById('friend-search-input').value.trim();
      const results = await handlers.onSearch(q);
      const resultsEl = document.getElementById('friend-search-results');
      resultsEl.innerHTML = results.map((u) => `
        <div class="list-row">
          <div class="row-icon">🧑‍🌾</div>
          <div class="row-main"><div class="row-title">${u.username}</div><div class="row-sub">Lvl ${u.level}</div></div>
          <div class="row-actions"><button data-add="${u.id}">Add</button></div>
        </div>`).join('') || '<div class="empty-state">No players found.</div>';
      resultsEl.querySelectorAll('button[data-add]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onRequest(btn.dataset.add));
      });
    });

    body.querySelectorAll('button[data-visit]').forEach((btn) => btn.addEventListener('click', () => handlers.onVisit(btn.dataset.visit)));
    body.querySelectorAll('button[data-remove]').forEach((btn) => btn.addEventListener('click', () => handlers.onRemove(btn.dataset.remove)));
    body.querySelectorAll('button[data-accept]').forEach((btn) => btn.addEventListener('click', () => handlers.onRespond(btn.dataset.accept, true)));
    body.querySelectorAll('button[data-decline]').forEach((btn) => btn.addEventListener('click', () => handlers.onRespond(btn.dataset.decline, false)));
  }

  function renderNotifications(list) {
    const body = panelBody();
    if (!list.length) {
      body.innerHTML = '<div class="empty-state">No notifications yet.</div>';
      return;
    }
    const typeIcon = { level_up: '⭐', help: '💧', friend_request: '👋', friend_accept: '🤝' };
    body.innerHTML = list.map((n) => `
      <div class="list-row">
        <div class="row-icon">${typeIcon[n.type] || '🔔'}</div>
        <div class="row-main">
          <div class="row-title">${n.message}</div>
          <div class="row-sub">${timeAgo(n.created_at)}</div>
        </div>
      </div>`).join('');
  }

  function timeAgo(unixSec) {
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function renderPicker(el, items, kind, player, onPick, selectedId) {
    if (!items.length) { el.classList.add('hidden'); return; }
    const GLYPH_BY_CATEGORY = { crops: '🌱', building: '🏗️', animal: '🐾', decoration: '🌷', interior: '🛋️' };
    el.innerHTML = items.map((item) => {
      const cost = item.seed_cost ?? item.cost;
      const locked = player.level < item.required_level;
      // The picker can hold a mix of categories at once (buildings,
      // decorations, AND animals all show up together after a Shop trip,
      // via openBuildPicker) — glyph per actual item category (item._cat),
      // not one fixed icon for the whole list, so an animal doesn't show
      // up looking like a building/decoration.
      const glyph = GLYPH_BY_CATEGORY[item._cat] || GLYPH_BY_CATEGORY[kind] || '❔';
      const owned = item._owned;
      const selected = item.id === selectedId;
      return `<button class="picker-item ${locked ? 'disabled' : ''} ${selected ? 'selected' : ''}" data-id="${item.id}" ${locked ? 'disabled' : ''}>
        <span class="picker-icon">${glyph}</span>
        <span>${item.name}</span>
        <span class="picker-cost">${owned !== undefined ? `× ${owned}` : `🪙${cost}`}</span>
      </button>`;
    }).join('');
    el.classList.remove('hidden');
    el.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.picker-item').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        onPick(btn.dataset.id);
      });
    });
  }

  function renderSiloPanel(wheatOwned, onCraft) {
    const body = panelBody();
    const recipes = [
      { animalType: 'chicken', feedName: 'Chicken Feed', wheatCost: 1, icon: '🐔' },
      { animalType: 'sheep',   feedName: 'Sheep Feed',   wheatCost: 3, icon: '🐑' },
      { animalType: 'pig',     feedName: 'Pig Feed',     wheatCost: 4, icon: '🐷' },
      { animalType: 'cow',     feedName: 'Cow Feed',     wheatCost: 5, icon: '🐄' },
    ];
    body.innerHTML = `
      <p class="panel-hint">You have 🌾 ${wheatOwned} wheat. Turn it into feed here, then feed your animals before collecting from them.</p>
      <div class="shop-grid">
        ${recipes.map((r) => {
          const maxAffordable = Math.max(1, Math.min(99, Math.floor(wheatOwned / r.wheatCost)));
          return `
          <div class="shop-card">
            <div class="shop-icon">${r.icon}</div>
            <div class="shop-name">${r.feedName}</div>
            <div class="shop-price">🌾 ${r.wheatCost} wheat each</div>
            <div class="qty-row"><input type="number" class="qty-input" min="1" max="99" value="1" data-qty-for="${r.animalType}"><button type="button" class="qty-max-btn" data-max-for="${r.animalType}" data-max-value="${maxAffordable}">MAX</button></div>
            <button data-animal="${r.animalType}" ${wheatOwned < r.wheatCost ? 'disabled' : ''}>Make Feed</button>
          </div>`;
        }).join('')}
      </div>
    `;
    body.querySelectorAll('.qty-max-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = body.querySelector(`input[data-qty-for="${btn.dataset.maxFor}"]`);
        if (input) input.value = btn.dataset.maxValue;
      });
    });
    body.querySelectorAll('.shop-card button[data-animal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="${btn.dataset.animal}"]`);
        const qty = qtyInput ? Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1)) : 1;
        onCraft(btn.dataset.animal, qty);
      });
    });
  }

  function renderStovePanel(inventory, onCook) {
    const body = panelBody();
    const recipes = [
      { cropType: 'wheat',      foodName: 'Bread',           cropCost: 2, energy: 5,  icon: '🌾' },
      { cropType: 'rice',       foodName: 'Rice Bowl',       cropCost: 2, energy: 6,  icon: '🌾' },
      { cropType: 'corn',       foodName: 'Corn Soup',       cropCost: 2, energy: 7,  icon: '🌽' },
      { cropType: 'carrot',     foodName: 'Carrot Stew',     cropCost: 2, energy: 8,  icon: '🥕' },
      { cropType: 'potato',     foodName: 'Mashed Potato',   cropCost: 2, energy: 10, icon: '🥔' },
      { cropType: 'tomato',     foodName: 'Tomato Soup',     cropCost: 2, energy: 11, icon: '🍅' },
      { cropType: 'strawberry', foodName: 'Strawberry Cake', cropCost: 2, energy: 14, icon: '🍓' },
      { cropType: 'pumpkin',    foodName: 'Pumpkin Pie',     cropCost: 2, energy: 17, icon: '🎃' },
      { cropType: 'egg',        foodName: 'Fried Egg',       cropCost: 2, energy: 6,  icon: '🥚' },
      { cropType: 'milk',       foodName: 'Milkshake',       cropCost: 2, energy: 10, icon: '🥛' },
      { cropType: 'truffle',    foodName: 'Truffle Dish',    cropCost: 2, energy: 18, icon: '🍄' },
    ];
    const ownedOf = (cropType) => (inventory.find((r) => r.item_id === cropType) || {}).quantity || 0;
    body.innerHTML = `
      <p class="panel-hint">Cook harvested crops or animal products into food — eating food restores ⚡ Energy, which you need to plow/plant/water.</p>
      <div class="shop-grid">
        ${recipes.map((r) => {
          const owned = ownedOf(r.cropType);
          const maxAffordable = Math.max(1, Math.min(99, Math.floor(owned / r.cropCost)));
          return `
          <div class="shop-card">
            <div class="shop-icon">${r.icon}</div>
            <div class="shop-name">${r.foodName}</div>
            <div class="shop-price">${r.cropCost} ${r.cropType} → ⚡+${r.energy}</div>
            <div class="shop-level">You have: ${owned}</div>
            <div class="qty-row"><input type="number" class="qty-input" min="1" max="99" value="1" data-qty-for="${r.cropType}"><button type="button" class="qty-max-btn" data-max-for="${r.cropType}" data-max-value="${maxAffordable}">MAX</button></div>
            <button data-crop="${r.cropType}" ${owned < r.cropCost ? 'disabled' : ''}>Cook</button>
          </div>`;
        }).join('')}
      </div>
    `;
    body.querySelectorAll('.qty-max-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = body.querySelector(`input[data-qty-for="${btn.dataset.maxFor}"]`);
        if (input) input.value = btn.dataset.maxValue;
      });
    });
    body.querySelectorAll('.shop-card button[data-crop]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="${btn.dataset.crop}"]`);
        const qty = qtyInput ? Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1)) : 1;
        onCook(btn.dataset.crop, qty);
      });
    });
  }

  // Storage Shed — a second item pool separate from the Bag, so things
  // can be tucked away to declutter without being sold or lost. Shows two
  // lists side by side: what's in your Bag (deposit) and what's already
  // in Storage (withdraw) — both use the same item-name lookup as the
  // Marketplace's stall panel.
  function renderStoragePanel(bagItems, storageItems, onDeposit, onWithdraw) {
    const body = panelBody();
    const catalog = window.GameCatalog || { crops: [], items: [] };
    const nameFor = (id) => {
      const crop = (catalog.crops || []).find((c) => c.id === id);
      if (crop) return crop.name;
      if (id.startsWith('seed_')) {
        const cropForSeed = (catalog.crops || []).find((c) => c.id === id.slice(5));
        if (cropForSeed) return `${cropForSeed.name} Seeds`;
      }
      const item = (catalog.items || []).find((i) => i.id === id);
      return item ? item.name : id;
    };
    // Placeable things (buildings/decorations/animals/interior furniture)
    // don't make sense to stash here — those live on the farm itself, not
    // in a stackable item pool. Only "regular" Bag contents apply.
    const isStashable = (id) => !['building_', 'decoration_', 'animal_', 'interior_'].some((p) => id.startsWith(p));

    const bagRows = bagItems.filter((r) => r.quantity > 0 && isStashable(r.item_id));
    const storageRows = storageItems.filter((r) => r.quantity > 0);

    const rowHtml = (id, qty, action, maxQty) => `
      <div class="storage-row">
        <div class="row-title">${nameFor(id)}</div>
        <div class="row-sub">Have: ${qty}</div>
        <div class="qty-row">
          <input type="number" class="qty-input" min="1" max="${maxQty}" value="1" data-qty-for="${action}-${id}">
          <button type="button" class="qty-max-btn" data-max-for="${action}-${id}" data-max-value="${maxQty}">MAX</button>
        </div>
        <button data-${action}="${id}">${action === 'deposit' ? 'Store' : 'Take out'}</button>
      </div>`;

    body.innerHTML = `
      <p class="panel-hint">Stash extra Bag items here to keep your Bag tidy — take them back out anytime.</p>
      <div class="panel-section-title">Your Bag</div>
      ${bagRows.length ? bagRows.map((r) => rowHtml(r.item_id, r.quantity, 'deposit', r.quantity)).join('') : '<div class="empty-state">Nothing to store right now.</div>'}
      <div class="panel-section-title">In Storage</div>
      ${storageRows.length ? storageRows.map((r) => rowHtml(r.item_id, r.quantity, 'withdraw', r.quantity)).join('') : '<div class="empty-state">Storage is empty.</div>'}
    `;

    body.querySelectorAll('.qty-max-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = body.querySelector(`input[data-qty-for="${btn.dataset.maxFor}"]`);
        if (input) input.value = btn.dataset.maxValue;
      });
    });
    body.querySelectorAll('button[data-deposit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="deposit-${btn.dataset.deposit}"]`);
        const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
        onDeposit(btn.dataset.deposit, qty);
      });
    });
    body.querySelectorAll('button[data-withdraw]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="withdraw-${btn.dataset.withdraw}"]`);
        const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
        onWithdraw(btn.dataset.withdraw, qty);
      });
    });
  }

  // Workshop — craft furniture from Wood instead of buying it from the
  // Shop. Same shape as the Silo panel (single-material recipes, MAX
  // button per recipe), just with 5 furniture recipes instead of 4 feeds.
  function renderWorkshopPanel(woodOwned, onCraft) {
    const body = panelBody();
    const recipes = [
      { furnitureType: 'crafted_bench',     name: 'Crafted Bench',     woodCost: 5,  icon: '🪑' },
      { furnitureType: 'crafted_chair',     name: 'Crafted Chair',     woodCost: 5,  icon: '💺' },
      { furnitureType: 'crafted_cabinet',   name: 'Crafted Cabinet',   woodCost: 10, icon: '🗄️' },
      { furnitureType: 'crafted_bookshelf', name: 'Crafted Bookshelf', woodCost: 10, icon: '📚' },
      { furnitureType: 'crafted_bed',       name: 'Crafted Bed',       woodCost: 15, icon: '🛏️' },
    ];
    body.innerHTML = `
      <p class="panel-hint">You have 🪵 ${woodOwned} wood. Craft furniture here instead of buying it — crafted pieces can also be sold at a Marketplace stall, unlike store-bought ones.</p>
      <div class="shop-grid">
        ${recipes.map((r) => {
          const maxAffordable = Math.max(1, Math.min(99, Math.floor(woodOwned / r.woodCost)));
          return `
          <div class="shop-card workshop-card">
            <div class="workshop-badge">🔨 Handmade</div>
            <div class="shop-icon">${r.icon}</div>
            <div class="shop-name">${r.name}</div>
            <div class="shop-price">🪵 ${r.woodCost} wood each</div>
            <div class="qty-row"><input type="number" class="qty-input" min="1" max="99" value="1" data-qty-for="${r.furnitureType}"><button type="button" class="qty-max-btn" data-max-for="${r.furnitureType}" data-max-value="${maxAffordable}">MAX</button></div>
            <button data-furniture="${r.furnitureType}" ${woodOwned < r.woodCost ? 'disabled' : ''}>Craft</button>
          </div>`;
        }).join('')}
      </div>
    `;
    body.querySelectorAll('.qty-max-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = body.querySelector(`input[data-qty-for="${btn.dataset.maxFor}"]`);
        if (input) input.value = btn.dataset.maxValue;
      });
    });
    body.querySelectorAll('.shop-card button[data-furniture]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="${btn.dataset.furniture}"]`);
        const qty = qtyInput ? Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1)) : 1;
        onCraft(btn.dataset.furniture, qty);
      });
    });
  }

  // Casino betting panel — shared shape for all 3 machines (Color Game,
  // Claw Machine, Lucky 777). One "Play" button per bet option (Claw
  // Machine only has one, since its bet is fixed at 800); an odds table
  // underneath lists every prize tier so the player knows the real chances
  // before betting, same "show the math" spirit as Silo/Stove/Workshop
  // showing exact costs before crafting.
  function renderCasinoPanel(machine, me, onBet) {
    const body = panelBody();
    const coins = me.coins || 0;
    const energy = me.energy || 0;
    body.innerHTML = `
      <p class="panel-hint">🪙 ${coins} coins · ⚡ ${energy} energy — each play costs your bet in coins PLUS ${machine.energyCostPerBet} energy, win or lose.</p>
      <div class="shop-grid">
        ${machine.betOptions.map((bet) => {
          const disabled = coins < bet || energy < machine.energyCostPerBet;
          return `
          <div class="shop-card">
            <div class="shop-icon">🎲</div>
            <div class="shop-name">Bet 🪙${bet}</div>
            <div class="shop-price">+${machine.energyCostPerBet} ⚡ energy</div>
            <button data-bet="${bet}" ${disabled ? 'disabled' : ''}>Play</button>
          </div>`;
        }).join('')}
      </div>
      <p class="panel-hint" style="margin-top:12px;font-weight:700;">Possible rewards:</p>
      <p class="panel-hint">
        ${machine.tiers.map((t) => {
          const reward = t.ppFlat != null
            ? `${t.ppFlat} PP 💎`
            : t.energyFlat != null
              ? `${t.energyFlat} ⚡ energy`
              : `${Math.round(t.betMultiplier * 100)}% of bet in ⚡ energy`;
          return `${t.label} → ${reward}`;
        }).join('<br>')}
      </p>
    `;
    body.querySelectorAll('button[data-bet]').forEach((btn) => {
      btn.addEventListener('click', () => onBet(parseInt(btn.dataset.bet, 10)));
    });
  }

  // Color Game — pick a color, pick a bet, hit START, watch 3 blocks
  // drop. onPlay(bet, color) must return a Promise resolving to the bet
  // result (including `reveal`, the 3 colors that dropped) — this
  // function owns the whole pick -> play -> animate -> show-result loop
  // itself, unlike renderCasinoPanel above (used by the other two
  // machines, which just fire one bet per button tap).
  const COLOR_HEX = { red: '#c0392b', yellow: '#e8c547', white: '#f4f4f4', pink: '#e05a7e', blue: '#3d8fe0', green: '#4f8f2e' };
  function renderColorGamePanel(machine, me, onPlay) {
    const body = panelBody();
    let selectedBet = machine.betOptions[0];
    let selectedColor = null;
    let playing = false;

    function render() {
      const coins = me.coins || 0;
      const energy = me.energy || 0;
      body.innerHTML = `
        <p class="panel-hint">🪙 ${coins} coins · ⚡ ${energy} energy — each drop costs your bet in coins PLUS ${machine.energyCostPerBet} energy, win or lose.</p>
        <div class="panel-section-title">1. Pick your bet</div>
        <div class="cg-bet-row">
          ${machine.betOptions.map((bet) => `<button type="button" class="cg-bet-pill ${bet === selectedBet ? 'cg-selected' : ''}" data-bet="${bet}">🪙${bet}</button>`).join('')}
        </div>
        <div class="panel-section-title">2. Pick your color</div>
        <div class="cg-swatch-grid">
          ${machine.colorPalette.map((c) => `<div class="cg-swatch ${c === selectedColor ? 'cg-selected' : ''}" data-color="${c}" style="background:${COLOR_HEX[c] || '#ccc'}" title="${c}"></div>`).join('')}
        </div>
        <div class="cg-drop-row" id="cg-drop-row"></div>
        <div class="cg-result-text" id="cg-result-text"></div>
        <button id="cg-start-btn" style="width:100%" ${(!selectedColor || playing || coins < selectedBet || energy < machine.energyCostPerBet) ? 'disabled' : ''}>${playing ? 'Dropping...' : 'START'}</button>
        <p class="panel-hint" style="margin-top:12px;font-weight:700;">Possible rewards: <span style="font-weight:400;">(🟡 = your chosen color)</span></p>
        <div>
          ${machine.tiers.map((t) => {
            const dots = Array.from({ length: 3 }, (_, i) => `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid #5e3b1f;background:${i < t.matchCount ? '#e8c547' : 'transparent'};"></span>`).join(' ');
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <div style="display:flex;gap:3px;flex-shrink:0;">${dots}</div>
              <span class="panel-hint" style="margin:0;">${t.label} → ${Math.round(t.betMultiplier * 100)}% of bet in ⚡ energy</span>
            </div>`;
          }).join('')}
        </div>
      `;
      body.querySelectorAll('button[data-bet]').forEach((btn) => {
        btn.addEventListener('click', () => { selectedBet = parseInt(btn.dataset.bet, 10); render(); });
      });
      body.querySelectorAll('.cg-swatch').forEach((el) => {
        el.addEventListener('click', () => { selectedColor = el.dataset.color; render(); });
      });
      const startBtn = document.getElementById('cg-start-btn');
      if (startBtn) startBtn.addEventListener('click', startDrop);
    }

    async function startDrop() {
      if (playing || !selectedColor) return;
      playing = true;
      render();
      try {
        const res = await onPlay(selectedBet, selectedColor);
        const dropRow = document.getElementById('cg-drop-row');
        dropRow.innerHTML = res.reveal.map(() => `<div class="cg-block"></div>`).join('');
        const blocks = dropRow.querySelectorAll('.cg-block');
        res.reveal.forEach((c, i) => {
          setTimeout(() => {
            const el = blocks[i];
            if (!el) return;
            el.style.background = COLOR_HEX[c] || '#ccc';
            el.classList.add('cg-dropped');
            if (c === selectedColor) el.classList.add('cg-match');
          }, i * 180);
        });
        setTimeout(() => {
          playing = false;
          render();
          // render() just rebuilt the body (clearing the drop row/result
          // text) — replay the SAME reveal state onto the fresh elements
          // so the finished drop + result stay visible for this round.
          const freshDropRow = document.getElementById('cg-drop-row');
          const freshResultText = document.getElementById('cg-result-text');
          freshDropRow.innerHTML = res.reveal.map((c) => `<div class="cg-block cg-dropped${c === selectedColor ? ' cg-match' : ''}" style="background:${COLOR_HEX[c] || '#ccc'};opacity:1;transform:none"></div>`).join('');
          if (res.win) {
            const rewardText = res.ppReward > 0 ? `+${res.ppReward} PP 💎` : `+${res.energyReward} ⚡ Energy`;
            freshResultText.textContent = `🎉 ${res.tier.label}! ${rewardText}`;
            freshResultText.style.color = '#4f8f2e';
          } else {
            freshResultText.textContent = 'No match this time — try again!';
            freshResultText.style.color = '#c0392b';
          }
        }, res.reveal.length * 180 + 450);
      } catch (err) {
        playing = false;
        render();
        toast(err.message);
      }
    }

    render();
  }

  // Lucky 777 — pick a bet (each amount costs a different amount of
  // Energy — see machine.energyCostByBet), hit START, watch the 3 reels
  // spin and land. Same pick -> play -> animate -> show-result loop shape
  // as renderColorGamePanel above.
  const SYMBOL_DISPLAY = { seven: '7', bar: 'BAR', bell: '🔔', cherry: '🍒', pp_logo: '💎', gm: '🎖️' };
  function renderSlotPanel(machine, me, onPlay) {
    const body = panelBody();
    let selectedBet = machine.betOptions[0];
    let playing = false;

    function render() {
      const coins = me.coins || 0;
      const energy = me.energy || 0;
      const cost = machine.energyCostByBet[selectedBet];
      body.innerHTML = `
        <p class="panel-hint">🪙 ${coins} coins · ⚡ ${energy} energy — bigger bets cost more energy per spin.</p>
        <div class="panel-section-title">Pick your bet</div>
        <div class="cg-bet-row">
          ${machine.betOptions.map((bet) => `<button type="button" class="cg-bet-pill ${bet === selectedBet ? 'cg-selected' : ''}" data-bet="${bet}">🪙${bet} (⚡${machine.energyCostByBet[bet]})</button>`).join('')}
        </div>
        <div class="cg-drop-row" id="slot-reel-row">
          ${[0, 1, 2].map(() => `<div class="cg-block slot-reel">?</div>`).join('')}
        </div>
        <div class="cg-result-text" id="slot-result-text"></div>
        <button id="slot-start-btn" style="width:100%" ${(playing || coins < selectedBet || energy < cost) ? 'disabled' : ''}>${playing ? 'Spinning...' : 'START'}</button>
        <p class="panel-hint" style="margin-top:12px;font-weight:700;">Possible rewards:</p>
        <div>
          ${machine.tiers.map((t) => {
            const reward = t.gmFlat != null ? `${t.gmFlat} GM Point${t.gmFlat === 1 ? '' : 's'} 🎖️` : t.ppFlat != null ? `${t.ppFlat} PP 💎` : `${Math.round(t.betMultiplier * 100)}% of bet in ⚡ energy`;
            const symbols = Array(t.matchCount).fill(SYMBOL_DISPLAY[t.symbol] || t.symbol)
              .map((s) => `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:#fff6e3;border:2px solid #5e3b1f;border-radius:4px;font-weight:800;font-size:13px;${t.symbol === 'seven' ? 'color:#c0392b;' : 'color:#2a1a10;'}">${s}</span>`)
              .join('');
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <div style="display:flex;gap:3px;flex-shrink:0;">${symbols}</div>
              <span class="panel-hint" style="margin:0;">${t.label} → ${reward}</span>
            </div>`;
          }).join('')}
        </div>
      `;
      body.querySelectorAll('button[data-bet]').forEach((btn) => {
        btn.addEventListener('click', () => { selectedBet = parseInt(btn.dataset.bet, 10); render(); });
      });
      const startBtn = document.getElementById('slot-start-btn');
      if (startBtn) startBtn.addEventListener('click', startSpin);
    }

    async function startSpin() {
      if (playing) return;
      playing = true;
      render();
      const reelRow = document.getElementById('slot-reel-row');
      const reels = reelRow.querySelectorAll('.slot-reel');
      // Quick random-cycling "spin" flourish before the real result comes
      // back, so it doesn't feel like a single instant flip even on a
      // fast connection.
      const spinPool = machine.reelSymbols;
      const spinTimer = setInterval(() => {
        reels.forEach((el) => { el.textContent = SYMBOL_DISPLAY[spinPool[Math.floor(Math.random() * spinPool.length)]]; });
      }, 80);
      try {
        const res = await onPlay(selectedBet);
        setTimeout(() => {
          clearInterval(spinTimer);
          res.reveal.forEach((s, i) => {
            setTimeout(() => {
              const el = reels[i];
              if (!el) return;
              el.textContent = SYMBOL_DISPLAY[s] || s;
              el.style.opacity = '1';
              el.style.background = '#fff6e3';
              if (s === 'seven') el.style.color = '#c0392b';
              else el.style.color = '#2a1a10';
              const isMatchSymbol = res.tier && res.tier && s === (machine.tiers.find((t) => t.id === res.tier.id) || {}).symbol;
              if (isMatchSymbol) el.classList.add('cg-match');
            }, i * 250);
          });
          setTimeout(() => {
            playing = false;
            const resultText = res.win
              ? `🎉 ${res.tier.label}! ${res.gmReward > 0 ? `+${res.gmReward} GM Point${res.gmReward === 1 ? '' : 's'} 🎖️` : res.ppReward > 0 ? `+${res.ppReward} PP 💎` : `+${res.energyReward} ⚡ Energy`}`
              : 'No match this time — try again!';
            const resultColor = res.win ? '#4f8f2e' : '#c0392b';
            render();
            const freshReelRow = document.getElementById('slot-reel-row');
            const freshReels = freshReelRow.querySelectorAll('.slot-reel');
            res.reveal.forEach((s, i) => {
              const el = freshReels[i];
              el.textContent = SYMBOL_DISPLAY[s] || s;
              el.style.opacity = '1';
              el.style.color = s === 'seven' ? '#c0392b' : '#2a1a10';
              el.style.background = '#fff6e3';
              const symbolForTier = res.tier && (machine.tiers.find((t) => t.id === res.tier.id) || {}).symbol;
              if (symbolForTier && s === symbolForTier) el.classList.add('cg-match');
            });
            const freshResultText = document.getElementById('slot-result-text');
            freshResultText.textContent = resultText;
            freshResultText.style.color = resultColor;
          }, res.reveal.length * 250 + 400);
        }, 500);
      } catch (err) {
        clearInterval(spinTimer);
        playing = false;
        render();
        toast(err.message);
      }
    }

    render();
  }

  // Claw Machine — one fixed bet (800 coins), no picking involved: just
  // tap Grab! and watch the claw come up with something (or nothing).
  function renderClawPanel(machine, me, onPlay) {
    const body = panelBody();
    let playing = false;
    const bet = machine.betOptions[0];

    function render() {
      const coins = me.coins || 0;
      const energy = me.energy || 0;
      body.innerHTML = `
        <p class="panel-hint">🪙 ${coins} coins · ⚡ ${energy} energy — each grab costs 🪙${bet} + ${machine.energyCostPerBet} ⚡ energy, win or lose.</p>
        <div class="cg-drop-row" style="min-height:70px;">
          <div class="cg-block" id="claw-icon" style="width:64px;height:64px;font-size:32px;display:flex;align-items:center;justify-content:center;background:#fff6e3;">🕳️</div>
        </div>
        <div class="cg-result-text" id="claw-result-text"></div>
        <button id="claw-grab-btn" style="width:100%" ${(playing || coins < bet || energy < machine.energyCostPerBet) ? 'disabled' : ''}>${playing ? 'Grabbing...' : '🕹️ Grab!'}</button>
        <p class="panel-hint" style="margin-top:12px;font-weight:700;">Possible rewards:</p>
        <p class="panel-hint">
          ${machine.tiers.map((t) => {
            const reward = t.ppFlat != null ? `${t.ppFlat} PP 💎` : `${t.energyFlat} ⚡ energy`;
            return `${t.icon} ${t.label} → ${reward}`;
          }).join('<br>')}
        </p>
      `;
      const grabBtn = document.getElementById('claw-grab-btn');
      if (grabBtn) grabBtn.addEventListener('click', startGrab);
    }

    async function startGrab() {
      if (playing) return;
      playing = true;
      render();
      const clawIcon = document.getElementById('claw-icon');
      clawIcon.textContent = '🕹️';
      clawIcon.style.transition = 'transform 0.4s ease';
      clawIcon.style.transform = 'translateY(10px)';
      try {
        const res = await onPlay();
        setTimeout(() => {
          playing = false;
          const resultText = res.win
            ? `🎉 Got it! ${res.ppReward > 0 ? `+${res.ppReward} PP 💎` : `+${res.energyReward} ⚡ Energy`}`
            : 'Missed — the claw came up empty!';
          const resultColor = res.win ? '#4f8f2e' : '#c0392b';
          render();
          const freshIcon = document.getElementById('claw-icon');
          freshIcon.textContent = res.icon || '🫙';
          const freshResultText = document.getElementById('claw-result-text');
          freshResultText.textContent = resultText;
          freshResultText.style.color = resultColor;
        }, 500);
      } catch (err) {
        playing = false;
        render();
        toast(err.message);
      }
    }

    render();
  }

  return { toast, openPanel, closePanel, panelBody, renderShop, renderInventory, renderFriends, renderNotifications, renderPicker, renderStallDetail, renderSiloPanel, renderStovePanel, renderStoragePanel, renderWorkshopPanel, renderCasinoPanel, renderColorGamePanel, renderSlotPanel, renderClawPanel, formatDuration, timeAgo };
})();

window.UI = UI;
