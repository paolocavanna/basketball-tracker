import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createLocalStore } from "../frontend/src/lib/localStore.js";
import { computeStats } from "../frontend/src/lib/stats.js";

const GAME_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_GAME_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// A fresh in-memory database per test, exposed through the real IndexedDB
// globals so nothing in the store can reach for the network or for state
// another test left behind.
function withDatabase(factory, run) {
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = IDBKeyRange;
  return Promise.resolve(run()).finally(() => {
    Object.assign(globalThis, previous);
  });
}

function withStore(run) {
  return withDatabase(new IDBFactory(), () => run(createLocalStore()));
}

// Consecutive taps in a test land inside the same millisecond, so the courtside
// clock is supplied explicitly wherever the order of the log matters.
const at = (n) => `2026-10-04T10:${String(n).padStart(2, "0")}:00.000Z`;

function tap(store, gameId, type, points, minute) {
  return store.saveEvent({
    game_id: gameId,
    type,
    points,
    created_at: at(minute),
  });
}

describe("local store schema", () => {
  it("creates a store per entity, the delete queue, and the log index", () =>
    withStore(async (store) => {
      const db = await store.open();
      assert.deepEqual([...db.objectStoreNames].sort(), ["events", "forcedDeletes", "games"]);

      const tx = db.transaction("events", "readonly");
      assert.deepEqual([...tx.objectStore("events").indexNames], ["by_game"]);
    }));

  it("finds the existing data when the app opens the database again", () =>
    withDatabase(new IDBFactory(), async () => {
      const first = createLocalStore();
      await first.saveGame({
        id: GAME_ID,
        team_id: 1,
        date: "2026-10-04",
        opponent_name: "Novi Ligure",
        created_at: "2026-10-04T18:00:00.000Z",
      });
      await tap(first, GAME_ID, "SCORE", 3, 1);

      const second = createLocalStore();
      assert.equal((await second.loadGame(GAME_ID)).opponent_name, "Novi Ligure");
      assert.deepEqual(
        (await second.loadGameEvents(GAME_ID)).map((event) => event.type),
        ["SCORE"],
      );
    }));
});

describe("games", () => {
  it("stores a client-generated game id, date and opponent as pending", () =>
    withStore(async (store) => {
      const game = await store.saveGame({
        id: GAME_ID,
        team_id: 1,
        date: "2026-10-04",
        opponent_name: "Novi Ligure",
        created_at: "2026-10-04T18:00:00.000Z",
      });

      assert.equal(game.id, GAME_ID);
      assert.equal(game.synced, false);
      assert.deepEqual(await store.loadGame(GAME_ID), game);
    }));

  it("loads a game that was never saved as null", () =>
    withStore(async (store) => {
      assert.equal(await store.loadGame(GAME_ID), null);
    }));
});

describe("events", () => {
  it("fills in the id and the courtside timestamp for a tap", () =>
    withStore(async (store) => {
      const before = Date.now();
      const event = await store.saveEvent({ game_id: GAME_ID, type: "SCORE", points: 3 });

      assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      assert.equal(event.game_id, GAME_ID);
      assert.equal(event.points, 3);
      assert.equal(event.synced, false);
      assert.equal(event.deleted, false);

      const parsed = Date.parse(event.created_at);
      assert.ok(parsed >= before && parsed <= Date.now(), event.created_at);
    }));

  it("keeps a caller supplied id and created_at", () =>
    withStore(async (store) => {
      const id = crypto.randomUUID();
      const event = await store.saveEvent({
        id,
        game_id: GAME_ID,
        type: "TOV",
        created_at: "2026-10-04T10:00:00.000Z",
      });

      assert.equal(event.id, id);
      assert.equal(event.created_at, "2026-10-04T10:00:00.000Z");
      assert.equal(event.points, 0);
    }));

  it("refuses a type the statistics rules do not define", () =>
    withStore(async (store) => {
      await assert.rejects(
        () => store.saveEvent({ game_id: GAME_ID, type: "MISS" }),
        /Unknown event type/,
      );
      await assert.rejects(() => store.saveEvent({ game_id: GAME_ID }), /Unknown event type/);
      assert.deepEqual(await store.loadGameEvents(GAME_ID), []);
    }));

  it("returns a game event log in tap order", () =>
    withStore(async (store) => {
      await store.saveGame({ id: GAME_ID, team_id: 1, date: "2026-10-04", opponent_name: "Novi" });
      await tap(store, GAME_ID, "SCORE", 2, 1);
      await tap(store, GAME_ID, "OFF_REB", 0, 2);
      await tap(store, GAME_ID, "TOV", 0, 3);

      const events = await store.loadGameEvents(GAME_ID);
      assert.deepEqual(
        events.map((event) => event.type),
        ["SCORE", "OFF_REB", "TOV"],
      );
      assert.equal(events[1].points, 0);
    }));

  it("keeps games apart", () =>
    withStore(async (store) => {
      await tap(store, GAME_ID, "SCORE", 3, 1);
      await tap(store, OTHER_GAME_ID, "TOV", 0, 1);

      assert.deepEqual(
        (await store.loadGameEvents(GAME_ID)).map((event) => event.type),
        ["SCORE"],
      );
      assert.deepEqual(
        (await store.loadGameEvents(OTHER_GAME_ID)).map((event) => event.type),
        ["TOV"],
      );
    }));
});

describe("undo", () => {
  it("keeps the undone record so its delete can still sync", () =>
    withStore(async (store) => {
      const score = await tap(store, GAME_ID, "SCORE", 3, 1);
      await tap(store, GAME_ID, "TOV", 0, 2);

      await store.deleteEvent(score.id);

      const events = await store.loadGameEvents(GAME_ID);
      assert.equal(events.length, 2);
      assert.equal(events[0].deleted, true);
      assert.equal(events[0].game_id, GAME_ID, "the tombstone stays in the game's queue");
      assert.deepEqual(await store.pendingEventIds(GAME_ID), [events[1].id]);
    }));

  it("drops the undone event from the statistics immediately", () =>
    withStore(async (store) => {
      const score = await tap(store, GAME_ID, "SCORE", 2, 1);
      await tap(store, GAME_ID, "EMPTY", 0, 2);
      assert.equal(computeStats(await store.loadGameEvents(GAME_ID)).points, 2);

      await store.deleteEvent(score.id);

      const stats = computeStats(await store.loadGameEvents(GAME_ID));
      assert.equal(stats.points, 0);
      assert.equal(stats.possessions, 1);
    }));

  it("returns the latest tap that is still queued for sync", () =>
    withStore(async (store) => {
      assert.equal(await store.lastEvent(GAME_ID), null);

      await tap(store, GAME_ID, "SCORE", 2, 1);
      const latest = await tap(store, GAME_ID, "DEF_REB", 0, 2);
      assert.equal((await store.lastEvent(GAME_ID)).id, latest.id);
    }));

  it("skips an undone tap and falls back to the one before it", () =>
    withStore(async (store) => {
      const first = await tap(store, GAME_ID, "SCORE", 2, 1);
      const second = await tap(store, GAME_ID, "TOV", 0, 2);
      await store.deleteEvent(second.id);

      assert.equal((await store.lastEvent(GAME_ID)).id, first.id);

      await store.deleteEvent(first.id);
      assert.equal(await store.lastEvent(GAME_ID), null);
    }));

  it("leaves an already synced tap to the server, not to Undo", () =>
    withStore(async (store) => {
      const score = await tap(store, GAME_ID, "SCORE", 2, 1);
      await tap(store, GAME_ID, "TOV", 0, 2);
      await store.markEventsSynced([score.id]);

      assert.equal((await store.lastEvent(GAME_ID)).type, "TOV");
    }));
});

describe("sync state", () => {
  it("queues every tap and stops queueing once marked synced", () =>
    withStore(async (store) => {
      const first = await tap(store, GAME_ID, "SCORE", 2, 1);
      const second = await tap(store, GAME_ID, "TOV", 0, 2);

      assert.deepEqual(await store.pendingEventIds(GAME_ID), [first.id, second.id]);

      const marked = await store.markEventsSynced([first.id, second.id]);
      assert.equal(marked, 2);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);

      const events = await store.loadGameEvents(GAME_ID);
      assert.deepEqual(
        events.map((event) => event.synced),
        [true, true],
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ["SCORE", "TOV"],
      );
    }));

  it("leaves the records of a partial batch pending", () =>
    withStore(async (store) => {
      const first = await tap(store, GAME_ID, "SCORE", 2, 1);
      const second = await tap(store, GAME_ID, "TOV", 0, 2);

      await store.markEventsSynced([first.id]);

      assert.deepEqual(await store.pendingEventIds(GAME_ID), [second.id]);
    }));

  it("ignores an unknown id instead of creating a record for it", () =>
    withStore(async (store) => {
      assert.equal(await store.markEventsSynced([crypto.randomUUID()]), 0);
      assert.equal(await store.deleteEvent(crypto.randomUUID()), null);
      assert.deepEqual(await store.loadGameEvents(GAME_ID), []);
    }));

  it("never resurrects an event undone while its batch was in flight", () =>
    withStore(async (store) => {
      const score = await tap(store, GAME_ID, "SCORE", 3, 1);
      const queued = await store.pendingEventIds(GAME_ID);

      await store.deleteEvent(score.id);
      await store.markEventsSynced(queued);

      const events = await store.loadGameEvents(GAME_ID);
      assert.equal(events.length, 1);
      assert.equal(events[0].deleted, true);
      assert.equal(events[0].synced, false);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);
      assert.deepEqual(
        (await store.pendingDeletions()).map((event) => event.id),
        [score.id],
      );
    }));

  it("requeues a synced event when it is undone", () =>
    withStore(async (store) => {
      const score = await tap(store, GAME_ID, "SCORE", 2, 1);
      await store.markEventsSynced([score.id]);

      await store.deleteEvent(score.id);

      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);
      const [tombstone] = await store.pendingDeletions();
      assert.equal(tombstone.id, score.id);
      assert.equal(tombstone.deleted, true);
      assert.equal(tombstone.synced, false);
    }));

  it("queues a fresh delete when a posted id is already a synced tombstone", () =>
    withStore(async (store) => {
      const score = await tap(store, GAME_ID, "SCORE", 2, 1);
      const kept = await tap(store, GAME_ID, "EMPTY", 0, 2);
      await store.deleteEvent(score.id);
      await store.markDeletionsSynced([score.id]);
      assert.equal((await store.loadGameEvents(GAME_ID))[0].synced, true);
      assert.deepEqual(await store.forcedDeleteIds(), []);

      const deletedIds = await store.settlePostedEvents([score.id, kept.id, crypto.randomUUID()]);
      assert.deepEqual(deletedIds, [score.id]);

      const events = await store.loadGameEvents(GAME_ID);
      assert.equal(events.find((event) => event.id === score.id).synced, false);
      assert.equal(events.find((event) => event.id === kept.id).synced, true);
      assert.deepEqual(await store.forcedDeleteIds(), [score.id]);

      await store.markDeletionsSynced([score.id]);
      assert.equal((await store.loadGameEvents(GAME_ID))[0].synced, true);
      assert.deepEqual(await store.forcedDeleteIds(), [score.id]);

      await store.clearForcedDeletes([score.id]);
      assert.deepEqual(await store.forcedDeleteIds(), []);
    }));

  it("marks a game synced only while it still matches the row that was sent", () =>
    withStore(async (store) => {
      const saved = await store.saveGame({
        id: GAME_ID,
        team_id: 1,
        date: "2026-10-04",
        opponent_name: "Novi Ligure",
        created_at: "2026-10-04T18:00:00.000Z",
      });
      assert.deepEqual(
        (await store.pendingGames()).map((game) => game.id),
        [GAME_ID],
      );

      await store.saveGame({ ...saved, opponent_name: "Alba" });
      assert.equal(await store.markGameSynced(GAME_ID, saved), false);
      assert.equal((await store.loadGame(GAME_ID)).synced, false);
      assert.equal(await store.markGameSynced(crypto.randomUUID(), saved), false);

      const current = await store.loadGame(GAME_ID);
      assert.equal(await store.markGameSynced(GAME_ID, current), true);
      assert.equal((await store.loadGame(GAME_ID)).synced, true);
      assert.deepEqual(await store.pendingGames(), []);
    }));

  it("keeps each game's queue separate", () =>
    withStore(async (store) => {
      const ours = await tap(store, GAME_ID, "SCORE", 2, 1);
      const theirs = await tap(store, OTHER_GAME_ID, "TOV", 0, 1);

      assert.deepEqual(await store.pendingEventIds(GAME_ID), [ours.id]);
      assert.deepEqual(await store.pendingEventIds(OTHER_GAME_ID), [theirs.id]);
    }));
});
