// public/js/game.js
// A simple top-down grid renderer for the farm. Deliberately not a heavy game
// engine — canvas + a small camera (pan/zoom) is enough for the classic
// "click a tile, do a thing" social-farming feel, and keeps the codebase easy
// to extend later (see project brief section 36).

const TILE = 64; // base tile size in world units

// ---- Character sprite assets ----
// Real illustrated raster sprites (not vector shapes) for the player
// character, replacing the earlier procedurally-drawn body. Loaded lazily
// and cached so each image is only fetched once regardless of how many
// characters (self + remote players) need to draw it.
const SPRITE_BASE = '/assets/characters/';
const SPRITE_CACHE = {};
function getSprite(key) {
  if (!SPRITE_CACHE[key]) {
    const img = new Image();
    img.src = `${SPRITE_BASE}${key}.png`;
    SPRITE_CACHE[key] = img;
  }
  return SPRITE_CACHE[key];
}

// ---- Building sprite assets ----
// Same lazy-load-and-cache pattern as character sprites, for buildings
// that use a real illustrated image instead of procedurally-drawn shapes
// (currently just the Mansion).
const BUILDING_SPRITE_BASE = '/assets/buildings/';
const BUILDING_SPRITE_CACHE = {};
function getBuildingSprite(key) {
  if (!BUILDING_SPRITE_CACHE[key]) {
    const img = new Image();
    img.src = `${BUILDING_SPRITE_BASE}${key}.png`;
    BUILDING_SPRITE_CACHE[key] = img;
  }
  return BUILDING_SPRITE_CACHE[key];
}
// Preload the full set immediately so the very first frame has them ready —
// every direction now has its own dedicated 2-frame walk cycle for both
// genders (no more mirroring, no more idle-only directions), which is what
// actually fixes characters looking like they're "gliding" instead of
// walking: the legs genuinely alternate as they move.
const SPRITE_DIRECTIONS = ['down', 'up', 'left', 'right'];
// Every outfit that has its own real matching sprite set goes here (beyond
// the base 'classic' look, which has no prefix). Adding a new one just
// means dropping the files in public/assets/characters/ following the same
// {gender}_{outfitKey}_walk_{dir}_{1|2}.png naming and listing it here.
const SPRITE_OUTFIT_KEYS = ['green', 'gentleman', 'winter', 'festival', 'lancer', 'sorcerer', 'swordsman'];
const SPRITE_CACHE_KNOWN = new Set();
['male', 'female'].forEach((g) => {
  getSprite(`${g}_walk_down_1`); // frame 1 of "down" also serves as that gender's idle pose
  SPRITE_DIRECTIONS.forEach((dir) => {
    getSprite(`${g}_walk_${dir}_1`);
    getSprite(`${g}_walk_${dir}_2`);
    SPRITE_CACHE_KNOWN.add(`${g}_walk_${dir}_1`);
    SPRITE_CACHE_KNOWN.add(`${g}_walk_${dir}_2`);
    SPRITE_OUTFIT_KEYS.forEach((outfitKey) => {
      getSprite(`${g}_${outfitKey}_walk_${dir}_1`);
      getSprite(`${g}_${outfitKey}_walk_${dir}_2`);
      SPRITE_CACHE_KNOWN.add(`${g}_${outfitKey}_walk_${dir}_1`);
      SPRITE_CACHE_KNOWN.add(`${g}_${outfitKey}_walk_${dir}_2`);
    });
  });
});

// Picks which sprite image to show for a character's current facing/motion.
// Every direction has a real 2-frame walk cycle now; while not moving, frame
// 1 of the relevant direction doubles as the idle pose (it's a natural
// standing-ish pose in the source sheet, not a mid-stride one).
function spriteKeyFor(gender, facingDir, walkFrame, moving, outfitKey) {
  const g = gender === 'female' ? 'female' : 'male';
  const dir = SPRITE_DIRECTIONS.includes(facingDir) ? facingDir : 'down';
  const frame = moving ? (walkFrame === 0 ? 1 : 2) : 1;
  // 'classic' is the base sprite set with no prefix; any other outfit key
  // (e.g. 'green') has its own matching sprite files, falling back to the
  // classic look automatically if that combination doesn't exist yet.
  const prefix = outfitKey && outfitKey !== 'classic' ? `${g}_${outfitKey}` : g;
  const key = `${prefix}_walk_${dir}_${frame}`;
  return SPRITE_CACHE_KNOWN.has(key) ? key : `${g}_walk_${dir}_${frame}`;
}

// Ground-aura color per Special Outfit (see _drawSpecialAura) — an
// outfitKey NOT in this map (every ordinary costume) simply gets no aura
// at all.
const SPECIAL_AURA_RGB = {
  lancer: '61,143,224',
  sorcerer: '176,96,224',
  swordsman: '244,201,93',
};

// The special-outfit sprites hold their weapon out to one side (a spear,
// staff, or sword), so the character's actual BODY/feet aren't perfectly
// centered in the image the way ordinary costumes are — drawing the aura
// at a flat, un-adjusted cx makes it look off-center under the visible
// character even though it's correctly centered on the image's own
// bounding box. Each value is how far the feet sit from the image's
// horizontal center, as a fraction of the image's width (negative = feet
// left of center, positive = right) — precomputed once per
// gender/costume/direction by measuring where the opaque pixels in the
// bottom of each sprite actually sit, not a guess.
const SPECIAL_AURA_OFFSET = {
  male_lancer_walk_down: -0.0522, male_lancer_walk_up: 0.0846, male_lancer_walk_left: -0.125, male_lancer_walk_right: 0.0524,
  male_sorcerer_walk_down: -0.105, male_sorcerer_walk_up: 0.0748, male_sorcerer_walk_left: -0.119, male_sorcerer_walk_right: 0.1068,
  male_swordsman_walk_down: -0.02, male_swordsman_walk_up: -0.0158, male_swordsman_walk_left: 0.0119, male_swordsman_walk_right: -0.0412,
  female_lancer_walk_down: -0.0849, female_lancer_walk_up: 0.0868, female_lancer_walk_left: -0.0889, female_lancer_walk_right: 0.0725,
  female_sorcerer_walk_down: -0.0818, female_sorcerer_walk_up: 0.0482, female_sorcerer_walk_left: -0.0532, female_sorcerer_walk_right: 0.0165,
  female_swordsman_walk_down: -0.0106, female_swordsman_walk_up: -0.0172, female_swordsman_walk_left: 0.0116, female_swordsman_walk_right: -0.0349,
};

// Fixed layout for the shared Marketplace plaza: 20 stalls in a 5×4 grid
// around a central fountain, so it reads as an actual town square you walk
// around rather than a menu.
const MARKET_WIDTH = 17;
const MARKET_HEIGHT = 15;

// Central Park — a shared open space (same "everyone in it sees each other
// move" model as the Marketplace, just no stalls) with fixed benches
// players can actually sit on for the faster energy regen, same as a
// bench out on their own farm.
const PARK_WIDTH = 16;
const PARK_HEIGHT = 14;
const PARK_BENCH_POSITIONS = [
  { x: 3, y: 4 }, { x: 6, y: 4 }, { x: 9, y: 4 }, { x: 12, y: 4 },
  { x: 3, y: 10 }, { x: 6, y: 10 }, { x: 9, y: 10 }, { x: 12, y: 10 },
];
// Casino building footprint, upper-left of the Park — same size as the
// Mansion's outdoor footprint (7x4), per the reference art. Tapping ANY
// tile inside this box enters it (see onParkCasinoClick in the park tap
// handler below), same forgiving whole-building-is-clickable behavior as
// the snack carts.
const CASINO_BUILDING = { x: 0, y: 0, width: 7, height: 4 };
const PARK_TREE_POSITIONS = [
  { x: 1, y: 5 }, { x: 14, y: 1 }, { x: 1, y: 12 }, { x: 14, y: 12 },
  { x: 7, y: 1 }, { x: 8, y: 12 },
];
// Snack carts — tap one to buy straight into your Bag (see main.js's
// handleParkCartClick / /api/farm/park-buy-snack). Placed together near
// the tree in the upper-left corner (with some breathing room between
// them) so they read as a little snack corner instead of being scattered
// randomly across the park. Shifted down to y:5 (was y:3) to sit clear of
// the Casino building's footprint above them.
const PARK_CART_POSITIONS = [
  { x: 2, y: 5, itemId: 'ice_cream', label: 'Ice Cream 🍦', cost: 75 },
  { x: 4, y: 5, itemId: 'hotdog', label: 'Hotdog 🌭', cost: 100 },
];

// ---- Casino interior (inside the Park building above) ----
// Same room WIDTH as the Mansion (the biggest interior in the game), but
// taller — 3 floors now, one machine TYPE per floor with 15 physical
// copies of it laid out in a 5x3 grid, so 15 players can each be on their
// own Color Game/Claw Machine/Slot machine at once instead of fighting
// over one shared machine (see the casino:lock/casino:unlock socket
// events for the actual "1 player at a time per physical machine" rule —
// this is just the layout). Entirely fixed/hardcoded, no per-player
// ownership or furniture placement, same "no server data to fetch, layout
// known client-side" simplicity as the Park itself.
const CASINO_INTERIOR_WIDTH = 15;
const CASINO_INTERIOR_HEIGHT = 12;
const CASINO_MACHINE_COLS = [1, 4, 7, 10, 13];
const CASINO_MACHINE_ROWS = [4, 7, 10];
const CASINO_STAIRS_ROW = 1;

// Builds the 15 grid positions (5 cols x 3 rows) for one floor's machine
// type, each with a globally-unique instance id (e.g. 'color_game_7') —
// that id is what the lock system above keys on, and what's sent as
// `machine` (the bet TYPE is derived from it, see machineTypeFromId
// below) to the betting API.
function buildMachineGrid(type) {
  const positions = [];
  let n = 1;
  for (const y of CASINO_MACHINE_ROWS) {
    for (const x of CASINO_MACHINE_COLS) {
      positions.push({ id: `${type}_${n}`, type, x, y });
      n++;
    }
  }
  return positions;
}

function machineTypeFromId(machineId) {
  return machineId.replace(/_\d+$/, '');
}

const CASINO_FLOOR_LAYOUT = {
  1: {
    machines: buildMachineGrid('color_game'),
    stairs: [{ x: 7, y: CASINO_STAIRS_ROW, direction: 'up', toFloor: 2 }],
  },
  2: {
    machines: buildMachineGrid('claw_machine'),
    stairs: [
      { x: 5, y: CASINO_STAIRS_ROW, direction: 'up', toFloor: 3 },
      { x: 9, y: CASINO_STAIRS_ROW, direction: 'down', toFloor: 1 },
    ],
  },
  3: {
    machines: buildMachineGrid('slot_777'),
    stairs: [{ x: 7, y: CASINO_STAIRS_ROW, direction: 'down', toFloor: 2 }],
  },
};

const MARKET_STALL_POSITIONS = (() => {
  const xs = [1, 4, 7, 10, 13];
  const ys = [1, 4, 8, 11];
  const positions = [];
  ys.forEach((y) => xs.forEach((x) => positions.push({ x, y })));
  return positions; // index 0 => stallId 1, index 1 => stallId 2, etc. (20 total)
})();

// Original, simple sprite language: each tile/object is drawn as a soft
// rounded-rect "tile" plus an emoji glyph. This avoids reproducing any
// copyrighted artwork while still giving every object a distinct look.
const CROP_GLYPH = {
  wheat: '🌾', corn: '🌽', carrot: '🥕', tomato: '🍅',
  potato: '🥔', strawberry: '🍓', pumpkin: '🎃', rice: '🌾',
};
const DECORATION_STYLE = {
  fence:    { shape: 'fence',   wood: '#a9714a' },
  tree:     { shape: 'tree',    trunk: '#8b5e34', leaf: '#4f8f2e', leafDark: '#3c7020' },
  flower:   { shape: 'flower',  soil: '#7a5232', colors: ['#e05a7e', '#f4c95d', '#f0f0f0', '#c48bd9'] },
  bush:     { shape: 'bush',    leaf: '#5aa32e', leafDark: '#468022' },
  hay_bale: { shape: 'hay',     body: '#e8c25a', bodyDark: '#c9a13c', band: '#a9714a' },
  bench:    { shape: 'bench',   wood: '#8b5e34', woodDark: '#6b4423' },
  lamp:     { shape: 'lamp',    post: '#4a3521', glass: '#fff3b0', glow: '#ffdd88' },
  sign:     { shape: 'sign',    post: '#6b4423', board: '#c7a877', boardDark: '#a9714a' },
  path:     { shape: 'path',    stone: '#c9c2b0', stoneDark: '#a9a08a' },
  pond:     { shape: 'pond',    water: '#5ab0ff', waterDark: '#3d8fe0', reed: '#4f8f2e' },
};
const ANIMAL_STYLE = {
  chicken: { shape: 'chicken', body: '#fdf6e3', comb: '#c0392b', beak: '#e8a527' },
  cow:     { shape: 'cow',     body: '#f8f4e8', spot: '#4a3521', nose: '#e8b4b4' },
  sheep:   { shape: 'sheep',   body: '#f2ead6', face: '#4a3521' },
  pig:     { shape: 'pig',     body: '#f2b6c4', snout: '#e090a4' },
};

// Category accent colors kept for anything without a dedicated vector shape.
const CATEGORY_ACCENT = { building: '#c4552e', animal: '#e8a527', decoration: '#4f8f2e' };

// Buildings are drawn as real little vector structures (roof, walls, door,
// windows) instead of an emoji glyph — each type gets its own silhouette so
// they read as distinct structures rather than the same icon in a box.
const BUILDING_STYLE = {
  farmhouse:    { shape: 'house',  roof: '#c0392b', roofDark: '#9c2f22', wall: '#f6ecd2', trim: '#8b5e34', door: '#6b4423', chimney: true,  windows: 2 },
  mansion:      { shape: 'mansion', roof: '#5a5a5a', roofDark: '#464646', wall: '#e0973f', wallDark: '#c47f2f', trim: '#f3cb7a', door: '#6b4423' },
  barn:         { shape: 'barn',   roof: '#f4f4f4', roofDark: '#d8d8d8', wall: '#b6402c', trim: '#f4f4f4', door: '#5e3b1f', hayloft: true },
  cow_barn:     { shape: 'barn',   roof: '#f4f4f4', roofDark: '#d8d8d8', wall: '#8f2f22', trim: '#f4f4f4', door: '#5e3b1f', hayloft: true },
  storage_shed: { shape: 'shed',   roof: '#6b7f8f', roofDark: '#54626e', wall: '#d8c9a3', trim: '#6b4423', door: '#6b4423' },
  workshop:     { shape: 'shed',   roof: '#7a6a52', roofDark: '#5e5140', wall: '#c7a877', trim: '#4a3521', door: '#4a3521' },
  chicken_coop: { shape: 'coop',   roof: '#c0392b', roofDark: '#9c2f22', wall: '#f6ecd2', trim: '#8b5e34', door: '#6b4423' },
  well:         { shape: 'well',   roof: '#8b5e34', roofDark: '#6b4423', stone: '#c9c2b0' },
  silo:         { shape: 'silo',   body: '#c9d6dd', bodyDark: '#a9bcc6', cap: '#8b5e34' },
  market_stall: { shape: 'stall',  roof: '#e8a527', roofDark: '#c98a12', wall: '#8b5e34', stripe: '#fff' },
};

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

class FarmGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = { x: 0, y: 0, scale: 1 };
    // Once the player manually pinch/scroll-zooms, their chosen zoom level
    // should stick across entering/exiting the house, market, park, etc.
    // instead of snapping back to the auto-fit default every time. Only
    // resetView() (the explicit "fix my view" button) clears this.
    this._userZoomed = false;
    this.farm = null;
    this.mode = 'outdoor'; // 'outdoor' | 'indoor' | 'market'
    this.interior = null; // { width, height, objects, serverTime } when mode === 'indoor'
    this.market = null; // { stalls } when mode === 'market'
    this.onTileClick = null; // callback(x, y)
    this.dragActEnabled = false; // when true (water tool active — see setDragActEnabled), holding
    // and dragging across tiles calls onTileClick for each NEW tile the
    // pointer passes over, instead of the drag panning the map.
    this.onObjectClick = null; // callback(object)
    // True while the player has an item picked from Build/Decorate/Plant/
    // Place-Animal and is choosing WHERE to put it (see main.js's
    // setPlacementSelectionActive) — while true, a tap on a tile that
    // already has something on it (e.g. tapping a Table to place a Table
    // Lamp on top of it) goes to onTileClick same as any empty tile,
    // instead of being swallowed by onObjectClick's "interact with this
    // existing thing" handling, which had no placement behavior of its
    // own and silently did nothing.
    this.placementSelectionActive = false;
    this.onMarketStallClick = null; // callback(stall)
    this.onParkBenchClick = null; // callback(benchPosition)
    this.onParkCartClick = null; // callback(cartPosition)
    this.onParkCasinoClick = null; // callback() — tapped the Casino building in the Park
    this.onCasinoMachineClick = null; // callback(machineId, machineType) — tapped a betting machine inside the Casino
    this.onCasinoStairsClick = null;  // callback(toFloor) — tapped a Casino staircase
    this.casinoLocks = new Map(); // machineId -> username currently occupying it (visual only — see casino:lock socket flow for actual enforcement)
    this.highlightFn = null; // (x,y) => 'valid'|'invalid'|null, drawn as overlay
    this._ghost = null; // { category, itemId, x, y, rotation, def } pending-placement preview

    this._dragging = false;
    this._dragMoved = false;
    this._lastPointer = null;
    this._pinchDist = null;
    this._clouds = this._makeClouds();
    this._startTime = Date.now();
    this._lastFrameTime = Date.now();

    // The little farmer: purely visual, walks to whatever tile the player
    // just acted on and does a small animation for the action performed.
    this._character = {
      x: TILE * 1.5, y: TILE * 1.5, // world position (center of a tile)
      targetX: TILE * 1.5, targetY: TILE * 1.5,
      facing: 1, // 1 = facing right, -1 = facing left (used to mirror the side sprite)
      facingDir: 'down', // 'down' | 'up' | 'left' | 'right' — which sprite to show
      walkFrame: 0, walkFrameTimer: 0, // alternates the walk-cycle frame while moving
      path: [], // queued waypoint tiles from pathfinding (see walkTo/_findPath)
      moving: false,
      actionGlyph: null,
      actionTimer: 0,
      bob: 0,
      gender: 'male',
      // default starter look — overridden by setAppearance() once player data loads
      shirtColor: '#5a8fc9', pantsColor: '#3f6a9c', hatColor: '#e0b060', style: 'overalls',
      outfitKey: 'classic', // which sprite set to draw — see public/assets/characters/
      chatText: null, chatTimer: 0,
      restPose: null, // null | 'sit' | 'lie' — see setRestPose()
    };

    // Other players sharing the same space (farm visit or the Marketplace
    // plaza) — see setMarketMode/join wiring in main.js. Map<userId, actor>.
    this.remotePlayers = new Map();
    this.onSelfMove = null; // callback(tileX, tileY) fired whenever the local player walks somewhere

    this._bindEvents();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._raf = requestAnimationFrame(() => this._loop());
  }

  // Update the character's gender + equipped outfit colors/style. Called
  // whenever player data is (re)loaded, so the drawn farmer always reflects
  // the current gender and outfit chosen from the Market.
  setAppearance(gender, outfitDef, dyeColor) {
    const c = this._character;
    c.gender = gender === 'female' ? 'female' : 'male';
    if (outfitDef) {
      c.shirtColor = dyeColor || outfitDef.shirt_color;
      c.pantsColor = outfitDef.pants_color;
      c.hatColor = outfitDef.hat_color || '#e0b060';
      c.style = outfitDef.style || 'overalls';
      c.outfitKey = outfitDef.sprite_key || 'classic';
    }
  }

  // A snapshot of the local player's current look, sent along when joining a
  // shared space so other clients can draw this player correctly.
  getAppearanceSnapshot() {
    const c = this._character;
    return { gender: c.gender, shirtColor: c.shirtColor, pantsColor: c.pantsColor, hatColor: c.hatColor, style: c.style, outfitKey: c.outfitKey };
  }

  // The local player's current position in tile coordinates — used when
  // announcing yourself to a newly-joined shared space.
  getCharacterTile() {
    const c = this._character;
    return { x: Math.floor(c.x / TILE), y: Math.floor(c.y / TILE) };
  }

  // ---- Remote players (other people sharing the current space) ----
  upsertRemotePlayer(userId, data) {
    const existing = this.remotePlayers.get(userId);
    const wx = (data.x || 0) * TILE + TILE / 2, wy = (data.y || 0) * TILE + TILE / 2;
    if (existing) {
      existing.username = data.username;
      if (data.appearance) Object.assign(existing, data.appearance);
      return;
    }
    this.remotePlayers.set(userId, {
      x: wx, y: wy, targetX: wx, targetY: wy, facing: 1, facingDir: 'down',
      walkFrame: 0, walkFrameTimer: 0, moving: false, bob: 0,
      username: data.username,
      gender: (data.appearance && data.appearance.gender) || 'male',
      shirtColor: (data.appearance && data.appearance.shirtColor) || '#5a8fc9',
      pantsColor: (data.appearance && data.appearance.pantsColor) || '#3f6a9c',
      hatColor: (data.appearance && data.appearance.hatColor) || '#e0b060',
      style: (data.appearance && data.appearance.style) || 'overalls',
      outfitKey: (data.appearance && data.appearance.outfitKey) || 'classic',
      chatText: null, chatTimer: 0,
      restPose: null, // set via setRemotePlayerRestPose() from the 'presence:rest' broadcast
    });
  }

  // Applies a live appearance change (new costume, new dye) broadcast by
  // someone else already sharing this space — see the 'presence:appearance'
  // socket event in main.js. A dedicated method rather than reusing
  // upsertRemotePlayer() for this: that function also expects `username`/
  // position data and would stomp existing.username with undefined if
  // called with only an appearance payload.
  setRemotePlayerAppearance(userId, appearance) {
    const existing = this.remotePlayers.get(userId);
    if (existing && appearance) Object.assign(existing, appearance);
  }

  // Applies another player's sit/lie state to their on-screen avatar —
  // called when the 'presence:rest' socket event arrives (see main.js),
  // so a visitor actually sees a friend resting on furniture instead of
  // just standing there. tileX/tileY (already the furniture's center, in
  // tile units) snap the avatar onto it the same way setRestPose does for
  // the local character.
  setRemotePlayerRestPose(userId, restPose, tileX, tileY, facingDir) {
    const actor = this.remotePlayers.get(userId);
    if (!actor) return;
    actor.restPose = restPose;
    if (restPose && tileX !== undefined && tileY !== undefined) {
      const wx = tileX * TILE, wy = tileY * TILE;
      actor.x = wx; actor.y = wy; actor.targetX = wx; actor.targetY = wy;
      actor.moving = false;
      actor.facingDir = facingDir || 'down';
    }
  }

  moveRemotePlayer(userId, tileX, tileY) {
    const actor = this.remotePlayers.get(userId);
    if (!actor) return;
    // Real movement means they've gotten up off whatever furniture they
    // were resting on — same as the local character's walkTo clearing its
    // own restPose. A rest-triggered 'presence:move' from setRemotePlayerRestPose
    // itself doesn't go through this function, so this only fires for genuine walking.
    if (actor.restPose) actor.restPose = null;
    const dx = tileX * TILE + TILE / 2 - actor.x, dy = tileY * TILE + TILE / 2 - actor.y;
    actor.targetX = tileX * TILE + TILE / 2;
    actor.targetY = tileY * TILE + TILE / 2;
    if (actor.targetX !== actor.x) actor.facing = actor.targetX > actor.x ? 1 : -1;
    if (Math.abs(dy) > Math.abs(dx) * 0.6) {
      actor.facingDir = dy > 0 ? 'down' : 'up';
    } else if (dx !== 0) {
      actor.facingDir = dx > 0 ? 'right' : 'left';
    }
    actor.moving = true;
  }

  removeRemotePlayer(userId) {
    this.remotePlayers.delete(userId);
  }

  clearRemotePlayers() {
    this.remotePlayers.clear();
  }

  // ---- Casino machine occupancy (visual only — see casino:lock socket
  // flow in main.js for the actual "1 player at a time" enforcement) ----
  setCasinoLocksSnapshot(locks) {
    this.casinoLocks = new Map((locks || []).map((l) => [l.machineId, l.username]));
  }
  setCasinoMachineLocked(machineId, username) {
    this.casinoLocks.set(machineId, username);
  }
  setCasinoMachineUnlocked(machineId) {
    this.casinoLocks.delete(machineId);
  }

  // Speech bubble above the local player's head (global chat while visible
  // in a shared space).
  showChatBubble(text) {
    this._character.chatText = text;
    this._character.chatTimer = 5;
  }

  showRemoteChatBubble(userId, text) {
    const actor = this.remotePlayers.get(userId);
    if (!actor) return;
    actor.chatText = text;
    actor.chatTimer = 5;
  }

  // Send the farmer walking to a tile. If actionGlyph is given, once the
  // farmer arrives it does a little bounce with that icon above its head —
  // used to visually perform whatever the player just did (plow/plant/etc).
  // ---- Movement collision + pathfinding ----
  // Fences (and buildings) block the tile they sit on; walkTo now routes
  // around them with a simple BFS instead of cutting straight through.
  _isTileBlocked(tileX, tileY) {
    return this._getBlockedTileSet().has(`${tileX},${tileY}`);
  }

  // A Set of every blocked tile ("x,y" strings) — buildings' full
  // footprint plus fence tiles — built ONCE from farm.objects and reused
  // until that array is actually replaced (see the farm.tiles/farm.crops
  // caching in _drawTiles for the same reasoning: these are only ever
  // REPLACED wholesale after a refetch, never mutated in place, so a
  // reference check safely detects when a rebuild is actually needed).
  // _isTileBlocked used to re-scan EVERY object on the farm on every
  // single call — and pathfinding below calls it for every neighbor of
  // every node it visits, so on a big, heavily-built farm that was
  // effectively O(pathNodes × 4 × totalObjects) for ONE walk command. A
  // Set lookup here is O(1) regardless of farm size.
  _getBlockedTileSet() {
    if (this._blockedSetSource !== (this.farm && this.farm.objects)) {
      const blocked = new Set();
      if (this.farm) {
        for (const obj of this.farm.objects) {
          if (obj.object_type === 'decoration' && obj.item_id === 'fence') {
            blocked.add(`${obj.grid_x},${obj.grid_y}`);
          } else if (obj.object_type === 'building') {
            const def = this._defFor(obj);
            const w = (def && def.width) || 1, h = (def && def.height) || 1;
            for (let dx = 0; dx < w; dx++) {
              for (let dy = 0; dy < h; dy++) blocked.add(`${obj.grid_x + dx},${obj.grid_y + dy}`);
            }
          }
        }
      }
      this._blockedSetCache = blocked;
      this._blockedSetSource = this.farm && this.farm.objects;
    }
    return this._blockedSetCache;
  }

  // Plain BFS over the tile grid — farms are small (tens of tiles per side)
  // so this is effectively instant and always finds the shortest route when
  // one exists. Returns an ordered list of waypoint tiles (excluding the
  // start, including the destination), or null if there's no way through.
  _findPath(startX, startY, endX, endY) {
    if (!this.farm) return [{ x: endX, y: endY }];
    const w = this.farm.width, h = this.farm.height;
    if (endX < 0 || endY < 0 || endX >= w || endY >= h) return null;
    if (startX === endX && startY === endY) return [];
    const blocked = this._getBlockedTileSet();
    if (blocked.has(`${endX},${endY}`)) return null;

    const key = (x, y) => `${x},${y}`;
    const startKey = key(startX, startY);
    const queue = [[startX, startY]];
    let qHead = 0; // index-based dequeue instead of Array.shift(), which is
                    // O(n) per call and turns this whole BFS into O(n²) at
                    // the node counts a wide-open big farm can reach —
                    // qHead++ is O(1) regardless of how many nodes are queued.
    const visited = new Set([startKey]);
    const cameFrom = new Map();
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let found = false;

    while (qHead < queue.length) {
      const [cx, cy] = queue[qHead++];
      if (cx === endX && cy === endY) { found = true; break; }
      for (const [dx, dy] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = key(nx, ny);
        if (visited.has(nk) || blocked.has(nk)) continue;
        visited.add(nk);
        cameFrom.set(nk, key(cx, cy));
        queue.push([nx, ny]);
      }
      if (visited.size > 30000) break; // safety cap against a pathological runaway search — land expansion is uncapped, and the old 4000 limit could actually fail to find a path across a big, wide-open farm (not just slow it down), so this needs real headroom, not just a small guard
    }
    if (!found) return null;

    const path = [];
    let curKey = key(endX, endY);
    while (curKey !== startKey) {
      const [x, y] = curKey.split(',').map(Number);
      path.unshift({ x, y });
      curKey = cameFrom.get(curKey);
      if (!curKey) break;
    }
    return path;
  }

  // Kicks off movement toward the next queued waypoint — shared by the
  // initial walkTo call and every subsequent step along a multi-tile path.
  _advanceToNextWaypoint(c) {
    if (!c.path || c.path.length === 0) { c.moving = false; return; }
    const next = c.path.shift();
    const targetX = next.x * TILE + TILE / 2, targetY = next.y * TILE + TILE / 2;
    const dx = targetX - c.x, dy = targetY - c.y;
    c.targetX = targetX; c.targetY = targetY;
    if (c.targetX !== c.x) c.facing = c.targetX > c.x ? 1 : -1;
    if (Math.abs(dy) > Math.abs(dx) * 0.6) {
      c.facingDir = dy > 0 ? 'down' : 'up';
    } else if (dx !== 0) {
      c.facingDir = dx > 0 ? 'right' : 'left';
    }
    c.moving = true;
    if (this.onSelfMove) this.onSelfMove(next.x, next.y);
  }

  // Walks to a tile and resolves once the character actually finishes
  // moving there (or resolves immediately if already there / the tile is
  // unreachable) — used for the "walk to the door, THEN fade/transition"
  // entry flow (see main.js's enterInterior/enterCasino), so entering a
  // building reads as actually walking up to it instead of teleporting.
  // See placementSelectionActive's comment in the constructor.
  setPlacementSelectionActive(active) {
    this.placementSelectionActive = !!active;
  }

  walkToAndWait(tileX, tileY) {
    this.walkTo(tileX, tileY, null);
    return new Promise((resolve) => {
      const check = () => {
        if (!this._character.moving) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  walkTo(tileX, tileY, actionGlyph) {
    const c = this._character;
    // Moving inherently means getting up off whatever furniture — clear
    // the faked sitting/lying pose so it doesn't try to combine with the
    // walk animation. main.js's rest-toggle handler independently calls
    // stop-rest on the server side; this just keeps the visual in sync.
    if (c.restPose) c.restPose = null;
    const startTileX = Math.floor(c.x / TILE), startTileY = Math.floor(c.y / TILE);
    // Pathfinding (fence/building collision) only applies to the outdoor
    // farm — the Marketplace and house interior use their own grids
    // (MARKET_WIDTH/HEIGHT, interior.width/height), not farm.width/height,
    // so running farm-based pathfinding there was rejecting every tap as
    // "out of bounds" and silently refusing to move the character at all.
    if (this.mode === 'outdoor' && this.farm) {
      const path = this._findPath(startTileX, startTileY, tileX, tileY);
      if (path === null) return; // destination is blocked or unreachable — ignore the tap
      c.path = path;
      c.pendingAction = actionGlyph || null;
      this._advanceToNextWaypoint(c);
      return;
    }
    // Market / indoor: simple direct walk, no farm-grid pathfinding.
    c.path = [];
    const targetX = tileX * TILE + TILE / 2, targetY = tileY * TILE + TILE / 2;
    const dx = targetX - c.x, dy = targetY - c.y;
    c.targetX = targetX; c.targetY = targetY;
    if (c.targetX !== c.x) c.facing = c.targetX > c.x ? 1 : -1;
    if (Math.abs(dy) > Math.abs(dx) * 0.6) {
      c.facingDir = dy > 0 ? 'down' : 'up';
    } else if (dx !== 0) {
      c.facingDir = dx > 0 ? 'right' : 'left';
    }
    c.moving = true;
    c.pendingAction = actionGlyph || null;
    if (this.onSelfMove) this.onSelfMove(tileX, tileY);
  }

  // Show the action bounce immediately (used when the farmer is already
  // standing on/near the target tile).
  playAction(glyph) {
    const c = this._character;
    c.actionGlyph = glyph;
    c.actionTimer = 0.7;
  }

  // Sitting on a chair / lying on a bed (see main.js's rest-toggle) — pass
  // null to stand back up. tileX/tileY are the CENTER of the furniture's
  // footprint in tile units (already includes the +width/2 from main.js,
  // not a raw grid_x/grid_y corner), so this multiplies straight by TILE
  // with no extra +TILE/2 — that offset is only right for a plain corner
  // coordinate, and double-applying it here is what pushed the anchor
  // (and so the whole faked lying pose) off to one side of multi-tile
  // furniture like the 2-wide bed.
  setRestPose(pose, tileX, tileY, facingDir) {
    const c = this._character;
    c.restPose = pose;
    if (pose && tileX !== undefined && tileY !== undefined) {
      const wx = tileX * TILE, wy = tileY * TILE;
      c.x = wx; c.y = wy; c.targetX = wx; c.targetY = wy;
      c.path = []; c.moving = false;
      // Face whichever way the chair/bench itself is facing (see
      // ROTATION_TO_FACING in main.js) — previously always snapped to
      // facing straight down regardless of the seat's own rotation, so a
      // chair rotated to face left/right/up still sat the character
      // facing the camera.
      c.facingDir = facingDir || 'down';
    }
  }

  // Enable/disable "hold and drag to keep acting on each tile" — used for
  // the water tool specifically, so watering a whole plot doesn't require
  // tapping every single tile one at a time. Off for every other tool,
  // where a drag still means "pan the map" as usual.
  setDragActEnabled(enabled) {
    this.dragActEnabled = enabled;
    this._lastDragActedTile = null;
  }

  // Tracks which tool is active — the plain tile-highlight box (see
  // _drawHoverHighlight) only shows while a tool is selected (plow/plant/
  // water/harvest/build/feed/etc.), since it's meaningless when just
  // walking around with nothing selected. The separate "this tile has
  // something interactive on it" glow (_drawHoverGlow) is independent of
  // this and always shows regardless of tool state.
  setActiveTool(tool) {
    this.activeTool = tool || null;
  }

  // A little watering-can-tips-and-sprinkles animation over a specific
  // tile, played alongside (not instead of) the usual action bounce —
  // gives watering a distinct, satisfying visual instead of just an emoji.
  playWaterEffect(tileX, tileY) {
    if (!this._waterEffects) this._waterEffects = [];
    this._waterEffects.push({
      x: tileX * TILE + TILE / 2,
      y: tileY * TILE + TILE / 2,
      startedAt: Date.now(),
      duration: 750,
    });
  }

  _drawWaterEffects() {
    if (!this._waterEffects || !this._waterEffects.length) return;
    const ctx = this.ctx;
    const now = Date.now();
    this._waterEffects = this._waterEffects.filter((fx) => now - fx.startedAt < fx.duration);
    for (const fx of this._waterEffects) {
      const p = (now - fx.startedAt) / fx.duration; // 0 -> 1
      const canX = fx.x - TILE * 0.35, canY = fx.y - TILE * 0.85;

      ctx.save();
      ctx.globalAlpha = p < 0.85 ? 1 : (1 - p) / 0.15;

      // watering can (simple tilted body + spout), tips forward then back
      const tilt = Math.sin(Math.min(p, 0.5) / 0.5 * Math.PI) * -0.55;
      ctx.translate(canX, canY);
      ctx.rotate(tilt);
      ctx.fillStyle = '#4a90d9';
      ctx.strokeStyle = '#2b1c10';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      this._roundRect(-9, -6, 16, 13, 3);
      ctx.fill(); ctx.stroke();
      // spout
      ctx.beginPath();
      ctx.moveTo(7, -2); ctx.lineTo(18, -9); ctx.lineTo(20, -6); ctx.lineTo(9, 2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // handle
      ctx.beginPath();
      ctx.arc(-2, -9, 5, Math.PI * 0.9, Math.PI * 2.1);
      ctx.stroke();
      ctx.restore();

      // falling water droplets + a little splash ring on the plant, only
      // while the can is tipped forward (the "pouring" phase)
      if (p > 0.15 && p < 0.85) {
        const pourP = (p - 0.15) / 0.7;
        ctx.save();
        ctx.fillStyle = 'rgba(120,190,255,0.85)';
        for (let i = 0; i < 4; i++) {
          const dropDelay = i * 0.15;
          const dp = Math.max(0, Math.min(1, (pourP - dropDelay) * 2.2));
          if (dp <= 0 || dp >= 1) continue;
          const dx = fx.x + (i - 1.5) * 4;
          const dy = (fx.y - TILE * 0.5) + dp * (TILE * 0.55);
          ctx.beginPath();
          ctx.ellipse(dx, dy, 1.6, 2.6, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        // splash ring pulsing on the ground under the plant
        const ringP = pourP;
        ctx.save();
        ctx.globalAlpha *= 0.5 * (1 - ringP);
        ctx.strokeStyle = '#a8d8ff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(fx.x, fx.y + TILE * 0.18, TILE * 0.18 * (0.5 + ringP * 0.6), TILE * 0.07 * (0.5 + ringP * 0.6), 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _makeClouds() {
    const clouds = [];
    for (let i = 0; i < 6; i++) {
      clouds.push({
        x: Math.random(),
        y: 0.05 + Math.random() * 0.25,
        scale: 0.6 + Math.random() * 0.9,
        speed: 0.004 + Math.random() * 0.006,
      });
    }
    return clouds;
  }

  // Deterministic pseudo-random value in [0,1) for a tile coordinate, so grass
  // texture/speckle patterns stay stable across redraws instead of flickering.
  _hash(x, y, salt) {
    let h = (x * 374761393 + y * 668265263 + salt * 97531) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 10000) / 10000;
  }

  setFarm(farm) {
    const isNewFarm = !this.farm || this.farm.ownerId !== farm.ownerId;
    this.farm = farm;
    // Track the gap between the server's clock and ours at the moment of this
    // fetch, so crop progress/readiness can be estimated every frame between
    // fetches instead of freezing until the next API call comes back.
    this._serverTimeOffset = farm.serverTime - Date.now() / 1000;
    // Only snap the camera (and re-place the character) on an ACTUAL farm
    // switch (first load, or now viewing a different player's farm) —
    // every plow/plant/water/harvest action re-fetches this same farm's
    // data too, and re-centering on every one of those was yanking the
    // zoom/pan back to default mid-play any time the player had manually
    // zoomed or panned. The camera should only move when the player moves it.
    if (isNewFarm) {
      this._centerCamera();
      // place the farmer near the farmhouse (or farm center as a fallback)
      const home = (farm.objects || []).find((o) => o.item_id === 'farmhouse');
      const tx = home ? home.grid_x + 1 : Math.floor(farm.width / 2);
      const ty = home ? home.grid_y + 2 : Math.floor(farm.height / 2);
      const wx = tx * TILE + TILE / 2, wy = ty * TILE + TILE / 2;
      this._character.x = wx; this._character.y = wy;
      this._character.targetX = wx; this._character.targetY = wy;
      this._character.moving = false;
    }
  }

  // Best estimate of the current server-side unix time, extrapolated from the
  // offset captured at the last farm fetch. Used only for smooth visual
  // countdowns — the server remains the sole authority on actual harvest
  // eligibility (re-checked on every plant/harvest/water request).
  _estimatedServerTime() {
    return Date.now() / 1000 + (this._serverTimeOffset || 0);
  }

  // ---- Interior (house) mode ----
  setInteriorMode(interiorData) {
    this.mode = 'indoor';
    this.interior = interiorData;
    this._serverTimeOffset = interiorData.serverTime - Date.now() / 1000;
    // 0.6 tiles of margin on left/right/top matches wallDepth in
    // _drawIndoorRoom — without this, the camera fit only accounted for
    // the bare floor and could clip the wall strips right at the edge of
    // the screen.
    this._centerCameraFor(interiorData.width, interiorData.height, 0.6, 0.6, 0.6, 0);
    const wx = (interiorData.width / 2) * TILE, wy = (interiorData.height * 0.7) * TILE;
    this._character.x = wx; this._character.y = wy;
    this._character.targetX = wx; this._character.targetY = wy;
    this._character.moving = false;
  }

  exitInteriorMode(doorTile) {
    this.mode = 'outdoor';
    this.interior = null;
    // A specific door tile (see main.js's enterInterior, which records
    // exactly where the player walked in) puts them back RIGHT OUTSIDE
    // that same building instead of always snapping back near the
    // farmhouse regardless of which building was actually entered.
    if (doorTile && this.farm) {
      const wx = doorTile.x * TILE + TILE / 2, wy = doorTile.y * TILE + TILE / 2;
      const c = this._character;
      c.x = wx; c.y = wy; c.targetX = wx; c.targetY = wy;
      c.moving = false; c.path = [];
    } else {
      this._repositionOnReturnToFarm();
    }
    if (this.farm) this._centerCamera();
  }

  // ---- Marketplace (shared plaza) mode ----
  setMarketMode(stalls) {
    this.mode = 'market';
    this.market = { stalls };
    this._centerCameraFor(MARKET_WIDTH, MARKET_HEIGHT);
    const wx = (MARKET_WIDTH / 2) * TILE, wy = (MARKET_HEIGHT - 1.5) * TILE;
    this._character.x = wx; this._character.y = wy;
    this._character.targetX = wx; this._character.targetY = wy;
    this._character.moving = false;
  }

  updateMarketStalls(stalls) {
    if (this.market) this.market.stalls = stalls;
  }

  exitMarketMode() {
    this.mode = 'outdoor';
    this.market = null;
    this._repositionOnReturnToFarm();
    if (this.farm) this._centerCamera();
  }

  // ---- Central Park (shared hangout plaza) mode ----
  setParkMode() {
    this.mode = 'park';
    this._centerCameraFor(PARK_WIDTH, PARK_HEIGHT);
    const wx = (PARK_WIDTH / 2) * TILE, wy = (PARK_HEIGHT / 2) * TILE;
    this._character.x = wx; this._character.y = wy;
    this._character.targetX = wx; this._character.targetY = wy;
    this._character.moving = false;
  }

  // The tile just outside the Casino's door — the only walkable tile
  // right below its footprint (see CASINO_BUILDING) — used by main.js to
  // walk the player there before fading into the Casino's interior.
  getCasinoDoorTile() {
    return {
      x: CASINO_BUILDING.x + Math.floor(CASINO_BUILDING.width / 2),
      y: CASINO_BUILDING.y + CASINO_BUILDING.height,
    };
  }

  exitParkMode() {
    this.mode = 'outdoor';
    this._repositionOnReturnToFarm();
    if (this.farm) this._centerCamera();
  }

  // ---- Casino (nested inside the Park) ----
  setCasinoMode(floor) {
    this.mode = 'casino';
    this.casinoFloor = floor || 1;
    this._centerCameraFor(CASINO_INTERIOR_WIDTH, CASINO_INTERIOR_HEIGHT);
    const wx = (CASINO_INTERIOR_WIDTH / 2) * TILE, wy = (CASINO_INTERIOR_HEIGHT * 0.75) * TILE;
    this._character.x = wx; this._character.y = wy;
    this._character.targetX = wx; this._character.targetY = wy;
    this._character.moving = false;
  }

  // Exits back to the PARK (not the farm) — the Casino is nested inside
  // it, same as a coop is nested inside a farm, so leaving one floor up
  // lands you right back where you tapped the building.
  exitCasinoMode() {
    this.mode = 'park';
    this.casinoFloor = null;
    this._centerCameraFor(PARK_WIDTH, PARK_HEIGHT);
    const wx = (CASINO_BUILDING.x + CASINO_BUILDING.width / 2) * TILE;
    const wy = (CASINO_BUILDING.y + CASINO_BUILDING.height + 0.5) * TILE;
    this._character.x = wx; this._character.y = wy;
    this._character.targetX = wx; this._character.targetY = wy;
    this._character.moving = false;
  }

  // The Marketplace and house interior are entirely separate grids from the
  // farm — a character position picked up while in one of those (e.g.
  // standing at market tile (8,10)) is meaningless back on the farm grid,
  // and setFarm()'s "isNewFarm" check doesn't catch this since it's still
  // the same farm/owner. Left alone, the character would sit at a bogus
  // world position — effectively invisible/off in the wrong place — until
  // a full page reload forced a proper reset. Explicitly snap back to a
  // sane spot (by the farmhouse, or the farm center) every time.
  _repositionOnReturnToFarm() {
    if (!this.farm) return;
    const home = (this.farm.objects || []).find((o) => o.item_id === 'farmhouse');
    const tx = home ? home.grid_x + 1 : Math.floor(this.farm.width / 2);
    const ty = home ? home.grid_y + 2 : Math.floor(this.farm.height / 2);
    const wx = tx * TILE + TILE / 2, wy = ty * TILE + TILE / 2;
    const c = this._character;
    c.x = wx; c.y = wy; c.targetX = wx; c.targetY = wy;
    c.moving = false; c.path = [];
  }

  // ---- Build/placement ghost preview ----
  // Shows a translucent preview of whatever the player is about to place,
  // and lets it be rotated before confirming (see rotateGhost / main.js).
  setGhost(ghost) {
    this._ghost = ghost;
  }
  clearGhost() {
    this._ghost = null;
  }
  rotateGhost() {
    if (!this._ghost) return;
    this._ghost.rotation = ((this._ghost.rotation || 0) + 90) % 360;
  }

  // marginLeft/Right/Top/Bottom (in TILE units) let the fit account for
  // decoration that extends past the room's own (0,0)-(gridW,gridH) floor
  // bounds — the interior room's wallpapered wall strips, specifically
  // (see _drawIndoorRoom), which used to get centered as if they didn't
  // exist and could end up clipped/invisible right at the edge of the
  // screen depending on viewport size.
  _centerCameraFor(gridW, gridH, marginLeft = 0, marginRight = 0, marginTop = 0, marginBottom = 0) {
    const worldW = (gridW + marginLeft + marginRight) * TILE;
    const worldH = (gridH + marginTop + marginBottom) * TILE;
    const rect = this.canvas.getBoundingClientRect();
    // Only auto-fit the zoom if the player hasn't manually zoomed yet —
    // once they have, keep their chosen scale and just re-center the
    // (possibly differently-sized) space around it.
    if (!this._userZoomed) {
      this.camera.scale = Math.min(2, Math.min(rect.width / worldW, rect.height / worldH) * 0.9) || 1;
    }
    const contentLeft = -marginLeft * TILE, contentTop = -marginTop * TILE;
    this.camera.x = (rect.width - worldW * this.camera.scale) / 2 - contentLeft * this.camera.scale;
    this.camera.y = (rect.height - worldH * this.camera.scale) / 2 - contentTop * this.camera.scale;
  }

  // Manual "fix my view" button — recenters and re-fits the zoom for
  // whichever space the player is currently in, in case scale/position
  // ever end up looking off (e.g. from repeated pinch-zooming).
  resetView() {
    // The one explicit way to get back to the auto-fit zoom, since normal
    // navigation now preserves whatever zoom the player last set.
    this._userZoomed = false;
    if (this.mode === 'indoor' && this.interior) {
      this._centerCameraFor(this.interior.width, this.interior.height, 0.6, 0.6, 0.6, 0);
    } else if (this.mode === 'market') {
      this._centerCameraFor(MARKET_WIDTH, MARKET_HEIGHT);
    } else if (this.mode === 'casino') {
      this._centerCameraFor(CASINO_INTERIOR_WIDTH, CASINO_INTERIOR_HEIGHT);
    } else {
      this._centerCamera();
    }
  }

  _centerCamera() {
    if (!this.farm) return;
    const worldW = this.farm.width * TILE;
    const worldH = this.farm.height * TILE;
    const rect = this.canvas.getBoundingClientRect();
    // Once the player has manually zoomed, leave the camera position
    // ALONE too, not just the zoom level — this used to still snap
    // camera.x/y back to dead-center every time a building was exited
    // (mansion, coop, barn, any of them) even though the zoom level
    // itself was correctly preserved, which is exactly what read as a
    // jarring "auto zoom + recenter" on every exit.
    if (this._userZoomed) return;
    this.camera.scale = Math.min(1, Math.min(rect.width / worldW, rect.height / worldH) * 0.95) || 1;
    this.camera.x = (rect.width - worldW * this.camera.scale) / 2;
    this.camera.y = (rect.height - worldH * this.camera.scale) / 2;
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.camera.x) / this.camera.scale,
      y: (sy - this.camera.y) / this.camera.scale,
    };
  }

  worldToTile(wx, wy) {
    return { x: Math.floor(wx / TILE), y: Math.floor(wy / TILE) };
  }

  _bindEvents() {
    const c = this.canvas;

    const getPos = (e) => {
      const rect = c.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    };

    const pointerDown = (e) => {
      if (e.touches && e.touches.length === 2) {
        this._pinchDist = this._touchDist(e.touches);
        return;
      }
      if (e.button === 2) {
        // Right mouse button drags the map — kept separate from left-click so
        // panning never fights with left-click farming actions (plow, plant,
        // water, etc. all use a normal left click/tap).
        this._rightDragging = true;
        this._lastPointer = getPos(e);
        return;
      }
      this._dragging = true;
      this._dragMoved = false;
      this._isTouch = !!e.touches;
      this._lastPointer = getPos(e);
    };

    const pointerMove = (e) => {
      // Hover highlight — updates on every mouse move regardless of
      // dragging/pinching/etc below, so whichever tile the mouse is
      // currently pointing at is always known for the highlight box drawn
      // in the render loop. Touch has no real "hover" (there's no pointer
      // position before you actually touch down), so this only matters
      // for mouse — touchmove events land here too but e.touches makes
      // this harmless/no-op-ish for them since there's no persistent hover
      // concept to show.
      if (!e.touches) {
        const pos = getPos(e);
        const world = this.screenToWorld(pos.x, pos.y);
        this._hoverTile = this.worldToTile(world.x, world.y);
      }
      if (e.touches && e.touches.length === 2) {
        const d = this._touchDist(e.touches);
        if (this._pinchDist) {
          const factor = d / this._pinchDist;
          // camera.x/y live in CSS-pixel space (see _centerCamera, which
          // uses getBoundingClientRect()), but canvas.width/height are in
          // device pixels (scaled by devicePixelRatio in _resize()) — using
          // those directly as the zoom-center made every pinch zoom drift
          // the camera further off, worse on high-DPI screens. Use the
          // CSS-pixel rect instead so the zoom center actually matches what
          // the person sees on screen.
          const rect = this.canvas.getBoundingClientRect();
          this._zoomAt(rect.width / 2, rect.height / 2, factor);
        }
        this._pinchDist = d;
        return;
      }
      if (this._rightDragging) {
        const pos = getPos(e);
        this.camera.x += pos.x - this._lastPointer.x;
        this.camera.y += pos.y - this._lastPointer.y;
        this._lastPointer = pos;
        return;
      }
      if (!this._dragging) return;
      const pos = getPos(e);
      const dx = pos.x - this._lastPointer.x;
      const dy = pos.y - this._lastPointer.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._dragMoved = true;

      // Water/Plow/Plant/Harvest: acting on each new tile the pointer
      // passes over, instead of panning — lets you hold and drag across a
      // whole plot to act on it in one motion rather than tapping tile by
      // tile. Also checks for an OBJECT on that tile (a tree, specifically
      // — watering/harvesting a tree goes through onObjectClick, not
      // onTileClick, since a tree is a farm_object, not a plain crop tile)
      // so dragging across trees works the same way dragging across open
      // crop tiles does, instead of needing a separate tap per tree.
      if (this.dragActEnabled && this.onTileClick) {
        const world = this.screenToWorld(pos.x, pos.y);
        const tile = this.worldToTile(world.x, world.y);
        const last = this._lastDragActedTile;
        if (!last || last.x !== tile.x || last.y !== tile.y) {
          this._lastDragActedTile = tile;
          const obj = this._objectAt(tile.x, tile.y);
          if (obj && this.onObjectClick) this.onObjectClick(obj);
          else this.onTileClick(tile.x, tile.y);
        }
        this._lastPointer = pos;
        return;
      }

      // Touch has no right-click equivalent, so a one-finger drag pans the
      // map directly (this is safe on touch specifically: a real tap never
      // triggers noticeable movement, so it doesn't fight with tap-to-act).
      // Mouse dragging still doesn't pan — that's what right-click-drag is
      // for on desktop — only tracked here to tell taps from drags.
      if (this._isTouch) {
        this.camera.x += dx;
        this.camera.y += dy;
      }
      this._lastPointer = pos;
    };

    const pointerUp = (e) => {
      // A touch on mobile fires BOTH 'touchend' and a synthetic 'mouseup'
      // right after it (browser compatibility shim for old code that only
      // listens for mouse events) — without this, a single tap called
      // pointerUp/_handleTap TWICE in a row, which for a toggle-style
      // action like plow (grass<->plowed) looked like "tapping barely did
      // anything" since the second call immediately flipped it back.
      if (e.type === 'touchend' || e.type === 'touchcancel') e.preventDefault();
      this._pinchDist = null;
      if (this._rightDragging) {
        this._rightDragging = false;
        return;
      }
      if (!this._dragging) return;
      this._dragging = false;
      this._lastDragActedTile = null;
      if (!this._dragMoved) {
        const pos = this._lastPointer;
        this._handleTap(pos.x, pos.y);
      }
    };

    c.addEventListener('mousedown', pointerDown);
    window.addEventListener('mousemove', pointerMove);
    window.addEventListener('mouseup', pointerUp);
    c.addEventListener('mouseleave', () => { this._hoverTile = null; });
    c.addEventListener('touchstart', pointerDown, { passive: true });
    c.addEventListener('touchmove', pointerMove, { passive: true });
    c.addEventListener('touchend', pointerUp);
    // Suppress the browser's native right-click menu on the canvas — right
    // click is repurposed for dragging the map instead.
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }, { passive: false });
  }

  _touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.camera.scale = Math.min(2.2, Math.max(0.4, this.camera.scale * factor));
    const after = this.screenToWorld(sx, sy);
    this.camera.x += (after.x - before.x) * this.camera.scale;
    this.camera.y += (after.y - before.y) * this.camera.scale;
    // From here on, entering/exiting the house/market/park should keep this
    // zoom level instead of snapping back to the auto-fit default.
    this._userZoomed = true;
  }

  _handleTap(sx, sy) {
    const world = this.screenToWorld(sx, sy);
    const tile = this.worldToTile(world.x, world.y);

    if (this.mode === 'market') {
      if (!this.market) return;
      if (tile.x < 0 || tile.y < 0 || tile.x >= MARKET_WIDTH || tile.y >= MARKET_HEIGHT) return;
      // Walk the character toward wherever was tapped, for the "wandering
      // the plaza" feel, then also open the stall if one was tapped.
      this.walkTo(tile.x, tile.y, null);
      const stallIndex = MARKET_STALL_POSITIONS.findIndex((p) =>
        tile.x >= p.x && tile.x < p.x + 2 && tile.y >= p.y && tile.y < p.y + 2
      );
      if (stallIndex >= 0 && this.onMarketStallClick) {
        const stallId = stallIndex + 1;
        const stall = (this.market.stalls || []).find((s) => s.id === stallId);
        if (stall) this.onMarketStallClick(stall);
      }
      return;
    }

    if (this.mode === 'park') {
      if (tile.x < 0 || tile.y < 0 || tile.x >= PARK_WIDTH || tile.y >= PARK_HEIGHT) return;
      if (tile.x >= CASINO_BUILDING.x && tile.x < CASINO_BUILDING.x + CASINO_BUILDING.width &&
          tile.y >= CASINO_BUILDING.y && tile.y < CASINO_BUILDING.y + CASINO_BUILDING.height) {
        if (this.onParkCasinoClick) { this.onParkCasinoClick(); return; }
      }
      const bench = PARK_BENCH_POSITIONS.find((p) => p.x === tile.x && p.y === tile.y);
      if (bench && this.onParkBenchClick) {
        this.onParkBenchClick(bench);
        return;
      }
      const cart = PARK_CART_POSITIONS.find((p) => p.x === tile.x && p.y === tile.y);
      if (cart && this.onParkCartClick) {
        this.onParkCartClick(cart);
        return;
      }
      this.walkTo(tile.x, tile.y, null);
      return;
    }

    if (this.mode === 'casino') {
      if (tile.x < 0 || tile.y < 0 || tile.x >= CASINO_INTERIOR_WIDTH || tile.y >= CASINO_INTERIOR_HEIGHT) return;
      const layout = CASINO_FLOOR_LAYOUT[this.casinoFloor] || CASINO_FLOOR_LAYOUT[1];
      // Machines are drawn much taller than the single tile they're
      // registered at (the cabinet + its floating name label extend
      // upward — see _drawCasinoMachine's cabH), so a tap on the exact
      // tile the player is actually LOOKING at (the visible cabinet,
      // mostly above the base tile) used to miss entirely on mobile,
      // where each tile can render at well under a comfortable touch-
      // target size. Hit-test against the machine's real drawn footprint
      // (with a little extra padding on top of that for finger slop)
      // instead of requiring the exact base tile.
      const machine = layout.machines.find((m) => {
        const left = m.x * TILE - TILE * 0.2;
        const right = (m.x + 1) * TILE + TILE * 0.2;
        const top = m.y * TILE - TILE * 1.0; // covers the cabinet (1.7x tile tall) + label above it
        const bottom = (m.y + 1) * TILE + TILE * 0.2;
        return world.x >= left && world.x < right && world.y >= top && world.y < bottom;
      });
      if (machine) {
        this.walkTo(machine.x, machine.y, null);
        if (this.onCasinoMachineClick) this.onCasinoMachineClick(machine.id, machine.type);
        return;
      }
      // Same forgiving-hitbox treatment for the staircase (its up/down
      // arrow is drawn above the tile too).
      const stairs = (layout.stairs || []).find((s) => {
        const left = s.x * TILE - TILE * 0.2;
        const right = (s.x + 1) * TILE + TILE * 0.2;
        const top = s.y * TILE - TILE * 0.6;
        const bottom = (s.y + 1) * TILE + TILE * 0.2;
        return world.x >= left && world.x < right && world.y >= top && world.y < bottom;
      });
      if (stairs) {
        this.walkTo(stairs.x, stairs.y, null);
        if (this.onCasinoStairsClick) this.onCasinoStairsClick(stairs.toFloor);
        return;
      }
      this.walkTo(tile.x, tile.y, null);
      return;
    }

    if (this.mode === 'indoor') {
      if (!this.interior) return;
      if (tile.x < 0 || tile.y < 0 || tile.x >= this.interior.width || tile.y >= this.interior.height) return;
      // See placementSelectionActive's comment in the constructor — while
      // the player is choosing where to put something, ANY tile (even one
      // already occupied, like a Table Lamp going on top of a Table)
      // routes to onTileClick, not onObjectClick.
      if (!this.placementSelectionActive) {
        const obj = this._objectAt(tile.x, tile.y);
        if (obj && this.onObjectClick) { this.onObjectClick(obj); return; }
      }
      if (this.onTileClick) this.onTileClick(tile.x, tile.y);
      return;
    }

    if (!this.farm) return;
    if (tile.x < 0 || tile.y < 0 || tile.x >= this.farm.width || tile.y >= this.farm.height) return;

    // Same reasoning as the indoor branch above — while actively choosing
    // where to place something, let the tap through to onTileClick even
    // over an already-occupied tile, so the server gets a chance to
    // validate/reject it (or accept it, for anything that's meant to
    // stack) instead of the tap being swallowed by object-interaction
    // logic that has no placement behavior of its own.
    if (!this.placementSelectionActive) {
      const obj = this._objectAt(tile.x, tile.y);
      if (obj && this.onObjectClick) {
        this.onObjectClick(obj);
        return;
      }
    }
    if (this.onTileClick) this.onTileClick(tile.x, tile.y);
  }

  _objectAt(x, y) {
    const objects = this.mode === 'indoor' ? (this.interior && this.interior.objects) : (this.farm && this.farm.objects);
    if (!objects) return null;
    for (const obj of objects) {
      const def = this._defFor(obj);
      const w = (def && def.width) || 1;
      const h = (def && def.height) || 1;
      if (x >= obj.grid_x && x < obj.grid_x + w && y >= obj.grid_y && y < obj.grid_y + h) return obj;
    }
    return null;
  }

  _defFor(obj) {
    const catalog = window.GameCatalog;
    if (!catalog) return null;
    const list = obj.object_type === 'building' ? catalog.buildings
      : obj.object_type === 'decoration' ? catalog.decorations
      : obj.object_type === 'interior' ? catalog.interiors
      : catalog.animals;
    return (list || []).find((d) => d.id === obj.item_id);
  }

  _loop() {
    try {
      const now = Date.now();
      const dt = Math.min(0.1, (now - this._lastFrameTime) / 1000);
      this._lastFrameTime = now;
      this._updateCharacter(dt, now);
      this._draw();
    } catch (err) {
      // Never let a drawing bug permanently freeze the canvas — log it and
      // keep the loop alive so the game recovers on its own next frame.
      // If the error happened between a ctx.save() and its matching
      // ctx.restore(), the canvas save-stack is left with an orphaned
      // entry — harmless once (the transform reset at the top of _draw()
      // handles the visual symptom), but if the same bug fires every
      // frame it would grow forever. restore() is a documented no-op once
      // the stack is empty, so calling it a few extra times is always safe.
      for (let i = 0; i < 5; i++) this.ctx.restore();
      console.error('FarmGame render error:', err);
    }
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _updateCharacter(dt, now) {
    this._updateActor(this._character, dt, now);
    if (this._character.chatTimer > 0) {
      this._character.chatTimer -= dt;
      if (this._character.chatTimer <= 0) { this._character.chatTimer = 0; this._character.chatText = null; }
    }
    for (const actor of this.remotePlayers.values()) {
      this._updateActor(actor, dt, now);
      if (actor.chatTimer > 0) {
        actor.chatTimer -= dt;
        if (actor.chatTimer <= 0) { actor.chatTimer = 0; actor.chatText = null; }
      }
    }
  }

  // Shared walking-interpolation logic for both the local character and any
  // remote players sharing the current space.
  _updateActor(c, dt, now) {
    const speed = TILE * 3.2; // world units per second
    if (c.moving) {
      const dx = c.targetX - c.x, dy = c.targetY - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) {
        c.x = c.targetX; c.y = c.targetY;
        if (c.path && c.path.length > 0) {
          this._advanceToNextWaypoint(c);
        } else {
          c.moving = false;
          if (c.pendingAction) { this.playAction(c.pendingAction); c.pendingAction = null; }
        }
      } else {
        const step = Math.min(dist, speed * dt);
        c.x += (dx / dist) * step;
        c.y += (dy / dist) * step;
      }
      c.bob = Math.sin((now / 1000) * 12) * 3;
      if (c.walkFrameTimer !== undefined) {
        c.walkFrameTimer += dt;
        if (c.walkFrameTimer > 0.22) { c.walkFrameTimer = 0; c.walkFrame = c.walkFrame === 0 ? 1 : 0; }
      }
    } else {
      c.bob = 0;
    }
    if (c.actionTimer > 0) {
      c.actionTimer -= dt;
      if (c.actionTimer <= 0) { c.actionTimer = 0; c.actionGlyph = null; }
    }
  }

  _draw() {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    // If a previous frame threw mid-draw (after ctx.save()/translate() but
    // before the matching ctx.restore()), the canvas would be left with a
    // leaked transform — and since clearRect() is itself affected by the
    // current transform, the "clear" wouldn't actually clear the visible
    // area, leaving old content behind and compounding worse every frame
    // (this is what caused the receding-staircase-of-grass bug). Resetting
    // to the identity transform first guarantees a clean slate every frame
    // no matter what happened previously.
    ctx.setTransform(this._dpr || 1, 0, 0, this._dpr || 1, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (this.mode === 'market') {
      if (!this.market) return;
      this._drawSky(rect);
      ctx.save();
      ctx.translate(this.camera.x, this.camera.y);
      ctx.scale(this.camera.scale, this.camera.scale);
      this._drawMarketPlaza();
      this._drawMarketStalls();
      this._drawPeopleSorted();
      this._drawCharacterOverlay();
      this._drawMarketBorder();
      ctx.restore();
      this._drawWeatherOverlay(rect);
      return;
    }

    if (this.mode === 'park') {
      this._drawSky(rect);
      ctx.save();
      ctx.translate(this.camera.x, this.camera.y);
      ctx.scale(this.camera.scale, this.camera.scale);
      this._drawParkPlaza();
      this._drawPeopleSorted();
      this._drawCharacterOverlay();
      this._drawParkBorder();
      ctx.restore();
      this._drawWeatherOverlay(rect);
      return;
    }

    if (this.mode === 'casino') {
      ctx.save();
      ctx.translate(this.camera.x, this.camera.y);
      ctx.scale(this.camera.scale, this.camera.scale);
      this._drawCasinoRoom();
      this._drawCasinoFloorContents(this.casinoFloor || 1);
      this._drawPeopleSorted();
      this._drawCharacterOverlay();
      ctx.restore();
      return;
    }

    if (this.mode === 'indoor') {
      if (!this.interior) return;
      ctx.save();
      ctx.translate(this.camera.x, this.camera.y);
      ctx.scale(this.camera.scale, this.camera.scale);
      this._drawIndoorRoom();
      this._drawIndoorObjects();
      this._drawHoverGlow(this.interior.width, this.interior.height);
      this._drawHoverHighlight(this.interior.width, this.interior.height);
      this._drawGhost();
      this._drawPeopleSorted();
      this._drawCharacterOverlay();
      ctx.restore();
      // Houses/coops/barns/mansions get dark at night same as outdoors —
      // without a placed table lamp to punch through it, a house at 2am
      // is just as dark inside as the farm is outside.
      this._drawWeatherOverlay(rect);
      return;
    }

    if (!this.farm) return;

    this._drawSky(rect);

    ctx.save();
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.scale, this.camera.scale);

    this._drawFarmShadowBase();
    this._visibleBounds = this._getVisibleTileBounds();
    this._drawTiles();
    this._drawFlatDecorations();
    this._drawSceneSorted();
    this._drawWaterEffects();
    this._drawHoverGlow(this.farm.width, this.farm.height);
    this._drawHoverHighlight(this.farm.width, this.farm.height);
    this._drawGhost();
    this._drawCharacterOverlay();
    this._drawWoodenBorder();

    ctx.restore();
    this._drawWeatherOverlay(rect);
  }

  // A soft highlight box on whichever tile the mouse is currently pointing
  // at (see the pointerMove hover tracking) — only while a tool is active
  // (plow/plant/water/harvest/build/feed/etc, see setActiveTool), since
  // it's meaningless clutter while just walking around with nothing
  // selected. Skipped when there's no hover tile (touch devices, or the
  // mouse has left the canvas) or it's outside the playable area.
  _drawHoverHighlight(boundsW, boundsH) {
    if (!this._hoverTile || !this.activeTool) return;
    const { x, y } = this._hoverTile;
    if (x < 0 || y < 0 || x >= boundsW || y >= boundsH) return;
    const ctx = this.ctx;
    const px = x * TILE, py = y * TILE;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(px, py, TILE, TILE);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);
    ctx.restore();
  }

  // A warm golden glow around whatever's under the mouse IF it's something
  // that actually DOES something when tapped — a crop (water/harvest), an
  // animal (feed/collect), or one of a specific set of buildings/furniture
  // with a real tap-function (enters a room, opens a crafting panel, lets
  // you sit/lie down, etc). Deliberately NOT every farm_object — plenty of
  // decorations (a fence, a painting, a rug, a path tile) do nothing
  // special when tapped with no tool active, so they don't glow either;
  // glowing them would just be visual noise that doesn't mean anything.
  // Unlike _drawHoverHighlight above, this shows regardless of whether a
  // tool is active — it answers "does this thing do something", not
  // "where will my current tool land".
  static FUNCTIONAL_ITEM_IDS = new Set([
    'farmhouse', 'chicken_coop', 'cow_barn', 'barn', // enterable buildings
    'silo', 'workshop', 'storage_shed', 'stove', // buildings/furniture that open a panel
    'bed', 'chair', 'bench', 'crafted_bed', 'crafted_chair', 'crafted_bench', // sit/lie
    'tree', // water/harvest depending on growth stage
  ]);
  _drawHoverGlow(boundsW, boundsH) {
    if (!this._hoverTile) return;
    const { x, y } = this._hoverTile;
    if (x < 0 || y < 0 || x >= boundsW || y >= boundsH) return;

    let fx = x, fy = y, fw = 1, fh = 1;
    const crop = this.mode !== 'indoor' && this.farm && this.farm.crops
      ? this.farm.crops.find((c) => c.tile_x === x && c.tile_y === y) : null;
    if (!crop) {
      const obj = this._objectAt(x, y);
      const isFunctional = obj && (obj.object_type === 'animal' || FarmGame.FUNCTIONAL_ITEM_IDS.has(obj.item_id));
      if (!isFunctional) return; // nothing interactive here — no glow
      const def = this._defFor(obj);
      fx = obj.grid_x; fy = obj.grid_y;
      fw = (def && def.width) || 1; fh = (def && def.height) || 1;
    }

    const ctx = this.ctx;
    const px = fx * TILE, py = fy * TILE, pw = fw * TILE, ph = fh * TILE;
    ctx.save();
    ctx.shadowColor = 'rgba(255,221,136,0.9)';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(255,221,136,0.85)';
    ctx.lineWidth = 3;
    ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    ctx.restore();
  }




  // Lighter version of _drawSceneSorted for the Marketplace: no crops/objects
  // to sort against, just making sure players standing near each other
  // occlude correctly based on position instead of the character always
  // drawing on top of everyone else.
  _drawPeopleSorted() {
    const items = [];
    for (const actor of this.remotePlayers.values()) {
      // Same restBoost reasoning as the local character below — without
      // it, a friend sitting on a bench/chair sorted behind the furniture
      // from everyone ELSE's point of view (their own screen looked fine
      // to them, since their local character always got the boost, but
      // remote viewers never applied it to what they saw of the OTHER
      // person).
      const actorRestBoost = actor.restPose ? TILE * 0.8 : 0;
      items.push({ sortY: actor.y + TILE * 0.28 + actorRestBoost, draw: () => this._drawSimpleAvatar(actor) });
    }
    const c = this._character;
    // When sitting/lying, the character's world position gets snapped
    // right onto the furniture's own tile — with no extra push, that
    // leaves its sort position TIED with (or even behind) the furniture
    // it's on, so the furniture's own backrest/frame could draw on top
    // of the character instead of the other way around. A resting
    // character should always read as sitting IN FRONT of/ON the
    // furniture, so give it a large sort-position boost while resting.
    const restBoost = c.restPose ? TILE * 0.8 : 0;
    items.push({ sortY: c.y + TILE * 0.28 + restBoost, draw: () => this._drawCharacter() });
    items.sort((a, b) => a.sortY - b.sortY);
    for (const item of items) item.draw();
  }

  // Draws crops, buildings/decorations/animals, remote players, and the
  // local character all together, ordered by how far "down" each one sits
  // (its ground-contact Y) so something in front visually covers something
  // behind it — this is what stops a crop or building in a farther row from
  // appearing to float in front of (or through) the character. Without this,
  // every item type was drawn in its own fixed pass regardless of position,
  // which is why a crop one tile behind the player could show up overlapping
  // their head.
  // Flat, ground-level decorations (a paved path, a pond's surface) aren't
  // "objects standing on a tile" the way a fence or tree is — they're part
  // of the ground itself, so they must never be depth-sorted against the
  // character. Sorting them like a vertical object was why the character
  // could appear to walk "under" a path tile instead of over it.
  static FLAT_DECORATIONS = new Set(['path', 'pond']);

  _drawSceneSorted() {
    const t = this._estimatedServerTime();
    const items = [];
    const b = this._visibleBounds;
    // Same viewport-culling reasoning as _drawTiles/_drawFlatDecorations —
    // a crop/object outside the visible area doesn't need to be drawn OR
    // even added to the depth-sort list, so this scales with what's
    // actually on screen instead of the whole farm's total crop/object
    // count. Remote players and the local character are never culled —
    // there are only ever a handful of those at once regardless of farm
    // size, so it's not worth the complexity.
    const inView = (gx, gy) => !b || (gx >= b.minX && gx <= b.maxX && gy >= b.minY && gy <= b.maxY);

    for (const crop of this.farm.crops) {
      if (!inView(crop.tile_x, crop.tile_y)) continue;
      items.push({ sortY: (crop.tile_y + 1) * TILE, draw: () => this._drawCropItem(crop, t) });
    }
    for (const obj of this.farm.objects) {
      if (obj.object_type === 'decoration' && FarmGame.FLAT_DECORATIONS.has(obj.item_id)) continue;
      if (!inView(obj.grid_x, obj.grid_y)) continue;
      const def = this._defFor(obj);
      const h = (def && def.height) || 1;
      items.push({ sortY: (obj.grid_y + h) * TILE, draw: () => this._drawObjectItem(obj, t) });
    }
    for (const actor of this.remotePlayers.values()) {
      // Same restBoost as the local character below — otherwise a friend
      // sitting on outdoor bench/furniture sorted behind it from
      // everyone else's point of view, even though it looked fine on
      // their own screen (their local character always got the boost).
      const actorRestBoost = actor.restPose ? TILE * 0.8 : 0;
      items.push({ sortY: actor.y + TILE * 0.28 + actorRestBoost, draw: () => this._drawSimpleAvatar(actor) });
    }
    const c = this._character;
    // When sitting/lying, the character's world position gets snapped
    // right onto the furniture's own tile — with no extra push, that
    // leaves its sort position TIED with (or even behind) the furniture
    // it's on, so the furniture's own backrest/frame could draw on top
    // of the character instead of the other way around. A resting
    // character should always read as sitting IN FRONT of/ON the
    // furniture, so give it a large sort-position boost while resting.
    const restBoost = c.restPose ? TILE * 0.8 : 0;
    items.push({ sortY: c.y + TILE * 0.28 + restBoost, draw: () => this._drawCharacter() });

    items.sort((a, b) => a.sortY - b.sortY);
    for (const item of items) item.draw();
  }

  // Draws flat ground-level decorations (paths, ponds) — called as part of
  // the base ground layer, before anything gets depth-sorted on top of it.
  _drawFlatDecorations() {
    const t = this._estimatedServerTime();
    const b = this._visibleBounds;
    for (const obj of this.farm.objects) {
      if (obj.object_type === 'decoration' && FarmGame.FLAT_DECORATIONS.has(obj.item_id)) {
        // Same viewport-culling reasoning as _drawTiles above — skip
        // anything outside the visible area instead of drawing every
        // decoration on the whole farm every frame.
        if (b && (obj.grid_x < b.minX || obj.grid_x > b.maxX || obj.grid_y < b.minY || obj.grid_y > b.maxY)) continue;
        this._drawObjectItem(obj, t);
      }
    }
  }

  // Time-of-day tint + a December snowfall, both driven off the player's
  // actual real-world clock (not an in-game clock) — drawn last, in screen
  // space, so it uniformly washes over the whole scene regardless of pan/zoom.
  _drawWeatherOverlay(rect) {
    const ctx = this.ctx;
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const isChristmasSeason = now.getMonth() === 11; // December

    // Day/night tint by hour: dawn ~5-7, day 7-17, dusk 17-19, night 19-5
    let tint = null, alpha = 0;
    if (hour >= 19 || hour < 5) {
      tint = '#0a1a4a'; alpha = 0.42; // night
    } else if (hour >= 5 && hour < 7) {
      const p = (hour - 5) / 2; // dawn fading out
      tint = '#ff9d5c'; alpha = 0.28 * (1 - p);
    } else if (hour >= 17 && hour < 19) {
      const p = (hour - 17) / 2; // dusk fading in
      tint = '#ff7a3d'; alpha = 0.28 * p;
    }
    if (tint && alpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.restore();

      // Lamp posts push the darkness back a bit around them — drawn here
      // (screen space, after the dark tint) rather than as part of the
      // lamp's own world-space drawing, since it needs to sit ON TOP of
      // the darkening overlay to actually cut into it.
      //
      // Kept deliberately subtle: earlier this used a much bigger radius
      // PLUS a second separate additive warm-glow layer on top of the
      // punch-through — fine for one isolated lamp, but with several
      // lamps anywhere near each other the additive layers stacked on
      // top of each other every time their circles overlapped, turning
      // into solid blown-out white blobs instead of a soft glow. Now it's
      // a single pass, smaller, and capped low enough that even several
      // overlapping lamps can't blow out past a gentle warm dimming.
      const isFullNight = hour >= 19 || hour < 5;
      // Houses/coops/barns/mansions get dark at night too now — same tint,
      // just sourced from interior.objects instead of farm.objects when
      // indoors, so a placed table lamp punches through the dark exactly
      // like an outdoor Lamp Post does.
      const lampSources = this.mode === 'indoor' ? (this.interior && this.interior.objects) : (this.farm && this.farm.objects);
      if (isFullNight && lampSources) {
        for (const obj of lampSources) {
          const isOutdoorLamp = obj.object_type === 'decoration' && obj.item_id === 'lamp';
          const isIndoorLamp = obj.object_type === 'interior' && (obj.item_id === 'table_lamp' || obj.item_id === 'wall_light');
          if (!isOutdoorLamp && !isIndoorLamp) continue;
          let worldX = (obj.grid_x + 0.5) * TILE;
          let worldY = (obj.grid_y + 0.55) * TILE; // roughly where the lamp's glass/bulb sits
          // Wall Light's actual bulb isn't at that floor-level spot at
          // all anymore — it's mounted up in whichever wall band
          // _drawIndoorObjects placed it in, so the punch-through glow
          // needs to follow it there instead of lighting up an empty
          // patch of floor next to the fixture.
          if (obj.item_id === 'wall_light' && this.interior) {
            if (obj.grid_y === 0) {
              worldY = obj.grid_y * TILE - TILE * 0.3; // up in the back wall band
            } else if (obj.grid_x === 0) {
              worldX = obj.grid_x * TILE - TILE * 0.3; // out in the left wall band
            } else if (obj.grid_x === this.interior.width - 1) {
              worldX = (obj.grid_x + 1) * TILE + TILE * 0.3; // out in the right wall band
            }
          }
          const sx = worldX * this.camera.scale + this.camera.x;
          const sy = worldY * this.camera.scale + this.camera.y;
          const radius = TILE * 1.1 * this.camera.scale;
          if (sx < -radius || sx > rect.width + radius || sy < -radius || sy > rect.height + radius) continue; // off-screen, skip

          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          const punch = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
          punch.addColorStop(0, 'rgba(0,0,0,0.55)');
          punch.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = punch;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    if (isChristmasSeason) {
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.restore();
      this._drawSnowfall(rect);
    }
  }

  _drawSnowfall(rect) {
    if (!this._snowflakes) {
      this._snowflakes = [];
      for (let i = 0; i < 45; i++) {
        this._snowflakes.push({
          x: Math.random(), y: Math.random(),
          size: 2 + Math.random() * 3,
          speed: 0.02 + Math.random() * 0.03,
          drift: Math.random() * 0.4 - 0.2,
        });
      }
    }
    const ctx = this.ctx;
    const t = (Date.now() - this._startTime) / 1000;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const f of this._snowflakes) {
      const fy = (f.y + t * f.speed) % 1.05;
      const fx = (f.x + Math.sin(t * 0.5 + f.y * 10) * 0.02) % 1;
      ctx.beginPath();
      ctx.arc(fx * rect.width, fy * rect.height, f.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- Marketplace plaza rendering ----
  _drawMarketPlaza() {
    const ctx = this.ctx;
    const stoneShades = ['#c9c2b0', '#bfb7a2', '#d4cdb9'];
    for (let y = 0; y < MARKET_HEIGHT; y++) {
      for (let x = 0; x < MARKET_WIDTH; x++) {
        const rnd = this._hash(x, y, 5);
        ctx.fillStyle = stoneShades[Math.floor(rnd * stoneShades.length)];
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        ctx.strokeStyle = 'rgba(0,0,0,0.06)';
        ctx.strokeRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    // central walkway strip, a bit lighter, running through the gap between
    // the second and third rows of stalls
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(0, 6 * TILE, MARKET_WIDTH * TILE, 2 * TILE);

    // a small fountain as the plaza's centerpiece
    const fx = (MARKET_WIDTH / 2) * TILE, fy = 7 * TILE;
    ctx.fillStyle = 'rgba(20,30,10,0.2)';
    ctx.beginPath(); ctx.ellipse(fx, fy + 14, 34, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a9a08a';
    ctx.beginPath(); ctx.ellipse(fx, fy, 32, 22, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5ab0ff';
    ctx.beginPath(); ctx.ellipse(fx, fy, 24, 16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c9c2b0';
    ctx.beginPath(); ctx.arc(fx, fy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(fx, fy, 8 + i * 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawMarketStalls() {
    const ctx = this.ctx;
    const stalls = (this.market && this.market.stalls) || [];
    const stallStyle = { roof: '#e8a527', roofDark: '#c98a12', wall: '#8b5e34', stripe: '#fff' };

    MARKET_STALL_POSITIONS.forEach((pos, i) => {
      const stallId = i + 1;
      const data = stalls.find((s) => s.id === stallId);
      const px = pos.x * TILE, py = pos.y * TILE;
      const pw = 2 * TILE, ph = 2 * TILE;

      ctx.fillStyle = 'rgba(30,20,10,0.2)';
      ctx.beginPath();
      ctx.ellipse(px + pw / 2, py + ph - 6, pw * 0.4, 8, 0, 0, Math.PI * 2);
      ctx.fill();

      this._drawStall(px, py, pw, ph, stallStyle);

      // name/status tag above the stall
      ctx.font = 'bold 11px Nunito, sans-serif';
      ctx.textAlign = 'center';
      const tagY = py - 8;
      const listings = (data && data.listings) || [];
      let label = 'Empty — for rent';
      if (data && data.renterUsername) {
        if (!listings.length) label = `${data.renterUsername} (no stock)`;
        else if (listings.length === 1) label = `${data.renterUsername}: ${listings[0].quantity} left`;
        else label = `${data.renterUsername}: ${listings.length} items`;
      }
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(94,59,31,0.85)';
      this._roundRect(px + pw / 2 - tw / 2 - 6, tagY - 12, tw + 12, 16, 8);
      ctx.fill();
      ctx.fillStyle = '#fff6e3';
      ctx.fillText(label, px + pw / 2, tagY);

      if (listings.length === 1) {
        ctx.font = 'bold 10px Nunito, sans-serif';
        ctx.fillStyle = '#e8a527';
        ctx.fillText(`🪙${listings[0].price}`, px + pw / 2, py + ph + 12);
      } else if (listings.length > 1) {
        ctx.font = 'bold 10px Nunito, sans-serif';
        ctx.fillStyle = '#e8a527';
        ctx.fillText('tap to browse', px + pw / 2, py + ph + 12);
      }
    });
  }

  _drawMarketBorder() {
    const ctx = this.ctx;
    const w = MARKET_WIDTH * TILE, h = MARKET_HEIGHT * TILE;
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 8;
    ctx.strokeRect(-1, -1, w + 2, h + 2);
    ctx.strokeStyle = '#8a5a34';
    ctx.lineWidth = 3;
    ctx.strokeRect(-1, -1, w + 2, h + 2);
  }

  // Grass field with a path grid, some trees around the edges, and fixed
  // benches players can actually sit at (see main.js's rest-toggle, which
  // already knows how to handle a 'bench' decoration — this just gives it
  // a shared space to live in instead of only the player's own farm).
  _drawParkPlaza() {
    const ctx = this.ctx;
    const grassShades = ['#8fc93a', '#86c134', '#93cf42'];
    for (let y = 0; y < PARK_HEIGHT; y++) {
      for (let x = 0; x < PARK_WIDTH; x++) {
        const rnd = this._hash(x, y, 9);
        ctx.fillStyle = grassShades[Math.floor(rnd * grassShades.length)];
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    // a simple cross-shaped path through the middle
    ctx.fillStyle = 'rgba(201,168,118,0.55)';
    ctx.fillRect(0, (PARK_HEIGHT / 2 - 1) * TILE, PARK_WIDTH * TILE, 2 * TILE);
    ctx.fillRect((PARK_WIDTH / 2 - 1) * TILE, 0, 2 * TILE, PARK_HEIGHT * TILE);

    for (const { x, y } of PARK_TREE_POSITIONS) {
      this._drawDecorationShape(ctx, DECORATION_STYLE.tree, x * TILE, y * TILE, TILE, TILE);
    }
    this._drawCasinoBuilding();
    for (const { x, y } of PARK_BENCH_POSITIONS) {
      this._drawDecorationShape(ctx, DECORATION_STYLE.bench, x * TILE, y * TILE, TILE, TILE);
    }
    for (const cart of PARK_CART_POSITIONS) {
      this._drawSnackCart(cart.x * TILE, cart.y * TILE, cart.itemId);
    }
  }

  // The Casino building, drawn as real illustrated art (same technique as
  // _drawMansionSprite — scaled to fit the footprint while preserving the
  // image's own aspect ratio, anchored to the bottom of the footprint so
  // it sits on the ground instead of floating). A pulsing "CASINO — tap to
  // enter" marquee label floats above it, since (unlike outdoor farm
  // buildings) there's no separate door tile — the whole footprint is
  // clickable (see the park tap handler above).
  _drawCasinoBuilding() {
    const ctx = this.ctx;
    const x = CASINO_BUILDING.x * TILE, y = CASINO_BUILDING.y * TILE;
    const w = CASINO_BUILDING.width * TILE, h = CASINO_BUILDING.height * TILE;
    const img = getBuildingSprite('casino');
    if (!img.complete || !img.naturalWidth) {
      ctx.fillStyle = '#2a1a40';
      ctx.fillRect(x, y, w, h);
      return;
    }
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = w / h;
    let dw, dh;
    if (imgRatio > boxRatio) {
      dw = w;
      dh = w / imgRatio;
    } else {
      dh = h;
      dw = h * imgRatio;
    }
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh);
    ctx.drawImage(img, dx, dy, dw, dh);

    // Soft pulsing glow + "tap to enter" marquee text, so the building
    // reads as interactive rather than pure scenery.
    const pulse = 0.55 + 0.25 * Math.sin(Date.now() / 400);
    ctx.save();
    ctx.font = `bold ${Math.floor(TILE * 0.32)}px 'Baloo 2', sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(255,215,90,${pulse})`;
    ctx.strokeStyle = 'rgba(60,20,10,0.9)';
    ctx.lineWidth = 3;
    const labelX = x + w / 2, labelY = y - TILE * 0.15;
    ctx.strokeText('🎰 Tap to Enter', labelX, labelY);
    ctx.fillText('🎰 Tap to Enter', labelX, labelY);
    ctx.restore();
  }

  // A little vendor cart — canopy + counter + wheels, tinted per snack and
  // topped with the snack's own emoji so it's obvious what's sold there
  // without needing a label to be visible at every zoom level.
  _drawSnackCart(px, py, itemId) {
    const ctx = this.ctx;
    const w = TILE, h = TILE;
    const canopyColor = itemId === 'ice_cream' ? '#e05a7e' : '#c0392b';
    const canopyColor2 = itemId === 'ice_cream' ? '#fff6e3' : '#f4c95d';
    const emoji = itemId === 'ice_cream' ? '🍦' : '🌭';

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(px + w / 2, py + h * 0.92, w * 0.4, h * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // wheels
    ctx.fillStyle = '#3a2a1a';
    ctx.beginPath(); ctx.arc(px + w * 0.28, py + h * 0.82, w * 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(px + w * 0.72, py + h * 0.82, w * 0.08, 0, Math.PI * 2); ctx.fill();

    // counter/body
    ctx.fillStyle = '#8b5e34';
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this._roundRect(px + w * 0.14, py + h * 0.5, w * 0.72, h * 0.32, 4);
    ctx.fill(); ctx.stroke();

    // striped canopy (a little scalloped roof)
    const stripeCount = 5;
    const canopyY = py + h * 0.18, canopyH = h * 0.22, canopyX = px + w * 0.08, canopyW = w * 0.84;
    for (let i = 0; i < stripeCount; i++) {
      ctx.fillStyle = i % 2 === 0 ? canopyColor : canopyColor2;
      ctx.fillRect(canopyX + (canopyW / stripeCount) * i, canopyY, canopyW / stripeCount, canopyH);
    }
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(canopyX, canopyY, canopyW, canopyH);
    // little support poles
    ctx.strokeStyle = '#8b5e34';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + w * 0.18, py + h * 0.4); ctx.lineTo(px + w * 0.18, canopyY + canopyH);
    ctx.moveTo(px + w * 0.82, py + h * 0.4); ctx.lineTo(px + w * 0.82, canopyY + canopyH);
    ctx.stroke();

    // the snack emoji, front and center
    ctx.font = `${Math.floor(h * 0.32)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, px + w / 2, py + h * 0.42);
  }

  _drawParkBorder() {
    const ctx = this.ctx;
    const w = PARK_WIDTH * TILE, h = PARK_HEIGHT * TILE;
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 8;
    ctx.strokeRect(-1, -1, w + 2, h + 2);
    ctx.strokeStyle = '#8a5a34';
    ctx.lineWidth = 3;
    ctx.strokeRect(-1, -1, w + 2, h + 2);
  }

  // ---- Casino interior rendering ----
  // Deep red/maroon checkerboard carpet + gold trim, distinct from the
  // plain wood-plank house interior — reads as a casino floor at a glance.
  _drawCasinoRoom() {
    const ctx = this.ctx;
    const w = CASINO_INTERIOR_WIDTH * TILE, h = CASINO_INTERIOR_HEIGHT * TILE;
    const carpetColors = ['#6b1420', '#7d1828'];
    for (let y = 0; y < CASINO_INTERIOR_HEIGHT; y++) {
      for (let x = 0; x < CASINO_INTERIOR_WIDTH; x++) {
        ctx.fillStyle = carpetColors[(x + y) % 2];
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    ctx.strokeStyle = 'rgba(232,197,71,0.3)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= CASINO_INTERIOR_WIDTH; x++) {
      ctx.beginPath(); ctx.moveTo(x * TILE, 0); ctx.lineTo(x * TILE, h); ctx.stroke();
    }

    // dark wallpapered back wall strip along the top, gold-trimmed
    ctx.fillStyle = '#241332';
    ctx.fillRect(0, -TILE * 0.6, w, TILE * 0.6);
    ctx.strokeStyle = '#e8c547';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, -TILE * 0.6, w, TILE * 0.6);

    // gold room border
    ctx.strokeStyle = '#e8c547';
    ctx.lineWidth = 6;
    ctx.strokeRect(-1, -1, w + 2, h + 2);
  }

  _drawCasinoFloorContents(floor) {
    const layout = CASINO_FLOOR_LAYOUT[floor] || CASINO_FLOOR_LAYOUT[1];
    for (const m of layout.machines) {
      this._drawCasinoMachine(m.id, m.type, m.x * TILE, m.y * TILE, TILE, TILE);
    }
    for (const s of layout.stairs || []) {
      this._drawCasinoStaircase(s.x * TILE, s.y * TILE, TILE, TILE, s.direction);
    }
  }

  // Dispatches to the right cabinet shape per machine, plus a shared
  // ground shadow and a small "#N" badge above every machine (the floor
  // is single-type, so the cabinet art alone already says WHICH game this
  // is — the badge just tells 15 identical copies apart). If someone else
  // currently has this exact machine locked (see the casino:lock socket
  // flow), it's dimmed with a red "IN USE — <name>" overlay instead.
  _drawCasinoMachine(machineId, type, px, py, tw, th) {
    const ctx = this.ctx;
    const cabH = th * 1.7; // taller than 1 tile, anchored to the bottom of the footprint
    const x = px, y = py + th - cabH;
    const w = tw;
    const lockedBy = this.casinoLocks && this.casinoLocks.get(machineId);

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(px + tw / 2, py + th * 0.94, tw * 0.44, th * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    if (lockedBy) ctx.globalAlpha = 0.55;
    if (type === 'color_game') this._drawColorGameCabinet(x, y, w, cabH);
    else if (type === 'claw_machine') this._drawClawMachineCabinet(x, y, w, cabH);
    else if (type === 'slot_777') this._drawSlot777Cabinet(x, y, w, cabH);
    ctx.restore();

    const badge = '#' + machineId.replace(/^\D+_/, '');
    ctx.save();
    ctx.font = `bold ${Math.floor(th * 0.22)}px 'Baloo 2', sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 3;
    ctx.fillStyle = '#fff6e3';
    const lx = x + w / 2, ly = y - th * 0.12;
    ctx.strokeText(badge, lx, ly);
    ctx.fillText(badge, lx, ly);
    ctx.restore();

    if (lockedBy) {
      ctx.save();
      ctx.fillStyle = 'rgba(160,20,20,0.35)';
      ctx.fillRect(x, y, w, cabH);
      ctx.font = `bold ${Math.floor(th * 0.16)}px 'Baloo 2', sans-serif`;
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.lineWidth = 3;
      ctx.fillStyle = '#ffdede';
      const ly2 = y + cabH * 0.5;
      ctx.strokeText('🔒 IN USE', x + w / 2, ly2 - th * 0.14);
      ctx.fillText('🔒 IN USE', x + w / 2, ly2 - th * 0.14);
      ctx.strokeText(lockedBy, x + w / 2, ly2 + th * 0.1);
      ctx.fillText(lockedBy, x + w / 2, ly2 + th * 0.1);
      ctx.restore();
    }
  }

  // "Color Game" cabinet — a carnival drop-box: a teal crate with an
  // open top (small colored cube prizes visible inside) and a handle up
  // top, sitting on a stand with a 2x3 grid of the 6 color swatches on
  // its front face — matches the reference photo the player shared.
  _drawColorGameCabinet(x, y, w, h) {
    const ctx = this.ctx;
    const colors = ['#e8c547', '#f4f4f4', '#e05a7e', '#3d8fe0', '#c0392b', '#4f8f2e']; // yellow, white, pink, blue, red, green

    // legs/stand
    const boxY = y + h * 0.18, boxH = h * 0.5;
    ctx.strokeStyle = '#2a6e6e';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.12, boxY + boxH); ctx.lineTo(x + w * 0.08, y + h);
    ctx.moveTo(x + w * 0.88, boxY + boxH); ctx.lineTo(x + w * 0.92, y + h);
    ctx.stroke();

    // handle frame up top
    ctx.strokeStyle = '#2a6e6e';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.38, boxY); ctx.lineTo(x + w * 0.38, y);
    ctx.lineTo(x + w * 0.62, y); ctx.lineTo(x + w * 0.62, boxY);
    ctx.stroke();

    // crate body
    ctx.fillStyle = '#2fa9a9';
    ctx.fillRect(x + w * 0.08, boxY, w * 0.84, boxH);
    ctx.strokeStyle = '#1f7a7a';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x + w * 0.08, boxY, w * 0.84, boxH);

    // open top opening (orange interior) with a couple of small prize
    // cubes peeking out
    const openY = boxY + boxH * 0.06, openH = boxH * 0.3;
    ctx.fillStyle = '#e8a527';
    ctx.fillRect(x + w * 0.16, openY, w * 0.68, openH);
    const cubeColors = [colors[3], colors[4], colors[1]];
    cubeColors.forEach((c, i) => {
      ctx.fillStyle = c;
      const cw = w * 0.13;
      ctx.fillRect(x + w * (0.3 + i * 0.16), openY + openH * 0.25, cw, cw);
    });

    // 2x3 grid of color swatches on the lower front face
    const gridY = boxY + boxH * 0.44, gridH = boxH * 0.5;
    const gx = x + w * 0.16, gw = w * 0.68;
    const cols = 3, rows = 2;
    const cellW = gw / cols, cellH = gridH / rows;
    colors.forEach((c, i) => {
      const cx2 = gx + (i % cols) * cellW, cy2 = gridY + Math.floor(i / cols) * cellH;
      ctx.fillStyle = c;
      ctx.fillRect(cx2 + 2, cy2 + 2, cellW - 4, cellH - 4);
      ctx.strokeStyle = '#1f7a7a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx2 + 2, cy2 + 2, cellW - 4, cellH - 4);
    });
  }

  // Glass-box arcade claw machine — plush prizes inside, claw + rail at
  // top, a coin slot + red joystick knob on the cabinet face.
  _drawClawMachineCabinet(x, y, w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#5e1a12';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // glass viewing window
    const gx = x + w * 0.1, gy = y + h * 0.08, gw = w * 0.8, gh = h * 0.5;
    ctx.fillStyle = 'rgba(180,220,255,0.35)';
    ctx.fillRect(gx, gy, gw, gh);
    ctx.strokeStyle = '#2a1a10';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(gx, gy, gw, gh);

    // plush prizes (little colored circles) sitting at the bottom of the glass
    const plushColors = ['#f4c95d', '#e05a7e', '#4f8f2e', '#3d8fe0'];
    plushColors.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(gx + gw * (0.18 + i * 0.22), gy + gh * 0.78, gw * 0.09, 0, Math.PI * 2);
      ctx.fill();
    });

    // claw + rail
    ctx.strokeStyle = '#e8c547';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gx, gy + gh * 0.15); ctx.lineTo(gx + gw, gy + gh * 0.15); ctx.stroke();
    const clawX = gx + gw * 0.5;
    ctx.beginPath();
    ctx.moveTo(clawX, gy + gh * 0.15); ctx.lineTo(clawX, gy + gh * 0.4);
    ctx.moveTo(clawX - gw * 0.06, gy + gh * 0.4); ctx.lineTo(clawX, gy + gh * 0.5); ctx.lineTo(clawX + gw * 0.06, gy + gh * 0.4);
    ctx.stroke();

    // coin slot + joystick knob on the lower cabinet face
    ctx.fillStyle = '#2a1a10';
    ctx.fillRect(x + w * 0.15, y + h * 0.68, w * 0.18, h * 0.05);
    ctx.fillStyle = '#e8c547';
    ctx.beginPath(); ctx.arc(x + w * 0.75, y + h * 0.75, w * 0.09, 0, Math.PI * 2); ctx.fill();
  }

  // "Lucky 777" slot machine cabinet — a screen showing three symbols
  // (cherries either side, "7" in the middle, hinting at the jackpot) and
  // a side lever, classic one-armed-bandit silhouette.
  _drawSlot777Cabinet(x, y, w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = '#241332';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#e8c547';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // screen
    const sx = x + w * 0.1, sy = y + h * 0.1, sw = w * 0.7, sh = h * 0.4;
    ctx.fillStyle = '#111';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.strokeStyle = '#e8c547';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.font = `bold ${Math.floor(sh * 0.7)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8c547';
    ctx.fillText('7', sx + sw * 0.22, sy + sh * 0.55);
    ctx.fillStyle = '#f4f4f4';
    ctx.fillText('7', sx + sw * 0.5, sy + sh * 0.55);
    ctx.fillStyle = '#e8c547';
    ctx.fillText('7', sx + sw * 0.78, sy + sh * 0.55);

    // side lever
    ctx.strokeStyle = '#8b5e34';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.92, y + h * 0.2);
    ctx.lineTo(x + w * 0.92, y + h * 0.02);
    ctx.stroke();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.arc(x + w * 0.92, y + h * 0.02, w * 0.07, 0, Math.PI * 2); ctx.fill();

    // coin tray
    ctx.fillStyle = '#5e3b1f';
    ctx.fillRect(x + w * 0.15, y + h * 0.82, w * 0.7, h * 0.1);
  }

  // Gold-trimmed staircase — same receding-steps shape as the house
  // furniture staircase, but themed to the Casino, plus an up/down arrow
  // so it's obvious which way this particular staircase goes on sight.
  _drawCasinoStaircase(px, py, w, h, direction) {
    const ctx = this.ctx;
    const x = px, y = py;
    const steps = 5;
    for (let i = 0; i < steps; i++) {
      const stepW = w * (1 - i * 0.15), stepH = h / steps;
      ctx.fillStyle = i % 2 === 0 ? '#8b5e34' : '#a3743f';
      ctx.fillRect(x, y + h - (i + 1) * stepH, stepW, stepH);
      ctx.strokeStyle = '#2a1a10';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y + h - (i + 1) * stepH, stepW, stepH);
    }
    ctx.fillStyle = '#e8c547';
    ctx.fillRect(x, y, w * 0.06, h);

    ctx.save();
    ctx.font = `bold ${Math.floor(h * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8c547';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    const arrow = direction === 'up' ? '▲' : '▼';
    ctx.strokeText(arrow, x + w / 2, y - h * 0.1);
    ctx.fillText(arrow, x + w / 2, y - h * 0.1);
    ctx.restore();
  }

  // ---- Interior room rendering ----
  _drawIndoorRoom() {
    const ctx = this.ctx;
    const w = this.interior.width * TILE, h = this.interior.height * TILE;

    // wood plank floor
    const plankColors = ['#c9a26a', '#bd9860'];
    for (let y = 0; y < this.interior.height; y++) {
      for (let x = 0; x < this.interior.width; x++) {
        ctx.fillStyle = plankColors[(x + y) % 2];
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    ctx.strokeStyle = 'rgba(94,59,31,0.25)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= this.interior.width; x++) {
      ctx.beginPath(); ctx.moveTo(x * TILE, 0); ctx.lineTo(x * TILE, h); ctx.stroke();
    }

    // Wallpapered walls — top (the room's "back"), plus left and right
    // side walls, all matching the same band so the room actually reads
    // as walled-in on three sides, with only the bottom (facing the
    // camera) left open. This is also exactly where wall-mounted décor
    // (TV, aircon, wall light, paintings) is required to go — see
    // WALL_MOUNTED_ITEMS's placement check in server/routes/shop.js.
    const wallDepth = TILE * 0.6;
    ctx.fillStyle = '#e8d4b0';
    ctx.fillRect(0, -wallDepth, w, wallDepth); // top
    ctx.fillRect(-wallDepth, 0, wallDepth, h); // left
    ctx.fillRect(w, 0, wallDepth, h); // right
    ctx.strokeStyle = '#c9a26a';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, -wallDepth, w, wallDepth);
    ctx.strokeRect(-wallDepth, 0, wallDepth, h);
    ctx.strokeRect(w, 0, wallDepth, h);

    // room border
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 6;
    ctx.strokeRect(-1, -1, w + 2, h + 2);
    // Outer edge of the three wall strips (top, left, right only — NOT
    // the bottom, which stays open/unwalled facing the camera) so they
    // read as a continuous solid wall rather than a filled rectangle
    // floating past the room border.
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#c9a26a';
    ctx.beginPath();
    ctx.moveTo(-wallDepth, h); ctx.lineTo(-wallDepth, -wallDepth); ctx.lineTo(w + wallDepth, -wallDepth); ctx.lineTo(w + wallDepth, h);
    ctx.stroke();
  }

  // Which interior furniture is wall-mounted (see WALL_MOUNTED_ITEMS in
  // server/routes/shop.js — kept in sync manually since one's JS running
  // server-side and the other client-side). Only matters for items
  // actually placed on the BACK wall (grid_y === 0) here — see
  // _drawIndoorObjects, which shifts these up into the wall band itself
  // (drawn in _drawIndoorRoom) instead of leaving them sitting on the
  // floor tile like a normal piece of furniture.
  static WALL_MOUNTED_FURNITURE = new Set(['painting', 'wall_light', 'aircon']);
  // Which interior furniture provides a surface other décor can sit ON
  // TOP of (see TABLE_ITEM_IDS in server/routes/shop.js), and which décor
  // actually requires one (MUST_BE_ON_TABLE_ITEMS there) — both kept in
  // sync manually for the same reason as above.
  static TABLE_FURNITURE = new Set(['table', 'side_table']);
  static MUST_SIT_ON_TABLE = new Set(['table_lamp', 'tv']);

  _drawIndoorObjects() {
    const t = this._estimatedServerTime();
    const roomWidth = this.interior.width;
    const ctx = this.ctx;
    const objects = this.interior.objects;

    // Which tiles have a table/side table on them — checked once up
    // front so tabletop décor (table lamp, TV) can be (a) drawn AFTER
    // every table, guaranteeing it visually layers on top regardless of
    // whatever order the objects array happens to come back in, and (b)
    // shifted up to sit at roughly tabletop height instead of floor
    // height, which is where it'd otherwise render like every other
    // piece of furniture.
    const tableTiles = new Set();
    for (const obj of objects) {
      if (obj.object_type === 'interior' && FarmGame.TABLE_FURNITURE.has(obj.item_id)) {
        tableTiles.add(`${obj.grid_x},${obj.grid_y}`);
      }
    }
    const tabletopDecor = [];

    for (const obj of objects) {
      const def = this._defFor(obj);
      const w = (def && def.width) || 1, h = (def && def.height) || 1;
      const px = obj.grid_x * TILE, py = obj.grid_y * TILE;
      const pw = w * TILE, ph = h * TILE;
      if (obj.object_type === 'animal') {
        // Animals housed in the coop/barn interior render the same way
        // they do outdoors, "ready to collect" glow included.
        const last = obj.last_collected_at || obj.created_at;
        const fed = this._isAnimalFed(obj);
        const ready = t >= last + (this._animalProdSeconds(obj.item_id) || 600) && fed;
        this._drawAnimal(px, py, pw, ph, obj.item_id, ready, obj.rotation || 0);
        this._drawFeedIndicator(px, py, pw, fed, ready);
      } else if (FarmGame.MUST_SIT_ON_TABLE.has(obj.item_id) && tableTiles.has(`${obj.grid_x},${obj.grid_y}`)) {
        tabletopDecor.push({ obj, px, py, pw, ph });
      } else if (FarmGame.WALL_MOUNTED_FURNITURE.has(obj.item_id) && obj.grid_y === 0) {
        // Mounted flush in the BACK wall band itself (see
        // _drawIndoorRoom's wallDepth) — shifted up and squashed to that
        // band's actual height, instead of drawn at full tile height
        // sitting on the floor below the wall like normal furniture.
        const wallBandH = TILE * 0.6;
        this._drawFurniture(px, py - wallBandH, pw, wallBandH, obj.item_id, obj.rotation || 0);
      } else if (FarmGame.WALL_MOUNTED_FURNITURE.has(obj.item_id) && (obj.grid_x === 0 || obj.grid_x === roomWidth - 1)) {
        // Mounted on a SIDE wall (left or right column) — reuse the exact
        // same "band drawn above the tile" shape as the back-wall case,
        // then rotate the whole thing 90° around the tile's own center so
        // that band ends up flush against the side wall band instead
        // (rotating left for the left wall, right for the right wall) —
        // rather than needing separate portrait-oriented art for every
        // wall-mounted item.
        const wallBandDepth = TILE * 0.6;
        const isLeft = obj.grid_x === 0;
        const cx = px + pw / 2, cy = py + ph / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(isLeft ? -Math.PI / 2 : Math.PI / 2);
        ctx.translate(-cx, -cy);
        this._drawFurniture(px, py - wallBandDepth, pw, wallBandDepth, obj.item_id, 0);
        ctx.restore();
      } else {
        this._drawFurniture(px, py, pw, ph, obj.item_id, obj.rotation || 0);
      }
    }

    // Second pass: tabletop décor drawn LAST (after every table is
    // already down) so it always layers visually on top of whatever it's
    // sitting on, shifted up to sit at roughly tabletop height instead of
    // floor height.
    const tabletopOffset = TILE * 0.35;
    for (const { obj, px, py, pw, ph } of tabletopDecor) {
      this._drawFurniture(px, py - tabletopOffset, pw, ph, obj.item_id, obj.rotation || 0);
    }
  }

  // Real vector-drawn furniture pieces instead of an icon-in-a-card — each
  // gets its own shape (legs, cushions, frames, etc.), matching how outdoor
  // buildings/decorations are drawn rather than looking like UI icons.
  // A rough, hand-cut wood-grain finish drawn on top of a crafted piece's
  // normal shape — a warm semi-transparent tint plus a few wavy grain
  // streaks, giving it a rustic "made from raw wood" look distinct from
  // the smoother, more finished/painted look of the store-bought version
  // of the same furniture. Applied by both _drawFurniture (crafted
  // chair/bed/cabinet/bookshelf) and _drawDecoration (crafted bench).
  _drawCraftedWoodGrain(x, y, w, h) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(139,94,52,0.16)';
    ctx.beginPath();
    this._roundRect(x + 2, y + 2, w - 4, h - 4, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(94,59,31,0.5)';
    ctx.lineWidth = 1;
    const grainCount = 3;
    for (let i = 0; i < grainCount; i++) {
      const gy = y + h * (0.3 + i * 0.22);
      ctx.beginPath();
      ctx.moveTo(x + w * 0.12, gy);
      ctx.quadraticCurveTo(x + w * 0.5, gy - h * 0.05, x + w * 0.88, gy);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawFurniture(px, py, pw, ph, itemId, rotation) {
    const ctx = this.ctx;
    const x = px, y = py, w = pw, h = ph;
    const OUTLINE = '#5e3b1f';
    // Workshop-crafted furniture (crafted_bed, crafted_chair, etc.) reuses
    // the same SHAPE as its store-bought counterpart — strip the prefix so
    // every itemId check below still matches, instead of falling through
    // to nothing drawn (which is exactly why these were rendering
    // invisible before, despite placing/functioning correctly). It's NOT
    // meant to look IDENTICAL once placed though — a rougher, more
    // rustic wood-grain finish (_drawCraftedWoodGrain, applied after the
    // normal shape below) is what actually tells a crafted piece apart
    // from the store-bought one at a glance.
    const isCrafted = itemId.startsWith('crafted_');
    itemId = isCrafted ? itemId.slice('crafted_'.length) : itemId;

    // A real 90°-step spin, not just a mirror — the footprint is square
    // (every piece of furniture is 1×1) so a true rotation never needs the
    // placement highlight box to change shape.
    if (rotation) {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }

    // soft ground/floor shadow under every piece
    ctx.fillStyle = 'rgba(30,20,10,0.18)';
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h * 0.88, w * 0.4, h * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.6;

    // Only reachable via a crafted_bench (the plain "bench" stays an
    // outdoor decoration, drawn separately in _drawDecorationShape) — see
    // the prefix-stripping above. Same look, just placeable indoors only.
    // A full-tile brick divider wall — lets a room be split into sections.
    // Purely visual/decorative for now (doesn't block walking through it,
    // same as every other piece of interior furniture).
    if (itemId === 'wall') {
      ctx.fillStyle = '#d8c9a3';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#8b5e34';
      ctx.lineWidth = 1.2;
      const brickH = h * 0.22;
      for (let row = 0, ry = y; ry < y + h; row++, ry += brickH) {
        const offset = (row % 2) * (w * 0.25);
        for (let bx = x - w * 0.25 + offset; bx < x + w; bx += w * 0.5) {
          ctx.strokeRect(Math.max(x, bx), ry, Math.min(w * 0.5, x + w - Math.max(x, bx)), Math.min(brickH, y + h - ry));
        }
      }
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    } else if (itemId === 'staircase') {
      // A simple wooden staircase, drawn as receding steps toward the
      // top-right (up) with a railing along the open edge — tap it to go
      // to the next floor (see handleObjectClick's staircase handler).
      ctx.fillStyle = '#8b5e34';
      const steps = 5;
      for (let i = 0; i < steps; i++) {
        const stepW = w * (1 - i * 0.15), stepH = h / steps;
        ctx.fillStyle = i % 2 === 0 ? '#8b5e34' : '#a3743f';
        ctx.fillRect(x, y + h - (i + 1) * stepH, stepW, stepH);
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y + h - (i + 1) * stepH, stepW, stepH);
      }
      ctx.fillStyle = '#4a3521';
      ctx.fillRect(x, y, w * 0.06, h);
    } else if (itemId === 'bench') {
      const bx = x + w * 0.14, by = y + h * 0.42, bw = w * 0.72;
      // No backrest bar (same reasoning as the outdoor bench in
      // _drawDecorationShape) — it visually cut across a seated
      // character's torso at roughly chest height.
      ctx.fillStyle = '#8b5e34';
      ctx.fillRect(bx, by + h * 0.24, bw, h * 0.1);
      ctx.fillStyle = '#6b4423';
      ctx.fillRect(bx + 2, by + h * 0.34, w * 0.06, h * 0.24);
      ctx.fillRect(bx + bw - w * 0.08, by + h * 0.34, w * 0.06, h * 0.24);
    } else if (itemId === 'rug') {
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      this._roundRect(x + w * 0.08, y + h * 0.25, w * 0.84, h * 0.55, 8);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#e8d4b0';
      ctx.lineWidth = 2;
      this._roundRect(x + w * 0.16, y + h * 0.33, w * 0.68, h * 0.39, 5);
      ctx.stroke();
      // simple diamond pattern
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const cx2 = x + w * (0.28 + i * 0.22), cy2 = y + h * 0.52;
        ctx.beginPath();
        ctx.moveTo(cx2, cy2 - 6); ctx.lineTo(cx2 + 6, cy2); ctx.lineTo(cx2, cy2 + 6); ctx.lineTo(cx2 - 6, cy2);
        ctx.closePath(); ctx.stroke();
      }
    } else if (itemId === 'table') {
      ctx.fillStyle = '#a9714a';
      // legs
      ctx.fillRect(x + w * 0.1, y + h * 0.55, w * 0.06, h * 0.35);
      ctx.fillRect(x + w * 0.84, y + h * 0.55, w * 0.06, h * 0.35);
      ctx.strokeRect(x + w * 0.1, y + h * 0.55, w * 0.06, h * 0.35);
      ctx.strokeRect(x + w * 0.84, y + h * 0.55, w * 0.06, h * 0.35);
      // tabletop
      ctx.fillStyle = '#c68b52';
      ctx.beginPath();
      this._roundRect(x + w * 0.05, y + h * 0.28, w * 0.9, h * 0.3, 4);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(94,59,31,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + w * 0.15, y + h * 0.43); ctx.lineTo(x + w * 0.85, y + h * 0.43); ctx.stroke();
    } else if (itemId === 'chair') {
      ctx.fillStyle = '#8b5e34';
      // backrest — lower now, just above the seat, not up near where a
      // seated character's chest/head would be (same fix as the bench).
      ctx.beginPath(); this._roundRect(x + w * 0.28, y + h * 0.32, w * 0.44, h * 0.14, 4); ctx.fill(); ctx.stroke();
      // seat
      ctx.beginPath(); this._roundRect(x + w * 0.2, y + h * 0.45, w * 0.6, h * 0.14, 3); ctx.fill(); ctx.stroke();
      // legs — pulled in closer to center (was 0.24/0.70) so a seated
      // character's body actually covers them instead of leaving them
      // visibly poking out past either side.
      ctx.fillRect(x + w * 0.34, y + h * 0.58, w * 0.06, h * 0.28);
      ctx.fillRect(x + w * 0.6, y + h * 0.58, w * 0.06, h * 0.28);
    } else if (itemId === 'cabinet') {
      ctx.fillStyle = '#a9714a';
      ctx.beginPath(); this._roundRect(x + w * 0.14, y + h * 0.1, w * 0.72, h * 0.72, 5); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x + w / 2, y + h * 0.1); ctx.lineTo(x + w / 2, y + h * 0.82); ctx.stroke();
      ctx.fillStyle = shade('#a9714a', 30);
      ctx.beginPath(); ctx.arc(x + w * 0.42, y + h * 0.45, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + w * 0.58, y + h * 0.45, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8b5e34';
      ctx.fillRect(x + w * 0.14, y + h * 0.78, w * 0.72, h * 0.06);
    } else if (itemId === 'bed') {
      ctx.fillStyle = '#8b5e34';
      ctx.beginPath(); this._roundRect(x + w * 0.06, y + h * 0.2, w * 0.1, h * 0.62, 3); ctx.fill(); ctx.stroke(); // headboard
      ctx.fillStyle = '#c9a26a';
      ctx.beginPath(); this._roundRect(x + w * 0.14, y + h * 0.34, w * 0.78, h * 0.48, 4); ctx.fill(); ctx.stroke(); // mattress
      ctx.fillStyle = '#5ab0ff';
      ctx.beginPath(); this._roundRect(x + w * 0.14, y + h * 0.5, w * 0.78, h * 0.32, 4); ctx.fill(); ctx.stroke(); // blanket
      ctx.fillStyle = '#fff';
      ctx.beginPath(); this._roundRect(x + w * 0.17, y + h * 0.36, w * 0.2, h * 0.12, 3); ctx.fill(); ctx.stroke(); // pillow
    } else if (itemId === 'potted_plant') {
      ctx.fillStyle = '#a9714a';
      ctx.beginPath(); this._roundRect(x + w * 0.32, y + h * 0.62, w * 0.36, h * 0.28, 4); ctx.fill(); ctx.stroke();
      const leafColors = ['#4f8f2e', '#5aa32e', '#3c7020'];
      [[-0.1, 0.15], [0.1, 0.15], [0, 0.05]].forEach(([dx, dy], i) => {
        ctx.fillStyle = leafColors[i];
        ctx.beginPath();
        ctx.ellipse(x + w * (0.5 + dx), y + h * (0.55 - dy), w * 0.16, h * 0.18, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      });
    } else if (itemId === 'painting') {
      ctx.fillStyle = '#5e3b1f';
      ctx.beginPath(); this._roundRect(x + w * 0.14, y + h * 0.1, w * 0.72, h * 0.6, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#bfe8fa';
      ctx.beginPath(); this._roundRect(x + w * 0.2, y + h * 0.16, w * 0.6, h * 0.48, 2); ctx.fill();
      // tiny landscape inside the frame
      ctx.fillStyle = '#9ed84a';
      ctx.beginPath(); ctx.ellipse(x + w * 0.5, y + h * 0.58, w * 0.3, h * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffc84a';
      ctx.beginPath(); ctx.arc(x + w * 0.62, y + h * 0.26, w * 0.06, 0, Math.PI * 2); ctx.fill();
    } else if (itemId === 'stove') {
      // body
      ctx.fillStyle = '#4a4a4a';
      ctx.beginPath(); this._roundRect(x + w * 0.12, y + h * 0.3, w * 0.76, h * 0.58, 5); ctx.fill(); ctx.stroke();
      // stovetop burners
      ctx.fillStyle = '#2a2a2a';
      ctx.beginPath(); ctx.arc(x + w * 0.32, y + h * 0.32, w * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + w * 0.68, y + h * 0.32, w * 0.09, 0, Math.PI * 2); ctx.fill();
      // oven door
      ctx.fillStyle = '#6b6b6b';
      ctx.beginPath(); this._roundRect(x + w * 0.22, y + h * 0.5, w * 0.56, h * 0.32, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3a3a3a';
      ctx.beginPath(); ctx.arc(x + w * 0.5, y + h * 0.66, w * 0.13, 0, Math.PI * 2); ctx.fill();
      // little flame glow behind the oven window
      ctx.fillStyle = '#ff9d3c';
      ctx.beginPath(); ctx.arc(x + w * 0.5, y + h * 0.66, w * 0.08, 0, Math.PI * 2); ctx.fill();
      // control knobs
      ctx.fillStyle = '#c9c9c9';
      ctx.beginPath(); ctx.arc(x + w * 0.32, y + h * 0.42, w * 0.03, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + w * 0.68, y + h * 0.42, w * 0.03, 0, Math.PI * 2); ctx.fill();
    } else if (itemId === 'fireplace') {
      ctx.fillStyle = '#a9a08a';
      ctx.beginPath(); this._roundRect(x + w * 0.1, y + h * 0.15, w * 0.8, h * 0.72, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3a2a18';
      ctx.beginPath(); this._roundRect(x + w * 0.26, y + h * 0.42, w * 0.48, h * 0.42, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ff9d3c';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.42, y + h * 0.84);
      ctx.quadraticCurveTo(x + w * 0.36, y + h * 0.68, x + w * 0.46, y + h * 0.6);
      ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.7, x + w * 0.58, y + h * 0.6);
      ctx.quadraticCurveTo(x + w * 0.64, y + h * 0.72, x + w * 0.58, y + h * 0.84);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath(); ctx.ellipse(x + w * 0.5, y + h * 0.76, w * 0.06, h * 0.08, 0, 0, Math.PI * 2); ctx.fill();
    } else if (itemId === 'bookshelf') {
      ctx.fillStyle = '#8b5e34';
      ctx.beginPath(); this._roundRect(x + w * 0.12, y + h * 0.08, w * 0.76, h * 0.76, 4); ctx.fill(); ctx.stroke();
      const bookColors = ['#c0392b', '#e8a527', '#4f8f2e', '#3d8fe0', '#8e44ad'];
      for (let shelf = 0; shelf < 2; shelf++) {
        const shelfY = y + h * (0.18 + shelf * 0.32);
        ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x + w * 0.14, shelfY + h * 0.22); ctx.lineTo(x + w * 0.86, shelfY + h * 0.22); ctx.stroke();
        let bx = x + w * 0.17;
        for (let i = 0; i < 5; i++) {
          const bw = w * 0.08;
          ctx.fillStyle = bookColors[(i + shelf) % bookColors.length];
          ctx.fillRect(bx, shelfY, bw, h * 0.2);
          bx += bw + 1;
        }
      }
    } else if (itemId === 'table_lamp') {
      // Small lamp on its own stand — the same "breathing" glow as the
      // outdoor Lamp Post (see DECORATION_STYLE's 'lamp' shape), so a
      // house/coop/barn actually has a light source to place at night —
      // see _drawWeatherOverlay's night punch-through check.
      const cx = x + w / 2;
      const t = performance.now() / 1000;
      const phase = (x + y) * 0.013;
      ctx.fillStyle = '#8b5e34';
      ctx.beginPath(); this._roundRect(x + w * 0.28, y + h * 0.62, w * 0.44, h * 0.14, 3); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#5e3b1f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, y + h * 0.62); ctx.lineTo(cx, y + h * 0.32); ctx.stroke();
      const pulse = 0.6 + 0.4 * Math.sin(t * 1.6 + phase);
      ctx.save();
      ctx.shadowColor = '#ffdd88';
      ctx.shadowBlur = 5 + pulse * 8;
      ctx.globalAlpha = 0.8 + pulse * 0.2;
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.18, y + h * 0.32);
      ctx.lineTo(cx + w * 0.18, y + h * 0.32);
      ctx.lineTo(cx + w * 0.11, y + h * 0.14);
      ctx.lineTo(cx - w * 0.11, y + h * 0.14);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.2;
      ctx.stroke();
    } else if (itemId === 'wall_light') {
      // Mounted high on the tile (wall-sconce read) — same breathing glow
      // treatment, and also counts as a light source at night.
      const cx = x + w / 2;
      const t = performance.now() / 1000;
      const phase = (x + y) * 0.017;
      ctx.fillStyle = '#5e3b1f';
      ctx.fillRect(cx - w * 0.02, y + h * 0.1, w * 0.04, h * 0.12);
      const pulse = 0.6 + 0.4 * Math.sin(t * 1.5 + phase);
      ctx.save();
      ctx.shadowColor = '#ffe9a8';
      ctx.shadowBlur = 5 + pulse * 7;
      ctx.globalAlpha = 0.8 + pulse * 0.2;
      ctx.fillStyle = '#fff7d6';
      ctx.beginPath(); ctx.ellipse(cx, y + h * 0.16, w * 0.11, h * 0.08, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(cx, y + h * 0.16, w * 0.11, h * 0.08, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (itemId === 'tv') {
      // Sits high on the tile (wall-mounted read) with a small stand below.
      ctx.fillStyle = '#2a2a2a';
      ctx.beginPath(); this._roundRect(x + w * 0.12, y + h * 0.14, w * 0.76, h * 0.42, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3d8fe0';
      ctx.fillRect(x + w * 0.16, y + h * 0.18, w * 0.68, h * 0.32);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(x + w * 0.46, y + h * 0.56, w * 0.08, h * 0.1);
      ctx.fillRect(x + w * 0.32, y + h * 0.65, w * 0.36, h * 0.04);
    } else if (itemId === 'aircon') {
      // A wall-unit box mounted high, with vent slats and a little
      // power-on indicator light.
      ctx.fillStyle = '#f4f4f4';
      ctx.beginPath(); this._roundRect(x + w * 0.1, y + h * 0.12, w * 0.8, h * 0.28, 5); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#c9c9c9'; ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const lx = x + w * (0.18 + i * 0.16);
        ctx.beginPath(); ctx.moveTo(lx, y + h * 0.16); ctx.lineTo(lx, y + h * 0.36); ctx.stroke();
      }
      ctx.fillStyle = '#4f8f2e';
      ctx.beginPath(); ctx.arc(x + w * 0.82, y + h * 0.16, 2, 0, Math.PI * 2); ctx.fill();
    } else if (itemId === 'side_table') {
      // Redesigned to clearly read as a TABLE (matches the Dining Table's
      // family look — rounded tabletop slab with a visible wood-grain
      // line, sitting higher up) instead of looking almost identical to
      // the Bench (a thin plank seat on 2 end legs) — the near-identical
      // silhouette was why placing a Table Lamp "on the table" kept
      // failing: players were tapping an actual Bench, thinking it was
      // this.
      ctx.fillStyle = '#8b5e34';
      ctx.fillRect(x + w * 0.22, y + h * 0.56, w * 0.08, h * 0.3);
      ctx.fillRect(x + w * 0.7, y + h * 0.56, w * 0.08, h * 0.3);
      ctx.strokeRect(x + w * 0.22, y + h * 0.56, w * 0.08, h * 0.3);
      ctx.strokeRect(x + w * 0.7, y + h * 0.56, w * 0.08, h * 0.3);
      ctx.fillStyle = '#c68b52';
      ctx.beginPath();
      this._roundRect(x + w * 0.14, y + h * 0.42, w * 0.72, h * 0.18, 4);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(94,59,31,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + w * 0.2, y + h * 0.51); ctx.lineTo(x + w * 0.8, y + h * 0.51); ctx.stroke();
    } else {
      // fallback generic card for any unrecognized item
      ctx.fillStyle = '#fffaf0';
      ctx.beginPath(); this._roundRect(x + 4, y + 4, w - 8, h - 8, 10); ctx.fill(); ctx.stroke();
    }

    if (isCrafted) this._drawCraftedWoodGrain(x, y, w, h);
    if (rotation) ctx.restore();
  }

  // Translucent preview of the item about to be placed (Build tool), shown
  // at the last-tapped tile so the player can see + rotate it before
  // confirming placement.
  _drawGhost() {
    if (!this._ghost) return;
    const ctx = this.ctx;
    const g = this._ghost;
    const px = g.x * TILE, py = g.y * TILE;
    const w = ((g.def && g.def.width) || 1) * TILE;
    const h = ((g.def && g.def.height) || 1) * TILE;
    const rotation = g.rotation || 0;

    ctx.save();
    ctx.globalAlpha = 0.55;
    if (g.category === 'building') this._drawBuilding(px, py, w, h, g.itemId, rotation);
    else if (g.category === 'decoration') this._drawDecoration(px, py, w, h, g.itemId, rotation);
    else if (g.category === 'animal') this._drawAnimal(px, py, w, h, g.itemId, false, rotation);
    else if (g.category === 'interior') this._drawFurniture(px, py, w, h, g.itemId, rotation);

    // Decorations and furniture do a real 90°-step spin (not just a
    // mirror), rotating around the footprint's own center — so for a
    // non-square item (a 2×1 rug, table, bed...) turned 90°/270°, the
    // highlight box needs its width/height swapped to actually frame the
    // rotated shape instead of the original orientation's box.
    const swapsDimensions = (g.category === 'decoration' || g.category === 'interior') && (rotation === 90 || rotation === 270);
    const boxW = swapsDimensions ? h : w;
    const boxH = swapsDimensions ? w : h;
    const cx = px + w / 2, cy = py + h / 2;
    const boxX = cx - boxW / 2, boxY = cy - boxH / 2;

    ctx.strokeStyle = '#ffc84a';
    ctx.lineWidth = 3;
    ctx.strokeRect(boxX + 2, boxY + 2, boxW - 4, boxH - 4);
    ctx.restore();
  }

  // Soft drifting clouds behind the farm, drawn in screen space so they're
  // independent of pan/zoom — a bit of atmosphere behind the plot.
  _drawSky(rect) {
    const ctx = this.ctx;
    const t = (Date.now() - this._startTime) / 1000;
    ctx.save();
    for (const c of this._clouds) {
      const x = ((c.x + t * c.speed * 0.05) % 1.2 - 0.1) * rect.width;
      const y = c.y * rect.height;
      const s = c.scale * 34;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * 0.55, 0, 0, Math.PI * 2);
      ctx.ellipse(x + s * 0.7, y + s * 0.12, s * 0.65, s * 0.4, 0, 0, Math.PI * 2);
      ctx.ellipse(x - s * 0.6, y + s * 0.15, s * 0.55, s * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // A soft ground shadow just outside the farm plot, so it reads as sitting
  // on the grass rather than floating on a flat background.
  _drawFarmShadowBase() {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(50,90,20,0.18)';
    const w = this.farm.width * TILE, h = this.farm.height * TILE;
    ctx.beginPath();
    ctx.ellipse(w / 2, h + 14, w * 0.55, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawWoodenBorder() {
    const ctx = this.ctx;
    const w = this.farm.width * TILE, h = this.farm.height * TILE;
    // Outer plank frame
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 10;
    ctx.strokeRect(-2, -2, w + 4, h + 4);
    ctx.strokeStyle = '#8a5a34';
    ctx.lineWidth = 4;
    ctx.strokeRect(-2, -2, w + 4, h + 4);
    // Plank seams along the top edge for a hand-built-fence feel — only
    // the ones actually within the visible width, since this loop's cost
    // otherwise scales with total farm WIDTH regardless of zoom (a very
    // wide farm was drawing seam ticks stretching far off both sides of
    // the screen every frame, for no visible benefit).
    const b = this._visibleBounds;
    const startX = b ? Math.max(0, b.minX) * TILE : 0;
    const endX = b ? Math.min(this.farm.width, b.maxX + 1) * TILE : w;
    ctx.strokeStyle = 'rgba(94,59,31,0.5)';
    ctx.lineWidth = 2;
    for (let x = startX; x < endX; x += TILE) {
      ctx.beginPath();
      ctx.moveTo(x, -6);
      ctx.lineTo(x, -2);
      ctx.stroke();
    }
  }

  // The little farmer — simple chibi shapes (hat, head, body, legs), no
  // external art. Walks between tiles (see walkTo) and does a small bounce
  // with an emoji "action icon" above its head when performing a task.
  // Simplified silhouettes for other players sharing the current space —
  // same body language as the local character (walk bob, colors, hat) but
  // lighter-weight to draw many of them, plus a username tag and speech
  // bubble so a global chat message shows above whoever sent it.
  _drawRemoteAvatars() {
    for (const actor of this.remotePlayers.values()) {
      this._drawSimpleAvatar(actor);
    }
  }

  // Same sprite-based rendering as the local character, for other players
  // sharing the current space (farm visit / Marketplace), plus a username
  // tag above their head.
  _drawSimpleAvatar(c) {
    const ctx = this.ctx;
    const cx = c.x, groundY = c.y + TILE * 0.28;

    ctx.fillStyle = 'rgba(20,30,10,0.22)';
    ctx.beginPath();
    ctx.ellipse(cx, groundY + 1, 9, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    this._drawSpecialAura(cx, groundY, c.outfitKey, c.gender, c.facingDir);

    const img = getSprite(spriteKeyFor(c.gender, c.facingDir, c.walkFrame, c.moving, c.outfitKey));
    if (img && img.complete && img.naturalWidth > 0) {
      const displayHeight = TILE * 1.45;
      const displayWidth = displayHeight * (img.naturalWidth / img.naturalHeight);
      // Same faked sitting/lying pose as the local character (see
      // _drawCharacter) — a visitor should actually see a friend resting
      // on a bed/chair/bench, not just standing there while their energy
      // regen is secretly faster. c.restPose comes from the 'presence:rest'
      // socket broadcast (see main.js).
      ctx.save();
      if (c.restPose === 'lie') {
        ctx.translate(cx, groundY + (c.bob || 0) - TILE * 0.18);
        ctx.rotate(-Math.PI / 2);
        ctx.scale(0.8, 0.68);
        ctx.drawImage(img, -displayWidth / 2, -displayHeight / 2, displayWidth, displayHeight);
      } else if (c.restPose === 'sit') {
        // Sunk down further than before so more of the character visually
        // overlaps the seat/legs — otherwise it read as "standing behind
        // a low table" rather than actually sitting on the furniture.
        ctx.translate(cx, groundY + (c.bob || 0) + TILE * 0.32);
        ctx.scale(0.85, 0.62);
        ctx.drawImage(img, -displayWidth / 2, -displayHeight, displayWidth, displayHeight);
      } else {
        ctx.translate(cx, groundY + (c.bob || 0));
        ctx.drawImage(img, -displayWidth / 2, -displayHeight, displayWidth, displayHeight);
      }
      ctx.restore();
    }

    // username tag
    ctx.font = 'bold 10px Nunito, sans-serif';
    ctx.textAlign = 'center';
    const tagY = groundY - 100;
    const tw = ctx.measureText(c.username).width;
    ctx.fillStyle = 'rgba(94,59,31,0.8)';
    this._roundRect(cx - tw / 2 - 5, tagY - 11, tw + 10, 15, 7);
    ctx.fill();
    ctx.fillStyle = '#fff6e3';
    ctx.fillText(c.username, cx, tagY - 3);

    if (c.chatText && c.chatTimer > 0) {
      this._drawSpeechBubble(cx, tagY - 20, c.chatText);
    }
  }


  // A cute rounded speech-bubble with a little tail, used for both the local
  // player's own chat bubble and remote players'.
  _drawSpeechBubble(cx, bottomY, text) {
    const ctx = this.ctx;
    ctx.font = '12px Nunito, sans-serif';
    const maxWidth = 160;
    const words = text.split(' ');
    const lines = [];
    let line = '';
    words.forEach((w) => {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
      else line = test;
    });
    if (line) lines.push(line);

    const lineHeight = 15;
    const boxW = Math.min(maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width))) + 20;
    const boxH = lines.length * lineHeight + 14;
    const boxX = cx - boxW / 2, boxY = bottomY - boxH;

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 2;
    this._roundRect(boxX, boxY, boxW, boxH, 10);
    ctx.fill(); ctx.stroke();
    // tail
    ctx.beginPath();
    ctx.moveTo(cx - 6, bottomY);
    ctx.lineTo(cx + 6, bottomY);
    ctx.lineTo(cx, bottomY + 8);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();

    ctx.fillStyle = '#4a3521';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => {
      ctx.fillText(l, cx, boxY + 16 + i * lineHeight);
    });
  }

  // Real illustrated sprite (raster image), replacing the old vector-drawn
  // body. The sprite is chosen from facingDir/gender/walk-frame (see
  // spriteKeyFor), drawn bottom-anchored at groundY so it stands correctly
  // on the tile regardless of the source image's own proportions.
  // Sprite only (shadow + character image) — the part that needs correct
  // depth-sorting against crops/objects. Action icon + chat bubble are
  // intentionally separate (see _drawCharacterOverlay) since those should
  // always render on top regardless of sort order.
  // Rare, admin-granted Special Outfits (Lancer/Sorcerer/Swordsman) get an
  // animated magic aura on the ground beneath the character instead of
  // just being another recolor — a pulsing glow puddle, spinning swirl
  // arcs, particles orbiting at ground level, and flickering upward light
  // rays. Everything here is driven off performance.now(), so nothing is
  // ever a static sticker — it's constantly rotating/pulsing/bobbing.
  // Color varies per costume to match its own palette rather than reusing
  // one generic glow for all three.
  // Rare, admin-granted Special Outfits (Lancer/Sorcerer/Swordsman) get an
  // animated summoning-circle aura on the ground beneath the character:
  // a glowing rune ring with tick marks, a counter-rotating star pattern
  // inside it, and glowing orbs that float and orbit at varying heights
  // above the ground (not just flat dots) — closer to a real "magic
  // circle" effect than a plain glow. Real bloom via ctx.shadowBlur, not
  // just semi-transparent strokes, so it actually reads as glowing.
  // Everything here is driven off performance.now(), so nothing is ever a
  // static sticker. Color varies per costume to match its own palette.
  _drawSpecialAura(cx, groundY, outfitKey, gender, facingDir) {
    const rgb = SPECIAL_AURA_RGB[outfitKey];
    if (!rgb) return;
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    const R = TILE * 0.62;

    // Shift the aura's center to line up under the character's actual
    // feet (see SPECIAL_AURA_OFFSET above) rather than the sprite image's
    // raw bounding-box center, which the weapon held out to one side
    // throws off.
    const g = gender === 'female' ? 'female' : 'male';
    const dir = SPRITE_DIRECTIONS.includes(facingDir) ? facingDir : 'down';
    const offsetRatio = SPECIAL_AURA_OFFSET[`${g}_${outfitKey}_walk_${dir}`] || 0;
    const img = getSprite(spriteKeyFor(gender, facingDir, 0, false, outfitKey));
    const displayHeight = TILE * 1.45;
    const displayWidth = (img && img.naturalWidth) ? displayHeight * (img.naturalWidth / img.naturalHeight) : 0;
    cx += offsetRatio * displayWidth;

    ctx.save();
    ctx.translate(cx, groundY);
    // Additive blending — where glowing shapes overlap they blow out toward
    // white/bright instead of just staying flat-colored, which is what
    // actually reads as "glowing light" rather than a plain colored outline
    // (a much bigger visual difference here than shadowBlur alone).
    ctx.globalCompositeOperation = 'lighter';

    // ---- Ground glow puddle — bright and broad ----
    const pulse = 0.45 + 0.18 * Math.sin(t * 2.2); // -10% brightness
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.3);
    grad.addColorStop(0, `rgba(${rgb},${pulse})`);
    grad.addColorStop(0.5, `rgba(${rgb},${pulse * 0.5})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, R * 1.3, R * 1.3 * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    // ---- Rotating rune rings (flattened to the ground-plane perspective) ----
    // ctx.shadowBlur is genuinely expensive per DRAW CALL in Canvas2D (most
    // engines re-run a real blur every time), so the earlier version of
    // this — 16 separate tick strokes plus the ring circle, each with
    // shadowBlur active, times 2 passes, times orbs too — added up to
    // ~48 blurred draws per character per frame and visibly dropped FPS.
    // Same visual, far fewer blurred draw calls: the ring circle AND all
    // 16 ticks are now one combined path per pass (1 stroke() instead of
    // 17), and the orbs' outer glow below uses a radial gradient instead
    // of shadowBlur (gradients are cheap; blur is not).
    ctx.save();
    ctx.scale(1, 0.42);

    // Outer ring: a solid circle plus radiating tick marks around the rim,
    // like a summoning circle — slowly spins one way. Each pass (thick
    // blurred glow underneath, thin near-white core on top) is ONE stroke
    // call covering the circle + all ticks together.
    ctx.save();
    ctx.rotate(t * 0.9);
    const tickCount = 16;
    const buildRingPath = () => {
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      for (let i = 0; i < tickCount; i++) {
        const a = (i / tickCount) * Math.PI * 2;
        const inner = R * 0.86, outer = R * 1.05;
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
      }
    };
    ctx.shadowColor = `rgba(${rgb},0.9)`;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = `rgba(${rgb},0.81)`;
    ctx.lineWidth = 5;
    buildRingPath();
    ctx.stroke();
    ctx.shadowBlur = 0; // core pass needs no blur of its own — the glow pass underneath already provides it
    ctx.strokeStyle = 'rgba(255,255,255,0.81)';
    ctx.lineWidth = 1.6;
    buildRingPath();
    ctx.stroke();
    ctx.restore();

    // Inner ring: a 5-point star/rune pattern, counter-rotating against the
    // outer ring so the whole thing reads as two independently-turning
    // gears rather than one flat spinning circle. Connecting every 2nd
    // vertex of a 5-gon traces a proper 5-point star in one continuous
    // path (works because gcd(5,2)=1 — a 6-gon skip-2 would just retrace
    // a triangle twice instead). Same single-blurred-pass-plus-cheap-core
    // treatment as the outer ring above.
    ctx.save();
    ctx.rotate(-t * 1.3);
    const starPoints = 5;
    const starPath = () => {
      ctx.beginPath();
      for (let i = 0; i <= starPoints; i++) {
        const a = (i * 2 * (Math.PI * 2)) / starPoints;
        const x = Math.cos(a) * R * 0.7, y = Math.sin(a) * R * 0.7;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    ctx.shadowColor = `rgba(${rgb},0.9)`;
    ctx.shadowBlur = 11;
    ctx.strokeStyle = `rgba(${rgb},0.77)`;
    ctx.lineWidth = 4;
    starPath();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.77)';
    ctx.lineWidth = 1.3;
    starPath();
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // end flattened scale

    // ---- Floating glowing orbs, orbiting at varying heights above the
    // ground ring (some low, some up near head height), each pulsing and
    // gently bobbing independently. The soft halo is a small radial
    // gradient (cheap) instead of shadowBlur, with a plain bright core
    // circle on top — same glowing look, no blur cost at all.
    const orbCount = 6;
    for (let i = 0; i < orbCount; i++) {
      const angle = t * 1.1 + (i / orbCount) * Math.PI * 2;
      const orbitR = R * (0.85 + 0.15 * Math.sin(t * 1.7 + i));
      const px = Math.cos(angle) * orbitR;
      const py = Math.sin(angle) * orbitR * 0.42;
      const floatHeight = TILE * (0.35 + 0.4 * (i % 3) / 2) + Math.sin(t * 2.5 + i * 1.3) * 6;
      const orbY = py - floatHeight;
      const orbPulse = 0.63 + 0.27 * Math.sin(t * 3 + i * 2); // -10% brightness

      const haloGrad = ctx.createRadialGradient(px, orbY, 0, px, orbY, 7);
      haloGrad.addColorStop(0, `rgba(${rgb},${orbPulse})`);
      haloGrad.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(px, orbY, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(255,255,255,${orbPulse})`;
      ctx.beginPath();
      ctx.arc(px, orbY, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _drawCharacter() {
    const ctx = this.ctx;
    const c = this._character;
    const cx = c.x, groundY = c.y + TILE * 0.28;

    ctx.fillStyle = 'rgba(20,30,10,0.22)';
    ctx.beginPath();
    ctx.ellipse(cx, groundY + 1, 9, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    this._drawSpecialAura(cx, groundY, c.outfitKey, c.gender, c.facingDir);

    const img = getSprite(spriteKeyFor(c.gender, c.facingDir, c.walkFrame, c.moving, c.outfitKey));
    if (!img || !img.complete || img.naturalWidth <= 0) return;
    const displayHeight = TILE * 1.45;
    const displayWidth = displayHeight * (img.naturalWidth / img.naturalHeight);

    // No dedicated sitting/lying sprite art exists — these fake the pose by
    // transforming the normal standing sprite: lying rotates it onto its
    // side and flattens/shrinks it a bit (like sinking into a mattress),
    // sitting just shrinks and drops it a bit (like sinking into a seat)
    // without the rotation. Good enough to read as "resting" at a glance.
    ctx.save();
    if (c.restPose === 'lie') {
      ctx.translate(cx, groundY + c.bob - TILE * 0.18);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(0.8, 0.68);
      // Centered vertically (-displayHeight/2, not -displayHeight) so the
      // rotation swings around the character's MIDDLE, not one end — using
      // the normal top-anchored offset here put the whole body hanging off
      // to one side of the anchor once rotated, sticking way out past
      // whatever furniture it was meant to be centered on.
      ctx.drawImage(img, -displayWidth / 2, -displayHeight / 2, displayWidth, displayHeight);
    } else if (c.restPose === 'sit') {
      ctx.translate(cx, groundY + c.bob + TILE * 0.32);
      ctx.scale(0.85, 0.62);
      ctx.drawImage(img, -displayWidth / 2, -displayHeight, displayWidth, displayHeight);
    } else {
      ctx.translate(cx, groundY + c.bob);
      ctx.drawImage(img, -displayWidth / 2, -displayHeight, displayWidth, displayHeight);
    }
    ctx.restore();
  }

  _drawCharacterOverlay() {
    const ctx = this.ctx;
    const c = this._character;
    const cx = c.x, groundY = c.y + TILE * 0.28;

    // A small floating "zzz" while resting reinforces the pose regardless
    // of how well the (rotated/squashed, not hand-drawn) fake pose reads
    // on its own — gently bobs so it doesn't look like a static sticker.
    if (c.restPose) {
      const bob = Math.sin(performance.now() / 500) * 3;
      ctx.save();
      ctx.font = '16px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('💤', cx + 14, groundY - 58 + bob);
      ctx.restore();
    }

    // action icon bounce
    if (c.actionGlyph && c.actionTimer > 0) {
      const p = 1 - c.actionTimer / 0.7;
      const bounce = Math.sin(p * Math.PI) * 10;
      ctx.save();
      ctx.globalAlpha = Math.min(1, c.actionTimer / 0.2);
      ctx.font = '22px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.actionGlyph, cx, groundY - 92 - bounce);
      ctx.restore();
    }

    // own chat bubble
    if (c.chatText && c.chatTimer > 0) {
      this._drawSpeechBubble(cx, groundY - 96, c.chatText);
    }
  }


  // Computes which farm tiles actually fall within the visible canvas
  // right now, given the current camera pan/zoom — computed ONCE per
  // frame in _draw() and shared by _drawTiles/_drawFlatDecorations/
  // _drawSceneSorted (all farm-wide loops whose cost used to scale with
  // total farm size instead of how much of it is actually on screen).
  // A small tile margin (pad) keeps anything tall (a tree, a building)
  // from visibly popping in/out right at the edge of the screen.
  _getVisibleTileBounds() {
    const rect = this.canvas.getBoundingClientRect();
    const pad = 2;
    return {
      minX: Math.max(0, Math.floor((-this.camera.x / this.camera.scale) / TILE) - pad),
      minY: Math.max(0, Math.floor((-this.camera.y / this.camera.scale) / TILE) - pad),
      maxX: Math.min(this.farm.width - 1, Math.ceil(((rect.width - this.camera.x) / this.camera.scale) / TILE) + pad),
      maxY: Math.min(this.farm.height - 1, Math.ceil(((rect.height - this.camera.y) / this.camera.scale) / TILE) + pad),
    };
  }

  _drawTiles() {
    const ctx = this.ctx;
    // Rebuilding these lookup maps from farm.tiles/farm.crops used to
    // happen EVERY FRAME (60fps) regardless of whether the farm's data had
    // actually changed since the last one — cheap on a small farm, but the
    // cost scales with total tile/crop count. farm.tiles/farm.crops are
    // only ever REPLACED wholesale (a fresh array from setFarm() after an
    // API refetch), never mutated element-by-element, so a plain
    // reference check safely tells us when a rebuild is actually needed
    // instead of redoing it unconditionally on every single frame.
    if (this._tileCacheSource !== this.farm.tiles) {
      this._tilesByPosCache = {};
      for (const t of this.farm.tiles) this._tilesByPosCache[`${t.x},${t.y}`] = t;
      this._tileCacheSource = this.farm.tiles;
    }
    if (this._wateredCacheSource !== this.farm.crops) {
      this._wateredByPosCache = {};
      for (const crop of this.farm.crops) {
        if (crop.watered) this._wateredByPosCache[`${crop.tile_x},${crop.tile_y}`] = true;
      }
      this._wateredCacheSource = this.farm.crops;
    }
    const tilesByPos = this._tilesByPosCache;
    const wateredByPos = this._wateredByPosCache;

    const grassShades = ['#8fc93a', '#96cf42', '#83c02f', '#9dd44f'];
    const soilShades = ['#8b5e34', '#96693c', '#7f552f', '#8f6438'];
    // darker, cooler tones for freshly-watered soil so it visibly reads as damp
    const wetSoilShades = ['#5c3d20', '#66432a', '#523419', '#5e3f22'];

    const b = this._visibleBounds;
    const minX = b.minX, minY = b.minY, maxX = b.maxX, maxY = b.maxY;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = tilesByPos[`${x},${y}`] || { state: 'grass' };
        const px = x * TILE, py = y * TILE;
        const rnd = this._hash(x, y, 1);
        const isWet = t.state === 'plowed' && wateredByPos[`${x},${y}`];

        if (t.state === 'plowed') {
          const shades = isWet ? wetSoilShades : soilShades;
          const base = shades[Math.floor(rnd * shades.length)];
          const grad = ctx.createLinearGradient(px, py, px, py + TILE);
          grad.addColorStop(0, base);
          grad.addColorStop(1, isWet ? '#3f2812' : '#6b4423');
          ctx.fillStyle = grad;
          ctx.fillRect(px, py, TILE, TILE);

          if (isWet) {
            // a couple of soft glossy highlights to sell the "wet" look,
            // like light catching on damp soil
            ctx.fillStyle = 'rgba(255,255,255,0.10)';
            ctx.beginPath();
            ctx.ellipse(px + TILE * 0.3, py + TILE * 0.35, TILE * 0.16, TILE * 0.06, -0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(px + TILE * 0.68, py + TILE * 0.62, TILE * 0.12, TILE * 0.045, 0.4, 0, Math.PI * 2);
            ctx.fill();
          }

          // furrow rows with soft highlight/shadow pairs
          for (let i = 10; i < TILE; i += 12) {
            ctx.strokeStyle = 'rgba(0,0,0,0.18)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px + 4, py + i);
            ctx.lineTo(px + TILE - 4, py + i);
            ctx.stroke();
            ctx.strokeStyle = isWet ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            ctx.moveTo(px + 4, py + i + 1.5);
            ctx.lineTo(px + TILE - 4, py + i + 1.5);
            ctx.stroke();
          }
          // small dirt clumps
          for (let i = 0; i < 3; i++) {
            const cr = this._hash(x, y, 10 + i);
            const cx = px + 8 + cr * (TILE - 16);
            const cy = py + 8 + this._hash(x, y, 20 + i) * (TILE - 16);
            ctx.fillStyle = 'rgba(0,0,0,0.12)';
            ctx.beginPath();
            ctx.ellipse(cx, cy, 3, 2, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          const base = grassShades[Math.floor(rnd * grassShades.length)];
          const grad = ctx.createLinearGradient(px, py, px, py + TILE);
          grad.addColorStop(0, base);
          grad.addColorStop(1, shade(base, -8));
          ctx.fillStyle = grad;
          ctx.fillRect(px, py, TILE, TILE);

          // grass tufts
          ctx.strokeStyle = 'rgba(60,110,20,0.35)';
          ctx.lineWidth = 1.5;
          for (let i = 0; i < 5; i++) {
            const tr1 = this._hash(x, y, 30 + i);
            const tr2 = this._hash(x, y, 40 + i);
            const bx = px + 6 + tr1 * (TILE - 12);
            const by = py + 10 + tr2 * (TILE - 16);
            ctx.beginPath();
            ctx.moveTo(bx, by + 5);
            ctx.lineTo(bx - 2, by - 3);
            ctx.moveTo(bx + 2, by + 5);
            ctx.lineTo(bx + 2, by - 4);
            ctx.moveTo(bx + 4, by + 5);
            ctx.lineTo(bx + 6, by - 2);
            ctx.stroke();
          }
          // occasional tiny wildflower speckle
          if (this._hash(x, y, 50) > 0.88) {
            const fx = px + 16 + this._hash(x, y, 51) * (TILE - 32);
            const fy = py + 16 + this._hash(x, y, 52) * (TILE - 32);
            ctx.fillStyle = this._hash(x, y, 53) > 0.5 ? '#fff3b0' : '#ffd6e8';
            for (let p = 0; p < 4; p++) {
              const ang = (Math.PI / 2) * p;
              ctx.beginPath();
              ctx.ellipse(fx + Math.cos(ang) * 2.2, fy + Math.sin(ang) * 2.2, 1.6, 1.6, 0, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.fillStyle = '#e8a527';
            ctx.beginPath();
            ctx.arc(fx, fy, 1.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        ctx.strokeStyle = 'rgba(0,0,0,0.05)';
        ctx.strokeRect(px, py, TILE, TILE);

        // highlight overlay (valid/invalid placement or selection)
        if (this.highlightFn) {
          const h = this.highlightFn(x, y);
          if (h === 'valid') {
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fillRect(px, py, TILE, TILE);
          } else if (h === 'invalid') {
            ctx.fillStyle = 'rgba(196,85,46,0.35)';
            ctx.fillRect(px, py, TILE, TILE);
          }
        }
      }
    }
  }

  _drawCrops() {
    const t = this._estimatedServerTime();
    for (const crop of this.farm.crops) this._drawCropItem(crop, t);
  }

  _drawCropItem(crop, t) {
    const ctx = this.ctx;
    const px = crop.tile_x * TILE, py = crop.tile_y * TILE;
    const cx = px + TILE / 2, cy = py + TILE / 2;

    // soft ground shadow under the plant
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + TILE * 0.22, TILE * 0.24, TILE * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    // little soil mound
    ctx.fillStyle = 'rgba(107,68,35,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + TILE * 0.2, TILE * 0.22, TILE * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // Dead (never watered in time) or withered (ready too long, left
    // un-harvested) — same idea either way: a droopy brown collapsed
    // plant instead of the normal upright icon, tinted and rotated onto
    // its side to read as "this has gone bad", tap Harvest to clear it.
    if (crop.state === 'dead' || crop.state === 'withered') {
      ctx.save();
      ctx.translate(cx, cy - 2);
      ctx.rotate(-0.35);
      ctx.font = `${Math.floor(TILE * 0.5)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.75;
      ctx.filter = 'grayscale(70%) sepia(40%)';
      const glyph = crop.state === 'dead' ? '🥀' : (CROP_GLYPH[crop.crop_type] || '🥀');
      ctx.fillText(glyph, 0, 0);
      ctx.restore();
      return;
    }

    const total = crop.growth_end_at - crop.planted_at;
    const elapsed = Math.min(total, Math.max(0, t - crop.planted_at));
    const rawProgress = total > 0 ? elapsed / total : 1;
    // Nothing about a crop's growth should visually move at all until it's
    // actually been watered — no size change, no icon change, no filling
    // progress bar — it should look exactly like the moment it was planted
    // for as long as it sits un-watered, no matter how much real time
    // passes. Previously the progress bar/icon scaling/glyph swap all used
    // the raw elapsed-time progress directly, so an un-watered crop still
    // visibly "grew" on its own, which is exactly backwards from the
    // watering requirement enforced server-side.
    const progress = crop.watered ? rawProgress : 0;
    const ready = crop.state === 'ready' || (progress >= 1 && !!crop.watered);

    // growth stage: brief generic sprout right after planting, then the
    // crop's own icon scales up throughout the rest of growth — so a
    // player can tell corn from carrots well before harvest instead of
    // everything looking like the same generic seedling for most of the
    // growth time.
    ctx.save();
    ctx.translate(cx, cy);
    const scale = ready ? 1 : 0.45 + progress * 0.55;
    ctx.font = `${Math.floor(TILE * 0.55 * scale)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const glyph = progress < 0.12 ? '🌱' : (CROP_GLYPH[crop.crop_type] || '🌿');
    ctx.fillText(glyph, 0, -2);
    ctx.restore();

    if (ready) {
      // gentle "ready" bounce indicator with a soft glow ring
      ctx.save();
      ctx.shadowColor = 'rgba(255,200,74,0.8)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = '#ffc84a';
      ctx.beginPath();
      ctx.arc(px + TILE - 10, py + 10, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (crop.watered) {
      // mini progress bar with a cream backing card — only shown once
      // watering has actually started the clock; an un-watered crop just
      // sits there as a plain seedling with no bar at all, since there's
      // no progress to show yet.
      const barW = TILE - 16;
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillRect(px + 7, py + TILE - 11, barW + 2, 7);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(px + 8, py + TILE - 10, barW, 5);
      ctx.fillStyle = '#5ab0ff';
      ctx.fillRect(px + 8, py + TILE - 10, barW * progress, 5);
    } else {
      // Un-watered: a small blue water-drop reminder instead of a
      // progress bar, so it's visually obvious the crop is just waiting,
      // not silently growing on its own.
      ctx.save();
      ctx.font = `${Math.floor(TILE * 0.28)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.75 + Math.sin(t * 2) * 0.2;
      ctx.fillText('💧', px + TILE - 12, py + 12);
      ctx.restore();
    }
  }

  _drawObjects() {
    const t = this._estimatedServerTime();
    for (const obj of this.farm.objects) this._drawObjectItem(obj, t);
  }

  _drawObjectItem(obj, t) {
    const def = this._defFor(obj);
    const w = (def && def.width) || 1;
    const h = (def && def.height) || 1;
    const px = obj.grid_x * TILE, py = obj.grid_y * TILE;
    const pw = w * TILE, ph = h * TILE;

    if (obj.object_type === 'building') {
      let customColor = null;
      if (obj.state) { try { customColor = JSON.parse(obj.state).color || null; } catch (e) { customColor = null; } }
      this._drawBuilding(px, py, pw, ph, obj.item_id, obj.rotation || 0, customColor);
    } else if (obj.object_type === 'decoration') {
      let growthState = null;
      if (obj.state) { try { growthState = JSON.parse(obj.state); } catch (e) { growthState = null; } }
      this._drawDecoration(px, py, pw, ph, obj.item_id, obj.rotation || 0, obj.grid_x, obj.grid_y, this.farm.objects, growthState);
    } else if (obj.object_type === 'animal') {
      const last = obj.last_collected_at || obj.created_at;
      const fed = this._isAnimalFed(obj);
      const ready = t >= last + (this._animalProdSeconds(obj.item_id) || 600) && fed;
      this._drawAnimal(px, py, pw, ph, obj.item_id, ready, obj.rotation || 0);
      this._drawFeedIndicator(px, py, pw, fed, ready);
    }
  }

  // ---- Vector building drawing ----
  // Each footprint gets a real little structure instead of an emoji: ground
  // shadow, walls, a roof shape specific to the building type, a door, and
  // windows. Keeps everything on plain canvas primitives (no external art).
  _drawBuilding(px, py, pw, ph, itemId, rotation, customColor) {
    const ctx = this.ctx;
    let style = BUILDING_STYLE[itemId] || BUILDING_STYLE.farmhouse;
    // House/Mansion have a chosen wall color stored per-instance (see
    // /place-object's `color` field) — override just the wall (and its
    // shaded variant) rather than the whole style object, so the roof/trim/
    // door stay their normal color and only the walls actually change.
    if (customColor) {
      style = { ...style, wall: customColor, wallDark: shade(customColor, -15) };
    }
    const pad = Math.min(pw, ph) * 0.08;
    const x = px + pad, y = py + pad, w = pw - pad * 2, h = ph - pad * 2;

    // ground shadow
    ctx.fillStyle = 'rgba(30,40,10,0.25)';
    ctx.beginPath();
    ctx.ellipse(px + pw / 2, py + ph - pad * 0.6, w * 0.46, h * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();

    // These are front-facing "storybook" sprites, not top-down tiles, so a
    // true 90°/270° turn wouldn't have matching art. Rotating instead mirrors
    // the building left-right at 180° — a believable "faced the other way"
    // for a front-view sprite, and a real, visible effect on the Rotate button.
    const flipped = rotation === 180 || rotation === 270;
    if (flipped) {
      ctx.save();
      ctx.translate(px + pw / 2, 0);
      ctx.scale(-1, 1);
      ctx.translate(-(px + pw / 2), 0);
    }

    if (style.shape === 'silo') this._drawSilo(x, y, w, h, style);
    else if (style.shape === 'well') this._drawWell(x, y, w, h, style);
    else if (style.shape === 'stall') this._drawStall(x, y, w, h, style);
    else if (style.shape === 'barn') this._drawHouseLike(x, y, w, h, style, 'barn');
    else if (style.shape === 'coop') this._drawHouseLike(x, y, w, h, style, 'coop');
    else if (style.shape === 'shed') this._drawHouseLike(x, y, w, h, style, 'shed');
    else if (style.shape === 'mansion') this._drawMansionSprite(x, y, w, h, customColor);
    else this._drawHouseLike(x, y, w, h, style, 'house');

    if (flipped) ctx.restore();
  }

  // Shared silhouette for house/barn/shed/coop: wall block + triangular
  // (or barn-peaked) roof + door + windows, parameterized by style.
  // A grand colonial-style mansion — flat gray roof, symmetric twin
  // chimneys, a central triangular pediment with a semicircle window
  // over two white pillars flanking the entrance, rows of windows
  // (arched on the ground floor, rectangular above), and a white
  // portico over the door. Distinct enough from the plain farmhouse
  // silhouette to read as a prestige building, matching the reference
  // look the player asked for.
  // The real illustrated Mansion artwork (see public/assets/buildings/
  // mansion_<color>.png) — drawn as-is, no tinting, since each color is a
  // genuinely separate hand-picked piece of art rather than one image
  // recolored. Scaled to fit the building's footprint while preserving
  // the image's own aspect ratio (so it's never stretched/distorted), and
  // centered within that footprint. Falls back to a plain rect if the
  // image hasn't finished loading yet, so there's never a blank gap on
  // the very first frame.
  _drawMansionSprite(x, y, w, h, customColor) {
    const ctx = this.ctx;
    const spriteKey = customColor ? `mansion_${customColor}` : 'mansion';
    const img = getBuildingSprite(spriteKey);
    if (!img.complete || !img.naturalWidth) {
      ctx.fillStyle = '#e0973f';
      ctx.fillRect(x, y, w, h);
      return;
    }
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = w / h;
    let dw, dh;
    if (imgRatio > boxRatio) {
      dw = w;
      dh = w / imgRatio;
    } else {
      dh = h;
      dw = h * imgRatio;
    }
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh); // anchor to the bottom of the footprint, not vertically centered — a building's "feet" should sit on the ground line, not float in the middle of its tile box
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  _drawMansion(x, y, w, h, style) {
    const ctx = this.ctx;
    const roofH = h * 0.14;
    const wallY = y + roofH;
    const wallH = h - roofH;
    const cx = x + w / 2;

    // main roof
    ctx.fillStyle = style.roof;
    ctx.fillRect(x, y, w, roofH);
    ctx.fillStyle = style.roofDark;
    ctx.fillRect(x, y + roofH - h * 0.015, w, h * 0.015);

    // twin chimneys
    const chimW = w * 0.03, chimH = h * 0.16;
    for (const cxOff of [w * 0.1, w * 0.9]) {
      const chx = x + cxOff - chimW / 2;
      ctx.fillStyle = style.wallDark || shade(style.wall, -20);
      ctx.fillRect(chx, y - chimH * 0.55, chimW, chimH * 0.55 + roofH * 0.4);
      ctx.fillStyle = style.roofDark;
      ctx.beginPath();
      ctx.moveTo(chx - chimW * 0.25, y - chimH * 0.55);
      ctx.lineTo(chx + chimW / 2, y - chimH * 0.75);
      ctx.lineTo(chx + chimW * 1.25, y - chimH * 0.55);
      ctx.closePath();
      ctx.fill();
    }

    // wall body
    const wallGrad = ctx.createLinearGradient(x, wallY, x, y + h);
    wallGrad.addColorStop(0, style.wall);
    wallGrad.addColorStop(1, style.wallDark || shade(style.wall, -15));
    ctx.fillStyle = wallGrad;
    ctx.fillRect(x, wallY, w, wallH);

    // central pediment (triangular gable over the entrance, rising above the main roofline)
    const pedW = w * 0.4, pedTopY = y - h * 0.12;
    ctx.fillStyle = style.trim;
    ctx.beginPath();
    ctx.moveTo(cx - pedW / 2, wallY);
    ctx.lineTo(cx, pedTopY);
    ctx.lineTo(cx + pedW / 2, wallY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shade(style.trim, -30);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // pediment cornice (the horizontal band the triangle sits on)
    ctx.fillStyle = style.trim;
    ctx.fillRect(cx - pedW / 2 - w * 0.02, wallY - h * 0.02, pedW + w * 0.04, h * 0.035);
    // semicircle window in the pediment
    ctx.fillStyle = '#bfe8fa';
    ctx.beginPath();
    ctx.arc(cx, wallY - h * 0.02, w * 0.045, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // two pillars supporting the pediment, flanking the entrance
    const pillarW = w * 0.028, pillarH = wallH * 0.82, pillarY = wallY - h * 0.02;
    ctx.fillStyle = style.trim;
    ctx.fillRect(cx - pedW / 2 + w * 0.02, pillarY, pillarW, pillarH);
    ctx.fillRect(cx + pedW / 2 - w * 0.02 - pillarW, pillarY, pillarW, pillarH);

    // windows — arched on the ground floor, rectangular on the floor above,
    // spread across both wings outside the pediment/pillars.
    const winY1 = wallY + wallH * 0.16, winY2 = wallY + wallH * 0.56;
    const winSize = Math.min(w, h) * 0.075;
    const winSpots = [0.06, 0.15, 0.24, 0.76, 0.85, 0.94];
    for (const spot of winSpots) {
      const wx = x + w * spot - winSize / 2;
      // upper rectangular window
      ctx.fillStyle = '#bfe8fa';
      ctx.fillRect(wx, winY1, winSize, winSize * 1.3);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.strokeRect(wx, winY1, winSize, winSize * 1.3);
      ctx.beginPath();
      ctx.moveTo(wx + winSize / 2, winY1); ctx.lineTo(wx + winSize / 2, winY1 + winSize * 1.3);
      ctx.stroke();
      // lower arched window
      ctx.fillStyle = '#bfe8fa';
      ctx.beginPath();
      ctx.moveTo(wx, winY2 + winSize * 1.4);
      ctx.lineTo(wx, winY2 + winSize * 0.5);
      ctx.arc(wx + winSize / 2, winY2 + winSize * 0.5, winSize / 2, Math.PI, 0);
      ctx.lineTo(wx + winSize, winY2 + winSize * 1.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }

    // portico (small white awning) over the entrance
    const doorW = w * 0.05, doorH = wallH * 0.4;
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - w * 0.09, y + h - doorH - h * 0.07, w * 0.18, h * 0.03);
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.1, y + h - doorH - h * 0.04);
    ctx.lineTo(cx, y + h - doorH - h * 0.09);
    ctx.lineTo(cx + w * 0.1, y + h - doorH - h * 0.04);
    ctx.closePath();
    ctx.fill();

    // door
    ctx.fillStyle = style.door;
    ctx.fillRect(cx - doorW / 2, y + h - doorH, doorW, doorH);
    ctx.strokeStyle = shade(style.door, -20);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - doorW / 2, y + h - doorH, doorW, doorH);
  }

  _drawHouseLike(x, y, w, h, style, kind) {
    const ctx = this.ctx;
    const roofH = kind === 'barn' ? h * 0.42 : h * 0.36;
    const wallY = y + roofH;
    const wallH = h - roofH;

    // walls
    const wallGrad = ctx.createLinearGradient(x, wallY, x, y + h);
    wallGrad.addColorStop(0, style.wall);
    wallGrad.addColorStop(1, shade(style.wall, -18));
    ctx.fillStyle = wallGrad;
    ctx.fillRect(x, wallY, w, wallH);
    ctx.strokeStyle = shade(style.wall, -35);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, wallY, w, wallH);

    // roof
    ctx.beginPath();
    if (kind === 'barn') {
      // classic barn gambrel-ish silhouette: two roof slopes meeting a steep peak
      const midY = y + roofH * 0.35;
      ctx.moveTo(x - w * 0.06, wallY);
      ctx.lineTo(x + w * 0.06, midY);
      ctx.lineTo(x + w * 0.5, y);
      ctx.lineTo(x + w * 0.94, midY);
      ctx.lineTo(x + w * 1.06, wallY);
      ctx.closePath();
    } else {
      ctx.moveTo(x - w * 0.08, wallY);
      ctx.lineTo(x + w * 0.5, y);
      ctx.lineTo(x + w * 1.08, wallY);
      ctx.closePath();
    }
    const roofGrad = ctx.createLinearGradient(x, y, x, wallY);
    roofGrad.addColorStop(0, style.roof);
    roofGrad.addColorStop(1, style.roofDark);
    ctx.fillStyle = roofGrad;
    ctx.fill();
    ctx.strokeStyle = shade(style.roofDark, -15);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // roof ridge highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y + 1);
    ctx.lineTo(x + w * (kind === 'barn' ? 0.94 : 1.08), wallY);
    ctx.stroke();

    if (style.chimney) {
      ctx.fillStyle = style.trim;
      ctx.fillRect(x + w * 0.68, y - h * 0.02, w * 0.09, roofH * 0.55);
      ctx.strokeStyle = shade(style.trim, -25);
      ctx.strokeRect(x + w * 0.68, y - h * 0.02, w * 0.09, roofH * 0.55);
    }

    // door
    const doorW = w * (kind === 'barn' ? 0.32 : 0.22);
    const doorH = wallH * (kind === 'barn' ? 0.75 : 0.62);
    const doorX = x + w / 2 - doorW / 2;
    const doorY = y + h - doorH;
    ctx.fillStyle = style.door;
    ctx.fillRect(doorX, doorY, doorW, doorH);
    if (kind === 'barn') {
      // barn doors get an X-brace, classic red-barn detail
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(doorX, doorY); ctx.lineTo(doorX + doorW, doorY + doorH);
      ctx.moveTo(doorX + doorW, doorY); ctx.lineTo(doorX, doorY + doorH);
      ctx.stroke();
    } else {
      ctx.fillStyle = shade(style.door, 30);
      ctx.beginPath();
      ctx.arc(doorX + doorW * 0.78, doorY + doorH * 0.55, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // windows
    const winCount = kind === 'coop' ? 0 : (style.windows || (kind === 'shed' ? 1 : 2));
    const winSize = Math.min(w, h) * 0.13;
    for (let i = 0; i < winCount; i++) {
      const spacing = w * 0.24;
      const wx = x + w / 2 - ((winCount - 1) * spacing) / 2 + i * spacing - winSize / 2;
      // skip a window if it would overlap the door
      if (Math.abs((wx + winSize / 2) - (x + w / 2)) < doorW * 0.7 + winSize * 0.6) continue;
      const wy = wallY + wallH * 0.22;
      ctx.fillStyle = '#bfe8fa';
      ctx.fillRect(wx, wy, winSize, winSize);
      ctx.strokeStyle = style.trim;
      ctx.lineWidth = 2;
      ctx.strokeRect(wx, wy, winSize, winSize);
      ctx.beginPath();
      ctx.moveTo(wx + winSize / 2, wy); ctx.lineTo(wx + winSize / 2, wy + winSize);
      ctx.moveTo(wx, wy + winSize / 2); ctx.lineTo(wx + winSize, wy + winSize / 2);
      ctx.strokeStyle = style.trim;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (kind === 'coop') {
      // wire-fence run in front of the coop
      const fenceY = y + h - wallH * 0.12;
      ctx.strokeStyle = '#8a5a34';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - w * 0.05, fenceY); ctx.lineTo(x + w * 1.05, fenceY);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(120,120,120,0.7)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 6; i++) {
        const fx = x - w * 0.05 + (i / 6) * w * 1.1;
        ctx.beginPath();
        ctx.moveTo(fx, fenceY - wallH * 0.28);
        ctx.lineTo(fx, fenceY);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(x - w * 0.05, fenceY - wallH * 0.28);
      ctx.lineTo(x + w * 1.05, fenceY - wallH * 0.28);
      ctx.stroke();
    }

    if (style.hayloft) {
      ctx.fillStyle = shade(style.wall, -30);
      ctx.beginPath();
      ctx.arc(x + w * 0.5, wallY + wallH * 0.2, Math.min(w, h) * 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = style.trim;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  _drawSilo(x, y, w, h, style) {
    const ctx = this.ctx;
    const bodyX = x + w * 0.2, bodyW = w * 0.6;
    const grad = ctx.createLinearGradient(bodyX, y, bodyX + bodyW, y);
    grad.addColorStop(0, style.bodyDark);
    grad.addColorStop(0.5, style.body);
    grad.addColorStop(1, style.bodyDark);
    ctx.fillStyle = grad;
    ctx.fillRect(bodyX, y + h * 0.12, bodyW, h * 0.85);
    ctx.strokeStyle = shade(style.bodyDark, -20);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bodyX, y + h * 0.12, bodyW, h * 0.85);

    // horizontal bands
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    for (let i = 1; i < 4; i++) {
      const by = y + h * 0.12 + (h * 0.85 * i) / 4;
      ctx.beginPath();
      ctx.moveTo(bodyX, by);
      ctx.lineTo(bodyX + bodyW, by);
      ctx.stroke();
    }

    // domed cap
    ctx.fillStyle = style.cap;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h * 0.12, bodyW / 2, h * 0.1, 0, Math.PI, 0, true);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h * 0.12, bodyW / 2, h * 0.05, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(style.cap, 15);
    ctx.fill();
  }

  _drawWell(x, y, w, h, style) {
    const ctx = this.ctx;
    // stone circular base
    ctx.fillStyle = style.stone;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h * 0.72, w * 0.36, h * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade(style.stone, -25);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // stone texture blocks
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(x + w / 2 + i * w * 0.14, y + h * 0.6);
      ctx.lineTo(x + w / 2 + i * w * 0.14, y + h * 0.84);
      ctx.stroke();
    }
    // posts
    ctx.fillStyle = style.roofDark;
    ctx.fillRect(x + w * 0.14, y + h * 0.18, w * 0.08, h * 0.5);
    ctx.fillRect(x + w * 0.78, y + h * 0.18, w * 0.08, h * 0.5);
    // roof
    ctx.beginPath();
    ctx.moveTo(x + w * 0.04, y + h * 0.26);
    ctx.lineTo(x + w * 0.5, y);
    ctx.lineTo(x + w * 0.96, y + h * 0.26);
    ctx.closePath();
    ctx.fillStyle = style.roof;
    ctx.fill();
    ctx.strokeStyle = shade(style.roof, -20);
    ctx.stroke();
    // rope + bucket
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + h * 0.22);
    ctx.lineTo(x + w / 2, y + h * 0.5);
    ctx.stroke();
    ctx.fillStyle = '#8a5a34';
    ctx.fillRect(x + w * 0.44, y + h * 0.5, w * 0.12, h * 0.1);
  }

  _drawStall(x, y, w, h, style) {
    const ctx = this.ctx;
    // counter/table
    ctx.fillStyle = style.wall;
    ctx.fillRect(x + w * 0.08, y + h * 0.6, w * 0.84, h * 0.3);
    ctx.strokeStyle = shade(style.wall, -25);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + w * 0.08, y + h * 0.6, w * 0.84, h * 0.3);
    // posts
    ctx.fillStyle = shade(style.wall, -15);
    ctx.fillRect(x + w * 0.1, y + h * 0.18, w * 0.06, h * 0.44);
    ctx.fillRect(x + w * 0.84, y + h * 0.18, w * 0.06, h * 0.44);
    // striped awning roof
    const stripes = 6;
    const roofY0 = y, roofY1 = y + h * 0.28;
    for (let i = 0; i < stripes; i++) {
      ctx.beginPath();
      const x0 = x + (w * i) / stripes, x1 = x + (w * (i + 1)) / stripes;
      ctx.moveTo(x0, roofY1);
      ctx.lineTo(x0 + w * 0.03, roofY0 + h * 0.06);
      ctx.lineTo(x1 - w * 0.03, roofY0 + h * 0.06);
      ctx.lineTo(x1, roofY1);
      ctx.closePath();
      ctx.fillStyle = i % 2 === 0 ? style.roof : style.stripe;
      ctx.fill();
      ctx.strokeStyle = shade(style.roofDark, -10);
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    // little produce dots on the counter
    const dots = ['#c0392b', '#e8a527', '#4f8f2e'];
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = dots[i % dots.length];
      ctx.beginPath();
      ctx.arc(x + w * 0.16 + i * w * 0.14, y + h * 0.63, w * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _animalProdSeconds(itemId) {
    const catalog = window.GameCatalog;
    const def = catalog && (catalog.animals || []).find((a) => a.id === itemId);
    return def ? def.production_seconds : null;
  }

  // An animal only counts as "ready" (glow + collectible) once BOTH the
  // production timer has elapsed AND it's been fed since the last
  // collection — otherwise it should read as waiting-on-feed, not
  // quietly counting down toward a reward it can't actually give yet.
  _isAnimalFed(obj) {
    if (!obj.state) return false;
    let state;
    try { state = JSON.parse(obj.state); } catch (e) { return false; }
    const last = obj.last_collected_at || obj.created_at;
    return !!(state.lastFed && state.lastFed >= last);
  }

  // Small badge above the animal showing feed status at a glance: an
  // orange "🍽️" bubble while it still needs feeding, a green "✓" once fed
  // and just waiting on its production timer. Once ready (fed AND timer
  // done), the existing ready-glow already communicates that clearly on
  // its own, so this badge steps aside rather than layering on top of it.
  _drawFeedIndicator(px, py, pw, fed, ready) {
    if (ready) return;
    const ctx = this.ctx;
    const cx = px + pw / 2, cy = py - 6;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fillStyle = fed ? '#4f8f2e' : '#e8a527';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(fed ? '✓' : '!', cx, cy + 1);
    ctx.restore();
  }

  _groundShadow(px, py, pw, ph) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(30,40,10,0.22)';
    ctx.beginPath();
    ctx.ellipse(px + pw / 2, py + ph * 0.86, pw * 0.36, ph * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  _readyGlow(px, py) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(255,200,74,0.8)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffc84a';
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- Vector decoration drawing ----
  // gridX/gridY/allObjects are only needed for fences (to auto-connect to
  // neighboring fence pieces). growthState (parsed from farm_objects.state)
  // is only used for growable decorations like trees — a sapling that's
  // still growing gets a distinct sprite + progress bar instead of an
  // instant full-grown look.
  _drawDecoration(px, py, pw, ph, itemId, rotation, gridX, gridY, allObjects, growthState) {
    const ctx = this.ctx;
    // Workshop-crafted decorations (currently just crafted_bench) reuse
    // the same SHAPE as their store-bought counterpart — strip the prefix
    // so the DECORATION_STYLE lookup below still matches "bench" instead
    // of finding nothing and silently rendering invisible. The rustic
    // wood-grain finish applied near the end of this function (see
    // _drawCraftedWoodGrain) is what actually makes it look distinct from
    // the store-bought bench once placed, not an identical copy of it.
    const isCrafted = itemId.startsWith('crafted_');
    itemId = isCrafted ? itemId.slice('crafted_'.length) : itemId;
    const style = DECORATION_STYLE[itemId];
    if (!style) return;
    const x = px, y = py, w = pw, h = ph;

    if (style.shape === 'fence') {
      this._drawFenceAutoTile(x, y, w, h, style, gridX, gridY, allObjects);
      return;
    }

    if (itemId === 'tree' && growthState) {
      this._drawGrowingTree(x, y, w, h, style, growthState);
      return;
    }

    // A real 90°-step spin — decorations are 1×1 (except pond at 2×2,
    // which is symmetric anyway), so there's no footprint-swap concern
    // like there was for non-square furniture.
    if (rotation) {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }

    this._drawDecorationShape(ctx, style, x, y, w, h);
    if (isCrafted) this._drawCraftedWoodGrain(x, y, w, h);
    if (itemId === 'sign' && growthState && growthState.text) {
      this._drawSignText(x, y, w, h, growthState.text);
    }

    if (rotation) ctx.restore();
  }

  // A tree that hasn't finished growing yet: shown as a small sapling that
  // scales up toward the full tree shape as it grows, with the same
  // progress-bar / ready-glow language used for crops so it reads
  // consistently (water it to speed it up, wait for it, then it's "ready").
  _drawGrowingTree(x, y, w, h, style, growthState) {
    const ctx = this.ctx;
    const t = this._estimatedServerTime();
    const total = growthState.growthEndAt - growthState.plantedAt;
    const elapsed = Math.min(total, Math.max(0, t - growthState.plantedAt));
    const progress = total > 0 ? elapsed / total : 1;
    const matured = progress >= 1 && !!growthState.watered;

    if (matured) {
      this._drawDecorationShape(ctx, style, x, y, w, h);
      return;
    }

    this._groundShadow(x, y, w, h);

    // scale the sapling up from a small sprout toward full tree size
    const scale = 0.35 + progress * 0.65;
    ctx.save();
    ctx.translate(x + w / 2, y + h * 0.85);
    ctx.scale(scale, scale);
    ctx.translate(-(x + w / 2), -(y + h * 0.85));
    ctx.fillStyle = style.trunk;
    ctx.fillRect(x + w * 0.46, y + h * 0.55, w * 0.08, h * 0.3);
    ctx.fillStyle = style.leaf;
    ctx.beginPath();
    ctx.arc(x + w * 0.5, y + h * 0.5, w * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade(style.leafDark, -10);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // progress bar (same visual language as crop growth)
    const barW = w - 16;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillRect(x + 7, y + h - 11, barW + 2, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x + 8, y + h - 10, barW, 5);
    ctx.fillStyle = growthState.watered ? '#5ab0ff' : '#ffc84a';
    ctx.fillRect(x + 8, y + h - 10, barW * progress, 5);
  }

  // Auto-connecting fence, like a classic tile-based fence system: looks at
  // the four neighboring tiles for other fence pieces and draws rails only
  // toward the ones that are actually there, plus a post. This means players
  // never have to rotate fences by hand — placing pieces next to each other
  // is enough for them to visually connect (straight runs, corners, T
  // junctions, and crossings all just fall out of the same logic).
  _drawFenceAutoTile(x, y, w, h, style, gridX, gridY, allObjects) {
    const ctx = this.ctx;
    const isFenceAt = (gx, gy) => {
      if (!allObjects || gridX === undefined) return false;
      return allObjects.some((o) => o.object_type === 'decoration' && o.item_id === 'fence' && o.grid_x === gx && o.grid_y === gy);
    };
    const north = isFenceAt(gridX, gridY - 1);
    const south = isFenceAt(gridX, gridY + 1);
    const east = isFenceAt(gridX + 1, gridY);
    const west = isFenceAt(gridX - 1, gridY);

    const cx = x + w / 2, cy = y + h / 2;
    const railW = h * 0.16;

    ctx.strokeStyle = style.wood;
    ctx.fillStyle = style.wood;
    ctx.lineWidth = railW;
    ctx.lineCap = 'butt';

    const hasAny = north || south || east || west;

    if (east) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x + w, cy); ctx.stroke(); }
    if (west) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, cy); ctx.stroke(); }
    if (north) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, y); ctx.stroke(); }
    if (south) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, y + h); ctx.stroke(); }

    // A lone fence piece with no neighbors yet still reads as a fence post
    // with two short stub rails, instead of just a blank dot.
    if (!hasAny) {
      ctx.beginPath(); ctx.moveTo(x + w * 0.15, cy); ctx.lineTo(x + w * 0.85, cy); ctx.stroke();
    }

    // corner/joint post
    ctx.fillStyle = shade(style.wood, -15);
    const postR = h * 0.13;
    ctx.beginPath();
    ctx.arc(cx, cy, postR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade(style.wood, -30);
    ctx.lineWidth = 1;
    ctx.stroke();

    // subtle highlight rail lines for a bit of dimension
    ctx.strokeStyle = shade(style.wood, 20);
    ctx.lineWidth = 1.5;
    if (east) { ctx.beginPath(); ctx.moveTo(cx, cy - railW / 2 + 1); ctx.lineTo(x + w, cy - railW / 2 + 1); ctx.stroke(); }
    if (west) { ctx.beginPath(); ctx.moveTo(cx, cy - railW / 2 + 1); ctx.lineTo(x, cy - railW / 2 + 1); ctx.stroke(); }
  }

  // The custom text a player paid to put on their Sign (see
  // /api/shop/set-sign-text) — drawn matching the sign board's own
  // position/tilt from the 'sign' shape below, small enough to fit a
  // single tile's worth of board, wrapping onto a second line if needed.
  _drawSignText(x, y, w, h, text) {
    const ctx = this.ctx;
    const cx = x + w / 2;
    ctx.save();
    ctx.translate(cx, y + h * 0.34);
    ctx.rotate(-0.06);
    ctx.fillStyle = '#3a2a1a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const words = text.split(' ');
    if (text.length <= 8 || words.length === 1) {
      ctx.font = `bold ${Math.floor(h * 0.11)}px Nunito, sans-serif`;
      ctx.fillText(text, 0, 0, w * 0.6);
    } else {
      // Split roughly in half by word count so both lines stay short.
      const mid = Math.ceil(words.length / 2);
      const line1 = words.slice(0, mid).join(' ');
      const line2 = words.slice(mid).join(' ');
      ctx.font = `bold ${Math.floor(h * 0.09)}px Nunito, sans-serif`;
      ctx.fillText(line1, 0, -h * 0.07, w * 0.6);
      ctx.fillText(line2, 0, h * 0.07, w * 0.6);
    }
    ctx.restore();
  }

  _drawDecorationShape(ctx, style, x, y, w, h) {
    if (style.shape === 'path') {
      // flush stone/brick tile, no shadow — sits flat like a paved patch.
      // Clipped to the tile bounds so the offset brick courses never bleed
      // into neighboring tiles or wrap around oddly.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, y + 2, w - 4, h - 4);
      ctx.clip();

      ctx.fillStyle = style.stone;
      ctx.fillRect(x + 2, y + 2, w - 4, h - 4);

      ctx.strokeStyle = style.stoneDark;
      ctx.lineWidth = 2;
      const brickH = h / 2;
      for (let row = 0; row < 2; row++) {
        const rowY = y + row * brickH;
        const offset = row % 2 === 0 ? 0 : -w / 4;
        for (let bx = x + offset; bx < x + w; bx += w / 2) {
          ctx.strokeRect(bx, rowY, w / 2, brickH);
        }
      }
      ctx.restore();
      ctx.strokeStyle = style.stoneDark;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      return;
    }

    if (style.shape === 'pond') {
      this._groundShadow(x, y, w, h);
      const cx = x + w / 2, cy = y + h / 2;
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, w * 0.42);
      grad.addColorStop(0, shade(style.water, 20));
      grad.addColorStop(1, style.waterDark);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.42, h * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = shade(style.waterDark, -15);
      ctx.lineWidth = 2;
      ctx.stroke();
      // ripple rings
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.08, cy - h * 0.05, w * 0.12, h * 0.08, 0, 0, Math.PI * 2);
      ctx.stroke();
      // reeds at the edge
      ctx.strokeStyle = style.reed;
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const rx = x + w * 0.14 + i * w * 0.05;
        ctx.beginPath();
        ctx.moveTo(rx, cy + h * 0.28);
        ctx.quadraticCurveTo(rx + 3, cy + h * 0.1, rx - 2, cy - h * 0.02);
        ctx.stroke();
      }
      return;
    }

    this._groundShadow(x, y, w, h);

    if (style.shape === 'tree') {
      ctx.fillStyle = style.trunk;
      ctx.fillRect(x + w * 0.44, y + h * 0.45, w * 0.12, h * 0.4);
      const clusters = [
        { dx: 0.5, dy: 0.34, r: 0.28 }, { dx: 0.32, dy: 0.46, r: 0.2 },
        { dx: 0.68, dy: 0.46, r: 0.2 }, { dx: 0.5, dy: 0.5, r: 0.24 },
      ];
      clusters.forEach((c, i) => {
        ctx.fillStyle = i % 2 === 0 ? style.leaf : style.leafDark;
        ctx.beginPath();
        ctx.arc(x + w * c.dx, y + h * c.dy, w * c.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.strokeStyle = shade(style.leafDark, -10);
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (style.shape === 'bush') {
      const clusters = [
        { dx: 0.5, dy: 0.65, r: 0.24 }, { dx: 0.32, dy: 0.72, r: 0.17 }, { dx: 0.68, dy: 0.72, r: 0.17 },
      ];
      clusters.forEach((c, i) => {
        ctx.fillStyle = i === 0 ? style.leaf : style.leafDark;
        ctx.beginPath();
        ctx.arc(x + w * c.dx, y + h * c.dy, w * c.r, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (style.shape === 'flower') {
      ctx.fillStyle = style.soil;
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h * 0.72, w * 0.34, h * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      const spots = [[0.34, 0.55], [0.5, 0.42], [0.66, 0.55], [0.42, 0.68], [0.58, 0.68]];
      spots.forEach(([dx, dy], i) => {
        const fx = x + w * dx, fy = y + h * dy;
        ctx.strokeStyle = '#5aa32e';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(fx, fy + 6); ctx.lineTo(fx, fy); ctx.stroke();
        ctx.fillStyle = style.colors[i % style.colors.length];
        for (let p = 0; p < 5; p++) {
          const ang = (Math.PI * 2 * p) / 5;
          ctx.beginPath();
          ctx.ellipse(fx + Math.cos(ang) * 3.2, fy + Math.sin(ang) * 3.2, 2.6, 2.2, ang, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#e8a527';
        ctx.beginPath(); ctx.arc(fx, fy, 1.6, 0, Math.PI * 2); ctx.fill();
      });
    } else if (style.shape === 'hay') {
      const cx = x + w / 2, cy = y + h * 0.58, r = Math.min(w, h) * 0.28;
      const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
      grad.addColorStop(0, style.bodyDark);
      grad.addColorStop(0.5, style.body);
      grad.addColorStop(1, style.bodyDark);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = style.band;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - r, cy - r * 0.2); ctx.lineTo(cx + r, cy - r * 0.2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - r, cy + r * 0.2); ctx.lineTo(cx + r, cy + r * 0.2); ctx.stroke();
    } else if (style.shape === 'bench') {
      // Narrowed to fit within a sitting character's own visual width
      // (~0.63 of a tile) — the seat plank used to be wider than that
      // (0.72), so it stuck out past the character on both sides even
      // with the legs pulled in and the backrest lowered.
      const bx = x + w * 0.22, by = y + h * 0.42, bw = w * 0.56;
      // The backrest sits just above the seat now, not up near where a
      // seated character's chest/head would be — a backrest that tall
      // used to visually cut across a seated character's torso no matter
      // which order the bench and character drew in.
      ctx.fillStyle = style.wood;
      ctx.fillRect(bx, by + h * 0.16, bw, h * 0.06); // backrest (low)
      ctx.fillRect(bx, by + h * 0.24, bw, h * 0.1); // seat
      ctx.fillStyle = style.woodDark;
      // Legs pulled in closer to center than the seat's own width would
      // suggest, so a seated character's body actually covers them
      // instead of leaving them visibly poking out past either side.
      ctx.fillRect(x + w * 0.32, by + h * 0.34, w * 0.06, h * 0.24); // legs
      ctx.fillRect(x + w * 0.62, by + h * 0.34, w * 0.06, h * 0.24);
    } else if (style.shape === 'lamp') {
      const cx = x + w / 2;
      const t = performance.now() / 1000;
      // Deterministic per-lamp phase offset from its own screen position —
      // so multiple lamp posts breathe/flicker out of sync with each
      // other instead of all pulsing in perfect unison.
      const phase = (x + y) * 0.013;
      ctx.fillStyle = style.post;
      ctx.fillRect(cx - w * 0.03, y + h * 0.28, w * 0.06, h * 0.55);
      ctx.fillStyle = style.post;
      ctx.beginPath(); ctx.ellipse(cx, y + h * 0.83, w * 0.12, h * 0.03, 0, 0, Math.PI * 2); ctx.fill();

      // "Breathing" glow — the bulb slowly brightens and dims instead of
      // sitting at one fixed brightness, same pulsing idea as the Special
      // Outfit aura's glow puddle.
      const pulse = 0.6 + 0.4 * Math.sin(t * 1.6 + phase);
      ctx.save();
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = 6 + pulse * 10;
      ctx.globalAlpha = 0.75 + pulse * 0.25;
      ctx.fillStyle = style.glass;
      ctx.beginPath();
      ctx.ellipse(cx, y + h * 0.2, w * 0.14, h * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Firefly-like glowing particles drifting around the lamp head —
      // same "glowing orbit" idea as the Special Outfit aura's floating
      // orbs, just smaller and scoped to right around the lamp instead of
      // a whole character. Gradient-based halos (not shadowBlur) to keep
      // this cheap even with several lamp posts on one farm.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const fireflyCount = 3;
      for (let i = 0; i < fireflyCount; i++) {
        const angle = t * (0.7 + i * 0.15) + phase + (i / fireflyCount) * Math.PI * 2;
        const orbitR = w * (0.32 + 0.15 * Math.sin(t * 0.9 + i * 2));
        const fx = cx + Math.cos(angle) * orbitR;
        const fy = y + h * 0.16 + Math.sin(angle * 1.3) * h * 0.14 - i * 2;
        const flicker = 0.35 + 0.65 * Math.sin(t * 4 + i * 3.1 + phase);
        const haloGrad = ctx.createRadialGradient(fx, fy, 0, fx, fy, 5);
        haloGrad.addColorStop(0, `rgba(255,240,150,${Math.max(0, flicker)})`);
        haloGrad.addColorStop(1, 'rgba(255,240,150,0)');
        ctx.fillStyle = haloGrad;
        ctx.beginPath(); ctx.arc(fx, fy, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,255,230,${Math.max(0, flicker)})`;
        ctx.beginPath(); ctx.arc(fx, fy, 1.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      ctx.strokeStyle = style.post;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.14, y + h * 0.12); ctx.lineTo(cx + w * 0.14, y + h * 0.12);
      ctx.moveTo(cx, y + h * 0.05); ctx.lineTo(cx, y + h * 0.28);
      ctx.stroke();
    } else if (style.shape === 'sign') {
      const cx = x + w / 2;
      ctx.fillStyle = style.post;
      ctx.fillRect(cx - w * 0.04, y + h * 0.3, w * 0.08, h * 0.55);
      ctx.save();
      ctx.translate(cx, y + h * 0.34);
      ctx.rotate(-0.06);
      ctx.fillStyle = style.board;
      ctx.fillRect(-w * 0.32, -h * 0.14, w * 0.64, h * 0.28);
      ctx.strokeStyle = style.boardDark;
      ctx.lineWidth = 2;
      ctx.strokeRect(-w * 0.32, -h * 0.14, w * 0.64, h * 0.28);
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-w * 0.26, 0); ctx.lineTo(w * 0.26, 0); ctx.stroke();
      ctx.restore();
    }
  }

  // ---- Vector animal drawing ----
  _drawAnimal(px, py, pw, ph, itemId, ready, rotation) {
    const ctx = this.ctx;
    const style = ANIMAL_STYLE[itemId];
    if (!style) return;
    const x = px, y = py, w = pw, h = ph;
    const cx = x + w / 2, cy = y + h * 0.6;

    this._groundShadow(px, py, pw, ph);

    // Mirror left-right at 180° so the animal visibly "turns to face the
    // other way" — a real, visible effect for the Rotate button on sprites
    // that (like the buildings) don't have true multi-angle art.
    const flipped = rotation === 180 || rotation === 270;
    if (flipped) {
      ctx.save();
      ctx.translate(cx, 0);
      ctx.scale(-1, 1);
      ctx.translate(-cx, 0);
    }

    // legs (drawn first, behind body)
    ctx.strokeStyle = shade(style.body, -60);
    ctx.lineWidth = 2.5;
    [-0.16, 0.16].forEach((dx) => {
      ctx.beginPath();
      ctx.moveTo(cx + w * dx, cy + h * 0.14);
      ctx.lineTo(cx + w * dx, cy + h * 0.26);
      ctx.stroke();
    });

    if (style.shape === 'sheep') {
      // fluffy cloud-bump body
      const bumps = [[-0.14, 0, 0.16], [0.14, 0, 0.16], [0, -0.06, 0.19], [-0.05, 0.08, 0.14], [0.05, 0.08, 0.14]];
      bumps.forEach(([dx, dy, r]) => {
        ctx.fillStyle = style.body;
        ctx.beginPath();
        ctx.arc(cx + w * dx, cy + h * dy, w * r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.strokeStyle = shade(style.body, -20);
      ctx.lineWidth = 1;
      ctx.stroke();
      // face
      ctx.fillStyle = style.face;
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.26, cy - h * 0.02, w * 0.09, h * 0.1, -0.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (style.shape === 'cow') {
      ctx.fillStyle = style.body;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.3, h * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = shade(style.body, -25);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // spots
      ctx.fillStyle = style.spot;
      ctx.beginPath(); ctx.ellipse(cx - w * 0.1, cy - h * 0.04, w * 0.07, h * 0.05, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + w * 0.14, cy + h * 0.03, w * 0.06, h * 0.045, -0.2, 0, Math.PI * 2); ctx.fill();
      // head
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.3, cy - h * 0.02, w * 0.12, h * 0.11, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = style.nose;
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.38, cy + h * 0.02, w * 0.06, h * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
      // ears
      ctx.fillStyle = style.spot;
      ctx.beginPath(); ctx.ellipse(cx - w * 0.34, cy - h * 0.12, w * 0.04, h * 0.05, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx - w * 0.22, cy - h * 0.12, w * 0.04, h * 0.05, 0, 0, Math.PI * 2); ctx.fill();
    } else if (style.shape === 'pig') {
      ctx.fillStyle = style.body;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.27, h * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = shade(style.body, -20);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // ears
      ctx.fillStyle = shade(style.body, -8);
      ctx.beginPath(); ctx.ellipse(cx - w * 0.22, cy - h * 0.12, w * 0.05, h * 0.06, -0.3, 0, Math.PI * 2); ctx.fill();
      // snout
      ctx.fillStyle = style.snout;
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.28, cy, w * 0.08, h * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade(style.snout, -30);
      ctx.beginPath(); ctx.arc(cx - w * 0.31, cy - 1, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx - w * 0.25, cy - 1, 1.2, 0, Math.PI * 2); ctx.fill();
      // curly tail
      ctx.strokeStyle = shade(style.body, -15);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx + w * 0.26, cy - h * 0.08, 3, 0, Math.PI * 1.5);
      ctx.stroke();
    } else if (style.shape === 'chicken') {
      // tail feathers (drawn first, behind the body)
      ctx.fillStyle = shade(style.body, -6);
      ctx.strokeStyle = shade(style.body, -25);
      ctx.lineWidth = 1;
      [[-0.02, -0.08], [-0.06, -0.03], [-0.06, 0.04]].forEach(([dx, dy]) => {
        ctx.beginPath();
        ctx.ellipse(cx - w * (0.24 + dx), cy + h * dy, w * 0.09, h * 0.05, -0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });

      // plump, fluffy body with soft shading
      const bodyGrad = ctx.createRadialGradient(cx + w * 0.03, cy - h * 0.05, 2, cx, cy, w * 0.22);
      bodyGrad.addColorStop(0, shade(style.body, 6));
      bodyGrad.addColorStop(1, style.body);
      ctx.fillStyle = bodyGrad;
      ctx.strokeStyle = shade(style.body, -25);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.2, h * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // wing
      ctx.fillStyle = shade(style.body, -10);
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.03, cy + h * 0.02, w * 0.1, h * 0.09, -0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = shade(style.body, -25);
      ctx.lineWidth = 1;
      ctx.stroke();

      // head — clearly separated from the body by a small neck, not fused
      ctx.fillStyle = bodyGrad;
      ctx.strokeStyle = shade(style.body, -25);
      ctx.beginPath();
      ctx.arc(cx + w * 0.19, cy - h * 0.17, w * 0.095, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // comb — rounded scallop shape, sits on top of the head
      ctx.fillStyle = style.comb;
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.1, cy - h * 0.22);
      ctx.quadraticCurveTo(cx + w * 0.12, cy - h * 0.32, cx + w * 0.16, cy - h * 0.24);
      ctx.quadraticCurveTo(cx + w * 0.19, cy - h * 0.33, cx + w * 0.22, cy - h * 0.24);
      ctx.quadraticCurveTo(cx + w * 0.25, cy - h * 0.3, cx + w * 0.26, cy - h * 0.21);
      ctx.closePath();
      ctx.fill();

      // wattle — small dangle right at the chin, under the beak
      ctx.fillStyle = shade(style.comb, 10);
      ctx.beginPath();
      ctx.ellipse(cx + w * 0.24, cy - h * 0.08, w * 0.02, h * 0.03, 0, 0, Math.PI * 2);
      ctx.fill();

      // beak — proper triangular point
      ctx.fillStyle = style.beak;
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.27, cy - h * 0.15);
      ctx.lineTo(cx + w * 0.35, cy - h * 0.13);
      ctx.lineTo(cx + w * 0.27, cy - h * 0.1);
      ctx.closePath();
      ctx.fill();

      // eye with a little highlight so it doesn't look dead/flat
      ctx.fillStyle = '#3a2a18';
      ctx.beginPath(); ctx.arc(cx + w * 0.21, cy - h * 0.19, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx + w * 0.215, cy - h * 0.2, 0.5, 0, Math.PI * 2); ctx.fill();
    }

    if (flipped) ctx.restore();
    if (ready) this._readyGlow(px + pw - 10, py + 10);
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

}

// Standalone mini character preview — used by the Outfits shop cards.
// Outfit shop preview — now shows the actual sprite (front-idle pose) so the
// card matches what you'll really see in-game, instead of a separate vector
// drawing. Outfit color options no longer change the character's look (the
// sprite is a fixed illustrated asset); dyeColor/outfitDef are accepted for
// backward compatibility with existing call sites but unused here now.
function drawMiniCharacter(canvas, gender, outfitDef, dyeColor) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const g = gender === 'female' ? 'female' : 'male';
  const key = spriteKeyFor(g, 'down', 0, false, outfitDef && outfitDef.sprite_key);
  const img = getSprite(key);
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    const displayHeight = h * 0.92;
    const displayWidth = displayHeight * (img.naturalWidth / img.naturalHeight);
    ctx.drawImage(img, (w - displayWidth) / 2, h - displayHeight - h * 0.04, displayWidth, displayHeight);
  };
  if (img.complete && img.naturalWidth > 0) draw();
  else img.addEventListener('load', draw, { once: true });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

window.FarmGame = FarmGame;
window.TILE = TILE;
window.drawMiniCharacter = drawMiniCharacter;
