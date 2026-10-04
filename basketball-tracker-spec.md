# Basketball Team Stats Tracker — Technical Spec

## 1. Goals

- Log basic in-game stats **from the bench, live, with minimal taps** (possessions, offensive/defensive rebounds, turnovers, points).
- Compute derived stats (points per possession) automatically.
- Show a dashboard: **per-game** view and **trend-over-time** view (across the season).
- Cheap/free to run, easy to keep updated, lives in your GitHub repo, deployable without vendor lock-in.

## 2. Does it need a database? Yes.

Serverless functions — Cloudflare Pages Functions included — are stateless: no writable filesystem persists between invocations. Since you explicitly want history "over time," you need a persistence layer outside the app code. The dataset is tiny (dozens of games/season, a few hundred events/game), so this is a capacity non-issue — pick the DB for *developer experience* and *free-tier permanence*, not scale.

**Recommendation: a small hosted SQL DB, decoupled from your hosting provider**, so you can move frontend/backend hosts later without touching data:

| Option | Why | Free tier |
|---|---|---|
| **Turso** (libSQL/SQLite) | Fastest to set up, SQL you already know, great for edge functions, fully independent of Cloudflare | Generous, no card required |
| **Supabase** (Postgres) | More features (auto REST API, realtime, dashboard UI to poke at data), if you want that overhead | Generous, no card required |
| Neon (Postgres) | Similar to Supabase, more minimal | Generous |

Go with **Turso** unless you want Supabase's built-in table-editor GUI for manually fixing a bad stat entry after a game — that's a real convenience for a non-technical assistant coach editing data.

## 3. Domain model

No opponent stats, no shot make/miss tracking (no FG%) — only what feeds possessions, points-per-possession, rebounds, and turnovers for your own team. This trims the bench UI to just what's needed, no shot-attempt bookkeeping.

**Entities**

- `teams` — id, name, category (e.g. `"U13"`, `"U14"`), slug. Seeded with a single row for Campus Monferrato U13 at setup. Not exposed in the UI at all for v1 — there's nothing to pick between yet — but every other table hangs off `team_id` from day one, so adding U14/U15 later is inserting a row here, not restructuring anything.
- `games` — id, `team_id` (FK → `teams`), date, opponent_name (free text label, not a tracked entity), final_score_for, final_score_against (optional, just for the record)
- `events` — id, game_id, timestamp/game_clock (optional), type, points (nullable)

**Event types** (single-button taps, 7 buttons total):

| Button | Effect |
|---|---|
| `+1` | Adds 1 point. Does **not** end the possession. Stored as `FT`. The points stay with the possession that a later `+2`, `+3`, `EMPTY`, or `TOV` closes |
| `+2` / `+3` | Adds points, **ends possession**. Stored as `SCORE` |
| `EMPTY` | Adds no points of its own and **ends possession**. Closes a trip that produced nothing, and also closes a free-throw trip that already scored with `+1` |
| `TOV` (turnover) | **Ends possession**, no points, counted separately as a turnover |
| `OFF_REB` | Continues the same possession. Does **not** end it or increment the possession count |
| `DEF_REB` | Standalone defensive stat. Tallied on its own, and it does not change the possession count |

There is still no `MISS` button and no field-goal percentage. A made free throw is one point on the current possession, not a shot attempt. `EMPTY` and `TOV` are still the only two buttons that end a possession with no points of their own. The bench sequences are in the README.

**Derived stats (computed, not stored), always scoped to a `team_id`:**

- `possessions` = count of `+2` + `+3` + `EMPTY` + `TOV` events. A `+1` is not in this count
- `points_per_possession` = `SUM(points) / possessions`. `SUM(points)` includes every `+1`
- `offensive_rebounds` = count of `OFF_REB`
- `defensive_rebounds` = count of `DEF_REB`
- `turnovers` = count of `TOV`

All stats derive from this one flat event log. There are no separate counters to keep in sync. A `+1` that is never closed stays in the points and is left out of the possession count.

## 4. SQL schema

Run this in `turso db shell campus-u13` (or paste into `tursodb` first to sanity-check the syntax locally, then re-run against the real Turso database — the two shells speak the same SQLite dialect but are separate tools, see the earlier note on `turso` vs `tursodb`):

```sql
CREATE TABLE teams (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,           -- e.g. 'U13', 'U14'
  slug     TEXT NOT NULL UNIQUE     -- e.g. 'campus-monferrato-u13'
);

CREATE TABLE games (
  id                  TEXT PRIMARY KEY,  -- client-generated UUID, see \u00a7 offline architecture
  team_id             INTEGER NOT NULL REFERENCES teams(id),
  date                TEXT NOT NULL,   -- ISO 8601, e.g. '2026-10-04'
  opponent_name       TEXT NOT NULL,
  final_score_for     INTEGER,
  final_score_against INTEGER,
  created_at          TEXT NOT NULL   -- set by the client at creation time, not by the server
);

CREATE INDEX idx_games_team_id ON games(team_id);

CREATE TABLE events (
  id         TEXT PRIMARY KEY,  -- client-generated UUID, see \u00a7 offline architecture
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('SCORE', 'FT', 'EMPTY', 'TOV', 'OFF_REB', 'DEF_REB')),
  points     INTEGER NOT NULL DEFAULT 0
             CHECK (
               (type = 'SCORE' AND points IN (2, 3)) OR
               (type = 'FT' AND points = 1) OR
               (type NOT IN ('SCORE', 'FT') AND points = 0)
             ),
  created_at TEXT NOT NULL   -- the moment it happened courtside, not the moment it synced
);

CREATE INDEX idx_events_game_id ON events(game_id);

-- Seed the one team you actually have right now:
INSERT INTO teams (name, category, slug)
VALUES ('Campus Monferrato', 'U13', 'campus-monferrato-u13');
```

**Why it's shaped this way, matching section 3:**

- `+2`/`+3` from the bench UI both map to `type = 'SCORE'`, with `points` set to 2 or 3. `+1` maps to `type = 'FT'` with `points = 1`. The `CHECK` constraint stops bad data (a `SCORE` row with `points = 0`, an `FT` row with `points = 2`, or a `TOV` row with `points = 2`) from landing in the table. SQLite cannot change that check in place, so an existing database is rebuilt once by `npm run db:migrate-free-throw`, which copies every current row.
- `EMPTY` and `TOV` both end a possession with `points = 0` but stay distinguishable in queries, since turnovers are a stat you track and empty possessions aren't.
- `OFF_REB` and `DEF_REB` are just rows in the same table — they don't need their own columns or tables, since every stat in section 3 is a `COUNT(*) ... WHERE type = '...'` over this one table.
- `ON DELETE CASCADE` on `events.game_id` means deleting a bad game (not just undoing one event) cleans up after itself — you won't be doing this often, but it's a one-line safeguard against orphaned rows.
- `games.id` and `events.id` are client-generated UUIDs (`crypto.randomUUID()`), not server autoincrement. This is a direct consequence of the offline-first design below: a tap at courtside has to get an ID *the instant it happens*, with zero network round-trip, so the ID can't come from the server. It also makes every write idempotent — if a sync retry re-sends the same event, the server sees the same ID and can safely ignore the duplicate.
- `created_at` is supplied by the client, not server-defaulted. The whole point of local-first capture is that the timestamp on a possession is *when it happened on the bench*, not when the phone happened to get signal again to sync it — those can be minutes apart.
- The two indexes exist because every dashboard query filters by `team_id` or `game_id` — trivial at this data size, but free and correct to have from the start.

With this schema, the stat formulas from section 3 become straightforward SQL, e.g. points-per-possession for a game:

```sql
SELECT
  SUM(points) * 1.0 / COUNT(*) FILTER (WHERE type IN ('SCORE', 'EMPTY', 'TOV')) AS ppp
FROM events
WHERE game_id = ?;
```

## 5. Tech stack

- **Frontend:** Vue 3 + Vite. No state library — the whole app is one game's worth of events plus a season list, well within what Vue's built-in `ref`/`reactive` and a couple of composables handle cleanly; Pinia would be dead weight here. Plain CSS (no Sass/SCSS), using native CSS nesting and custom properties for the brand palette/theming — no preprocessor, no PostCSS plugin chain. Charts are small hand-rolled SVG components (a handful of bars/lines over at most a season's worth of games) rather than pulling in Chart.js/ApexCharts for something this size.
- **Backend:** Node.js as Cloudflare Pages Functions, using Cloudflare's native file-based routing (`/functions/api/*.js`) directly — no router framework (Hono etc.) needed for five endpoints.
- **Browser target:** modern evergreen browsers only (last 2 versions of Chrome/Safari/Firefox/Edge) — no polyfills, no Babel transpilation, free use of modern CSS (nesting, `:has()`, `color-mix()`) and modern JS.
- **DB:** Turso (libSQL), accessed via `@libsql/client`.
- **Auth:** none needed for v1 if only your coaching staff uses it (share a private link); add a simple shared password/PIN gate if you want a minimal barrier.

## 6. Offline-first architecture: local persistence & background sync

**The core requirement:** tapping a stat button must feel instant, with zero dependency on network round-trip time — gym WiFi is exactly the kind of connection that shouldn't be on the critical path between a tap and the screen updating. Every interaction is written to the device first; the remote DB is a background concern, not something the UI ever waits on.

**Storage: IndexedDB**, not localStorage/sessionStorage — see the reasoning above. One object store per entity (`games`, `events`), each record carrying a `synced: boolean` flag alongside its normal fields.

**Write path for every button tap (e.g. `+2`):**
1. Generate a UUID for the event client-side (`crypto.randomUUID()`).
2. Build the event record with `created_at = new Date().toISOString()` and `synced: false`.
3. Write it to IndexedDB.
4. Update the in-memory reactive state (Vue `ref`) from the same write — the running possessions/PPP/rebounds/turnovers tally on screen updates immediately, in the same tick. No `await fetch(...)` anywhere in this path.
5. Kick the sync manager (step below) — it decides on its own whether now is a good time to actually talk to the network.

This means the UI's only source of truth *during a game* is IndexedDB plus in-memory state — the API is never read from live during the tracker flow, only written to, asynchronously, after the fact.

**Sync manager (runs the same on every page, not just the tracker):**
- Triggers on three occasions: (a) the browser's `online` event firing, (b) an idle moment via `requestIdleCallback` (with a `setTimeout` fallback for Safari, which doesn't support it), and (c) a periodic tick (e.g. every 10s) as a safety net.
- On trigger: read all `synced: false` records from IndexedDB, `POST` them to the API in one batch (see the new endpoint below), and on success mark them `synced: true` in IndexedDB.
- On failure (no network, request errors): does nothing and quietly waits for the next trigger — no retry loop spinning in the background, no error shown to the person on the bench mid-game.
- Because IDs are client-generated and creation is idempotent, a batch that partially succeeded and gets re-sent in full next time causes no duplicates.

**Undo** follows the same pattern: marking an event deleted is itself a local, instant write (soft-delete flag or local removal), synced to the server as a `DELETE` in the same background pass — never a blocking call.

**Sync status:** a small, unobtrusive indicator (a dot or icon, not a banner) showing synced vs. pending — enough for you to glance at before packing up after a game, without ever gating interaction on it.

**What this doesn't cover:** loading the app itself for the very first time still needs one successful network fetch (to get the app shell and the team's `id`). In practice that's a non-issue — you'll open the app once with gym WiFi/cell signal before tip-off — but if fully-offline first load ever matters, that's an additive PWA service-worker step later, not a redesign of anything above.

## 7. API spec (minimal REST)

```
GET    /api/teams                 list teams (v1: returns the single U13 row)
PUT    /api/games/:id              upsert a game {id, team_id, date, opponent, created_at}
GET    /api/games?team_id=         list games for a team (for dashboard/season view)
GET    /api/games/:id              game detail + all events
POST   /api/games/:id/events/sync  upsert a batch of events: [{id, type, points, created_at}, ...]
DELETE /api/events/:id             undo a mis-tap, synced in the same background pass
GET    /api/stats/season?team_id=  aggregated stats across a team's games
```

Two changes from the earlier draft, both direct consequences of the offline-first design in the section above:

- **`PUT` instead of `POST` for games, and everything keyed by the client-generated `id`.** Since IDs are minted on the device (not assigned by the server), every write is a "create this if it doesn't exist yet, otherwise no-op" — an upsert (`INSERT ... ON CONFLICT (id) DO NOTHING` under the hood) rather than a plain insert. This is what makes retrying a sync after a dropped connection safe.
- **Events sync as a batch (`/sync`), not one `POST` per tap.** The frontend never calls this endpoint from the tap handler — only the background sync manager calls it, with whatever's piled up in IndexedDB since the last successful sync. One network round-trip for a whole flurry of taps, not one per tap.

Every read endpoint takes `team_id` even though v1 only ever has one team — the frontend hardcodes it (fetched once from `/api/teams`) rather than showing a picker. This is the one place the "leave it open" decision costs anything up front, and it's a single query parameter, not an architectural change.

Keep responses pre-aggregated where possible (compute possessions/PPP server-side) so the dashboard doesn't need heavy client logic. Dashboard reads still go straight to the API as before — it's only the *tracker's* writes that are local-first; the dashboard is read-only and has no reason not to just ask the server.

## 8. Frontend UX

Routes are already team-scoped internally (`teamId` is threaded through every API call, sourced from the one row `/api/teams` returns), but there's no team switcher or team-picking screen in v1 — you land straight on the U13 dashboard/tracker, no extra tap. If a second category gets added later, the switcher is a small additive component, not a rebuild of the routing.

### Bench Live Tracker (`/game/:id/live`)
- Seven thumb-friendly buttons: `+1`, `+2`, `+3` on the first row, then `EMPTY`, `TOV`, `OFF REB`, `DEF REB`. `+1` adds a point and does not end the possession. The sequences are in the README.
- Running tally visible at top: current possessions, PPP, rebounds, turnovers — computed from local IndexedDB state and updated the instant a button is tapped, with no network involved in that path at all (see § Offline-first architecture).
- **Undo button** always visible — bench entry will have mis-taps, this is non-negotiable for real usability.
- **End game button** always visible, labeled with the words "End game" while the game is in progress. This is how a person finishes the live screen. The browser Back button is not the way to end a game, and the Pending sync status is not a reason to stay.
- Tapping End game opens a short confirmation. Cancel leaves the game in progress. Confirm marks it finished, keeps every recorded event, saves that finished state and the team's score locally, and opens the post-game summary. It does not wait for the network or for sync to finish. Uploads that are still pending keep running.
- The summary shows the team's points and stats and lets the coach enter or correct the opponent's final score. From the summary the coach can reopen the live log or return to the start screen. Opening `/game/:id/live` for a finished game still shows the log and still accepts corrections.
- The start screen lists finished games stored on this device, labeled finished, with Open. The same list is on the dashboard. An in-progress game is not listed and has no resume action. Finding a finished game does not require the game URL or a successful sync. Refreshing the live page you are already on still loads that game.
- No page reloads.

### Dashboard (`/dashboard`)
- **Per-game view:** pick a game, see its stat line + a simple bar/line chart of possession-by-possession PPP.
- **Season/trend view:** line charts of PPP, TOV, reb rates across all games in chronological order, so you can see whether the team is trending up.
- Finished games stored on this device are listed above the season view, with Open. An in-progress game is not listed. That list is local, so it remains when the season request fails.

## 9. Deployment plan

1. **Repo structure:** monorepo, `/frontend` (Vue) and `/functions` (Cloudflare Pages Functions) — keeps it a single GitHub repo, single deploy.
2. **Host:** **Cloudflare Pages** — static Vue build served from Pages, API routes as Pages Functions (Node-compatible via the `nodejs_compat` flag) in the same project. One GitHub integration, one deploy.
3. **DB:** Turso, connected via env var (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) — set as encrypted Pages environment variables, never committed.
4. **CI/CD:** push to `main` → Cloudflare Pages auto-builds and deploys via its GitHub integration, no extra GitHub Actions needed.
5. **Cost:** $0 — Cloudflare Pages free tier (unlimited requests, 500 builds/month) comfortably covers this traffic; Turso free tier (500 DBs, 9GB storage, 1B row reads/month) is wildly more than you'll ever use.

## 10. Build order (suggested milestones)

1. DB schema + API CRUD for games/events (no UI yet, test with curl/Postman)
2. Bench Live Tracker view, wired to API, with undo
3. Per-game dashboard view
4. Season trend view
5. Polish: PIN gate, mobile responsiveness pass (this will mostly be used on a phone/tablet courtside)

## 11. Branding — Campus Monferrato U13

The app is for Campus Monferrato's Under 13 team (campusmonferrato.com), so it should carry the club's identity rather than look generic:

- **Logo:** pulled from the club site (currently served at `wp-content/uploads/2023/09/cropped-CAMPUS-MONFERRATO.png`) — use this as the header mark on both the live tracker and dashboard.
- **Colors:** the club's identity is "rossoblu" (red and blue) — confirmed both on the site's badge and the club's own social bio. Confirmed hex values:
  - Blue (primary): `#0b0e37`
  - Red (secondary/accent): `#c72027`
  - Gold (third/accent): `#cca059`
- These go in as CSS custom properties (`--color-primary: #0b0e37`, `--color-secondary: #c72027`, `--color-accent: #cca059`, plus a couple of derived shades for hover/active states via `color-mix()`) on `:root`, so the whole UI themes off three values — no color literals scattered through components.

## 12. Mobile-first UI/UX

- Layout built mobile-first: base styles target a phone/tablet in the hand at the bench, with `min-width` media queries progressively enhancing for desktop (larger dashboard charts, side-by-side game list + detail) rather than the reverse.
- Bench Live Tracker: during a game the interactive controls are the 6 stat buttons, Undo, and End game. Large tap targets (min 44×44px), high contrast, no scrolling needed to reach any of them one-handed. End game is labeled in words so leaving the game is obvious.
- Desktop dashboard: a decent but secondary experience — wider layout takes advantage of the extra space (charts side-by-side, game list as a sidebar) but there's no bench-specific desktop mode; you'll be running this from a phone or tablet courtside.

## 13. Scope decision

Team-level stats only, with no per-player breakdown in v1. The event log has no `player_id`, which keeps the bench UI to the 7 buttons above with nothing to select before tapping. If you want per-player stats later, it's a clean additive migration on the same schema (add a nullable `player_id` column to `events`), not a redesign.

## 14. Multi-category readiness (U14, U15, …)

Not committed to — U13 is the only team that exists right now — but the schema and API are shaped so adding a category later doesn't touch what's already built:

- Adding U14 = inserting one row in `teams` and pointing new games at its `team_id`. No migration of existing U13 data.
- The only UI work needed is a team switcher (a dropdown or a `/teams` landing page) — everything underneath (bench tracker, dashboards, stat queries) is already parameterized by `team_id`.
- Branding stays per-team-ready too: if a future category ever wants different colors on top of the shared club identity, `--color-*` custom properties can be overridden per team without touching component code — not needed now, just noting the palette work already supports it.

## 15. Product improvements

The following five product suggestions are listed separately for review. Where they conflict with the earlier End game behavior in §8, this section takes precedence.

1. **Complete a game with a post-game flow.** End game should open a short summary showing the team's recorded points and game stats, and let the coach enter the opponent's final score. A game should have an explicit in-progress or finished state. Save its finished state and score locally without waiting for sync. From the summary, the coach can return to the start screen or reopen the game to correct its event log or final score. Corrections remain possible after finishing.
2. **Do not resume an in-progress game.** The start screen and the dashboard do not list a game that is still in progress, and they do not offer Continue. Leaving the live page is not a way back into that game. Finished games remain discoverable from the start screen and the dashboard.
3. **Clarify season boundaries.** Do not silently combine games from different seasons in one trend view. Provide a way to select a season using an explicit definition the coach can understand. When only one season exists, keep the dashboard simple and avoid making selection an unnecessary step.
4. **Use comparable trend measures.** Show turnovers and offensive/defensive rebounds as counts per 10 of the team's possessions, so game-to-game trends remain comparable when games have different numbers of possessions. Label these as per-10-possession rates, not percentages. The tracked events do not include opponent rebound opportunities, so a true rebound percentage is unavailable.
5. **Protect against accidental game endings.** Finishing asks for one lightweight confirmation before the game is marked finished. Cancel leaves it in progress. Confirm keeps the event log. Open on the start screen and the dashboard is the way back to a finished game, including after a refresh or a failed sync.
