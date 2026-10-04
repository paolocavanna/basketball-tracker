import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  applyFinishChoice,
  gameResult,
  parseFinalScore,
  persistDerivedScore,
  recentGames,
  recoveryPath,
  capitalizedOpponent,
  resultLabel,
  saveFinalScores,
} from "../frontend/src/lib/gameLifecycle.ts";
import { createLocalStore } from "../frontend/src/lib/localStore.ts";
import type { LocalStore } from "../frontend/src/lib/localStore.ts";
import { gameStatus } from "../frontend/src/lib/localStore.ts";
import { summaryPath } from "../frontend/src/lib/route.ts";
import { computeStats } from "../frontend/src/lib/stats.ts";
import { createSyncManager } from "../frontend/src/lib/syncManager.ts";
import type { StoredEvent, StoredGame } from "../types.ts";

const GAME_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_GAME_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function withDatabase<T>(factory: IDBFactory, run: () => T | Promise<T>): Promise<T> {
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = IDBKeyRange;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      Object.assign(globalThis, previous);
    });
}

function withStore<T>(run: (store: LocalStore) => T | Promise<T>): Promise<T> {
  return withDatabase(new IDBFactory(), () => run(createLocalStore()));
}

async function saveGame(
  store: LocalStore,
  id: string,
  opponent: string,
  createdAt: string,
): Promise<StoredGame> {
  return store.saveGame({
    id,
    team_id: 1,
    date: "2026-10-04",
    opponent_name: opponent,
    created_at: createdAt,
    status: "in-progress",
  });
}

async function score(store: LocalStore, gameId: string, points: 2 | 3): Promise<StoredEvent> {
  return store.saveEvent({
    game_id: gameId,
    type: "SCORE",
    points,
    created_at: "2026-10-04T18:05:00.000Z",
  });
}

function eventShape(events: StoredEvent[]) {
  return events.map((event) => ({
    id: event.id,
    type: event.type,
    points: event.points,
    deleted: event.deleted,
  }));
}

describe("finish confirmation", () => {
  it("treats a game with no status as still in progress", () => {
    assert.equal(gameStatus({}), "in-progress");
    assert.equal(gameStatus({ status: "finished" }), "finished");
  });

  it("leaves the game in progress when the coach cancels", () =>
    withStore(async (store) => {
      const game = await saveGame(store, GAME_ID, "Novi Ligure", "2026-10-04T18:00:00.000Z");
      const event = await score(store, GAME_ID, 2);
      const beforeEvents = await store.loadGameEvents(GAME_ID);

      const kept = await applyFinishChoice(store, "cancel", game, beforeEvents);

      assert.equal(gameStatus(kept), "in-progress");
      assert.deepEqual(kept, await store.loadGame(GAME_ID));
      assert.deepEqual(eventShape(await store.loadGameEvents(GAME_ID)), eventShape(beforeEvents));
      assert.equal((await store.loadGameEvents(GAME_ID))[0]?.id, event.id);
      assert.deepEqual(recentGames(await store.listGames()), []);
    }));

  it("marks the game finished and keeps every event when the coach confirms", () =>
    withStore(async (store) => {
      const game = await saveGame(store, GAME_ID, "Novi Ligure", "2026-10-04T18:00:00.000Z");
      await store.saveGame({ ...game, final_score_against: 41 });
      const withScore = await store.loadGame(GAME_ID);
      assert.ok(withScore);
      const event = await score(store, GAME_ID, 2);
      await store.deleteEvent(event.id);
      await score(store, GAME_ID, 3);
      const beforeEvents = await store.loadGameEvents(GAME_ID);

      const finished = await applyFinishChoice(store, "confirm", withScore, beforeEvents);
      const afterEvents = await store.loadGameEvents(GAME_ID);

      assert.equal(finished.status, "finished");
      assert.equal(finished.final_score_for, computeStats(beforeEvents).points);
      assert.equal(finished.final_score_against, 41);
      assert.equal(finished.synced, false);
      assert.deepEqual(await store.loadGame(GAME_ID), finished);
      assert.deepEqual(eventShape(afterEvents), eventShape(beforeEvents));
      assert.equal(afterEvents.filter((row) => row.deleted).length, 1);
      assert.equal(recoveryPath(finished), summaryPath(GAME_ID));
      assert.deepEqual(
        recentGames(await store.listGames()).map((row) => row.id),
        [GAME_ID],
      );
    }));
});

describe("recovery", () => {
  it("lists a finished game and leaves an in-progress game off the list", () =>
    withStore(async (store) => {
      const older = await saveGame(store, GAME_ID, "Novi Ligure", "2026-10-04T18:00:00.000Z");
      await score(store, GAME_ID, 2);
      await applyFinishChoice(store, "confirm", older, await store.loadGameEvents(GAME_ID));
      await saveGame(store, OTHER_GAME_ID, "Alba", "2026-10-05T18:00:00.000Z");

      const stored = await store.listGames();
      assert.deepEqual(stored.map((game) => game.id).sort(), [GAME_ID, OTHER_GAME_ID].sort());
      const listed = recentGames(stored);
      assert.deepEqual(
        listed.map((game) => game.id),
        [GAME_ID],
      );
      const finished = listed[0];
      assert.ok(finished);
      assert.equal(recoveryPath(finished), summaryPath(GAME_ID));
    }));

  it("still has the finished game after the page is opened again", () =>
    withDatabase(new IDBFactory(), async () => {
      const first = createLocalStore();
      const game = await saveGame(first, GAME_ID, "Novi Ligure", "2026-10-04T18:00:00.000Z");
      await score(first, GAME_ID, 2);
      await applyFinishChoice(first, "confirm", game, await first.loadGameEvents(GAME_ID));

      const second = createLocalStore();
      const reloaded = await second.loadGame(GAME_ID);
      assert.ok(reloaded);
      assert.equal(reloaded.status, "finished");
      assert.equal((await second.loadGameEvents(GAME_ID)).length, 1);
      assert.equal(recentGames(await second.listGames())[0]?.id, GAME_ID);
      assert.equal(recoveryPath(reloaded), summaryPath(GAME_ID));
    }));
});

describe("corrections after finishing", () => {
  it("saves both final scores, names the winner, and keeps that result when the log changes", () =>
    withStore(async (store) => {
      assert.equal(parseFinalScore(""), null);
      assert.equal(parseFinalScore("8.5"), null);
      assert.equal(parseFinalScore("-1"), null);
      assert.equal(parseFinalScore("1000"), null);
      assert.equal(parseFinalScore("08"), null);
      assert.equal(parseFinalScore("0"), 0);
      assert.equal(parseFinalScore(" 12 "), 12);
      assert.equal(gameResult(61, 39), "win");
      assert.equal(gameResult(39, 61), "loss");
      assert.equal(gameResult(40, 40), "draw");
      assert.equal(gameResult(null, 10), null);
      assert.equal(
        resultLabel("loss", "Novara", {
          campusWon: "Campus won",
          opponentWon: "{opponent} won",
          draw: "Draw",
        }),
        "Novara won",
      );
      assert.equal(capitalizedOpponent("novara basket"), "Novara Basket");
      assert.equal(capitalizedOpponent("Novara"), "Novara");
      assert.equal(capitalizedOpponent("nOVARA"), "NOVARA");
      assert.equal(capitalizedOpponent("de faveri"), "De Faveri");

      const game = await saveGame(store, GAME_ID, "Novara", "2026-10-04T18:00:00.000Z");
      await score(store, GAME_ID, 2);
      const events = await store.loadGameEvents(GAME_ID);
      const finished = await applyFinishChoice(store, "confirm", game, events);
      const first = await saveFinalScores(store, finished, events, "61", "39");
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.equal(first.game.final_score_for, 61);
      assert.equal(first.game.final_score_against, 39);
      assert.equal(first.game.final_scores_confirmed, true);
      assert.equal(first.game.status, "finished");
      assert.equal(gameResult(first.game.final_score_for, first.game.final_score_against), "win");

      const second = await saveFinalScores(store, first.game, events, "39", "61");
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.game.final_score_for, 39);
      assert.equal(second.game.final_score_against, 61);
      assert.equal(
        gameResult(second.game.final_score_for, second.game.final_score_against),
        "loss",
      );

      const tied = await saveFinalScores(store, second.game, events, "40", "40");
      assert.equal(tied.ok, true);
      if (!tied.ok) return;
      assert.equal(gameResult(tied.game.final_score_for, tied.game.final_score_against), "draw");

      const invalid = await saveFinalScores(store, tied.game, events, "61", "nope");
      assert.equal(invalid.ok, false);
      const stored = await store.loadGame(GAME_ID);
      assert.ok(stored);
      assert.equal(stored.final_score_for, 40);
      assert.equal(stored.final_score_against, 40);

      await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 3,
        created_at: "2026-10-04T18:06:00.000Z",
      });
      const kept = await persistDerivedScore(store, stored, await store.loadGameEvents(GAME_ID));
      assert.ok(kept);
      assert.equal(kept.final_score_for, 40);
      assert.equal(kept.final_score_against, 40);
      assert.equal(kept.final_scores_confirmed, true);
      assert.equal((await store.loadGameEvents(GAME_ID)).length, 2);
    }));

  it("lets the coach add and undo events without leaving the finished state", () =>
    withStore(async (store) => {
      const game = await saveGame(store, GAME_ID, "Novi Ligure", "2026-10-04T18:00:00.000Z");
      await score(store, GAME_ID, 2);
      const finished = await applyFinishChoice(
        store,
        "confirm",
        game,
        await store.loadGameEvents(GAME_ID),
      );
      const added = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 3,
        created_at: "2026-10-04T18:06:00.000Z",
      });
      const withAddition = await store.loadGameEvents(GAME_ID);
      const rescored = await persistDerivedScore(store, finished, withAddition);
      assert.ok(rescored);
      assert.equal(rescored.status, "finished");
      assert.equal(rescored.final_score_for, computeStats(withAddition).points);
      assert.equal(withAddition.length, 2);

      await store.deleteEvent(added.id);
      const withUndo = await store.loadGameEvents(GAME_ID);
      const afterUndo = await persistDerivedScore(store, rescored, withUndo);
      assert.ok(afterUndo);
      assert.equal(afterUndo.status, "finished");
      assert.equal(withUndo.length, 2);
      assert.equal(withUndo.find((event) => event.id === added.id)?.deleted, true);
      assert.equal(afterUndo.final_score_for, computeStats(withUndo).points);
      assert.equal(recoveryPath(afterUndo), summaryPath(GAME_ID));
    }));
});

describe("failed sync", () => {
  it("does not undo or hide a finished game when the upload fails", () =>
    withStore(async (store) => {
      const game = await saveGame(store, GAME_ID, "Novi Ligure", "2026-10-04T18:00:00.000Z");
      await score(store, GAME_ID, 2);
      const events = await store.loadGameEvents(GAME_ID);
      await applyFinishChoice(store, "confirm", game, events);

      const sync = createSyncManager({
        store,
        fetch: () => Promise.reject(new Error("offline")),
        target: new EventTarget(),
      });
      const result = await sync.syncNow();

      assert.equal(result.ok, false);
      const stored = await store.loadGame(GAME_ID);
      assert.ok(stored);
      assert.equal(stored.status, "finished");
      assert.equal(stored.final_score_for, 2);
      assert.deepEqual(eventShape(await store.loadGameEvents(GAME_ID)), eventShape(events));
      const listed = recentGames(await store.listGames());
      assert.equal(listed[0]?.id, GAME_ID);
      assert.equal(recoveryPath(listed[0] ?? stored), summaryPath(GAME_ID));
    }));
});
