# 🌾 FarmYARN

A real, playable, multiplayer, old-school social farming game — inspired by the
gameplay feel of classic 2009-era browser farm games. Original code, original
art direction (emoji-glyph sprites on hand-painted wooden panels), no
copyrighted assets.

This is a **working foundation**, not a mockup: real accounts, a real
database, server-authoritative crop growth, and enforced farm-visit
permissions, all designed to be deployed to your own server.

## What's implemented (v1 / MVP)

- Registration & login (bcrypt-hashed passwords, JWT sessions)
- Persistent per-player farm stored in SQLite (grid, tiles, crops, objects)
- Plow → Plant → Water → Harvest, with **server-timestamp-based growth** —
  crops keep growing while you're logged out, and the server (not the
  browser clock) decides when they're ready
- Coins, XP, leveling (unlocks higher-level seeds/buildings/animals)
- Shop: seeds, buildings, animals, decorations — all purchases validated
  server-side
- Farm expansion (grid grows, cost doubles each time)
- Animals that produce goods over time (collected the same way as crops)
- Friends/neighbors: search, request, accept, remove
- Visiting another player's farm: read-only by default, with a
  **friend-gated "help" system** (watering a friend's crop) that is
  rate-limited to once per growth cycle and rewards the helper
- Server-enforced permissions — a visitor's client can *try* to move or
  sell things on someone else's farm, but the backend always rejects it
  (see the test script below)
- Notifications (level up, help received, friend requests/accepts)
- Daily login rewards with streak tracking
- Optional energy system (togglable via `.env`)
- Basic admin panel (`/admin.html`): view/search players, adjust
  coins/XP, give items, ban/unban
- Real-time layer via Socket.IO: online presence + push notifications
  (help alerts, friend requests) without polling
- Canvas-based farm view with pan/zoom (mouse + touch), works on desktop
  and mobile browsers

Everything server-important — coins, XP, crop timers, purchase costs,
visitor permissions — is computed and checked **on the server**. The
client only sends intents ("plant wheat at (3,4)") and renders whatever
the server returns.

## Architecture

```
farmco-op/
├── server/
│   ├── index.js           Express app + Socket.IO wiring, static hosting
│   ├── db/
│   │   ├── migrate.js     Schema + seed data (crops/buildings/etc.)
│   │   └── make-admin.js  CLI: promote a user to admin
│   ├── middleware/auth.js JWT auth + admin gating
│   ├── lib/gameLogic.js   Server-authoritative rules (XP curve, energy,
│   │                      reward granting, crop-state resolution)
│   └── routes/
│       ├── auth.js        register / login
│       ├── farm.js        plow / plant / water / harvest / sell / expand
│       ├── shop.js        buy/move/delete objects, collect animal goods
│       ├── friends.js     search / request / accept / remove
│       ├── player.js      profile, inventory, notifications, daily reward
│       └── admin.js       player management
├── public/                 Frontend (vanilla JS + Canvas, no build step)
│   ├── index.html
│   ├── admin.html
│   ├── css/style.css
│   └── js/
│       ├── api.js          fetch() wrapper for the REST API
│       ├── game.js         canvas renderer + camera + input handling
│       ├── ui.js            panel/toast rendering
│       └── main.js          app state machine, wires everything together
├── data/                    SQLite database lives here (gitignored)
├── .env.example
└── package.json
```

**Stack:** Node.js + Express, SQLite (via `better-sqlite3`), JWT auth,
Socket.IO for presence/notifications, vanilla JS + HTML5 Canvas frontend
(no build step, no framework — easy to read and extend).

SQLite was chosen over Postgres/MySQL for the MVP because it needs zero
setup on your server and the whole game state fits comfortably in it for
quite a while. The schema is plain SQL and the queries are simple, so
swapping in Postgres later (if you outgrow a single file) is a
straightforward port — see "Scaling up" below.

## Database schema

See `server/db/migrate.js` for the authoritative schema. Summary:

- `users` — accounts, coins, xp, level, energy, admin/ban flags
- `farms` — one per user, width/height/expansion_level
- `farm_tiles` — grass/plowed state per (farm, x, y)
- `crops` — `planted_at` / `growth_end_at` are **unix timestamps**; growth
  is always computed from these, never from elapsed client time
- `farm_objects` — buildings/decorations/animals placed on a farm, with
  `last_collected_at` used for animal production timing
- `crop_types`, `building_types`, `decoration_types`, `animal_types`,
  `item_types` — static game-content tables, editable directly in SQLite
  or by extending the seed data in `migrate.js`
- `inventory`, `friends`, `help_actions`, `notifications`,
  `daily_rewards_claimed` — self-explanatory from their names

## Local setup

Requires **Node.js 18+**.

```bash
cd farmco-op
npm install
cp .env.example .env
# Edit .env and set a real JWT_SECRET (see the comment in the file for
# a one-liner to generate one). Everything else has sane defaults.
npm run migrate     # creates data/farmco-op.db and seeds game content
npm start            # starts the server on http://localhost:3000
```

Open `http://localhost:3000` in a browser (or two browsers / a private
window, to play as two different players at once).

To make a player an admin:

```bash
npm run make-admin -- <username>
```

Then log in at `http://localhost:3000/admin.html` with that account.

## Deploying to your own server

The app is a single Node process that serves both the API and the
static frontend — no separate frontend build/deploy step.

1. Copy the whole project to your server (or `git clone` it).
2. `npm install --production`
3. Create `.env` on the server (same as local setup, but set:
   - `JWT_SECRET` to a real random secret
   - `CORS_ORIGIN` to your actual domain, e.g. `https://myfarmgame.com`
   - `PORT` to whatever your reverse proxy expects, commonly `3000`)
4. `npm run migrate`
5. Start it with a process manager so it survives reboots/crashes, e.g.:
   ```bash
   npm install -g pm2
   pm2 start server/index.js --name farmyarn
   pm2 save
   ```
6. Put a reverse proxy (nginx/Caddy) in front for TLS + your domain.
   Example nginx `location` block:
   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;   # needed for Socket.IO
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
   }
   ```
   Caddy does this automatically with just:
   ```
   myfarmgame.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
7. Visit `https://myfarmgame.com`. The frontend and backend are the
   same origin, so nothing needs a hardcoded `localhost` URL anywhere.

### If you outgrow SQLite (scaling up)

`better-sqlite3` handles a meaningful number of concurrent players fine
(it's synchronous and very fast for this workload), but if you need
true multi-process/multi-server scaling later, swap `server/db/migrate.js`
and the `db.prepare(...)` calls for a Postgres client (e.g. `pg` or
`postgres.js`) — the schema is plain SQL and translates directly. At that
point also move Socket.IO to a Redis adapter so presence works across
multiple server instances.

## Configuration

All in `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs login tokens. Must be set, no default. |
| `PORT` | Port the server listens on. |
| `DB_PATH` | Where the SQLite file lives. |
| `CORS_ORIGIN` | Allowed origin for API/websocket requests. |
| `ENERGY_ENABLED` | `true`/`false` — turn the energy system on/off. |
| `ENERGY_MAX` | Max energy. |
| `ENERGY_REGEN_SECONDS` | Seconds per 1 energy point regenerated. |

## Testing the multiplayer/permission behavior

A quick manual test that mirrors the classic acceptance tests for this
kind of game:

1. Register two accounts (Player A, Player B).
2. As A: plow a tile, plant wheat.
3. Wait for (or, for testing, directly edit) `growth_end_at` in the
   `crops` table to be in the past — harvest should now succeed, proving
   growth is resolved from the stored timestamp rather than a client
   timer.
4. Have A and B become friends (`request` → `respond` with `accept:true`).
5. As A, visit B's farm (`GET /api/farm/:userId`) — you can see it but
   `POST /api/shop/move-object` on B's objects returns an error, and
   `POST /api/farm/harvest` only ever operates on your *own* farm route.
6. As A, water one of B's growing (unwatered) crops — succeeds once,
   grants A a small reward, and creates a notification for B. Trying to
   water the same crop again fails ("You already helped with this crop").
7. Call any `/api/*` route with no `Authorization` header — you get
   `401 Missing auth token`.

This exact sequence was run against the server during development
(see the project history) and all of the above held.

## Extending the game

The architecture was kept deliberately simple so new content is mostly
data, not new systems:

- **New crop/building/decoration/animal**: add a row to the relevant
  seed array in `server/db/migrate.js` and re-run `npm run migrate`
  (it's an upsert, safe to re-run). Add a glyph mapping in
  `public/js/game.js` (`CROP_GLYPH` / `BUILDING_GLYPH` / etc.) so it
  renders.
- **New farm action**: add a route in `server/routes/farm.js` following
  the existing pattern (validate ownership/permission → validate game
  rules → mutate DB → return new state), then wire a client call in
  `public/js/api.js` and a toolbar button in `index.html`/`main.js`.
- **Chat, quests, achievements, seasonal events, trading, etc.**
  (see the original brief's "future features" list): each of these fits
  as a new table + a new route file, following the same conventions as
  `friends.js` or `player.js`. The Socket.IO layer is already in place
  for anything that needs to push updates in real time.

## Security notes

- Passwords are hashed with bcrypt (cost factor 12), never stored or
  logged in plain text.
- All game-economy actions (planting, harvesting, buying, selling,
  expanding) are validated and mutated server-side; the client cannot
  set its own coins/xp/level.
- Crop and animal timers are computed from stored unix timestamps, not
  trusted client clocks.
- JWT auth is required on every gameplay route; admin routes additionally
  require `is_admin = 1` on the account.
- Visiting another player's farm only grants read access plus the
  specific, rate-limited "water a crop" help action — every other
  mutation route re-derives the farm from the authenticated user's own
  id, so there is no code path where a request body can specify whose
  farm to modify.
- Basic rate limiting is applied globally (`/api/*`) and more strictly
  on `/api/auth/*` to slow down brute-force attempts.
