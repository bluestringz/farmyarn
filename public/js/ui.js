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
    farmhouse: 'Your home — given free at signup. Walk in to decorate the inside.',
    barn: 'Tap to go inside — houses Pigs and Sheep. Each barn you build has its own separate room.',
    silo: 'Tap it to turn wheat into animal feed — feed your animals here before you can collect from them.',
    well: 'Classic farm decoration — a water source for the homestead look.',
    market_stall: 'A rentable stall in the shared Marketplace — sell goods to other players.',
    storage_shed: 'Extra storage building for your farm.',
    chicken_coop: 'Tap to go inside — houses Chickens only. Each coop you build has its own separate room.',
    cow_barn: 'Tap to go inside — houses Cows only. Each cow barn you build has its own separate room.',
    workshop: 'Crafting-flavored building — mainly a farm centerpiece for now.',
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
    ];
    const tabs = categories.map((c) =>
      `<button class="shop-tab ${c.key === activeCategory ? 'active' : ''}" data-cat="${c.key}">${c.label}</button>`
    ).join('');

    if (activeCategory === 'outfits') {
      // These items never got real matching artwork (they just fell back to
      // showing the classic look), which made them pointless/misleading —
      // hidden here now that real illustrated costumes exist. Not removed
      // from the database, so anyone who already owns/wears one keeps it.
      const PLACEHOLDER_OUTFITS = new Set(['red_flannel', 'blue_dungarees', 'straw_worker', 'harvest_gold', 'meadow_dress', 'sunflower_dress']);
      const items = (catalog.outfits || [])
        .filter((o) => o.gender === 'unisex' || o.gender === player.gender)
        .filter((o) => !PLACEHOLDER_OUTFITS.has(o.id));
      const cards = items.map((item) => {
        const locked = player.level < item.required_level;
        const owned = item.owned;
        const equipped = item.equipped;
        const affordable = (player.premiumCurrency || 0) >= item.cost;
        const isRental = item.cost > 0; // the free classic_overalls never expires
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
            <div class="shop-price">${isRental ? `💎 ${item.cost} / 7 days` : 'Free'}</div>
            ${expiryLine}
            ${locked ? `<div class="shop-level">Requires Lvl ${item.required_level}</div>` : ''}
            ${ITEM_DESCRIPTIONS[item.id] ? `<div class="shop-desc">${ITEM_DESCRIPTIONS[item.id]}</div>` : ''}
            <button data-item="${item.id}" ${(locked || (!owned && !affordable) || (equipped && owned)) ? 'disabled' : ''}>
              ${equipped && owned ? 'Equipped' : owned ? 'Wear' : locked ? 'Locked' : isRental ? 'Rent (7 days)' : 'Wear'}
            </button>
          </div>`;
      }).join('') || `<div class="empty-state">Nothing here yet.</div>`;

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
    const items = catalog[catalogKey] || [];
    const isCrops = activeCategory === 'crops';
    const cards = items.map((item) => {
      const cost = item.seed_cost ?? item.cost;
      const locked = player.level < item.required_level;
      const affordable = player.coins >= cost;
      const glyphMap = { crops: '🌱', buildings: '🏗️', animals: '🐾', decorations: '🌷', interiors: '🛋️' };
      const durationLine = isCrops ? `<div class="shop-level">⏱ ${formatDuration(item.growth_seconds)} to harvest</div>` : '';
      // Seeds are the one thing people buy in bulk (to plant a whole field
      // at once) — give them a quantity field instead of one-click-at-a-time.
      const qtyRow = isCrops && !locked
        ? `<div class="qty-row"><input type="number" class="qty-input" min="1" max="99" value="1" data-qty-for="${item.id}"></div>`
        : '';
      return `
        <div class="shop-card">
          <div class="shop-icon">${glyphMap[activeCategory]}</div>
          <div class="shop-name">${item.name}</div>
          <div class="shop-price">🪙 ${cost}${isCrops ? ' each' : ''}</div>
          ${durationLine}
          ${locked ? `<div class="shop-level">Requires Lvl ${item.required_level}</div>` : ''}
          ${ITEM_DESCRIPTIONS[item.id] ? `<div class="shop-desc">${ITEM_DESCRIPTIONS[item.id]}</div>` : ''}
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
    body.querySelectorAll('.shop-card button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="${btn.dataset.item}"]`);
        const qty = qtyInput ? Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1)) : 1;
        onBuy(buyCategory, btn.dataset.item, qty);
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
    const FOOD_ITEMS = { bread: 5, rice_bowl: 6, corn_soup: 7, carrot_stew: 8, mashed_potato: 10, tomato_soup: 11, strawberry_cake: 14, pumpkin_pie: 17, fried_egg: 6, milkshake: 10, truffle_dish: 18 };
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
      const item = (catalog.items || []).find((i) => i.id === id);
      return item ? item.name : id;
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
            <div class="row-icon">🏷️</div>
            <div class="row-main">
              <div class="row-title">${nameFor(l.itemId)} × ${l.quantity}</div>
              <div class="row-sub">🪙 ${l.price} each</div>
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
            <div class="row-icon">🏷️</div>
            <div class="row-main">
              <div class="row-title">${nameFor(l.itemId)} × ${l.quantity} available</div>
              <div class="row-sub">🪙 ${l.price} each</div>
            </div>
          </div>
          <div class="mkt-form">
            <input type="number" class="mkt-buy-qty" data-buy-qty-for="${l.id}" min="1" max="${l.quantity}" value="1">
            <button data-buy-listing="${l.id}">Buy</button>
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
      handlers.getInventory().then((inv) => {
        // Seeds ARE sellable here — this is the one place they can be sold
        // at all (the Shop won't buy them back, on purpose, so they hold
        // real value — see server/routes/farm.js's /sell route). Only
        // placeable-category items (buildings/decorations/animals/interior)
        // are excluded, since those go through Build/Decorate, not selling.
        const sellable = inv.filter((r) =>
          !['building_', 'decoration_', 'animal_', 'interior_'].some((p) => r.item_id.startsWith(p)));
        const select = document.getElementById('mkt-list-item');
        select.innerHTML = sellable.map((r) => `<option value="${r.item_id}">${nameFor(r.item_id)} (have ${r.quantity})</option>`).join('')
          || '<option value="">Nothing to sell</option>';
      });
      document.getElementById('mkt-list-submit').addEventListener('click', () => {
        const itemId = document.getElementById('mkt-list-item').value;
        const qty = parseInt(document.getElementById('mkt-list-qty').value, 10);
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
    el.innerHTML = items.map((item) => {
      const cost = item.seed_cost ?? item.cost;
      const locked = player.level < item.required_level;
      const glyph = { crops: '🌱', buildings: '🏗️', animals: '🐾', decorations: '🌷' }[kind] || '❔';
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
      { animalType: 'chicken', feedName: 'Chicken Feed', wheatCost: 2, icon: '🐔' },
      { animalType: 'sheep',   feedName: 'Sheep Feed',   wheatCost: 4, icon: '🐑' },
      { animalType: 'pig',     feedName: 'Pig Feed',     wheatCost: 5, icon: '🐷' },
      { animalType: 'cow',     feedName: 'Cow Feed',     wheatCost: 6, icon: '🐄' },
    ];
    body.innerHTML = `
      <p class="panel-hint">You have 🌾 ${wheatOwned} wheat. Turn it into feed here, then feed your animals before collecting from them.</p>
      <div class="shop-grid">
        ${recipes.map((r) => `
          <div class="shop-card">
            <div class="shop-icon">${r.icon}</div>
            <div class="shop-name">${r.feedName}</div>
            <div class="shop-price">🌾 ${r.wheatCost} wheat each</div>
            <div class="qty-row"><input type="number" class="qty-input" min="1" max="99" value="1" data-qty-for="${r.animalType}"></div>
            <button data-animal="${r.animalType}">Make Feed</button>
          </div>`).join('')}
      </div>
    `;
    body.querySelectorAll('.shop-card button').forEach((btn) => {
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
        ${recipes.map((r) => `
          <div class="shop-card">
            <div class="shop-icon">${r.icon}</div>
            <div class="shop-name">${r.foodName}</div>
            <div class="shop-price">${r.cropCost} ${r.cropType} → ⚡+${r.energy}</div>
            <div class="shop-level">You have: ${ownedOf(r.cropType)}</div>
            <div class="qty-row"><input type="number" class="qty-input" min="1" max="99" value="1" data-qty-for="${r.cropType}"></div>
            <button data-crop="${r.cropType}" ${ownedOf(r.cropType) < r.cropCost ? 'disabled' : ''}>Cook</button>
          </div>`).join('')}
      </div>
    `;
    body.querySelectorAll('.shop-card button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qtyInput = body.querySelector(`input[data-qty-for="${btn.dataset.crop}"]`);
        const qty = qtyInput ? Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1)) : 1;
        onCook(btn.dataset.crop, qty);
      });
    });
  }

  return { toast, openPanel, closePanel, panelBody, renderShop, renderInventory, renderFriends, renderNotifications, renderPicker, renderStallDetail, renderSiloPanel, renderStovePanel, formatDuration, timeAgo };
})();

window.UI = UI;
