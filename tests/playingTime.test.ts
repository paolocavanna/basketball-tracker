import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createLocalStore } from "../frontend/src/lib/localStore.ts";
import {
  calculateUsage,
  elapsedGameSeconds,
  formatPlayingTime,
  gameRoster,
  pauseGameClock,
  savePlayingTimeOverride,
  startGameClock,
  substitutePlayers,
  undoSubstitution,
} from "../frontend/src/lib/playingTime.ts";
import type { LocalStore } from "../frontend/src/lib/localStore.ts";

const GAME_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_GAME_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

async function withStore<T>(run: (store: LocalStore) => Promise<T>): Promise<T> {
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  try {
    return await run(createLocalStore());
  } finally {
    Object.assign(globalThis, previous);
  }
}

const roster = Array.from({ length: 6 }, (_, index) => ({
  id: `player-${index + 1}`,
  name: `Player ${index + 1}`,
  active: true,
}));

describe("playing time", () => {
  it("times the starting five, splits time on substitution, and excludes paused time", () =>
    withStore(async (store) => {
      await store.saveGamePlayers(
        gameRoster(
          GAME_ID,
          roster,
          roster.map((p) => p.id),
          roster.slice(0, 5).map((p) => p.id),
        ),
      );
      assert.equal(await startGameClock(store, GAME_ID, 1_000), true);
      await substitutePlayers(store, GAME_ID, "player-1", "player-6", 61_000);
      await pauseGameClock(store, GAME_ID, 121_000);

      const players = await store.loadGamePlayers(GAME_ID);
      const shifts = await store.loadPlayerShifts(GAME_ID);
      const usage = calculateUsage(players, shifts, 500_000);
      assert.equal(usage.find((player) => player.player_id === "player-1")?.seconds, 60);
      assert.equal(usage.find((player) => player.player_id === "player-6")?.seconds, 60);
      assert.equal(usage.find((player) => player.player_id === "player-2")?.seconds, 120);
      assert.equal(elapsedGameSeconds(await store.loadGameTimer(GAME_ID), 500_000), 120);
      assert.equal(usage.length, 6);
    }));

  it("restores the prior lineup and timing when the latest substitution is undone", () =>
    withStore(async (store) => {
      await store.saveGamePlayers(
        gameRoster(
          GAME_ID,
          roster,
          roster.map((p) => p.id),
          roster.slice(0, 5).map((p) => p.id),
        ),
      );
      await startGameClock(store, GAME_ID, 1_000);
      const undo = await substitutePlayers(store, GAME_ID, "player-1", "player-6", 31_000);
      assert.ok(undo);
      await undoSubstitution(store, undo);

      const players = await store.loadGamePlayers(GAME_ID);
      assert.equal(players.find((player) => player.player_id === "player-1")?.on_court, true);
      assert.equal(players.find((player) => player.player_id === "player-6")?.on_court, false);
      const shifts = await store.loadPlayerShifts(GAME_ID);
      assert.equal(
        shifts.filter((shift) => shift.player_id === "player-1" && !shift.ended_at).length,
        1,
      );
      assert.equal(
        shifts.some((shift) => shift.player_id === "player-6"),
        false,
      );
    }));

  it("validates per-game minute corrections and formats short times", () =>
    withStore(async (store) => {
      const [player] = gameRoster(
        GAME_ID,
        roster,
        roster.map((p) => p.id),
        roster.slice(0, 5).map((p) => p.id),
      );
      assert.ok(player);
      await store.saveGamePlayers([player]);
      const saved = (await store.loadGamePlayers(GAME_ID))[0];
      assert.ok(saved);
      assert.equal(await savePlayingTimeOverride(store, saved, 61, 60), false);
      assert.equal(await savePlayingTimeOverride(store, saved, 60, 60), true);
      assert.equal(formatPlayingTime(125), "2:05");
      assert.equal(formatPlayingTime(-2), "0:00");
    }));

  it("clears temporary time records when leaving the game summary", () =>
    withStore(async (store) => {
      const [player] = gameRoster(
        GAME_ID,
        roster,
        roster.map((p) => p.id),
        roster.slice(0, 5).map((p) => p.id),
      );
      assert.ok(player);
      await store.saveGamePlayers([player]);
      await store.saveGameTimer({ game_id: GAME_ID, elapsed_ms: 0, running_since: null });
      await store.clearGamePlayingTime(GAME_ID);
      assert.deepEqual(await store.loadGamePlayers(GAME_ID), []);
      assert.deepEqual(await store.loadPlayerShifts(GAME_ID), []);
      assert.equal(await store.loadGameTimer(GAME_ID), null);
    }));

  it("clears timing for other games but preserves the currently open game", () =>
    withStore(async (store) => {
      const player = gameRoster(
        GAME_ID,
        roster,
        roster.map((entry) => entry.id),
        roster.slice(0, 5).map((entry) => entry.id),
      )[0];
      assert.ok(player);
      await store.saveGamePlayers([player, { ...player, game_id: OTHER_GAME_ID }]);
      await store.saveGameTimer({ game_id: GAME_ID, elapsed_ms: 0, running_since: null });
      await store.saveGameTimer({ game_id: OTHER_GAME_ID, elapsed_ms: 0, running_since: null });
      await store.clearGamePlayingTimeExcept(GAME_ID);
      assert.equal((await store.loadGamePlayers(GAME_ID)).length, 1);
      assert.deepEqual(await store.loadGamePlayers(OTHER_GAME_ID), []);
      assert.deepEqual(await store.loadGameTimer(GAME_ID), {
        game_id: GAME_ID,
        elapsed_ms: 0,
        running_since: null,
      });
      assert.equal(await store.loadGameTimer(OTHER_GAME_ID), null);
    }));
});
