// public/js/main.js
// App bootstrap + state machine. Ties Api (network), FarmGame (canvas),
// and UI (panels) together. All game rules are enforced server-side; this
// file just reflects whatever the server returns.

(() => {
  const state = {
    me: null,             // current player (from /api/player/me)
    catalog: null,        // shop catalog (cached)
    viewingUserId: null,  // null = own farm, otherwise the farm being visited
    inHouse: false,        // whether we're currently in the interior view
    inMarket: false,        // whether we're currently in the marketplace plaza
    marketStalls: [],
    tool: null,            // 'plow' | 'plant' | 'water' | 'harvest' | 'build' | 'remove' | 'decorate' | null
    buildSelection: null,  // { category, itemId, def } chosen from a picker, not yet placed
    pendingPlacement: null, // { category, itemId, def, x, y, rotation } — ghost awaiting confirm
    online: new Set(),
    socket: null,
    currentSpace: null, // 'farm:<ownerId>' | 'market' | null (indoor has no shared presence)
  };

  let game;

  const ACTION_ICON = { plow: '🚜', unplow: '↩️', plant: '🌱', water: '💧', harvest: '🧺', build: '🏗️', collect: '🧺', decorate: '🖼️' };

  // Kept in sync with server/lib/interiorSpaces.js's BUILDING_ALLOWED_ANIMALS
  // — used here only for quick client-side UX (which animals to even show
  // in the picker); the server is what actually enforces this.
  const BUILDING_ALLOWED_ANIMALS = { chicken_coop: ['chicken'], cow_barn: ['cow'], barn: ['pig', 'sheep'] };
  function isAnimalPenBuilding() {
    return !!(state.interiorSpace && BUILDING_ALLOWED_ANIMALS[state.interiorSpace.buildingType]);
  }

  // ---------------- Auth screen wiring ----------------

  function initAuthScreen() {
    document.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const isLogin = tab.dataset.tab === 'login';
        document.getElementById('login-form').classList.toggle('hidden', !isLogin);
        document.getElementById('register-form').classList.toggle('hidden', isLogin);
      });
    });

    let selectedGender = 'male';
    document.querySelectorAll('.gender-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedGender = btn.dataset.gender;
      });
    });

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      errEl.textContent = '';
      try {
        const { token } = await Api.login(username, password);
        Api.setToken(token);
        await bootGame();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('register-username').value.trim();
      const password = document.getElementById('register-password').value;
      const errEl = document.getElementById('register-error');
      errEl.textContent = '';
      try {
        const { token } = await Api.register(username, password, selectedGender);
        Api.setToken(token);
        await bootGame();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    document.getElementById('forgot-password-link').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('forgot-password-username').value = document.getElementById('login-username').value;
      document.getElementById('forgot-password-message').value = '';
      document.getElementById('forgot-password-error').textContent = '';
      document.getElementById('forgot-password-modal').classList.remove('hidden');
    });
    document.getElementById('forgot-password-cancel').addEventListener('click', () => {
      document.getElementById('forgot-password-modal').classList.add('hidden');
    });
    document.getElementById('forgot-password-submit').addEventListener('click', async () => {
      const username = document.getElementById('forgot-password-username').value.trim();
      const message = document.getElementById('forgot-password-message').value.trim();
      const errEl = document.getElementById('forgot-password-error');
      if (!username) { errEl.textContent = 'Enter your username.'; return; }
      try {
        const res = await Api.forgotPassword(username, message);
        document.getElementById('forgot-password-modal').classList.add('hidden');
        alert(res.message);
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  }

  // ---------------- Game boot ----------------

  function promptForProfileName() {
    return new Promise((resolve) => {
      const modal = document.getElementById('profile-name-modal');
      const input = document.getElementById('profile-name-input');
      const errEl = document.getElementById('profile-name-error');
      const submitBtn = document.getElementById('profile-name-submit');
      errEl.textContent = '';
      input.value = '';
      modal.classList.remove('hidden');
      input.focus();

      const submit = async () => {
        const name = input.value.trim();
        if (!name) { errEl.textContent = 'Please enter a name.'; return; }
        try {
          const res = await Api.setDisplayName(name);
          state.me.displayName = res.displayName;
          if (res.premiumCurrency !== undefined) state.me.premiumCurrency = res.premiumCurrency;
          renderTopbar();
          modal.classList.add('hidden');
          submitBtn.removeEventListener('click', submit);
          input.removeEventListener('keydown', onKeydown);
          resolve();
        } catch (err) {
          errEl.textContent = err.message;
        }
      };
      const onKeydown = (e) => { if (e.key === 'Enter') submit(); };
      submitBtn.addEventListener('click', submit);
      input.addEventListener('keydown', onKeydown);
    });
  }

  async function bootGame() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('game-screen').classList.remove('hidden');

    game = new FarmGame(document.getElementById('farm-canvas'));
    game.onTileClick = handleTileClick;
    game.onObjectClick = handleObjectClick;
    game.onSelfMove = (x, y) => {
      if (state.socket && state.currentSpace) state.socket.emit('space:move', { space: state.currentSpace, x, y });
    };

    state.catalog = await Api.catalog();
    window.GameCatalog = state.catalog;

    await refreshPlayer();
    if (!state.me.displayName) await promptForProfileName();
    connectSocket(); // must exist before loadOwnFarm() so the first space:join isn't dropped
    await loadOwnFarm();
    initToolbar();
    initTopbarActions();
    initAvatarUpload();
    initPlacementBar();
    initChat();
    checkDailyReward();

    setInterval(refreshPlayer, 20000); // keep energy/coins reasonably fresh
    setInterval(refreshCurrentFarm, 45000); // catch server-side changes (friend watered a crop, etc.)
    setInterval(() => { if (state.inMarket) refreshMarketStalls(); }, 20000); // keep stall listings fresh
  }

  async function refreshPlayer() {
    state.me = await Api.me();
    renderTopbar();
    applyCharacterAppearance();
  }

  function applyCharacterAppearance() {
    if (!game || !state.me) return;
    const outfitDef = (state.catalog.outfits || []).find((o) => o.id === state.me.equippedOutfit);
    game.setAppearance(state.me.gender, outfitDef || null, state.me.dyeColor);
  }

  function renderTopbar() {
    const m = state.me;
    document.getElementById('player-name').textContent = m.displayName || m.username;
    document.getElementById('stat-coins').textContent = m.coins;
    document.getElementById('stat-premium').textContent = m.premiumCurrency || 0;
    document.getElementById('stat-energy').textContent = `${m.energy ?? 0}/${m.maxEnergy ?? 20}${m.isResting ? ' 💤' : ''}`;
    const xp = m.xpProgress;
    document.getElementById('xp-bar-label').textContent = `Lvl ${xp.level}`;
    document.getElementById('avatar-level-badge').textContent = xp.level;
    const pct = xp.xpForNext > 0 ? Math.min(100, Math.round((xp.xpIntoLevel / xp.xpForNext) * 100)) : 100;
    document.getElementById('xp-bar-fill').style.width = pct + '%';

    const img = document.getElementById('avatar-img');
    const emoji = document.getElementById('avatar-emoji');
    if (m.avatar && m.avatar.startsWith('/uploads/')) {
      img.src = m.avatar;
      img.classList.remove('hidden');
      emoji.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      emoji.classList.remove('hidden');
    }
  }

  function initAvatarUpload() {
    const badge = document.getElementById('avatar-badge');
    const input = document.getElementById('avatar-file-input');
    badge.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = ''; // allow re-selecting the same file later
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) { UI.toast('Image is too big — please pick one under 3MB.'); return; }
      try {
        const res = await Api.uploadAvatar(file);
        state.me.avatar = res.avatar;
        renderTopbar();
        UI.toast('Profile picture updated!');
      } catch (err) {
        UI.toast(err.message);
      }
    });
  }

  // ---------------- Shared presence ("spaces") ----------------
  // A space is either `farm:<ownerId>` (own farm or a friend's, both use the
  // owner's id so the owner always sees visitors) or `market`. Interior
  // (house) has no shared presence.

  function joinSpace(spaceId) {
    if (state.currentSpace === spaceId) return;
    if (state.currentSpace && state.socket) state.socket.emit('space:leave', { space: state.currentSpace });
    if (game) game.clearRemotePlayers();
    state.currentSpace = spaceId;
    if (spaceId && state.socket) {
      const tile = game.getCharacterTile();
      state.socket.emit('space:join', { space: spaceId, x: tile.x, y: tile.y, appearance: game.getAppearanceSnapshot() });
    }
  }

  function leaveCurrentSpace() {
    joinSpace(null);
  }

  // Sets the local character's sit/lie pose AND tells everyone else
  // sharing the current space (a visitor in the same house, someone else
  // in the Park) so they actually see it happen too — see setRemotePlayerRestPose
  // in game.js and the 'presence:rest' socket handler above. Every caller
  // that used to call game.setRestPose(...) directly should call this
  // instead so the broadcast never gets missed.
  function setLocalRestPose(pose, tileX, tileY) {
    game.setRestPose(pose, tileX, tileY);
    if (state.socket && state.currentSpace) {
      state.socket.emit('space:rest', { space: state.currentSpace, restPose: pose, x: tileX, y: tileY });
    }
  }

  async function loadOwnFarm() {
    state.viewingUserId = null;
    state.inHouse = false;
    document.getElementById('visiting-banner').classList.add('hidden');
    document.getElementById('house-banner').classList.add('hidden');
    const farm = await Api.myFarm();
    game.setFarm(farm);
    joinSpace(`farm:${farm.ownerId}`);
  }

  async function loadFarm(userId) {
    const farm = await Api.viewFarm(userId);
    game.setFarm(farm);
    joinSpace(`farm:${farm.ownerId}`);
    if (farm.isOwner) {
      state.viewingUserId = null;
      state.viewingUsername = null;
      document.getElementById('visiting-banner').classList.add('hidden');
    } else {
      state.viewingUserId = userId;
      state.viewingUsername = farm.ownerUsername;
      document.getElementById('visiting-text').textContent = `Visiting ${farm.ownerUsername}'s farm (Lvl ${farm.ownerLevel})`;
      document.getElementById('visiting-banner').classList.remove('hidden');
      setTool(null);
    }
  }

  async function refreshCurrentFarm() {
    if (state.inHouse || state.inMarket || state.inPark) return; // interior/market/park don't need the outdoor refresh
    if (state.viewingUserId) await loadFarm(state.viewingUserId);
    else await loadOwnFarm();
  }

  // ---------------- House interior ----------------

  // 'house' | 'coop' | 'barn' | null — which enterable building the player
  // is currently inside, if any. state.inHouse stays true for ALL of these
  // (kept as-is since a lot of existing "restrict farm tools while inside"
  // checks already key off it) — this just tracks which specific one, for
  // API calls and exit routing.
  // Which enterable building the player is currently inside, if any:
  // { buildingType: 'house'|'chicken_coop'|'cow_barn'|'barn', buildingId }
  // (buildingId is null for the house, since it's a singleton). state.inHouse
  // stays true for ALL of these (a lot of existing "restrict farm tools
  // while inside" checks already key off it) — this tracks the specifics.
  async function enterInterior(opts, bannerId) {
    // Anyone can walk into a house/coop/barn/cow_barn now, owner or
    // visitor alike — same as being able to see the outdoor farm already.
    // Read-only for visitors: state.viewingUserId stays set the whole
    // time they're inside, and every build/decorate/move/remove/feed
    // handler already gates on `!state.viewingUserId`, so nothing extra
    // is needed here to keep it look-but-don't-touch.
    const fetchOpts = state.viewingUserId ? { ...opts, ownerId: state.viewingUserId } : opts;
    const interior = await Api.myInterior(fetchOpts);
    game.setInteriorMode(interior);
    state.inHouse = true;
    state.interiorSpace = { buildingType: interior.buildingType, buildingId: interior.buildingId || null, location: interior.location };
    // Shared presence for interiors too — a visitor and the owner (or two
    // visitors) standing in the SAME specific room now actually see each
    // other move around, the same way farm/market/park already work.
    // interior.location is already unique per specific building (see
    // server/lib/interiorSpaces.js), so keying on
    // "interior:<ownerId>:<location>" naturally puts everyone looking at
    // that exact room together without colliding with a different one.
    const ownerId = state.viewingUserId || state.me.id;
    joinSpace(`interior:${ownerId}:${interior.location}`);
    clearPendingPlacement();
    setTool(null);
    const label = { chicken_coop: 'chicken coop', cow_barn: 'cow barn', barn: 'barn', farmhouse: 'house' };
    const placeName = label[interior.buildingType] || 'building';
    const bannerText = state.viewingUserId
      ? `Visiting ${state.viewingUsername || 'a friend'}'s ${placeName} (look only)`
      : `Inside your ${placeName}`;
    if (bannerId === 'coop-banner') {
      document.getElementById('pen-banner-text').textContent = bannerText;
    } else {
      document.querySelector(`#${bannerId} span`).textContent = bannerText;
    }
    document.getElementById(bannerId).classList.remove('hidden');
    document.getElementById('visiting-banner').classList.add('hidden');
  }

  async function enterHouse() { await enterInterior({ space: 'house' }, 'house-banner'); }
  async function enterBuilding(obj) {
    // Chicken coop, cow barn, and (plain) barn all use the same generic
    // per-building-instance room now — each specific building placed gets
    // its own separate interior (see server/lib/interiorSpaces.js).
    await enterInterior({ buildingId: obj.id }, 'coop-banner');
  }

  async function openSiloPanel() {
    const inv = await Api.inventory();
    const wheatRow = inv.find((row) => row.item_id === 'wheat');
    UI.openPanel('Silo — Make Feed');
    UI.renderSiloPanel(wheatRow ? wheatRow.quantity : 0, async (animalType, qty) => {
      try {
        const res = await Api.craftFeed(animalType, qty);
        UI.toast(res.failed > 0
          ? `Made ${res.quantity} ${res.feedItemId.replace('_', ' ')} — ${res.failed} batch(es) came out ruined! (used ${res.wheatSpent} wheat)`
          : `Made ${res.quantity} ${res.feedItemId.replace('_', ' ')} (used ${res.wheatSpent} wheat)`);
        await openSiloPanel(); // refresh wheat count shown
      } catch (err) {
        UI.toast(err.message);
      }
    });
  }

  async function openWorkshopPanel() {
    const inv = await Api.inventory();
    const woodRow = inv.find((row) => row.item_id === 'log');
    UI.openPanel('Workshop — Craft Furniture');
    UI.renderWorkshopPanel(woodRow ? woodRow.quantity : 0, async (furnitureType, qty) => {
      try {
        const res = await Api.craftFurniture(furnitureType, qty);
        UI.toast(`Crafted ${res.quantity}x! (used ${res.woodSpent} wood) Check your Bag.`);
        await openWorkshopPanel(); // refresh wood count shown
      } catch (err) {
        UI.toast(err.message);
      }
    });
  }

  async function openStovePanel() {
    const inv = await Api.inventory();
    UI.openPanel('Stove — Cook Food');
    UI.renderStovePanel(inv, async (cropType, qty) => {
      try {
        const res = await Api.cook(cropType, qty);
        UI.toast(res.failed > 0
          ? `Cooked ${res.quantity} ${res.foodItemId.replace(/_/g, ' ')} — ${res.failed} came out burnt! (used ${res.cropSpent} ${cropType})`
          : `Cooked ${res.quantity} ${res.foodItemId.replace(/_/g, ' ')} (used ${res.cropSpent} ${cropType})`);
        await openStovePanel(); // refresh crop counts shown
      } catch (err) {
        UI.toast(err.message);
      }
    });
  }

  async function openStoragePanel() {
    const [bagItems, storageItems] = await Promise.all([Api.inventory(), Api.storage()]);
    UI.openPanel('Storage Shed');
    UI.renderStoragePanel(bagItems, storageItems,
      async (itemId, qty) => {
        try {
          await Api.storageDeposit(itemId, qty);
          UI.toast(`Stored ${qty}x`);
          await openStoragePanel();
        } catch (err) { UI.toast(err.message); }
      },
      async (itemId, qty) => {
        try {
          await Api.storageWithdraw(itemId, qty);
          UI.toast(`Took out ${qty}x — check your Bag`);
          await openStoragePanel();
        } catch (err) { UI.toast(err.message); }
      });
  }

  async function exitHouse() {
    // Leaving means you're not on the furniture anymore either — stop the
    // faster regen rate rather than leave it silently running forever.
    if (state.me.isResting) {
      try {
        const res = await Api.stopResting();
        state.me.isResting = res.resting;
        state.me.energy = res.energy;
        renderTopbar();
      } catch (err) { /* non-critical — don't block leaving over this */ }
    }
    setLocalRestPose(null);
    game.exitInteriorMode();
    state.inHouse = false;
    state.interiorSpace = null;
    clearPendingPlacement();
    setTool(null);
    document.getElementById('house-banner').classList.add('hidden');
    document.getElementById('coop-banner').classList.add('hidden');
    // Rejoin whichever outdoor space we actually came from — a visitor
    // exiting a friend's house/coop/barn belongs back on the FRIEND's
    // farm, not their own (state.viewingUserId stays set the whole time
    // they're inside for exactly this reason).
    if (state.viewingUserId) await loadFarm(state.viewingUserId);
    else await loadOwnFarm();
  }

  async function refreshInterior() {
    if (!state.interiorSpace) return;
    const opts = state.interiorSpace.buildingId ? { buildingId: state.interiorSpace.buildingId } : { space: 'house' };
    if (state.viewingUserId) opts.ownerId = state.viewingUserId;
    const interior = await Api.myInterior(opts);
    game.setInteriorMode(interior);
  }

  // ---------------- Toolbar / tools ----------------

  function initToolbar() {
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => onToolButton(btn.dataset.tool));
    });
  }

  function onToolButton(tool) {
    if (tool === 'shop') { openShop(); return; }
    if (tool === 'inventory') { openInventory(); return; }
    if (tool === 'expand') { doExpand(); return; }
    if (tool === 'marketplace') { enterMarket(); return; }
    if (tool === 'park') { enterPark(); return; }
    if (tool === 'event-place') { enterEventPlace(); return; }

    if (state.inHouse) {
      if (tool === 'decorate') { setTool(state.tool === 'decorate' ? null : 'decorate'); return; }
      if (tool === 'remove') { setTool(state.tool === 'remove' ? null : 'remove'); return; }
      if (tool === 'move') { setTool(state.tool === 'move' ? null : 'move'); return; }
      if (tool === 'feed' && isAnimalPenBuilding()) {
        setTool(state.tool === 'feed' ? null : 'feed');
        return;
      }
      if (tool === 'place-animal' && isAnimalPenBuilding()) {
        setTool(state.tool === 'place-animal' ? null : 'place-animal');
        return;
      }
      UI.toast('That tool is for the farm outside');
      return;
    }

    if (tool === 'build') { setTool(state.tool === 'build' ? null : 'build'); return; }
    if (tool === 'place-animal') { setTool(state.tool === 'place-animal' ? null : 'place-animal'); return; }
    if (tool === 'remove') {
      if (state.viewingUserId) { UI.toast("You can't remove things on a friend's farm"); return; }
      setTool(state.tool === 'remove' ? null : 'remove');
      return;
    }

    if (state.viewingUserId && tool !== 'water') {
      UI.toast("You can only help water on a friend's farm");
      return;
    }
    setTool(state.tool === tool ? null : tool);
  }

  function setTool(tool) {
    state.tool = tool;
    state.buildSelection = null;
    clearPendingPlacement();
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    // Swap the canvas cursor to match, so the pointer itself shows what
    // you're about to do to a tile — same tiny icon set as ACTION_ICON.
    const canvas = document.getElementById('farm-canvas');
    canvas.classList.remove('tool-plow', 'tool-plant', 'tool-water', 'tool-harvest', 'tool-build', 'tool-feed');
    const CURSOR_TOOLS = new Set(['plow', 'plant', 'water', 'harvest', 'build', 'feed']);
    if (tool && CURSOR_TOOLS.has(tool)) canvas.classList.add(`tool-${tool}`);
    // Watering supports hold-and-drag across a whole plot instead of one
    // tap per tile — every other tool keeps the normal single-tap
    // behavior (a drag still just pans the map for those).
    game.setDragActEnabled(tool === 'water');
    game.setActiveTool(tool);
    document.getElementById('seed-picker').classList.add('hidden');
    document.getElementById('build-picker').classList.add('hidden');

    if (tool === 'plant') {
      openSeedPicker();
    } else if (tool === 'build') {
      openBuildPicker();
    } else if (tool === 'place-animal') {
      openAnimalPicker();
    } else if (tool === 'decorate') {
      openDecoratePicker();
    }
  }

  async function openSeedPicker() {
    const picker = document.getElementById('seed-picker');
    const inv = await Api.inventory();
    const owned = {};
    inv.forEach((row) => {
      if (row.item_id.startsWith('seed_')) owned[row.item_id.slice(5)] = row.quantity;
    });
    const seedsOwned = state.catalog.crops
      .filter((c) => (owned[c.id] || 0) > 0)
      .map((c) => ({ ...c, _owned: owned[c.id] }));

    if (!seedsOwned.length) {
      picker.classList.add('hidden');
      UI.toast("You don't have any seeds yet — buy some from the Shop first!");
      return;
    }
    UI.renderPicker(picker, seedsOwned, 'crops', state.me, (id) => {
      state.buildSelection = { category: 'crop', itemId: id };
      UI.toast(`Selected ${id}. Tap a plowed tile to plant.`);
    });
  }

  async function openBuildPicker() {
    const picker = document.getElementById('build-picker');
    const inv = await Api.inventory();
    const owned = [];
    inv.forEach((row) => {
      for (const cat of ['building', 'decoration']) {
        if (row.item_id.startsWith(`${cat}_`) && row.quantity > 0) {
          const itemId = row.item_id.slice(cat.length + 1);
          const def = findDef(cat, itemId);
          if (def) owned.push({ ...def, _cat: cat, _owned: row.quantity });
        }
      }
    });
    if (!owned.length) {
      picker.classList.add('hidden');
      UI.toast("You haven't bought any buildings or decorations to place yet — visit the Shop first!");
      return;
    }
    UI.renderPicker(picker, owned, 'buildings', state.me, (id) => {
      const found = owned.find((x) => x.id === id);
      state.buildSelection = { category: found._cat, itemId: id, def: found };
      UI.toast(`Selected ${found.name}. Tap a spot on your farm to preview it.`);
    });
  }

  // Animals get their own picker/tool, separate from Build — placing a
  // chicken shouldn't feel lumped in with placing a fence or a silo.
  // Animals can go in the coop/barn/cow_barn interiors OR straight
  // outdoors on the open farm (the placement endpoint enforces which
  // buildings accept which animal types either way).
  async function openAnimalPicker() {
    const picker = document.getElementById('build-picker');
    const inv = await Api.inventory();
    const owned = [];
    // Inside a coop/barn/cow_barn, only that specific building's allowed
    // animal types are offered — the server enforces this regardless, but
    // this keeps the picker from even showing a cow as an option inside a
    // chicken coop. Outdoors (or a plain house — though this tool isn't
    // reachable there), every owned animal is fair game.
    const allowedInside = state.inHouse && isAnimalPenBuilding()
      ? (BUILDING_ALLOWED_ANIMALS[state.interiorSpace.buildingType] || []) : null;
    inv.forEach((row) => {
      if (row.item_id.startsWith('animal_') && row.quantity > 0) {
        const itemId = row.item_id.slice('animal_'.length);
        if (allowedInside && !allowedInside.includes(itemId)) return;
        const def = findDef('animal', itemId);
        if (def) owned.push({ ...def, _cat: 'animal', _owned: row.quantity });
      }
    });
    if (!owned.length) {
      picker.classList.add('hidden');
      const hint = allowedInside
        ? `You don't own any (${allowedInside.join('/')}) animals yet — buy some from the Shop's Animals tab!`
        : "You haven't bought any animals yet — visit the Shop's Animals tab first!";
      UI.toast(hint);
      return;
    }
    UI.renderPicker(picker, owned, 'animals', state.me, (id) => {
      const found = owned.find((x) => x.id === id);
      state.buildSelection = { category: found._cat, itemId: id, def: found };
      UI.toast(`Selected ${found.name}. Tap a spot to place it.`);
    });
  }

  async function openDecoratePicker() {
    const picker = document.getElementById('build-picker');
    const inv = await Api.inventory();
    const owned = [];
    inv.forEach((row) => {
      if (row.item_id.startsWith('interior_') && row.quantity > 0) {
        const itemId = row.item_id.slice('interior_'.length);
        const def = findDef('interior', itemId);
        if (def) owned.push({ ...def, _cat: 'interior', _owned: row.quantity });
      }
    });
    if (!owned.length) {
      picker.classList.add('hidden');
      UI.toast("You don't own any furniture yet — buy some from the Shop's Interior tab!");
      return;
    }
    UI.renderPicker(picker, owned, 'buildings', state.me, (id) => {
      const found = owned.find((x) => x.id === id);
      state.buildSelection = { category: found._cat, itemId: id, def: found };
      UI.toast(`Selected ${found.name}. Tap a spot to preview it.`);
    });
  }

  function findDef(category, itemId) {
    const list = category === 'building' ? state.catalog.buildings
      : category === 'decoration' ? state.catalog.decorations
      : category === 'animal' ? state.catalog.animals
      : state.catalog.interiors;
    return (list || []).find((d) => d.id === itemId);
  }

  // ---------------- Build/Decorate ghost placement ----------------

  function initPlacementBar() {
    document.getElementById('placement-rotate').addEventListener('click', () => {
      if (!state.pendingPlacement) return;
      if (state.pendingPlacement.itemId === 'fence') {
        UI.toast('Fences auto-connect to neighboring fence tiles — no need to rotate them!');
        return;
      }
      state.pendingPlacement.rotation = (state.pendingPlacement.rotation + 90) % 360;
      game.rotateGhost();
    });
    document.getElementById('placement-confirm').addEventListener('click', confirmPlacement);
    document.getElementById('placement-cancel').addEventListener('click', clearPendingPlacement);

    window.addEventListener('keydown', (e) => {
      if (!state.pendingPlacement) return;
      if (e.key === 'r' || e.key === 'R' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (state.pendingPlacement.itemId === 'fence') return;
        state.pendingPlacement.rotation = (state.pendingPlacement.rotation + 90) % 360;
        game.rotateGhost();
      } else if (e.key === 'Enter') {
        confirmPlacement();
      } else if (e.key === 'Escape') {
        clearPendingPlacement();
      }
    });
  }

  function showPendingPlacement(x, y) {
    const sel = state.buildSelection;
    state.pendingPlacement = { category: sel.category, itemId: sel.itemId, def: sel.def, x, y, rotation: 0 };
    game.setGhost({ ...state.pendingPlacement });
    document.getElementById('placement-bar').classList.remove('hidden');
  }

  function clearPendingPlacement() {
    state.pendingPlacement = null;
    if (game) game.clearGhost();
    document.getElementById('placement-bar').classList.add('hidden');
  }

  // Maps the current interior space to the `location` value the backend's
  // farm_objects rows actually use — kept in one place so confirmPlacement
  // (and anything else needing it) can't drift out of sync. Each specific
  // coop/barn/cow_barn building has its own room now (indoor:<buildingId>);
  // only the house is still the plain fixed 'indoor' value.
  function locationForCurrentSpace() {
    if (!state.inHouse) return 'outdoor';
    if (state.interiorSpace && state.interiorSpace.buildingId) return `indoor:${state.interiorSpace.buildingId}`;
    return 'indoor'; // house (also the safe default for older sessions)
  }

  async function confirmPlacement() {
    const p = state.pendingPlacement;
    if (!p) return;
    try {
      if (p.movingObjectId) {
        game.walkTo(p.x, p.y, null);
        await Api.moveObject(p.movingObjectId, p.x, p.y, p.rotation);
        UI.toast('Moved!');
        game.playAction(ACTION_ICON.build);
        clearPendingPlacement();
        if (state.inHouse) await refreshInterior();
        else await refreshCurrentFarm();
        return;
      }
      const location = locationForCurrentSpace();
      game.walkTo(p.x, p.y, null);
      await Api.placeObject(p.category, p.itemId, p.x, p.y, p.rotation, location);
      UI.toast('Placed!');
      game.playAction(ACTION_ICON.build);
      clearPendingPlacement();
      if (state.inHouse) { await refreshInterior(); await openDecoratePicker(); }
      else {
        await refreshCurrentFarm();
        if (state.tool === 'place-animal') await openAnimalPicker();
        else await openBuildPicker();
      }
    } catch (err) {
      UI.toast(err.message);
      clearPendingPlacement();
    }
  }

  // ---------------- Tile / object interaction ----------------

  async function handleTileClick(x, y) {
    // Tapping anywhere to walk means getting up off the furniture —
    // fire-and-forget the server call so the faster resting regen rate
    // doesn't stay active after the character has visually stood up.
    if (state.me && state.me.isResting) {
      state.me.isResting = false;
      Api.stopResting().then((res) => { state.me.energy = res.energy; renderTopbar(); }).catch(() => {});
      renderTopbar();
    }
    if (state.tool === 'move' && state.pendingPlacement && state.pendingPlacement.movingObjectId) {
      // Already holding something picked up with the Move tool — subsequent
      // taps just slide the ghost to the new spot; Confirm in the
      // placement bar is what actually commits it via Api.moveObject.
      state.pendingPlacement.x = x;
      state.pendingPlacement.y = y;
      game.setGhost({ ...state.pendingPlacement });
      return;
    }
    if (!state.tool) {
      // No tool selected — just wander the farm, same free-walk feel as the
      // Marketplace plaza, instead of doing nothing.
      game.walkTo(x, y, null);
      return;
    }
    try {
      if (state.tool === 'plow') {
        if (state.viewingUserId || state.inHouse) return;
        game.walkTo(x, y, null);
        const res = await Api.plow(x, y);
        if (res.energy !== undefined) state.me.energy = res.energy;
        renderTopbar();
        const wasPlowed = res.tile.state === 'plowed';
        UI.toast(wasPlowed ? 'Plowed!' : 'Un-plowed');
        game.playAction(wasPlowed ? ACTION_ICON.plow : ACTION_ICON.unplow);
        await refreshCurrentFarm();
      } else if (state.tool === 'plant') {
        if (state.viewingUserId || state.inHouse) return;
        if (!state.buildSelection || state.buildSelection.category !== 'crop') { UI.toast('Pick a seed first'); return; }
        game.walkTo(x, y, null);
        const res = await Api.plant(x, y, state.buildSelection.itemId);
        if (res.energy !== undefined) state.me.energy = res.energy;
        renderTopbar();
        UI.toast(`Planted ${state.buildSelection.itemId}!`);
        game.playAction(ACTION_ICON.plant);
        await refreshCurrentFarm();
        await openSeedPicker(); // refresh remaining seed count
      } else if (state.tool === 'water') {
        if (state.inHouse) return;
        game.walkTo(x, y, null);
        const ownerId = state.viewingUserId || undefined;
        const res = await Api.water(x, y, ownerId);
        if (res.coins !== undefined) state.me.coins = res.coins;
        if (res.energy !== undefined) state.me.energy = res.energy;
        UI.toast(ownerId ? 'Helped water! 💧 (cost gold — see your balance)' : 'Watered! 💧');
        game.playAction(ACTION_ICON.water);
        game.playWaterEffect(x, y);
        renderTopbar();
        await refreshCurrentFarm();
      } else if (state.tool === 'harvest') {
        if (state.viewingUserId || state.inHouse) return;
        game.walkTo(x, y, null);
        const res = await Api.harvest(x, y);
        if (res.cleared) {
          // Dead/withered crop — cleared with no yield, no XP/energy spent.
          UI.toast(res.message);
        } else {
          await refreshPlayer();
          const qtyLabel = res.harvestQuantity > 1 ? `${res.harvestQuantity}x ${res.harvested}` : res.harvested;
          UI.toast(res.seedReturned
            ? `Harvested ${qtyLabel}! +${res.reward.xp} XP — got a free seed back! 🌱`
            : `Harvested ${qtyLabel}! +${res.reward.xp} XP`);
        }
        game.playAction(ACTION_ICON.harvest);
        await refreshCurrentFarm();
      } else if ((state.tool === 'build' || state.tool === 'decorate' || state.tool === 'place-animal') && state.buildSelection) {
        if (state.viewingUserId) return;
        showPendingPlacement(x, y);
      }
    } catch (err) {
      UI.toast(err.message);
    }
  }

  async function handleObjectClick(obj) {
    if (state.tool === 'remove') {
      const label = obj.item_id.replace(/_/g, ' ');
      if (!confirm(`Remove this ${label}?`)) return;
      try {
        await Api.deleteObject(obj.id);
        UI.toast('Removed!');
        if (state.inHouse) await refreshInterior();
        else await refreshCurrentFarm();
      } catch (err) {
        UI.toast(err.message);
      }
      return;
    }

    if (state.tool === 'move') {
      if (obj.object_type === 'building') {
        UI.toast("Buildings can't be moved — remove and re-place them instead.");
        return;
      }
      if (obj.item_id === 'tree') {
        UI.toast("A planted tree can't be moved — chop it down and plant a new one instead.");
        return;
      }
      const def = findDef(obj.object_type, obj.item_id);
      state.pendingPlacement = {
        category: obj.object_type, itemId: obj.item_id, def,
        x: obj.grid_x, y: obj.grid_y, rotation: obj.rotation || 0,
        movingObjectId: obj.id,
      };
      game.setGhost({ ...state.pendingPlacement });
      document.getElementById('placement-bar').classList.remove('hidden');
      UI.toast('Tap where you want to move it, then Confirm.');
      return;
    }

    // Sit on a chair/bench or lie on a bed to regenerate energy faster — a
    // plain tap (no tool active) on any of them toggles it. Chair/bed are
    // house furniture (only usable indoors); the bench is an outdoor
    // decoration, usable out on the farm instead.
    const REST_INTERIOR = new Set(['bed', 'chair', 'crafted_bed', 'crafted_chair']);
    const REST_OUTDOOR = new Set(['bench', 'crafted_bench']);
    const isRestFurniture = (state.inHouse && obj.object_type === 'interior' && REST_INTERIOR.has(obj.item_id))
      || (!state.inHouse && obj.object_type === 'decoration' && REST_OUTDOOR.has(obj.item_id));
    // Sitting/lying down is a personal action (your own energy regen) that
    // doesn't change anything about a friend's farm, so there's no reason
    // to restrict it to your own furniture only — you can rest on theirs
    // too while visiting, same as you can already walk around and help
    // water their crops.
    if (isRestFurniture && !state.tool) {
      try {
        if (state.me.isResting) {
          const res = await Api.stopResting();
          state.me.isResting = res.resting;
          state.me.energy = res.energy;
          setLocalRestPose(null);
          UI.toast('You got up.');
        } else {
          const pose = obj.item_id === 'bed' ? 'lie' : 'sit';
          // Snap to the CENTER of the furniture's footprint, not its
          // top-left corner — a bed is 2 tiles wide, so anchoring at
          // grid_x directly put the character's rotated body hanging half
          // a tile off one edge instead of centered on the bed. This is in
          // TILE units already (not world pixels) — see setRestPose.
          const def = findDef(obj.object_type, obj.item_id);
          const centerX = obj.grid_x + ((def && def.width) || 1) / 2;
          const centerY = obj.grid_y + ((def && def.height) || 1) / 2;
          setLocalRestPose(pose, centerX, centerY);
          const res = await Api.startResting();
          state.me.isResting = res.resting;
          state.me.energy = res.energy;
          UI.toast(obj.item_id === 'bed' ? 'Lying down — energy regenerates faster. Tap again to get up.' : 'Sitting down — energy regenerates faster. Tap again to get up.');
        }
        renderTopbar();
      } catch (err) {
        setLocalRestPose(null);
        UI.toast(err.message);
      }
      return;
    }

    if (!state.inHouse && obj.item_id === 'farmhouse' && obj.object_type === 'building'
        && state.tool !== 'build' && state.tool !== 'plow' && state.tool !== 'plant' && state.tool !== 'harvest'
        && state.tool !== 'move' && state.tool !== 'remove') {
      await enterHouse();
      return;
    }

    const ENTERABLE_PEN_BUILDINGS = new Set(['chicken_coop', 'cow_barn', 'barn', 'mansion']);
    if (!state.inHouse && ENTERABLE_PEN_BUILDINGS.has(obj.item_id) && obj.object_type === 'building'
        && state.tool !== 'build' && state.tool !== 'plow' && state.tool !== 'plant' && state.tool !== 'harvest'
        && state.tool !== 'move' && state.tool !== 'remove') {
      await enterBuilding(obj);
      return;
    }

    if (obj.item_id === 'silo' && obj.object_type === 'building' && !state.viewingUserId
        && state.tool !== 'build' && state.tool !== 'move' && state.tool !== 'remove') {
      game.walkTo(obj.grid_x, obj.grid_y, null);
      await openSiloPanel();
      return;
    }

    if (obj.item_id === 'workshop' && obj.object_type === 'building' && !state.viewingUserId
        && state.tool !== 'build' && state.tool !== 'move' && state.tool !== 'remove') {
      game.walkTo(obj.grid_x, obj.grid_y, null);
      await openWorkshopPanel();
      return;
    }

    if (obj.item_id === 'storage_shed' && obj.object_type === 'building' && !state.viewingUserId
        && state.tool !== 'build' && state.tool !== 'move' && state.tool !== 'remove') {
      game.walkTo(obj.grid_x, obj.grid_y, null);
      await openStoragePanel();
      return;
    }

    if (obj.item_id === 'stove' && obj.object_type === 'interior'
        && state.tool !== 'decorate' && state.tool !== 'move' && state.tool !== 'remove') {
      game.walkTo(obj.grid_x, obj.grid_y, null);
      await openStovePanel();
      return;
    }

    if (state.tool === 'water' && obj.object_type === 'decoration' && obj.item_id === 'tree' && !state.viewingUserId) {
      try {
        game.walkTo(obj.grid_x, obj.grid_y, null);
        const res = await Api.waterDecoration(obj.id);
        state.me.coins = res.coins;
        renderTopbar();
        UI.toast('Watered the sapling! 💧');
        game.playAction(ACTION_ICON.water);
        game.playWaterEffect(obj.grid_x, obj.grid_y);
        await refreshCurrentFarm();
      } catch (err) {
        UI.toast(err.message);
      }
      return;
    }

    if (state.tool === 'harvest' && obj.object_type === 'decoration' && obj.item_id === 'tree' && !state.viewingUserId) {
      try {
        game.walkTo(obj.grid_x, obj.grid_y, null);
        const res = await Api.harvestTree(obj.id);
        await refreshPlayer();
        UI.toast(`Chopped the tree — got ${res.logs} logs! 🪵 +${res.reward.xp} XP`);
        game.playAction('🪵');
        await refreshCurrentFarm();
      } catch (err) {
        UI.toast(err.message);
      }
      return;
    }

    if (state.tool === 'feed' && obj.object_type === 'animal' && !state.viewingUserId) {
      try {
        game.walkTo(obj.grid_x, obj.grid_y, null);
        await Api.feedAnimal(obj.id);
        UI.toast('Fed! 🌾');
        game.playAction('🌾');
        await refreshCurrentFarm();
      } catch (err) {
        UI.toast(err.message);
      }
      return;
    }

    if (obj.object_type === 'animal' && !state.viewingUserId) {
      try {
        game.walkTo(obj.grid_x, obj.grid_y, null);
        let res;
        try {
          res = await Api.collectAnimal(obj.id);
        } catch (err) {
          // "Feed this animal first" — try auto-feeding from the Bag (if
          // there's matching feed) and retry once, so the common case of
          // "I already made feed" doesn't need a separate tap-through step.
          if (err.message.includes('Feed this animal')) {
            await Api.feedAnimal(obj.id);
            UI.toast('Fed the animal — collecting...');
            res = await Api.collectAnimal(obj.id);
          } else {
            throw err;
          }
        }
        await refreshPlayer();
        UI.toast(`Collected ${res.productQuantity > 1 ? `${res.productQuantity}x ${res.product}` : res.product}!`);
        game.playAction(ACTION_ICON.collect);
        await refreshCurrentFarm();
      } catch (err) {
        UI.toast(err.message);
      }
      return;
    }
    if (state.tool === 'plow' || state.tool === 'plant' || state.tool === 'harvest') {
      UI.toast('There is something built here.');
      return;
    }
    // Tap a Sign (with no tool active) to set/change its custom text —
    // costs coins every time, since it's a paid customization rather than
    // a one-time unlock. A blank/cancelled prompt does nothing (no charge).
    if (!state.tool && obj.object_type === 'decoration' && obj.item_id === 'sign' && !state.viewingUserId) {
      let currentText = '';
      if (obj.state) { try { currentText = JSON.parse(obj.state).text || ''; } catch (e) { /* ignore */ } }
      const newText = prompt(`Customize this sign's text (🪙150, max 24 characters):`, currentText);
      if (newText === null) return; // cancelled
      const trimmed = newText.trim();
      if (!trimmed) { UI.toast('Enter some text for the sign.'); return; }
      (async () => {
        try {
          const res = await Api.setSignText(obj.id, trimmed);
          state.me.coins = res.coins;
          renderTopbar();
          UI.toast(`Sign updated to "${res.text}"!`);
          await refreshCurrentFarm();
        } catch (err) {
          UI.toast(err.message);
        }
      })();
      return;
    }
    // Flat, walkable decorations (a paved path, a pond) aren't something to
    // "interact with" — tapping one with no special tool active should just
    // walk the character there, same as tapping open grass.
    if (!state.tool && obj.object_type === 'decoration' && (obj.item_id === 'path' || obj.item_id === 'pond')) {
      game.walkTo(obj.grid_x, obj.grid_y, null);
    }
  }

  // ---------------- Shop / Inventory / Expand ----------------

  function openShop() {
    UI.openPanel('Shop');
    renderShopPanel('crops');
  }

  async function renderShopPanel(category) {
    let catalogForRender = state.catalog;
    if (category === 'outfits') {
      const outfits = await Api.outfits();
      catalogForRender = { ...state.catalog, outfits };
    } else if (category === 'buildings') {
      // The Market Stall building stays hidden here — it's a different,
      // confusing thing from the real rentable stalls in the shared
      // Marketplace plaza (Api.rentStall / the Market screen), and having
      // both made it look like buying this building was how you got a
      // selling stall. Stays in state.catalog.buildings itself
      // (unfiltered) so the game's renderer can still look up its
      // width/height for anyone who already placed one before this was
      // hidden. The farmhouse ("House") is NOT hidden anymore — it can
      // now be bought (and re-bought if removed) like any other building.
      const hiddenFromShop = new Set(['market_stall']);
      catalogForRender = { ...state.catalog, buildings: state.catalog.buildings.filter((b) => !hiddenFromShop.has(b.id)) };
    } else if (category === 'interiors') {
      // Wall-hangable decor doesn't make sense yet — everything currently
      // just sits on the floor tile grid like furniture, so a "painting"
      // ends up looking like it's propped up in the middle of the room
      // instead of hung on a wall. Hidden until wall placement is a real
      // thing; stays in state.catalog.interiors itself so anyone who
      // already placed one still renders correctly.
      catalogForRender = { ...state.catalog, interiors: state.catalog.interiors.filter((i) => i.id !== 'painting') };
    }
    UI.renderShop(catalogForRender, category, state.me, async (cat, itemId, qty) => {
      try {
        if (cat === 'crops') {
          const quantity = qty || 1;
          const res = await Api.buySeed(itemId, quantity);
          state.me.coins = res.coins;
          renderTopbar();
          UI.toast(`Bought ${quantity} ${itemId} seed${quantity > 1 ? 's' : ''}! Check your Bag, or pick "Plant" to use ${quantity > 1 ? 'them' : 'it'}.`);
          await renderShopPanel('crops');
          return;
        }
        if (cat === 'outfits') {
          const outfits = await Api.outfits();
          const target = outfits.find((o) => o.id === itemId);
          if (target && target.owned) {
            await Api.equipOutfit(itemId);
            UI.toast('Outfit changed!');
          } else {
            const res = await Api.buyOutfit(itemId);
            state.me.coins = res.coins;
            state.me.premiumCurrency = res.premiumCurrency;
            renderTopbar();
            UI.toast('New outfit bought and worn!');
          }
          await refreshPlayer();
          await renderShopPanel('outfits');
          return;
        }
        if (['building', 'decoration', 'animal', 'interior'].includes(cat)) {
          const res = await Api.buyPlaceable(cat, itemId, 1);
          state.me.coins = res.coins;
          renderTopbar();
          const toolHint = cat === 'interior' ? 'Decorate (inside your house)' : cat === 'animal' ? 'Animal' : 'Build';
          UI.toast(`Bought! Pick "${toolHint}" on the toolbar to place it.`);
          await renderShopPanel(cat === 'interior' ? 'interiors' : cat === 'building' ? 'buildings' : cat === 'animal' ? 'animals' : 'decorations');
          return;
        }
      } catch (err) {
        UI.toast(err.message);
      }
    }, (cat) => renderShopPanel(cat), async (name) => {
      try {
        const res = await Api.setDisplayName(name);
        state.me.displayName = res.displayName;
        state.me.premiumCurrency = res.premiumCurrency;
        renderTopbar();
        UI.toast(res.wasFree ? 'Name set!' : 'Name changed! 💎 200 spent.');
        await renderShopPanel('outfits');
      } catch (err) {
        UI.toast(err.message);
      }
    });
  }

  async function renderInventoryPanel() {
    const items = await Api.inventory();
    UI.renderInventory(items, state.catalog, async (itemId, qty) => {
      try {
        const quantity = qty || 1;
        const res = await Api.sell(itemId, quantity);
        state.me.coins = res.coins;
        renderTopbar();
        UI.toast(`Sold ${quantity} for 🪙${res.totalCoins}`);
        await renderInventoryPanel();
      } catch (err) {
        UI.toast(err.message);
      }
    }, async (foodItemId) => {
      try {
        const res = await Api.eat(foodItemId);
        state.me.energy = res.energy;
        renderTopbar();
        UI.toast(`Yum! +${res.energyRestored} ⚡ energy`);
        await renderInventoryPanel();
      } catch (err) {
        UI.toast(err.message);
      }
    });
  }

  async function openInventory() {
    UI.openPanel('Bag');
    await renderInventoryPanel();
  }

  async function doExpand() {
    if (state.viewingUserId || state.inHouse || state.inMarket) { UI.toast("You can only expand your own farm"); return; }
    const expansionLevel = (game.farm && game.farm.expansionLevel) || 0;
    const cost = 500 * Math.pow(2, expansionLevel);
    const confirmed = confirm(
      `Expand your farm by 4×4 tiles for 🪙${cost}?\n\nThis will be deducted from your coins immediately and cannot be undone.`
    );
    if (!confirmed) return;
    try {
      const res = await Api.expand();
      UI.toast(`Farm expanded to ${res.width}×${res.height}! (-🪙${res.coinsSpent})`);
      await refreshPlayer();
      await refreshCurrentFarm();
    } catch (err) {
      UI.toast(err.message);
    }
  }

  // ---------------- Marketplace (player-to-player, walkable plaza) ----------------

  async function enterMarket() {
    if (state.viewingUserId) { UI.toast("Leave your friend's farm first"); return; }
    if (state.inHouse) await exitHouse();
    const stalls = await Api.marketplace();
    state.marketStalls = stalls;
    game.setMarketMode(stalls);
    game.onMarketStallClick = openStallDetail;
    state.inMarket = true;
    joinSpace('market');
    setTool(null);
    document.getElementById('market-banner').classList.remove('hidden');
    document.getElementById('visiting-banner').classList.add('hidden');
  }

  async function exitMarket() {
    game.exitMarketMode();
    state.inMarket = false;
    document.getElementById('market-banner').classList.add('hidden');
    await loadOwnFarm(); // rejoins the outdoor farm space
  }

  // Central Park — a shared hangout space like the Marketplace (everyone
  // in it sees everyone else move around), just with fixed benches
  // instead of stalls. No server data to fetch — the layout is fixed and
  // known entirely client-side (see PARK_WIDTH/HEIGHT/PARK_BENCH_POSITIONS
  // in game.js) — so entering it is simpler than the market or a farm.
  // The Event Place is just a regular farm (owned by whichever admin set
  // it up via the admin panel) — reuses the exact same visit flow as
  // clicking a friend in the Friends list, so shared presence, read-only
  // enforcement for non-owners, and owner-only placement all come for
  // free with zero new logic.
  async function enterEventPlace() {
    if (state.inHouse) await exitHouse();
    if (state.inPark) await exitPark();
    if (state.inMarket) await exitMarket();
    try {
      const farm = await Api.eventPlace();
      await loadFarm(farm.ownerId);
      UI.toast(farm.isOwner ? "This is the Event Place — you can build here." : "Welcome to the Event Place!");
    } catch (err) {
      UI.toast(err.message);
    }
  }

  async function enterPark() {
    if (state.viewingUserId) { UI.toast("Leave your friend's farm first"); return; }
    if (state.inHouse) await exitHouse();
    game.setParkMode();
    game.onParkBenchClick = handleParkBenchClick;
    game.onParkCartClick = handleParkCartClick;
    state.inPark = true;
    joinSpace('park');
    setTool(null);
    document.getElementById('park-banner').classList.remove('hidden');
    document.getElementById('visiting-banner').classList.add('hidden');
  }

  async function exitPark() {
    if (state.me.isResting) {
      try {
        const res = await Api.stopResting();
        state.me.isResting = res.resting;
        state.me.energy = res.energy;
        renderTopbar();
      } catch (err) { /* non-critical */ }
    }
    setLocalRestPose(null);
    game.exitParkMode();
    state.inPark = false;
    document.getElementById('park-banner').classList.add('hidden');
    await loadOwnFarm(); // rejoins the outdoor farm space
  }

  async function handleParkBenchClick(bench) {
    game.walkTo(bench.x, bench.y, null);
    try {
      if (state.me.isResting) {
        const res = await Api.stopResting();
        state.me.isResting = res.resting;
        state.me.energy = res.energy;
        setLocalRestPose(null);
        UI.toast('You got up.');
      } else {
        setLocalRestPose('sit', bench.x + 0.5, bench.y + 0.5);
        const res = await Api.startResting();
        state.me.isResting = res.resting;
        state.me.energy = res.energy;
        UI.toast('Sitting down — energy regenerates faster. Tap the bench again to get up.');
      }
      renderTopbar();
    } catch (err) {
      UI.toast(err.message);
    }
  }

  async function handleParkCartClick(cart) {
    game.walkTo(cart.x, cart.y, null);
    if (!confirm(`Buy a ${cart.label} for 🪙${cart.cost}? It'll go to your Bag — eat it there whenever you want the energy.`)) return;
    try {
      const res = await Api.buyParkSnack(cart.itemId);
      state.me.coins = res.coins;
      renderTopbar();
      UI.toast(`Bought a ${cart.label}! Check your Bag to eat it.`);
    } catch (err) {
      UI.toast(err.message);
    }
  }

  async function refreshMarketStalls() {
    const stalls = await Api.marketplace();
    state.marketStalls = stalls;
    game.updateMarketStalls(stalls);
    return stalls;
  }

  async function openStallDetail(stall) {
    UI.openPanel(`Stall #${stall.id}`);
    await renderStallDetailPanel(stall.id);
  }

  async function renderStallDetailPanel(stallId) {
    const stalls = await refreshMarketStalls();
    const stall = stalls.find((s) => s.id === stallId);
    if (!stall) return;
    UI.renderStallDetail(stall, state.catalog, state.me, {
      onRent: async () => {
        try {
          const res = await Api.rentStall(stallId);
          state.me.coins = res.coins;
          renderTopbar();
          UI.toast('Stall rented for 24 hours!');
          await renderStallDetailPanel(stallId);
        } catch (err) { UI.toast(err.message); }
      },
      onList: async (itemId, quantity, price) => {
        try {
          await Api.listStall(itemId, quantity, price);
          UI.toast('Listed for sale!');
          await renderStallDetailPanel(stallId);
        } catch (err) { UI.toast(err.message); }
      },
      onRemoveListing: async (listingId) => {
        try {
          await Api.removeListing(listingId);
          UI.toast('Listing removed — items returned to your Bag.');
          await renderStallDetailPanel(stallId);
        } catch (err) { UI.toast(err.message); }
      },
      onLeave: async () => {
        try {
          await Api.leaveStall();
          UI.toast('Left the stall.');
          UI.closePanel();
          await refreshMarketStalls();
        } catch (err) { UI.toast(err.message); }
      },
      onBuy: async (listingId, quantity) => {
        try {
          const res = await Api.buyFromStall(listingId, quantity);
          state.me.coins = res.coins;
          renderTopbar();
          UI.toast(`Bought ${res.boughtQuantity} for 🪙${res.totalCost}!`);
          await renderStallDetailPanel(stallId);
        } catch (err) { UI.toast(err.message); }
      },
      getInventory: () => Api.inventory(),
    });
  }

  // ---------------- Friends / Notifications ----------------

  function initTopbarActions() {
    document.getElementById('home-btn').addEventListener('click', async () => {
      if (state.inHouse) { await exitHouse(); return; }
      if (state.inMarket) { await exitMarket(); return; }
      await loadOwnFarm();
    });
    document.getElementById('logout-btn').addEventListener('click', () => {
      Api.setToken(null);
      if (state.socket) state.socket.disconnect();
      window.location.reload();
    });
    document.getElementById('friends-btn').addEventListener('click', openFriends);
    document.getElementById('notif-btn').addEventListener('click', openNotifications);
    document.getElementById('settings-btn').addEventListener('click', () => {
      document.getElementById('settings-current-password').value = '';
      document.getElementById('settings-new-password').value = '';
      document.getElementById('account-settings-error').textContent = '';
      document.getElementById('account-settings-modal').classList.remove('hidden');
    });
    document.getElementById('account-settings-cancel').addEventListener('click', () => {
      document.getElementById('account-settings-modal').classList.add('hidden');
    });
    document.getElementById('account-settings-submit').addEventListener('click', async () => {
      const currentPassword = document.getElementById('settings-current-password').value;
      const newPassword = document.getElementById('settings-new-password').value;
      const errEl = document.getElementById('account-settings-error');
      errEl.textContent = '';
      try {
        await Api.changePassword(currentPassword, newPassword);
        document.getElementById('account-settings-modal').classList.add('hidden');
        UI.toast('Password changed!');
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
    document.getElementById('side-panel-close').addEventListener('click', UI.closePanel);
    document.getElementById('visiting-return-btn').addEventListener('click', loadOwnFarm);
    document.getElementById('house-exit-btn').addEventListener('click', exitHouse);
    document.getElementById('coop-exit-btn').addEventListener('click', exitHouse);
    document.getElementById('market-exit-btn').addEventListener('click', exitMarket);
    document.getElementById('park-exit-btn').addEventListener('click', exitPark);
    document.getElementById('daily-reward-btn').addEventListener('click', claimDailyReward);
    refreshNotifBadge();
    setInterval(refreshNotifBadge, 15000);
    initMusic();
  }

  function initMusic() {
    const btn = document.getElementById('music-toggle-btn');
    const updateIcon = () => { btn.textContent = FarmMusic.isMuted() ? '🔇' : '🔊'; };
    updateIcon();
    btn.addEventListener('click', () => {
      FarmMusic.toggle();
      updateIcon();
    });
    // Browsers block audio until a real user gesture — try immediately in
    // case one already happened (e.g. clicking "Log in"), and otherwise
    // catch the very next tap/click anywhere on the page as the gesture.
    if (!FarmMusic.isMuted()) {
      FarmMusic.start();
      const tryStartOnce = () => {
        FarmMusic.start();
        document.removeEventListener('pointerdown', tryStartOnce);
      };
      document.addEventListener('pointerdown', tryStartOnce, { once: true });
    }
  }

  async function openFriends() {
    UI.openPanel('Neighbors');
    const data = await Api.listFriends();
    UI.renderFriends(data, state.online, {
      onSearch: (q) => Api.searchUsers(q),
      onRequest: async (userId) => { await Api.requestFriend(userId); UI.toast('Friend request sent!'); openFriends(); },
      onRespond: async (requestId, accept) => { await Api.respondFriend(requestId, accept); UI.toast(accept ? 'Friend added!' : 'Request declined'); openFriends(); },
      onRemove: async (userId) => {
        if (!confirm('Remove this friend? You can send a new friend request later if you change your mind.')) return;
        await Api.removeFriend(userId);
        UI.toast('Removed');
        openFriends();
      },
      onVisit: async (userId) => { UI.closePanel(); await loadFarm(parseInt(userId, 10)); },
    });
  }

  async function openNotifications() {
    UI.openPanel('Notifications');
    const list = await Api.notifications();
    UI.renderNotifications(list);
    await Api.markNotificationsRead();
    document.getElementById('notif-badge').classList.add('hidden');
  }

  async function refreshNotifBadge() {
    try {
      const list = await Api.notifications();
      const unread = list.filter((n) => !n.read).length;
      const badge = document.getElementById('notif-badge');
      if (unread > 0) { badge.textContent = unread; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    } catch (e) { /* ignore */ }
  }

  async function checkDailyReward() {
    const status = await Api.dailyRewardStatus();
    const btn = document.getElementById('daily-reward-btn');
    btn.classList.toggle('outline', status.claimedToday);
    btn.dataset.claimed = status.claimedToday ? '1' : '0';
  }

  async function claimDailyReward() {
    try {
      const res = await Api.claimDailyReward();
      const r = res.reward;
      let msg = `Day ${res.streakDay} reward: `;
      if (r.coins) msg += `🪙${r.coins} `;
      if (r.xp) msg += `${r.xp}XP `;
      if (r.item) msg += `1× ${r.item} `;
      UI.toast(msg.trim());
      await refreshPlayer();
    } catch (err) {
      UI.toast(err.message);
    }
  }

  // ---------------- Socket.IO (presence + live notifications) ----------------

  function connectSocket() {
    const socket = io({ auth: { token: Api.getToken() } });
    state.socket = socket;
    socket.on('presence', ({ userId, online }) => {
      if (online) state.online.add(userId); else state.online.delete(userId);
    });
    socket.on('notification', ({ message }) => {
      UI.toast(message);
      refreshNotifBadge();
    });
    // Someone (possibly you, on another device) just logged into this
    // same account — session_version bumped server-side, which makes
    // this session's token invalid from here on. Log out immediately with
    // an explicit reason rather than leaving the person to discover it
    // confusingly on their next action (a failed request, a frozen game).
    socket.on('session:kicked', () => {
      Api.setToken(null);
      alert('You were logged out because this account signed in on another device.');
      window.location.reload();
    });

    // ---- Shared presence (farm visits + Marketplace) ----
    socket.on('presence:roster', ({ space, occupants }) => {
      if (space !== state.currentSpace) return;
      occupants.forEach((o) => {
        game.upsertRemotePlayer(o.userId, o);
        // Whoever was already in this room (sitting/lying) before we
        // walked in should look that way from the very first frame, not
        // pop into a resting pose only once they happen to move next.
        if (o.restPose) game.setRemotePlayerRestPose(o.userId, o.restPose, o.x, o.y);
      });
    });
    socket.on('presence:joined', (info) => {
      game.upsertRemotePlayer(info.userId, info);
    });
    socket.on('presence:move', ({ userId, x, y }) => {
      game.moveRemotePlayer(userId, x, y);
    });
    socket.on('presence:rest', ({ userId, restPose, x, y }) => {
      game.setRemotePlayerRestPose(userId, restPose, x, y);
    });
    socket.on('presence:left', ({ userId }) => {
      game.removeRemotePlayer(userId);
    });

    // ---- Chat ----
    socket.on('chat:global', (msg) => {
      appendChatMessage(msg, 'global');
      if (msg.fromUserId === state.me.id) game.showChatBubble(msg.message);
      else game.showRemoteChatBubble(msg.fromUserId, msg.message);
    });
    socket.on('chat:whisper', (msg) => {
      appendChatMessage(msg, 'whisper');
      if (msg.fromUserId !== state.me.id) UI.toast(`💬 ${msg.fromUsername} whispered to you`);
    });
  }

  // ---------------- Chat (global + whisper) ----------------

  let chatMode = 'global'; // 'global' | 'whisper'
  let whisperTargetId = null;

  async function initChat() {
    document.querySelectorAll('.chat-tab').forEach((btn) => {
      btn.addEventListener('click', async () => {
        document.querySelectorAll('.chat-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        chatMode = btn.dataset.mode;
        const targetSelect = document.getElementById('chat-whisper-target');
        targetSelect.classList.toggle('hidden', chatMode !== 'whisper');
        if (chatMode === 'whisper') await populateWhisperTargets();
      });
    });

    document.getElementById('chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });
    document.getElementById('chat-whisper-target').addEventListener('change', (e) => {
      whisperTargetId = e.target.value || null;
    });
    // Chat starts fully hidden behind the small floating button — tapping
    // it opens the box; the ✕ inside closes it back down to just the
    // button. Replaces the old "collapsed bar" state, which still sat on
    // screen and was fiddly to open/close on mobile.
    document.getElementById('chat-fab').addEventListener('click', () => {
      document.getElementById('chat-box').classList.remove('hidden');
      document.getElementById('chat-fab').classList.add('hidden');
    });
    document.getElementById('chat-toggle').addEventListener('click', () => {
      document.getElementById('chat-box').classList.add('hidden');
      document.getElementById('chat-fab').classList.remove('hidden');
    });

    // Load recent global chat history on every page load (refresh included)
    // — it only actually clears when you log out (a fresh login always
    // re-fetches from the server, same as this), not just from reloading
    // the page while still signed in.
    Api.globalChatHistory().then((rows) => {
      rows.forEach((msg) => appendChatMessage(msg, 'global', false));
      scrollChatToBottom();
    }).catch(() => { /* history is a nice-to-have, don't block chat working without it */ });
  }

  async function populateWhisperTargets() {
    const select = document.getElementById('chat-whisper-target');
    try {
      const data = await Api.listFriends();
      select.innerHTML = '<option value="">Whisper to...</option>' +
        data.friends.map((f) => `<option value="${f.id}">${f.username}</option>`).join('');
      if (!data.friends.length) select.innerHTML = '<option value="">Add friends to whisper</option>';
    } catch (e) {
      select.innerHTML = '<option value="">Could not load friends</option>';
    }
  }

  async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    try {
      if (chatMode === 'global') {
        const res = await Api.sendGlobalChat(text);
        state.me.coins = res.coins;
        renderTopbar();
      } else {
        if (!whisperTargetId) { UI.toast('Pick a friend to whisper to'); return; }
        await Api.sendWhisper(whisperTargetId, text);
      }
      input.value = '';
    } catch (err) {
      UI.toast(err.message);
    }
  }

  function appendChatMessage(msg, kind, autoScroll = true) {
    const log = document.getElementById('chat-log');
    const el = document.createElement('div');
    el.className = `chat-line ${kind}${msg.isAnnouncement ? ' announcement' : ''}`;
    if (msg.isAnnouncement) {
      el.innerHTML = `<span class="chat-announcement-tag">📢 Announcement:</span> ${escapeHtml(msg.message)}`;
    } else if (kind === 'whisper') {
      const isOutgoing = msg.fromUserId === state.me.id;
      const label = isOutgoing ? `→ ${msg.toUsername}` : `${msg.fromUsername} →`;
      el.innerHTML = `<span class="chat-whisper-tag">${label}</span> ${escapeHtml(msg.message)}`;
    } else {
      el.innerHTML = `<span class="chat-username">${escapeHtml(msg.fromUsername)}:</span> ${escapeHtml(msg.message)}`;
    }
    log.appendChild(el);
    while (log.children.length > 100) log.removeChild(log.firstChild);
    if (autoScroll) scrollChatToBottom();
  }

  function scrollChatToBottom() {
    const log = document.getElementById('chat-log');
    log.scrollTop = log.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------- Boot ----------------

  async function main() {
    initAuthScreen();
    // Someone logging into this same account elsewhere invalidates this
    // session immediately, mid-use — not just on the next page load. Set
    // this before bootGame() so it's already armed for the very first API
    // call, and _sessionSupersededHandled guards against firing more than
    // once if several in-flight requests all fail from the same cause at
    // once (each would otherwise try to alert+reload independently).
    let sessionSupersededHandled = false;
    Api.setOnSessionSuperseded(() => {
      if (sessionSupersededHandled) return;
      sessionSupersededHandled = true;
      Api.setToken(null);
      alert('You were logged out because this account signed in from another device.');
      window.location.reload();
    });
    if (Api.getToken()) {
      try {
        await bootGame();
        return;
      } catch (err) {
        Api.setToken(null);
      }
    }
  }

  main();
})();
