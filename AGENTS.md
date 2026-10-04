# AGENTS.md

## Project: Campus Monferrato U13 Basketball Stats Tracker

This file defines the engineering rules for AI coding agents working on this repository.

The authoritative product and technical specification is:

`basketball-tracker-spec.md`

Read that file before making architectural or product decisions.

The specification takes precedence over assumptions, generic best practices, or suggestions to introduce additional libraries/frameworks.

---

# 1. Product

This is a small mobile-first basketball team statistics tracker for Campus Monferrato U13.

The primary use case is recording team-level statistics live from the bench with the minimum possible number of taps.

The live tracker must feel instant and must never depend on network availability.

Tracked events:

- `+1` (made free throw, does not end the possession)
- `+2`
- `+3`
- `EMPTY`
- `TOV`
- `OFF_REB`
- `DEF_REB`

Derived statistics:

- possessions
- points per possession
- offensive rebounds
- defensive rebounds
- turnovers

There are deliberately no:

- player statistics
- shot attempts
- makes/misses
- opponent statistics
- player selection before recording an event
- unnecessary game-state concepts

Do not expand the product scope unless explicitly instructed.

---

# 2. Core engineering principle

## Keep it simple

This is a deliberately small application.

Do NOT introduce additional frameworks, libraries, abstractions, services, or infrastructure unless they are explicitly required by the specification or requested by the developer.

In particular, do not introduce:

- Pinia
- Vuex
- Redux
- Hono
- Express
- Chart.js
- ApexCharts
- Sass/SCSS
- Tailwind unless explicitly requested
- a router framework on the backend
- a repository/service/domain abstraction layer for its own sake
- unnecessary validation libraries
- unnecessary state-management libraries
- unnecessary UI component libraries
- unnecessary build plugins

Prefer:

- Vue 3 built-in `ref` / `reactive`
- composables
- plain JavaScript/TypeScript where appropriate
- native browser APIs
- plain CSS
- small focused functions
- Cloudflare Pages Functions
- Turso/libSQL

Before adding a dependency, ask:

> Can this be implemented clearly and safely with the platform APIs or existing stack?

If yes, prefer that approach.

---

# 3. Tech stack

The intended stack is:

### Frontend

- Vue 3
- Vite
- plain CSS
- native CSS custom properties
- native CSS nesting
- native modern browser APIs
- no state-management library

### Backend

- Node.js
- Cloudflare Pages Functions
- file-based routing under `/functions/api/`
- no backend router framework

### Database

- Turso
- libSQL
- `@libsql/client`

### Persistence/offline

- IndexedDB
- one object store for `games`
- one object store for `events`

### Hosting

- Cloudflare Pages
- GitHub integration
- frontend and Functions deployed together

### Browser support

Modern evergreen browsers only:

- latest two versions of Chrome
- latest two versions of Safari
- latest two versions of Firefox
- latest two versions of Edge

Do not add polyfills or legacy browser support.

---

# 4. Repository structure

The intended high-level structure is:

```text
/
├── frontend/
├── functions/
├── basketball-tracker-spec.md
├── AGENTS.md
└── package.json / workspace configuration
```

Keep frontend and backend clearly separated.

Do not create a monolithic application structure.

---

# 5. Database model

The database contains:

## teams

Fields:

- `id`
- `name`
- `category`
- `slug`

Seed:

```text
Campus Monferrato
U13
campus-monferrato-u13
```

The UI does not expose team selection in v1.

The schema must nevertheless remain team-scoped.

## games

Fields:

- `id`
- `team_id`
- `date`
- `opponent_name`
- `final_score_for`
- `final_score_against`
- `created_at`

Game IDs are client-generated UUIDs.

## events

Fields:

- `id`
- `game_id`
- `type`
- `points`
- `created_at`

Valid event types:

```text
SCORE
FT
EMPTY
TOV
OFF_REB
DEF_REB
```

For `SCORE`:

```text
points = 2 or 3
```

For `FT` (the `+1` button):

```text
points = 1
```

For all other types:

```text
points = 0
```

Use the database constraints from the specification.

Do not store derived statistics as counters.

---

# 6. Statistics rules

All statistics derive from the event log.

Never maintain separate persistent possession/rebound/turnover counters.

Definitions:

```text
possessions =
  SCORE + EMPTY + TOV

points_per_possession =
  total points / possessions

offensive_rebounds =
  OFF_REB count

defensive_rebounds =
  DEF_REB count

turnovers =
  TOV count
```

`FT` adds its point to that total and does not add a possession. The point belongs to the next `SCORE`, `EMPTY`, or `TOV`. A free throw that is never closed stays in the points and is left out of the possession count. The bench sequences are in the README.

An `OFF_REB` does NOT end a possession.

A `DEF_REB` is an independent defensive statistic.

A `SCORE` event ends a possession.

`EMPTY` ends a possession, including a free-throw trip that already has `FT` points.

`TOV` ends a possession.

An `FT` event does not end a possession.

Do not invent a `MISS` event.

---

# 7. Offline-first requirement

This is the most important architectural requirement.

## The network must never be in the critical path of a bench tap

The live tracker write path is:

```text
user tap
  ↓
generate UUID
  ↓
write event to IndexedDB
  ↓
update reactive UI
  ↓
trigger/background sync
```

NOT:

```text
user tap
  ↓
fetch API
  ↓
database
  ↓
response
  ↓
update UI
```

There must be no `await fetch()` in the tap handler or equivalent critical interaction path.

A stat must appear immediately even with:

- no network
- poor Wi-Fi
- temporary connection loss
- airplane mode after the application has loaded

---

# 8. IndexedDB rules

Use IndexedDB, not:

- localStorage
- sessionStorage

Each local record should contain its normal data plus synchronization state as needed.

For events:

```text
id
game_id
type
points
created_at
synced
```

Generate IDs using:

```js
crypto.randomUUID()
```

Generate timestamps on the client:

```js
new Date().toISOString()
```

The timestamp represents when the event happened courtside, not when it was synchronized.

---

# 9. Sync manager

Synchronization is asynchronous.

Trigger sync on:

1. browser `online` event
2. idle opportunity using `requestIdleCallback`
3. `setTimeout` fallback where necessary
4. periodic safety tick, approximately every 10 seconds

Sync pending records in batches.

Do not send one HTTP request per stat tap.

Events use:

```text
POST /api/games/:id/events/sync
```

The batch must be safe to retry.

Client-generated UUIDs provide idempotency.

If synchronization fails:

- do not spin in a retry loop
- do not interrupt the live tracker
- do not show an intrusive error
- leave records pending
- try again on the next trigger

---

# 10. Undo

Undo must also be local-first.

Undoing an event must:

1. update local state immediately
2. prevent the event from appearing in current calculations
3. synchronize the deletion asynchronously

Never make Undo wait for the API.

The exact local soft-delete/removal implementation should remain simple and consistent with the existing persistence model.

---

# 11. API

The intended API is:

```text
GET    /api/teams
PUT    /api/games/:id
GET    /api/games?team_id=
GET    /api/games/:id
POST   /api/games/:id/events/sync
DELETE /api/events/:id
GET    /api/stats/season?team_id=
```

Games use `PUT` because their IDs are generated by the client.

Event synchronization is batched.

All team-scoped reads should receive `team_id`, even though v1 only contains one team.

Do not create additional endpoints unless required.

---

# 12. Frontend UX

## Live tracker

Route:

```text
/game/:id/live
```

The screen must contain:

- seven large thumb-friendly buttons
- running possessions
- running PPP
- rebounds
- turnovers
- always-visible Undo
- always-visible End game button, labeled "End game" while the game is in progress
- sync status indicator

The seven primary buttons are:

```text
+1
+2
+3
EMPTY
TOV
OFF REB
DEF REB
```

`+1`, `+2`, and `+3` share the first row. `+1` adds one point and leaves the possession open. `EMPTY` closes that possession when the other team takes the ball, including after one or more made free throws. For an and-1, `+1` is tapped before `+2` or `+3`. The full sequences are in the README.

End game asks for one confirmation, then marks the game finished, keeps its events, and opens the summary. Cancel leaves the game in progress. None of that waits on the network. The start screen and the dashboard list finished games locally so a finished game can be opened after a refresh or a failed sync. An in-progress game is not listed and has no resume action. The browser Back button is not the way to end a game.

No page reloads.

No scrolling should be necessary to reach the controls.

Minimum target size:

```text
44 × 44px
```

Prefer larger touch targets where practical.

The tracker is mobile-first and optimized for one-handed use.

---

# 13. Dashboard

Route:

```text
/dashboard
```

Provide:

## Per-game

- game selector/list
- game statistics
- simple possession-by-possession PPP visualization

## Season

Chronological trend views for:

- PPP
- turnovers
- rebound rates

Use small hand-rolled SVG components.

Do not add Chart.js or another charting dependency.

---

# 14. Styling

Use plain CSS.

Use CSS custom properties for branding:

```css
--color-primary: #0b0e37;
--color-secondary: #c72027;
--color-accent: #cca059;
```

Do not scatter color literals throughout components.

Use derived colors through modern CSS where useful, including `color-mix()`.

Do not introduce Sass/SCSS.

Do not introduce a CSS framework unless explicitly requested.

---

# 15. Branding

The application represents Campus Monferrato U13.

Use the club logo specified in the product specification.

Brand colors:

```text
Blue: #0b0e37
Red:  #c72027
Gold: #cca059
```

The UI should feel like a purposeful club/team tool rather than a generic admin dashboard.

---

# 16. Multi-team readiness

The application is currently for one team:

```text
Campus Monferrato U13
```

Do not build a team-management UI.

However, preserve `team_id` throughout the database and API.

Adding another team later should primarily require:

1. inserting another team
2. adding a team switcher or team landing page

Do not prematurely implement multi-team UI.

---

# 17. Security/authentication

Authentication is not required for v1.

A simple shared PIN/password gate may be added during the polish phase if explicitly requested.

Do not introduce:

- OAuth
- user accounts
- roles
- permissions
- JWT infrastructure

unless explicitly requested.

---

# 18. Scope boundaries

Do not implement these in v1:

- player-level statistics
- player management
- shot charts
- shot attempts
- FG%
- opponent statistics
- possession-by-player
- player selection
- team administration
- sophisticated authentication
- real-time multi-user collaboration
- push notifications
- analytics platforms
- unnecessary third-party services

If a feature is not in the specification, do not silently add it.

---

# 19. Implementation style

Prefer small, understandable modules.

Avoid:

- premature abstraction
- generic frameworks
- factories for trivial objects
- excessive class-based architecture
- deeply nested component hierarchies
- huge components
- duplicated business logic
- magic constants

Keep business rules easy to find and test.

The code should be understandable by a competent JavaScript developer without needing to understand an elaborate architecture.

---

# 20. Error handling

Handle errors where they matter.

For the live tracker:

- never block the user because of network failure
- preserve local data
- expose only useful, non-intrusive status

For API/database operations:

- return appropriate HTTP status codes
- validate required inputs
- do not expose database internals to clients
- log useful diagnostic information server-side

Do not build elaborate error infrastructure.

---

# 21. Testing

Add tests where they provide meaningful confidence.

Prioritize:

1. statistics calculations
2. event/possession rules
3. IndexedDB persistence
4. sync idempotency
5. undo behavior
6. API behavior

Particularly test:

```text
SCORE ends possession
EMPTY ends possession
TOV ends possession
FT adds one point and does not end possession
OFF_REB does not end possession
DEF_REB does not affect possession count
duplicate sync does not duplicate events
```

Do not chase arbitrary test coverage percentages.

---

# 22. AI agent behavior

When working on a task:

### Before coding

1. Read `basketball-tracker-spec.md`.
2. Inspect the existing repository.
3. Identify relevant existing files.
4. State the implementation plan briefly.
5. Do not modify unrelated code.

### While coding

- Implement only the requested milestone/task.
- Follow the existing architecture.
- Prefer simple solutions.
- Reuse existing code where appropriate.
- Do not introduce dependencies without justification.
- Do not rewrite working code merely for stylistic reasons.

### Commits

- Commit messages must follow the Conventional Commits format: `type(scope): description` (scope is optional), such as `feat: add game summary` or `docs: clarify commit conventions`.
- Keep the description concise and use the appropriate type, such as `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`.

### After coding

Always:

1. run the relevant tests
2. run the build
3. run lint/type checks if configured
4. inspect the resulting diff
5. fix errors you introduced
6. report exactly what changed

Do not claim a task is complete if the build or tests fail.

---

# 23. Handling ambiguity

If the specification leaves an implementation detail open:

1. choose the simplest solution
2. preserve the existing architecture
3. avoid adding dependencies
4. document the decision if it affects future work

Do not redesign the application because of a small ambiguity.

If the ambiguity materially affects product behavior or data integrity, stop and ask for clarification instead of guessing.

---

# 24. Important AI anti-patterns

Do NOT:

- turn the app into a generic enterprise architecture
- introduce a state management framework
- introduce a backend framework
- add a chart library
- make API calls from the live tap path
- store derived counters
- create player entities
- create unnecessary abstractions
- add features "that will probably be useful later"
- replace IndexedDB with localStorage
- make the tracker dependent on connectivity
- silently change the database schema
- silently change event semantics
- rewrite unrelated files

The simplest implementation that satisfies the specification is usually the correct implementation.

---

# 25. Definition of done

A feature is complete only when:

- it matches the specification
- it works on a mobile-sized viewport
- it does not introduce unnecessary dependencies
- relevant tests pass
- the application builds successfully
- offline behavior remains intact
- the git diff contains only relevant changes

For the live tracker specifically:

> A user must be able to tap a stat button with no network connection and see the correct updated statistics immediately.

That behavior is non-negotiable.
