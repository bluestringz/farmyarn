// public/js/api.js
// Thin wrapper around fetch(). All game rules live server-side; this file
// never computes coins/xp/growth itself, it only relays requests.

const Api = (() => {
  let token = localStorage.getItem('fy_token') || null;

  function setToken(t) {
    token = t;
    if (t) localStorage.setItem('fy_token', t);
    else localStorage.removeItem('fy_token');
  }

  function getToken() {
    return token;
  }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const message = res.status === 429
        ? "You're doing that a bit fast — wait a few seconds and try again."
        : (data && data.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Separate from request() — file uploads need multipart/form-data with a
  // browser-generated boundary, not our usual JSON content type.
  async function uploadAvatar(file) {
    const form = new FormData();
    form.append('avatar', file);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/player/avatar', { method: 'POST', headers, body: form });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const message = res.status === 429
        ? "You're doing that a bit fast — wait a few seconds and try again."
        : (data && data.error) || `Upload failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    setToken, getToken,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    del: (path) => request('DELETE', path),
    uploadAvatar,
    setDisplayName: (name) => request('POST', '/api/player/display-name', { name }),
    changePassword: (currentPassword, newPassword) => request('POST', '/api/player/change-password', { currentPassword, newPassword }),
    startResting: () => request('POST', '/api/player/rest'),
    stopResting: () => request('POST', '/api/player/stop-rest'),
    forgotPassword: (username, message) => request('POST', '/api/auth/forgot-password', { username, message }),

    // Auth
    register: (username, password, gender) => request('POST', '/api/auth/register', { username, password, gender }),
    login: (username, password) => request('POST', '/api/auth/login', { username, password }),

    // Player
    me: () => request('GET', '/api/player/me'),
    inventory: () => request('GET', '/api/player/inventory'),
    outfits: () => request('GET', '/api/player/outfits'),
    equipOutfit: (outfitId) => request('POST', '/api/player/equip-outfit', { outfitId }),
    notifications: () => request('GET', '/api/player/notifications'),
    markNotificationsRead: (notificationId) => request('POST', '/api/player/notifications/read', { notificationId }),
    dailyRewardStatus: () => request('GET', '/api/player/daily-reward/status'),
    claimDailyReward: () => request('POST', '/api/player/daily-reward/claim'),

    // Farm
    myFarm: () => request('GET', '/api/farm/me'),
    viewFarm: (userId) => request('GET', `/api/farm/${userId}`),
    myInterior: (opts) => {
      const params = new URLSearchParams();
      if (opts && opts.buildingId) params.set('buildingId', opts.buildingId);
      else if (opts && opts.space) params.set('space', opts.space);
      const qs = params.toString();
      return request('GET', `/api/farm/me/interior${qs ? `?${qs}` : ''}`);
    },
    plow: (x, y) => request('POST', '/api/farm/plow', { x, y }),
    plant: (x, y, cropType) => request('POST', '/api/farm/plant', { x, y, cropType }),
    water: (x, y, ownerId) => request('POST', '/api/farm/water', { x, y, ownerId }),
    waterDecoration: (objectId) => request('POST', '/api/farm/water-decoration', { objectId }),
    harvestTree: (objectId) => request('POST', '/api/farm/harvest-tree', { objectId }),
    harvest: (x, y) => request('POST', '/api/farm/harvest', { x, y }),
    sell: (itemId, quantity) => request('POST', '/api/farm/sell', { itemId, quantity }),
    expand: () => request('POST', '/api/farm/expand'),

    // Shop
    catalog: () => request('GET', '/api/shop/catalog'),
    buySeed: (cropType, quantity) => request('POST', '/api/shop/buy-seed', { cropType, quantity }),
    buyOutfit: (outfitId) => request('POST', '/api/shop/buy-outfit', { outfitId }),
    dye: (color) => request('POST', '/api/shop/dye', { color }),
    buyPlaceable: (category, itemId, quantity) => request('POST', '/api/shop/buy-placeable', { category, itemId, quantity }),
    placeObject: (category, itemId, x, y, rotation, location) =>
      request('POST', '/api/shop/place-object', { category, itemId, x, y, rotation, location }),
    moveObject: (objectId, x, y, rotation) => request('POST', '/api/shop/move-object', { objectId, x, y, rotation }),
    deleteObject: (objectId) => request('DELETE', `/api/shop/object/${objectId}`),
    collectAnimal: (objectId) => request('POST', '/api/shop/collect-animal', { objectId }),
    craftFeed: (animalType, quantity) => request('POST', '/api/shop/craft-feed', { animalType, quantity }),
    feedAnimal: (objectId) => request('POST', '/api/shop/feed-animal', { objectId }),
    cook: (cropType, quantity, atFarmId) => request('POST', '/api/farm/cook', { cropType, quantity, atFarmId }),
    eat: (foodItemId) => request('POST', '/api/farm/eat', { foodItemId }),

    // Marketplace (player-to-player)
    marketplace: () => request('GET', '/api/marketplace'),
    rentStall: (stallId) => request('POST', '/api/marketplace/rent', { stallId }),
    listStall: (itemId, quantity, price) => request('POST', '/api/marketplace/list', { itemId, quantity, price }),
    cancelListing: () => request('POST', '/api/marketplace/cancel-listing'),
    leaveStall: () => request('POST', '/api/marketplace/leave'),
    buyFromStall: (stallId, quantity) => request('POST', '/api/marketplace/buy', { stallId, quantity }),

    // Friends
    searchUsers: (q) => request('GET', `/api/friends/search?q=${encodeURIComponent(q)}`),
    listFriends: () => request('GET', '/api/friends'),
    requestFriend: (userId) => request('POST', '/api/friends/request', { userId }),
    respondFriend: (requestId, accept) => request('POST', '/api/friends/respond', { requestId, accept }),
    removeFriend: (userId) => request('DELETE', `/api/friends/${userId}`),

    // Chat
    globalChatHistory: () => request('GET', '/api/chat/global'),
    sendGlobalChat: (message) => request('POST', '/api/chat/global', { message }),
    sendWhisper: (toUserId, message) => request('POST', '/api/chat/whisper', { toUserId, message }),
  };
})();
