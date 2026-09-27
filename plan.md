# Prompt sequence

## Prompt 1 - Inspect project and implement foundation

Read `AGENTS.md` and `basketball-tracker-spec.md` completely before making any changes.

You are working on the existing `dev` branch of the Campus Monferrato U13 basketball tracker.

IMPORTANT: this is NOT a greenfield repository.

The repository already contains a Vue 3 + Vite frontend setup. Do not recreate or replace the existing frontend scaffolding.

The current repository already includes:

* Vue 3
* Vite
* `@vitejs/plugin-vue`
* an existing `src/` application
* `public/` assets
* Vite configuration
* existing frontend package configuration
* `frontend/` and `functions/` directories

The `functions/` directory currently contains only its placeholder `.gitkeep`, so the backend has not yet been implemented.

## Your task

First, inspect the CURRENT repository thoroughly.

Before changing anything:

1. Inspect the complete file tree.
2. Read the existing `package.json`.
3. Read the existing Vite configuration.
4. Read the existing Vue entry point and `App.vue`.
5. Inspect existing CSS/assets/components.
6. Inspect the existing `frontend/` and `functions/` directories.
7. Identify which parts of `basketball-tracker-spec.md` are already satisfied by the current repository and which are not.
8. Briefly report your findings and your proposed changes.

Do NOT recreate anything that already exists.

Do NOT migrate the current project into another structure simply because the specification describes a target structure.

## Then implement ONLY the project foundation that is actually missing

The immediate goal is to prepare the repository for the first implementation milestone.

### Frontend

Preserve the existing Vue 3 + Vite setup.

Do not replace the existing application with a new Vue/Vite scaffold.

Only make frontend changes if they are required to align the existing project with the specification or to prepare it for the next milestone.

Do not implement the tracker UI yet.

Do not implement the dashboard yet.

### Backend

Set up the Cloudflare Pages Functions structure under:

`/functions`

Use Cloudflare's file-based Functions routing.

Do NOT introduce Hono, Express, or another backend framework.

Do not implement the complete API yet unless the existing project structure makes a minimal API foundation necessary.

### Repository configuration

Only add configuration that is genuinely missing and required by the specification.

Do not add unnecessary dependencies.

Do not reorganize working files without a reason.

## Important architectural constraints

The existing frontend is the starting point.

The specification is the target architecture.

Your job is to move the existing repository toward that target with the smallest sensible delta.

Do NOT:

* recreate Vue/Vite
* replace `package.json` unnecessarily
* replace existing assets unnecessarily
* introduce Pinia
* introduce a CSS framework
* introduce Sass/SCSS
* introduce Hono
* introduce a backend framework
* introduce a charting library
* create unnecessary abstractions
* implement features from later milestones
* rewrite existing files merely for stylistic reasons

## Validation

After making changes:

1. Run the existing frontend build.
2. Verify that the existing application still builds successfully.
3. Verify that the new Functions structure does not break the Vite application.
4. Inspect the git diff carefully.
5. Make sure only files relevant to this foundation step changed.

At the end, report:

### Already present

List the relevant parts of the specification that were already implemented before your changes.

### Added

List exactly what you added.

### Not implemented yet

List the major pieces intentionally left for later milestones.

### Validation

Report the commands run and their results.

Do not claim the project is further along than it actually is.

The goal of this task is NOT "build the app".

The goal is:

> Understand the existing repository, preserve what is already correct, and establish only the missing foundation needed for the next implementation milestone.

___

## Prompt 2 - Database and API

Read `AGENTS.md` and the database/API sections of `basketball-tracker-spec.md`.

Implement milestone 1:

* Turso/libSQL database schema
* `teams`
* `games`
* `events`
* required indexes
* required constraints
* seed the Campus Monferrato U13 team
* Cloudflare Pages Functions API

Implement exactly these endpoints:

GET    /api/teams
PUT    /api/games/:id
GET    /api/games?team_id=
GET    /api/games/:id
POST   /api/games/:id/events/sync
DELETE /api/events/:id
GET    /api/stats/season?team_id=

Important:

* client-generated UUIDs
* idempotent game upsert
* idempotent event synchronization
* event validation
* team scoping
* no additional backend framework

Do not implement the frontend tracker or dashboard yet.

After implementation, test the API behavior locally as far as the current project setup allows.

Pay particular attention to the event constraints and the distinction between possession-ending and non-possession-ending events.

Do not change the product model from the specification.

___

## Prompt 3 - Domain / statistic layer

Read `AGENTS.md` and the statistics/domain sections of `basketball-tracker-spec.md`.

Before building the UI, implement and test the application's core statistics logic.

The rules are:

* SCORE with 2 points ends a possession
* SCORE with 3 points ends a possession
* EMPTY ends a possession
* TOV ends a possession
* OFF_REB does NOT end a possession
* DEF_REB does NOT affect possession count
* turnovers = TOV count
* offensive rebounds = OFF_REB count
* defensive rebounds = DEF_REB count
* PPP = total points / possessions

Create the smallest clean set of reusable functions needed for these calculations.

Do not introduce a state-management library.

Write focused tests covering:

* empty game
* scoring possessions
* empty possessions
* turnovers
* offensive rebounds
* defensive rebounds
* mixed event sequences
* zero-possession handling
* duplicate events should not be counted twice if they are deduplicated by ID

Do not build UI yet.

Run all relevant tests and fix failures before finishing.

___

## Prompt 4 - IndexedDB / offline layer

Read `AGENTS.md` and section 6 of `basketball-tracker-spec.md` carefully.

Implement the local-first persistence layer using IndexedDB.

Requirements:

* object store for games
* object store for events
* events contain local synchronization state
* client-generated UUIDs
* client-generated `created_at`
* local writes must complete without network access
* local state is the source of truth during live tracking
* no localStorage/sessionStorage

Create a small, understandable persistence API/composable rather than scattering IndexedDB calls across Vue components.

Implement:

* create/load game
* save event locally
* load game events
* update/delete event locally as required for Undo
* query pending events
* mark events synchronized

Do not implement the network sync manager yet.

Add tests for the persistence behavior where practical.

Important:
The implementation must not accidentally turn IndexedDB operations into a network-dependent flow.

After implementation, inspect the code specifically for unnecessary abstractions and simplify anything that became more complex than necessary.

___

## Prompt 5 - Sync manager

Read `AGENTS.md` and the offline-first/API sections of `basketball-tracker-spec.md`.

Implement the background synchronization manager.

Requirements:

* browser `online` event
* idle synchronization using `requestIdleCallback`
* appropriate fallback where `requestIdleCallback` is unavailable
* periodic safety sync approximately every 10 seconds
* batch pending events
* use `POST /api/games/:id/events/sync`
* mark local records synced only after successful synchronization
* failed synchronization must leave records pending
* no retry loop
* synchronization must never block the live tracker
* duplicate sync attempts must be safe

Also implement game synchronization using the client-generated game ID and the specified PUT endpoint.

Do not modify the API contract unless absolutely necessary.

Write tests for:

* successful batch
* failed batch
* retry after failure
* duplicate batch
* partial/previously synchronized data
* multiple pending events

Critically inspect for race conditions between two sync triggers firing close together.

The sync manager must not interfere with immediate local UI updates.

___

## Prompt 6 - Live tracker

Read `AGENTS.md` and the live tracker section of `basketball-tracker-spec.md`.

Implement the Bench Live Tracker at:

`/game/:id/live`

Requirements:

* six large buttons:

  * +2
  * +3
  * EMPTY
  * TOV
  * OFF REB
  * DEF REB
* running possessions
* running PPP
* rebounds
* turnovers
* always-visible Undo
* small sync status indicator
* no page reloads
* no navigation during the game
* no scrolling required to access the controls
* minimum 44x44px touch targets
* mobile-first
* one-handed use

Most important requirement:

A button tap must:

1. generate the event ID
2. persist locally
3. update reactive state
4. show the new statistics immediately

The tap handler must NOT wait for the network.

Do not make the live tracker fetch the server after every tap.

Use the IndexedDB/local state and background sync architecture already implemented.

Do not implement dashboard functionality in this task.

After implementation, manually inspect the UI at phone-sized dimensions and fix obvious usability issues.

___

## Prompt 7 - Dashboard

Read `AGENTS.md` and the dashboard section of `basketball-tracker-spec.md`.

Implement `/dashboard`.

Build:

## Per-game view

* game list/selector
* selected game's statistics
* simple possession-by-possession PPP visualization

## Season view

Show chronological trends for:

* PPP
* turnovers
* rebound rates

Use small hand-written SVG components.

Do NOT add Chart.js, ApexCharts, D3, or another charting library.

Dashboard data may come from the API because the dashboard is read-only.

Keep the visual design consistent with the Campus Monferrato branding.

Do not modify the live tracker architecture.

Keep the dashboard simple: this is a coaching tool, not an analytics platform.

Make the mobile layout usable but optimize the larger dashboard experience for tablet/desktop as specified.

___

## Prompt 8 - Branding and UX polish

Read `AGENTS.md` and sections 11–12 of `basketball-tracker-spec.md`.

Perform a focused UX/visual polish pass.

Branding:

* primary blue: #0b0e37
* secondary red: #c72027
* accent gold: #cca059
* use CSS custom properties
* use the Campus Monferrato logo specified in the project specification

Prioritize the live tracker.

Check:

* button size
* contrast
* thumb reach
* spacing
* accidental taps
* readability while standing courtside
* visual hierarchy
* current score/stat visibility
* Undo discoverability
* sync status visibility without being distracting

Then polish the dashboard.

Use plain CSS only.

Do not introduce a design system, CSS framework, component library, or unnecessary dependency.

Do not change functionality or event semantics during this task.

Test the UI at:

* small phone
* desktop

___

## Prompt 9 - Full audit

Act as a senior engineer performing a hostile code review.

Read:

* `AGENTS.md`
* `basketball-tracker-spec.md`
* the entire implementation

Do NOT make changes yet.

Audit the application against the specification, focusing especially on:

## Offline correctness

* Can a stat be recorded with zero network?
* Does the UI update before synchronization?
* Can sync race with another sync?
* Can duplicate events reach the database?
* Can a failed sync lose local data?
* Can Undo race with synchronization?
* Can stale local state overwrite newer state?

## Statistics correctness

Verify every event type and possession rule.

## API correctness

Verify:

* IDs
* idempotency
* team scoping
* validation
* HTTP semantics
* event synchronization

## Data integrity

Look for:

* duplicate records
* orphaned records
* invalid event combinations
* derived counters stored incorrectly
* timestamp problems

## UX

Verify that the live tracker can realistically be operated from the bench with one hand.

## Architecture

Look for:

* unnecessary dependencies
* unnecessary abstractions
* accidental framework creep
* duplicated business logic
* network calls in the live path

Produce a prioritized list:

P0 = data-loss/correctness issue
P1 = important bug
P2 = maintainability/usability issue
P3 = optional improvement

Do not change code yet.

___

## Prompt 10 - Fix + final verification

Use the audit from the previous step.

Fix all P0 and P1 issues.

Fix P2 issues only when the fix is small and clearly improves correctness or maintainability.

Do NOT implement speculative P3 improvements.

After making changes:

1. run all tests
2. run the production build
3. run lint/type checks if configured
4. inspect the final git diff
5. verify there are no accidental dependency additions
6. verify the live tracker does not await network operations
7. verify IndexedDB remains the local source of truth during a game
8. verify event synchronization is batched and idempotent
9. verify the database constraints
10. verify the statistics formulas

Then perform a final requirements check against `basketball-tracker-spec.md`.

Report:

* what was fixed
* tests executed
* build result
* remaining known limitations
* any manual setup still required for Turso/Cloudflare

Do not claim the application is production-ready if any P0/P1 issue remains.

___

## Prompt 11 - Migrate to Typescript

## Objective

Refactor the existing basketball-tracker project from JavaScript to TypeScript.

The goal is to introduce TypeScript across the project while preserving the existing architecture, functionality, UX, and behavior.

This is a refactoring task, **not a feature-development task**.

Do not introduce unrelated architectural changes or redesign existing functionality unless they are strictly necessary to complete the TypeScript migration.

---

## 1. Start by inspecting the existing project

Before modifying anything:

* Inspect the complete repository structure.
* Identify the framework, build system, package manager, and existing tooling.
* Identify all JavaScript source files.
* Identify tests and test configuration.
* Identify configuration files that need TypeScript support.
* Identify shared types/models that are currently represented only through implicit JavaScript structures.
* Identify API boundaries and external data structures.
* Identify places where `any`-like behavior is currently relied upon.

Read the existing code carefully before deciding on the migration strategy.

Do not assume the project structure from this prompt.

---

## 2. Define the TypeScript migration strategy

Before making large changes, establish a clear migration plan based on the actual repository.

Prefer an incremental migration over a complete rewrite.

The migration should:

* preserve existing functionality;
* preserve existing public APIs and application behavior;
* preserve existing tests;
* minimize unnecessary code changes;
* avoid introducing unnecessary abstractions;
* use TypeScript idiomatically rather than simply adding type annotations everywhere.

If the project already contains some TypeScript, build on the existing setup rather than replacing it.

---

## 3. Configure TypeScript correctly

Add or update the appropriate TypeScript configuration.

The configuration should:

* be appropriate for the project's framework and build tooling;
* provide strict type checking where practical;
* avoid unnecessarily disabling TypeScript safety;
* integrate correctly with the existing test/build/lint tooling;
* avoid producing build artifacts inside the source tree unless the project already follows that convention.

Prefer a strict configuration.

If enabling full strict mode immediately creates a very large amount of migration noise, use the smallest temporary relaxation necessary and document it. Do not permanently weaken type safety merely to make the migration easier.

---

## 4. Migrate application source code

Convert JavaScript source files to TypeScript using the appropriate extensions:

* `.js` → `.ts`
* `.jsx` → `.tsx` where applicable

Do not mechanically rename files without actually typing the important parts of the code.

Add meaningful types for:

* domain models;
* API responses;
* function parameters and return values;
* component props;
* component state where inference is insufficient;
* event handlers;
* callbacks;
* collections;
* configuration objects;
* external integrations.

Prefer inferred types when inference is clear.

Do not add redundant annotations simply to increase the number of TypeScript annotations.

---

## 5. Establish domain types

Identify the core basketball-tracker domain entities and create appropriate reusable types/interfaces.

Examples may include concepts such as:

* players;
* teams;
* games;
* matches;
* statistics;
* scores;
* seasons;
* competitions;
* standings;
* API responses.

Use the actual domain model discovered in the existing implementation.

Do not invent domain concepts that are not required by the current application.

Keep domain types centralized where that improves maintainability, but avoid creating an unnecessarily complex type architecture.

---

## 6. Type API and external boundaries carefully

API boundaries are particularly important.

For every external data source:

* define the expected response shape;
* type request parameters;
* type returned data;
* handle optional/missing fields explicitly;
* avoid `any` at API boundaries.

Do not blindly trust external data just because a TypeScript interface describes it.

If runtime validation is already present, preserve it.

If runtime validation is necessary for an important external boundary, introduce it only where justified by the existing architecture.

---

## 7. Eliminate `any`

Search the resulting codebase for:

* explicit `any`;
* implicit `any`;
* unsafe casts;
* `@ts-ignore`;
* unnecessary `@ts-expect-error`;
* broad type assertions such as `as SomeType` that merely silence compiler errors.

Remove them wherever reasonably possible.

Do not replace every `any` with an excessively complicated generic type just to satisfy the compiler.

When a value genuinely cannot be known statically, use an appropriate safer alternative such as:

* `unknown`;
* discriminated unions;
* generics;
* properly defined interfaces/types.

Any remaining exceptions must be justified with a comment.

---

## 8. Migrate tests

Migrate tests to TypeScript where appropriate and supported by the existing test setup.

Ensure:

* existing tests continue to run;
* test utilities are correctly typed;
* mocks are correctly typed;
* fixtures are typed;
* test-only types do not leak into production code.

Do not rewrite tests unnecessarily.

The purpose of this phase is to preserve and improve confidence in the existing behavior while migrating the implementation.

___

## 9. Update tooling

Update the relevant tooling as necessary:

* package scripts;
* build configuration;
* test configuration;
* ESLint;
* formatting configuration;
* TypeScript tooling;
* CI configuration.

Only make changes that are required or clearly beneficial for TypeScript support.

Do not upgrade unrelated dependencies simply because newer versions are available.

Avoid dependency churn.

___

## 10. Maintain project conventions

Follow the conventions already established in the repository.

Do not introduce:

* unnecessary new libraries;
* unnecessary architectural layers;
* unnecessary design patterns;
* speculative abstractions;
* unrelated refactors.

The final code should feel like the existing project, but written and maintained as a properly typed TypeScript project.

___

## 11. Validate continuously

After each meaningful migration step:

1. Run the relevant tests.
2. Run TypeScript type checking.
3. Run linting.
4. Run the production build when appropriate.

Fix errors rather than bypassing them.

At the end, verify that:

```text
- the application builds successfully
- all existing tests pass
- TypeScript type checking passes
- linting passes
- no accidental JavaScript source remains
- no unnecessary `any` remains
- no migration-only hacks remain
```

Use the actual package-manager commands defined by the repository rather than assuming npm/yarn/pnpm.

___

## 12. Review the final migration

After completing the migration, perform a final review specifically for:

* unnecessary type complexity;
* duplicated types;
* unsafe casts;
* `any`;
* dead JavaScript files;
* obsolete configuration;
* unused dependencies;
* migration artifacts;
* inconsistent naming;
* types that should be shared;
* opportunities to simplify the resulting code.

Keep the final implementation simple.

___

## Important constraints

### Do not change product behavior

The application should behave exactly as it did before the migration unless a change is required to fix a TypeScript-related issue.

### Do not perform unrelated refactoring

Do not use this task as an opportunity to redesign the application.

### Do not rewrite working code unnecessarily

Prefer small, understandable changes.

### Do not stop at "it compiles"

The migration is complete only when the application, tests, linting, and build all work correctly.

___

## Final report

At the end, provide a concise summary containing:

1. What was migrated to TypeScript.
2. Which files/configuration were changed.
3. The main domain types introduced.
4. Any remaining JavaScript files and why they remain.
5. Any remaining `any`/type-safety exceptions and why.
6. Tests/build/type-check/lint results.
7. Any follow-up technical debt created by the migration.

Do not modify unrelated functionality while producing this report.

___

## 13 — Complete a game with a post-game flow

## Objective

Implement a complete post-game flow for the basketball tracker.

When the coach finishes a game, the application must:

* explicitly mark the game as finished;
* preserve all recorded events;
* show a short post-game summary;
* allow the coach to enter the opponent's final score;
* persist the finished state and final score locally immediately;
* allow the coach to return to the dashboard/start screen;
* allow the coach to reopen the finished game;
* allow the coach to correct the event log or final score after finishing.

This feature must work reliably even when synchronization is unavailable.

Do not introduce unrelated product or architectural changes.

---

## 1. Inspect the existing implementation

Before making changes:

* Inspect the existing game lifecycle and state model.
* Identify how games are created, stored, loaded and synchronized.
* Identify how game events are recorded.
* Identify how the current game URL/routing works.
* Identify the existing dashboard/start screen.
* Identify how the team's score and statistics are currently calculated.
* Identify the existing local persistence mechanism.
* Identify existing tests related to games, events, persistence and navigation.

Build on the existing architecture rather than introducing a parallel game model.

---

## 2. Introduce an explicit game state

A game must have an explicit lifecycle state.

At minimum support:

```text
in-progress
finished
```

The state must be persisted as part of the game data.

Do not infer whether a game is finished merely from:

* the existence of a score;
* the URL;
* the last recorded event;
* the absence of an active screen.

The game state must be explicit and reliable.

Use the existing type/model conventions introduced by the TypeScript migration.

---

## 3. Implement the finish-game action

Provide a clear action for the coach to finish the current game.

When the coach chooses to finish:

1. Preserve all existing events.
2. Calculate the team's final score and game statistics from the recorded events.
3. Ask for the opponent's final score if it has not already been entered.
4. Mark the game as `finished`.
5. Persist the finished state and opponent score locally immediately.
6. Navigate to the post-game summary.

Do not wait for remote synchronization before considering the game finished locally.

If synchronization exists, it should happen independently of the local state transition.

---

## 4. Post-game summary

Create a concise post-game summary screen.

The summary should show at least:

* team's final score;
* opponent's final score;
* basic game statistics already available in the application;
* clear indication that the game is finished.

Use the existing visual language and components.

Do not turn the summary into a full analytics report.

The primary purpose is to give the coach a quick confirmation of the completed game.

---

## 5. Opponent final score

Allow the coach to enter the opponent's final score.

Requirements:

* accept only valid basketball scores;
* prevent invalid/non-numeric input;
* make the current value clear;
* persist the value locally;
* allow the value to be corrected later.

Do not assume that the opponent's score can be calculated from tracked events.

The opponent's score is manually entered by the coach.

---

## 6. Reopen a finished game

From the post-game summary, provide a clear action to reopen the game.

Reopening a finished game must allow the coach to:

* inspect the recorded event log;
* add/remove/correct events using the existing game-editing capabilities;
* correct the opponent's final score;
* recalculate the team's derived statistics and score.

Corrections must remain possible after a game has been marked finished.

If events are modified after finishing, the displayed summary must reflect the corrected event log.

---

## 7. Returning to the start screen

Provide a clear action from the post-game summary to return to the start/dashboard screen.

The finished game must remain persisted and discoverable after returning.

Do not rely on the browser's back button as the only way to leave the summary.

---

## 8. Local-first persistence

The finished state and opponent score must be saved locally before any attempt to synchronize remotely.

The application must remain correct if:

* the network is unavailable;
* synchronization fails;
* the page is closed immediately after finishing.

The local representation must contain enough information to reconstruct:

* game state;
* game events;
* team score/statistics;
* opponent final score.

Do not introduce a separate temporary storage mechanism if the existing persistence layer can support this cleanly.

---

## 9. URL and navigation behaviour

Preserve the existing routing approach.

A game URL should continue to identify the game rather than relying exclusively on transient application state.

A finished game opened directly should display an appropriate finished-game experience.

Do not make the game inaccessible simply because its state is `finished`.

---

## 10. Tests

Add or update tests covering at least:

* a game starts as `in-progress`;
* finishing a game changes its state to `finished`;
* recorded events are preserved;
* opponent score is persisted;
* finished state is persisted locally;
* post-game summary displays the correct values;
* returning to the dashboard does not lose the game;
* reopening a finished game is possible;
* event corrections update the derived score/statistics;
* opponent score can be corrected;
* finishing does not depend on successful synchronization.

Use the existing testing conventions.

Do not rewrite unrelated tests.

---

## 11. Validation

Run the project's normal:

* type checking;
* linting;
* tests;
* production build.

Fix issues caused by this feature.

Do not weaken linting or TypeScript configuration to make the feature pass.

---

## Constraints

* Do not delete events when finishing a game.
* Do not make finishing dependent on network synchronization.
* Do not make finished games read-only.
* Do not introduce a second game persistence model.
* Do not redesign unrelated screens.
* Preserve existing game recording behaviour.

## Final report

Summarize:

1. Game lifecycle changes.
2. Post-game summary implementation.
3. Opponent score handling.
4. Local persistence changes.
5. Reopening/correction behaviour.
6. Tests added or updated.
7. Validation results.

___

## 14 — Make in-progress games easy to resume

## Objective

Make it easy for a coach to find and continue an in-progress game from the start/dashboard screen.

The coach must not need to remember or manually recover a game URL after leaving the tracker.

The dashboard should:

* show recent games;
* clearly distinguish in-progress games from finished games;
* provide an obvious `Continue` action for in-progress games;
* keep finished games discoverable.

Build on the explicit game lifecycle introduced previously.

Do not introduce unrelated dashboard redesigns.

---

## 1. Inspect the existing implementation

Before making changes:

* Inspect the current start/dashboard screen.
* Inspect how games are listed or retrieved.
* Inspect the game state model.
* Inspect routing/navigation.
* Inspect local persistence.
* Inspect existing game-related tests.

Use the existing data and navigation architecture.

---

## 2. Recent games

Add a recent-games section to the start/dashboard screen.

Display a useful set of recent games rather than an unlimited history.

Each game entry should provide enough information to identify it, using data already available in the application, such as:

* date/time;
* teams/opponent;
* score if available;
* game status.

Do not invent unnecessary metadata.

Order recent games consistently, with the most recent first unless the existing product convention dictates otherwise.

---

## 3. In-progress games

Clearly distinguish games whose state is:

```text
in-progress
```

from:

```text
finished
```

For an in-progress game, provide a prominent and immediately understandable:

```text
Continue
```

action.

The action must take the coach directly back into that specific game.

Do not require the coach to find or copy a game URL.

---

## 4. Finished games

Finished games must remain discoverable from the dashboard.

Provide an appropriate action such as:

```text
View
```

or equivalent existing terminology.

Opening a finished game should lead to its finished-game/post-game experience.

Do not treat finished games as deleted or inaccessible.

---

## 5. Recovery after leaving the application

Verify the following scenario:

1. Start a game.
2. Record several events.
3. Leave the tracker or close the page.
4. Return to the application.
5. Find the game in recent games.
6. Select `Continue`.
7. Confirm that the game and its recorded events are intact.

This must work using locally persisted state.

Do not rely on browser session state or an in-memory store.

---

## 6. Multiple in-progress games

If the application permits more than one in-progress game:

* list them clearly;
* do not automatically choose one without showing the user which game is being resumed;
* ensure each `Continue` action targets the correct game.

If the existing product model intentionally permits only one active game, preserve that constraint rather than introducing multiple active games.

---

## 7. Empty state

When there are no recent games, keep the dashboard simple.

Provide the existing/new-game action without introducing unnecessary empty-state complexity.

---

## 8. Responsive and usable design

The recent-games section should work on the application's existing supported screen sizes.

The `Continue` action should be visually prominent and easy to tap/click.

Do not redesign the entire dashboard.

---

## 9. Tests

Add or update tests covering:

* recent games are displayed;
* in-progress games are identified correctly;
* `Continue` opens the correct game;
* finished games remain discoverable;
* finished games do not incorrectly show `Continue`;
* locally persisted in-progress games appear after application restart;
* recorded events are preserved when resuming.

Use the project's existing testing conventions.

---

## 10. Validation

Run:

* type checking;
* linting;
* tests;
* production build.

Fix issues caused by this feature only.

## Constraints

* Do not require a game URL to resume a game.
* Do not delete or hide finished games.
* Do not automatically finish abandoned games.
* Do not introduce unrelated dashboard features.
* Use the existing persistence and routing architecture.

## Final report

Summarize:

1. Dashboard changes.
2. Recent-games behaviour.
3. Continue behaviour.
4. Finished-game discovery.
5. Recovery behaviour.
6. Tests and validation results.

___

## 15 — Clarify season boundaries

## Objective

Make season boundaries explicit in the dashboard and trend views.

The application must never silently combine games from different seasons when calculating or displaying trends.

The coach must be able to understand which season a trend represents and select a different season when multiple seasons exist.

When only one season exists, keep the dashboard simple and do not force the coach through an unnecessary selection step.

---

## 1. Inspect the existing implementation

Before making changes:

* Inspect how games are currently grouped and queried.
* Inspect whether a season concept already exists.
* Inspect game dates and metadata.
* Inspect dashboard/trend calculations.
* Inspect existing filters and selectors.
* Inspect persistence and TypeScript domain models.
* Inspect existing tests.

Do not create a second season concept if one already exists.

---

## 2. Define an explicit season

A season must have a clear, understandable definition.

The definition must be deterministic and explainable to the coach.

Use the project's existing domain conventions if a season model already exists.

If no season model exists, introduce the simplest appropriate representation.

For example, if the product convention is a sports season spanning two calendar years, represent it consistently as something understandable such as:

```text
2026/27
```

Do not silently derive multiple incompatible definitions in different parts of the application.

---

## 3. Associate games with seasons

Every game used by trend/season analysis must belong to a clearly identifiable season.

Prefer deriving the season from an explicit, well-defined rule rather than requiring unnecessary manual input for every game.

If the existing data model already contains season information, reuse it.

Ensure existing games can be assigned consistently.

Do not modify historical game dates or event data.

---

## 4. Prevent cross-season trend aggregation

Trend calculations must never silently combine games belonging to different seasons.

All trend queries/calculations must operate within the selected season.

Review all relevant dashboard metrics and charts to ensure they respect the season boundary.

Pay particular attention to:

* averages;
* totals;
* game counts;
* trend lines;
* per-game statistics;
* any rolling or aggregated metrics.

---

## 5. Season selection UX

When more than one season exists:

* provide a clear season selector;
* show the currently selected season;
* make the meaning of the season understandable;
* update trend data when the selected season changes.

The selector should not require navigating to a separate settings page.

Use the existing dashboard design language.

When only one season exists:

* do not force the user to make a selection;
* keep the dashboard simple;
* optionally display the season as contextual information if useful.

---

## 6. Default selection

When multiple seasons exist, choose a sensible default.

Prefer the most recent/current season unless the existing product requirements dictate another behaviour.

The default must be deterministic.

Do not randomly select a season or silently combine all seasons.

---

## 7. Persistence of the selected season

If appropriate to the existing application architecture, preserve the coach's selected season when navigating between dashboard/trend views.

Do not introduce persistent user preferences unless they are useful and consistent with the existing architecture.

---

## 8. Tests

Add or update tests covering:

* games are assigned to the correct season;
* trend calculations do not cross season boundaries;
* multiple seasons appear in the selector;
* selecting a season changes the displayed data;
* the most recent season is selected by default where appropriate;
* a single-season dashboard does not require a selector;
* historical games remain correctly associated with their season.

Include edge cases around the season boundary.

For example, if using a `2026/27` season definition, test dates on both sides of the boundary.

---

## 9. Validation

Run:

* type checking;
* linting;
* tests;
* production build.

Manually verify at least one scenario containing games from two different seasons.

Confirm that the trend view never combines them without an explicit user choice.

## Constraints

* Do not silently aggregate multiple seasons.
* Do not introduce an unnecessarily complex season-management system.
* Do not require manual season selection when only one season exists.
* Do not alter historical game data unnecessarily.
* Do not redesign unrelated dashboard functionality.

## Final report

Summarize:

1. Season definition.
2. How games are associated with seasons.
3. Trend filtering behaviour.
4. Season selector behaviour.
5. Single-season behaviour.
6. Tests and validation results.

___

## 16 — Use comparable trend measures

## Objective

Update the dashboard's turnover and rebound trend metrics so they are comparable across games with different numbers of possessions.

The application must display:

* turnovers per 10 team possessions;
* offensive rebounds per 10 team possessions;
* defensive rebounds per 10 team possessions.

These are **rates per 10 possessions**, not percentages.

Do not label them as percentages.

Do not calculate true rebound percentage because the tracked events do not contain opponent rebound opportunities.

---

## 1. Inspect the existing implementation

Before changing calculations:

* Inspect how team possessions are currently calculated.
* Inspect turnover events.
* Inspect offensive rebound events.
* Inspect defensive rebound events.
* Inspect existing dashboard/trend calculations.
* Inspect chart labels and tooltips.
* Inspect TypeScript domain models.
* Inspect existing tests.

Reuse the existing event model and possession calculation where correct.

Do not create a second independent possession algorithm without a strong reason.

---

## 2. Define the metrics

For each game, calculate:

```text
Turnovers per 10 possessions
= turnovers / team possessions × 10

Offensive rebounds per 10 possessions
= offensive rebounds / team possessions × 10

Defensive rebounds per 10 possessions
= defensive rebounds / team possessions × 10
```

Use the team's possessions as the denominator.

These values should be calculated consistently for every game included in the trend.

---

## 3. Handle zero possessions safely

If a game has zero recorded possessions:

* do not divide by zero;
* do not display `Infinity` or `NaN`;
* use the application's established representation for unavailable data.

If no such representation exists, use a clear unavailable state rather than inventing a value.

---

## 4. Correct terminology

Use terminology such as:

* `Turnovers / 10 possessions`
* `Offensive rebounds / 10 possessions`
* `Defensive rebounds / 10 possessions`

Do not use:

* `%`;
* `turnover percentage`;
* `offensive rebound percentage`;
* `defensive rebound percentage`.

The UI should make it clear these are **per-10-possession rates**.

Tooltips, legends, chart axes, cards and accessible labels should use consistent terminology.

---

## 5. Do not calculate rebound percentage

Do not implement:

```text
offensive rebound %
defensive rebound %
total rebound %
```

because the application does not track the opponent rebound opportunities required to calculate a true rebound percentage.

If existing UI currently presents one of these metrics as a percentage, replace it with the appropriate per-10-possession measure.

Do not estimate opponent rebound opportunities.

---

## 6. Trend calculations

Ensure the trend view uses the normalized per-10-possession value for each game.

Do not calculate a simple percentage from the raw event count.

Be careful not to accidentally aggregate raw counts across games and then normalize the combined value unless that is explicitly how the existing trend is designed.

The purpose is to make individual game trends comparable when possession counts differ.

---

## 7. Preserve raw statistics

Do not remove the underlying raw event counts.

The existing game statistics should continue to be available where useful.

The new normalized metrics are an additional representation for trend comparison.

---

## 8. Tests

Add or update tests covering:

* turnover rate calculation;
* offensive rebound rate calculation;
* defensive rebound rate calculation;
* different possession counts producing appropriately normalized values;
* zero-possession games;
* correct rounding/display precision;
* correct labels;
* absence of percentage terminology;
* season filtering continues to work correctly.

Include explicit numerical examples in tests.

For example:

```text
10 turnovers / 100 possessions = 1.0 per 10 possessions
5 offensive rebounds / 50 possessions = 1.0 per 10 possessions
```

---

## 9. Validation

Run:

* type checking;
* linting;
* tests;
* production build.

Manually inspect the trend UI to ensure the labels communicate the new metric correctly.

## Constraints

* Do not use percentages.
* Do not estimate opponent rebound opportunities.
* Do not change the underlying event tracking model unnecessarily.
* Do not create a second possession definition without justification.
* Do not change unrelated statistics.

## Final report

Summarize:

1. Possession denominator used.
2. Three normalized metrics implemented.
3. UI terminology changes.
4. Handling of zero possessions.
5. Tests added/updated.
6. Validation results.

___

## 17 — Protect against accidental game endings

## Objective

Make finishing a game safe and recoverable.

The coach must not accidentally lose access to a game or its event log by ending it.

Implement a lightweight protection mechanism before finishing a game and ensure that the existing `Continue`/reopen flow provides an immediate recovery path.

The fundamental rule is:

**Finishing a game must never delete its events or make the game difficult to resume or correct.**

---

## 1. Inspect the existing implementation

Before making changes:

* Inspect the current finish-game action.
* Inspect the post-game flow.
* Inspect the explicit game state.
* Inspect local persistence.
* Inspect the dashboard recent-games/Continue flow.
* Inspect game reopening/editing.
* Inspect existing tests.

Build on the lifecycle and recovery mechanisms already implemented.

Do not create a second confirmation or recovery system.

---

## 2. Add lightweight finish confirmation

Before transitioning a game from `in-progress` to `finished`, provide a lightweight confirmation.

The confirmation should clearly communicate that:

* the game will be marked finished;
* recorded events will be preserved;
* the game can still be reopened and corrected.

Use the application's existing modal/dialog/confirmation pattern if one exists.

Avoid an overly disruptive multi-step confirmation flow.

If the product already has an appropriate confirmation mechanism, reuse it.

---

## 3. Preserve the game before finishing

When the coach confirms:

1. Preserve the complete event log.
2. Persist the current game data locally.
3. Persist the transition to `finished`.
4. Persist the opponent score.
5. Navigate to the post-game summary.

Do not delete or replace the event log as part of the state transition.

---

## 4. Recovery from the dashboard

After finishing a game and returning to the dashboard:

* the game must remain visible;
* its finished status must be clear;
* the coach must be able to open it;
* the coach must be able to correct the event log or final score.

If the coach accidentally finishes the game, the path to recovery should be immediately understandable.

Do not require manually reconstructing the game URL.

---

## 5. Browser/page interruption

Verify that the game remains recoverable if:

* the page is closed immediately after finishing;
* the browser is refreshed;
* synchronization fails;
* the network is unavailable.

Local persistence must remain the source of immediate truth for the completed transition.

---

## 6. Avoid destructive behaviour

Explicitly verify that finishing a game does NOT:

* delete events;
* clear the event log;
* remove the game from local storage;
* make the game inaccessible;
* invalidate the game URL;
* disable correction of the opponent score.

If any existing behaviour does this, fix it as part of this task.

---

## 7. Tests

Add or update tests covering:

* cancelling the finish confirmation leaves the game in progress;
* confirming the finish marks the game as finished;
* all events remain available;
* the finished game remains discoverable;
* the finished game can be reopened;
* the opponent score can be corrected;
* events can be corrected after finishing;
* refresh/reload does not lose the finished game;
* failed synchronization does not undo or hide the locally finished game.

---

## 8. Validation

Run:

* type checking;
* linting;
* tests;
* production build.

Manually verify the complete flow:

```text
Start game
    ↓
Record events
    ↓
Finish
    ↓
Confirm
    ↓
Post-game summary
    ↓
Return to dashboard
    ↓
Reopen game
    ↓
Correct event / score
    ↓
Save
    ↓
Verify corrected game
```

Also verify the cancellation path:

```text
Start game
    ↓
Finish
    ↓
Cancel
    ↓
Game remains in progress
```

## Constraints

* Keep confirmation lightweight.
* Do not introduce destructive finish behaviour.
* Do not make finished games read-only.
* Do not delete or reset events.
* Do not make recovery dependent on synchronization.
* Do not redesign unrelated game flows.

## Final report

Summarize:

1. Confirmation mechanism.
2. Recovery path.
3. Persistence behaviour.
4. Any destructive behaviour fixed.
5. Tests added/updated.
6. Validation results.
