import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createLocalStore } from "../frontend/src/lib/localStore.js";
import { createSyncManager } from "../frontend/src/lib/syncManager.js";
import { computeStats } from "../frontend/src/lib/stats.js";

const GAME_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_GAME_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const at = (minute) => `2026-10-04T10:${String(minute).padStart(2, "0")}:00.000Z`;

function game(id, opponent, createdAt = "2026-10-04T18:00:00.000Z") {
  return {
    id,
    team_id: 1,
    date: "2026-10-04",
    opponent_name: opponent,
    created_at: createdAt,
  };
}

function deferred() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

function recorded(handler) {
  const calls = [];
  return {
    calls,
    fetch(url, options = {}) {
      const call = {
        url: String(url),
        method: options.method,
        body: options.body == null ? null : JSON.parse(options.body),
      };
      calls.push(call);
      return handler(call);
    },
  };
}

const posts = (calls) => calls.filter((call) => call.method === "POST");
const puts = (calls) => calls.filter((call) => call.method === "PUT");
const deletes = (calls) => calls.filter((call) => call.method === "DELETE");

function accepted(call) {
  if (call.method === "DELETE") return new Response(null, { status: 204 });
  const synced = Array.isArray(call.body) ? call.body.length : 1;
  return Response.json({ synced }, { status: call.method === "PUT" ? 201 : 200 });
}

function clock() {
  const intervals = [];
  const timeouts = [];
  const idle = [];
  return {
    intervals,
    timeouts,
    idle,
    setInterval(fn, ms) {
      const handle = { fn, ms };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle) {
      const index = intervals.indexOf(handle);
      if (index >= 0) intervals.splice(index, 1);
    },
    setTimeout(fn, ms) {
      const handle = { fn, ms };
      timeouts.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const index = timeouts.indexOf(handle);
      if (index >= 0) timeouts.splice(index, 1);
    },
    requestIdleCallback(fn) {
      const handle = { fn };
      idle.push(handle);
      return handle;
    },
    cancelIdleCallback(handle) {
      const index = idle.indexOf(handle);
      if (index >= 0) idle.splice(index, 1);
    },
  };
}

async function withStore(run) {
  const store = createLocalStore({
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  });
  await run(store);
}

describe("sync manager", { concurrency: false }, () => {
  it("marks a game and its events synced after the batch is accepted", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      const score = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });
      const rebound = await store.saveEvent({
        game_id: GAME_ID,
        type: "OFF_REB",
        created_at: at(2),
      });

      const http = recorded((call) => accepted(call));
      const manager = createSyncManager({ store, fetch: http.fetch });
      const result = await manager.syncNow();

      assert.equal(result.ok, true);
      assert.equal(puts(http.calls).length, 1);
      assert.equal(posts(http.calls).length, 1);
      assert.equal(deletes(http.calls).length, 0);

      const put = puts(http.calls)[0];
      assert.equal(put.url, `/api/games/${GAME_ID}`);
      assert.deepEqual(put.body, {
        id: GAME_ID,
        team_id: 1,
        date: "2026-10-04",
        opponent: "Novi Ligure",
        created_at: "2026-10-04T18:00:00.000Z",
      });

      const post = posts(http.calls)[0];
      assert.equal(post.url, `/api/games/${GAME_ID}/events/sync`);
      assert.deepEqual(post.body, [
        { id: score.id, type: "SCORE", points: 2, created_at: at(1) },
        { id: rebound.id, type: "OFF_REB", points: 0, created_at: at(2) },
      ]);
      assert.ok(http.calls.indexOf(put) < http.calls.indexOf(post));

      assert.equal((await store.loadGame(GAME_ID)).synced, true);
      const events = await store.loadGameEvents(GAME_ID);
      assert.deepEqual(
        events.map((event) => event.synced),
        [true, true],
      );
      assert.equal(computeStats(events).points, 2);
      assert.equal(computeStats(events).offensive_rebounds, 1);
    }));

  it("leaves the batch pending when the upload fails", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      const score = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 3,
        created_at: at(1),
      });
      const turnover = await store.saveEvent({
        game_id: GAME_ID,
        type: "TOV",
        created_at: at(2),
      });

      const http = recorded((call) => {
        if (call.method === "POST") return new Response(null, { status: 500 });
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });
      const result = await manager.syncNow();

      assert.equal(result.ok, false);
      assert.equal(puts(http.calls).length, 1);
      assert.equal(posts(http.calls).length, 1);
      assert.equal((await store.loadGame(GAME_ID)).synced, true);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), [score.id, turnover.id]);

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(posts(http.calls).length, 1);
    }));

  it("sends the same batch again on the next trigger after a failure", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      const score = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });
      const empty = await store.saveEvent({
        game_id: GAME_ID,
        type: "EMPTY",
        created_at: at(2),
      });

      let uploads = 0;
      const http = recorded((call) => {
        if (call.method === "POST") {
          uploads += 1;
          if (uploads === 1) throw new TypeError("offline");
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });

      const failed = await manager.syncNow();
      assert.equal(failed.ok, false);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), [score.id, empty.id]);

      const retried = await manager.syncNow();
      assert.equal(retried.ok, true);
      assert.equal(posts(http.calls).length, 2);
      assert.deepEqual(posts(http.calls)[0].body, posts(http.calls)[1].body);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);
    }));

  it("re-uploads a game the server has lost, then retries its events", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      // Synced from this device, and then the row went: a wiped database, a
      // restore from backup. The flag says otherwise, so the batch is refused.
      await store.markGameSynced(GAME_ID);
      const score = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 3,
        created_at: at(1),
      });

      const stored = new Set();
      const http = recorded((call) => {
        if (call.method === "PUT") {
          stored.add(GAME_ID);
          return accepted(call);
        }
        if (!stored.has(GAME_ID)) {
          return Response.json({ error: "Game not found" }, { status: 404 });
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });

      const refused = await manager.syncNow();
      assert.equal(refused.ok, false);
      assert.equal((await store.loadGame(GAME_ID)).synced, false);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), [score.id]);
      // The pass stops there rather than looping, and the game is not re-PUT
      // inside the pass that released it.
      assert.equal(posts(http.calls).length, 1);
      assert.equal(puts(http.calls).length, 0);

      const retried = await manager.syncNow();
      assert.equal(retried.ok, true);
      assert.equal(puts(http.calls).length, 1);
      assert.equal(posts(http.calls).length, 2);
      assert.equal((await store.loadGame(GAME_ID)).synced, true);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);
    }));

  it("does not send a batch that was already synchronized", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      const score = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });
      await store.saveEvent({
        game_id: GAME_ID,
        type: "TOV",
        created_at: at(2),
      });

      const http = recorded((call) => accepted(call));
      const manager = createSyncManager({ store, fetch: http.fetch });
      await manager.syncNow();
      const again = await manager.syncNow();

      assert.equal(again.ok, true);
      assert.equal(puts(http.calls).length, 1);
      assert.equal(posts(http.calls).length, 1);
      assert.equal((await store.loadGameEvents(GAME_ID)).length, 2);
      assert.equal((await store.loadGameEvents(GAME_ID))[0].id, score.id);
      assert.deepEqual(
        (await store.loadGameEvents(GAME_ID)).map((event) => event.synced),
        [true, true],
      );
    }));

  it("posts only the events that are not synced yet", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      const done = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });
      const pending = await store.saveEvent({
        game_id: GAME_ID,
        type: "TOV",
        created_at: at(2),
      });
      const later = await store.saveEvent({
        game_id: GAME_ID,
        type: "DEF_REB",
        created_at: at(3),
      });
      await store.markEventsSynced([done.id]);

      const http = recorded((call) => accepted(call));
      const manager = createSyncManager({ store, fetch: http.fetch });
      await manager.syncNow();

      assert.equal(posts(http.calls).length, 1);
      assert.deepEqual(
        posts(http.calls)[0].body.map((event) => event.id),
        [pending.id, later.id],
      );
      const events = await store.loadGameEvents(GAME_ID);
      assert.equal(events[0].points, 2);
      assert.deepEqual(
        events.map((event) => event.synced),
        [true, true, true],
      );
    }));

  it("posts every pending event for a game in one batch", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure", "2026-10-04T18:00:00.000Z"));
      await store.saveGame(game(OTHER_GAME_ID, "Alba", "2026-10-05T18:00:00.000Z"));
      const first = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });
      const second = await store.saveEvent({
        game_id: GAME_ID,
        type: "OFF_REB",
        created_at: at(2),
      });
      const third = await store.saveEvent({
        game_id: GAME_ID,
        type: "TOV",
        created_at: at(3),
      });
      const otherScore = await store.saveEvent({
        game_id: OTHER_GAME_ID,
        type: "SCORE",
        points: 3,
        created_at: at(4),
      });
      const otherRebound = await store.saveEvent({
        game_id: OTHER_GAME_ID,
        type: "DEF_REB",
        created_at: at(5),
      });

      const http = recorded((call) => accepted(call));
      const manager = createSyncManager({ store, fetch: http.fetch });
      await manager.syncNow();

      assert.deepEqual(
        http.calls.map((call) => call.method),
        ["PUT", "PUT", "POST", "POST"],
      );
      assert.deepEqual(
        posts(http.calls)[0].body.map((event) => event.id),
        [first.id, second.id, third.id],
      );
      assert.equal(posts(http.calls)[0].url, `/api/games/${GAME_ID}/events/sync`);
      assert.deepEqual(
        posts(http.calls)[1].body.map((event) => event.id),
        [otherScore.id, otherRebound.id],
      );
      assert.equal(posts(http.calls)[1].url, `/api/games/${OTHER_GAME_ID}/events/sync`);
      assert.equal(otherScore.points, 3);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);
      assert.deepEqual(await store.pendingEventIds(OTHER_GAME_ID), []);
    }));

  it("keeps a second trigger from overlapping the upload already in flight", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      const first = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });

      const blocked = deferred();
      let active = 0;
      let maxActive = 0;
      const http = recorded(async (call) => {
        if (call.method === "POST" && posts(http.calls).length === 1) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await blocked.opened;
          active -= 1;
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });

      const running = manager.syncNow();
      await waitFor(() => active === 1);
      const overlapping = manager.syncNow();
      const during = await store.saveEvent({
        game_id: GAME_ID,
        type: "TOV",
        created_at: at(2),
      });
      manager.kick();
      assert.equal(active, 1);
      assert.equal(manager.kick(), undefined);

      blocked.open();
      const [firstResult, secondResult] = await Promise.all([running, overlapping]);

      assert.equal(firstResult.ok, true);
      assert.equal(secondResult.ok, true);
      assert.equal(maxActive, 1);
      assert.deepEqual(
        posts(http.calls).map((call) => call.body.map((event) => event.id)),
        [[first.id], [during.id]],
      );
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);
    }));

  it("does not retry a failed pass just because another trigger arrived", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });

      const blocked = deferred();
      let started = 0;
      const http = recorded(async (call) => {
        if (call.method === "POST") {
          started += 1;
          await blocked.opened;
          return new Response(null, { status: 500 });
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });

      const running = manager.syncNow();
      await waitFor(() => started === 1);
      const overlapping = manager.syncNow();
      blocked.open();
      const [firstResult, secondResult] = await Promise.all([running, overlapping]);

      assert.equal(firstResult.ok, false);
      assert.equal(secondResult.ok, false);
      assert.equal(posts(http.calls).length, 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(posts(http.calls).length, 1);
      assert.equal((await store.pendingEventIds(GAME_ID)).length, 1);
    }));

  it("shows a tap that lands during sync without waiting for the upload", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      const first = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });

      const blocked = deferred();
      let posted = false;
      const http = recorded(async (call) => {
        if (call.method === "POST") {
          posted = true;
          await blocked.opened;
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });
      const running = manager.syncNow();
      await waitFor(() => posted);

      const during = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 3,
        created_at: at(2),
      });
      const midway = computeStats(await store.loadGameEvents(GAME_ID));
      assert.equal(midway.points, 5);
      assert.equal(midway.possessions, 2);
      assert.equal(during.synced, false);

      let finished = false;
      running.then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(finished, false);

      blocked.open();
      await running;

      const events = await store.loadGameEvents(GAME_ID);
      assert.equal(events.find((event) => event.id === first.id).synced, true);
      assert.equal(events.find((event) => event.id === first.id).points, 2);
      assert.equal(events.find((event) => event.id === during.id).synced, false);
      assert.equal(events.find((event) => event.id === during.id).points, 3);
      assert.equal(computeStats(events).points, 5);
    }));

  it("keeps a game pending when it changes while the upload is in flight", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });

      const blocked = deferred();
      let putting = false;
      const http = recorded(async (call) => {
        if (call.method === "PUT") {
          putting = true;
          await blocked.opened;
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });
      const running = manager.syncNow();
      await waitFor(() => putting);

      await store.saveGame(game(GAME_ID, "Alba"));
      blocked.open();
      const result = await running;

      assert.equal(result.ok, false);
      assert.equal(puts(http.calls).length, 1);
      assert.equal(puts(http.calls)[0].body.opponent, "Novi Ligure");
      assert.equal(posts(http.calls).length, 0);
      const stored = await store.loadGame(GAME_ID);
      assert.equal(stored.opponent_name, "Alba");
      assert.equal(stored.synced, false);
      assert.equal((await store.pendingEventIds(GAME_ID)).length, 1);
    }));

  it("deletes an event that was undone while its batch was uploading", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      const score = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 3,
        created_at: at(1),
      });

      const blocked = deferred();
      let posted = false;
      const http = recorded(async (call) => {
        if (call.method === "POST") {
          posted = true;
          await blocked.opened;
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });
      const running = manager.syncNow();
      await waitFor(() => posted);
      await store.deleteEvent(score.id);
      blocked.open();
      await running;

      assert.equal(posts(http.calls).length, 1);
      assert.deepEqual(
        deletes(http.calls).map((call) => call.url),
        [`/api/events/${score.id}`],
      );
      const [tombstone] = await store.loadGameEvents(GAME_ID);
      assert.equal(tombstone.deleted, true);
      assert.equal(tombstone.synced, true);
      assert.equal(computeStats(await store.loadGameEvents(GAME_ID)).points, 0);

      await manager.syncNow();
      assert.equal(posts(http.calls).length, 1);
      assert.equal(deletes(http.calls).length, 1);
    }));

  it("leaves a tombstone pending when the delete fails", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      const score = await store.saveEvent({
        game_id: GAME_ID,
        type: "SCORE",
        points: 2,
        created_at: at(1),
      });
      await store.deleteEvent(score.id);

      let deleteAttempts = 0;
      const http = recorded((call) => {
        if (call.method === "DELETE") {
          deleteAttempts += 1;
          if (deleteAttempts === 1) return new Response(null, { status: 500 });
        }
        return accepted(call);
      });
      const manager = createSyncManager({ store, fetch: http.fetch });
      const failed = await manager.syncNow();

      assert.equal(failed.ok, false);
      assert.equal(posts(http.calls).length, 0);
      assert.equal(deletes(http.calls).length, 1);
      assert.deepEqual(
        (await store.pendingDeletions()).map((event) => event.id),
        [score.id],
      );

      const retried = await manager.syncNow();
      assert.equal(retried.ok, true);
      assert.equal(deletes(http.calls).length, 2);
      assert.equal((await store.loadGameEvents(GAME_ID))[0].synced, true);
      assert.deepEqual(await store.pendingDeletions(), []);
    }));

  it("syncs when the browser comes online, when idle, and on the safety tick", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      await store.saveEvent({
        game_id: GAME_ID,
        type: "TOV",
        created_at: at(1),
      });

      const timers = clock();
      const target = new EventTarget();
      const http = recorded((call) => accepted(call));
      const manager = createSyncManager({
        store,
        fetch: http.fetch,
        target,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        requestIdleCallback: timers.requestIdleCallback,
        cancelIdleCallback: timers.cancelIdleCallback,
      });

      manager.start();
      manager.start();
      assert.equal(timers.intervals.length, 1);
      assert.equal(timers.intervals[0].ms, 10_000);
      assert.equal(timers.idle.length, 1);
      assert.equal(http.calls.length, 0);

      target.dispatchEvent(new Event("online"));
      await manager.settled();
      assert.equal(posts(http.calls).length, 1);

      await store.saveEvent({
        game_id: GAME_ID,
        type: "OFF_REB",
        created_at: at(2),
      });
      timers.intervals[0].fn();
      await manager.settled();
      assert.equal(posts(http.calls).length, 2);

      await store.saveEvent({
        game_id: GAME_ID,
        type: "DEF_REB",
        created_at: at(3),
      });
      assert.equal(manager.kick(), undefined);
      assert.equal(timers.idle.length, 1);
      assert.equal(posts(http.calls).length, 2);
      timers.idle[0].fn();
      await manager.settled();
      assert.equal(posts(http.calls).length, 3);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);

      manager.stop();
      assert.equal(timers.intervals.length, 0);
      target.dispatchEvent(new Event("online"));
      await manager.settled();
      assert.equal(posts(http.calls).length, 3);
    }));

  it("falls back to a timer when requestIdleCallback is missing", () =>
    withStore(async (store) => {
      await store.saveGame(game(GAME_ID, "Novi Ligure"));
      await store.markGameSynced(GAME_ID);
      await store.saveEvent({
        game_id: GAME_ID,
        type: "EMPTY",
        created_at: at(1),
      });

      const timers = clock();
      const http = recorded((call) => accepted(call));
      const manager = createSyncManager({
        store,
        fetch: http.fetch,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        requestIdleCallback: undefined,
        cancelIdleCallback: undefined,
      });

      manager.kick();
      manager.kick();
      assert.equal(timers.timeouts.length, 1);
      assert.equal(timers.timeouts[0].ms, 0);
      assert.equal(timers.idle.length, 0);
      assert.equal(http.calls.length, 0);

      timers.timeouts[0].fn();
      await manager.settled();
      assert.equal(posts(http.calls).length, 1);
      assert.deepEqual(await store.pendingEventIds(GAME_ID), []);
      manager.stop();
    }));

  it("deletes an event another tab removed before this post lands", async () => {
    const indexedDB = new IDBFactory();
    const storeA = createLocalStore({ indexedDB, IDBKeyRange });
    const storeB = createLocalStore({ indexedDB, IDBKeyRange });
    await storeA.saveGame(game(GAME_ID, "Novi Ligure"));
    await storeA.markGameSynced(GAME_ID);
    const score = await storeA.saveEvent({
      game_id: GAME_ID,
      type: "SCORE",
      points: 2,
      created_at: at(1),
    });

    const blocked = deferred();
    let posted = false;
    const calls = [];
    const fetchA = async (url, options = {}) => {
      if (options.method === "POST") {
        posted = true;
        await blocked.opened;
      }
      calls.push({ tab: "A", method: options.method, url: String(url) });
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ synced: 1 }, { status: 200 });
    };
    const fetchB = async (url, options = {}) => {
      calls.push({ tab: "B", method: options.method, url: String(url) });
      return new Response(null, { status: 204 });
    };

    const managerA = createSyncManager({ store: storeA, fetch: fetchA });
    const running = managerA.syncNow();
    await waitFor(() => posted);

    await storeB.deleteEvent(score.id);
    const managerB = createSyncManager({ store: storeB, fetch: fetchB });
    await managerB.syncNow();
    const [before] = await storeA.loadGameEvents(GAME_ID);
    assert.equal(before.deleted, true);
    assert.equal(before.synced, true);

    blocked.open();
    const result = await running;

    assert.equal(result.ok, true);
    const postIndex = calls.findIndex((call) => call.tab === "A" && call.method === "POST");
    const deleteIndex = calls.findIndex((call) => call.tab === "A" && call.method === "DELETE");
    assert.ok(postIndex >= 0);
    assert.ok(deleteIndex > postIndex);
    const [tombstone] = await storeA.loadGameEvents(GAME_ID);
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.synced, true);
    assert.deepEqual(await storeA.forcedDeleteIds(), []);
    assert.deepEqual(await storeA.pendingDeletions(), []);
    assert.equal(computeStats(await storeA.loadGameEvents(GAME_ID)).points, 0);

    await managerA.syncNow();
    assert.equal(calls.filter((call) => call.tab === "A" && call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 2);
  });

  it("retries a raced delete after the other tab marks the tombstone synced", async () => {
    const indexedDB = new IDBFactory();
    const storeA = createLocalStore({ indexedDB, IDBKeyRange });
    const storeB = createLocalStore({ indexedDB, IDBKeyRange });
    await storeA.saveGame(game(GAME_ID, "Novi Ligure"));
    await storeA.markGameSynced(GAME_ID);
    const score = await storeA.saveEvent({
      game_id: GAME_ID,
      type: "SCORE",
      points: 3,
      created_at: at(1),
    });

    const blocked = deferred();
    let posted = false;
    let deletesFromA = 0;
    const fetchA = async (_url, options = {}) => {
      if (options.method === "POST") {
        posted = true;
        await blocked.opened;
        return Response.json({ synced: 1 });
      }
      deletesFromA += 1;
      if (deletesFromA === 1) return new Response(null, { status: 500 });
      return new Response(null, { status: 204 });
    };

    const managerA = createSyncManager({ store: storeA, fetch: fetchA });
    const running = managerA.syncNow();
    await waitFor(() => posted);
    await storeB.deleteEvent(score.id);
    await storeB.markDeletionsSynced([score.id]);
    blocked.open();
    const failed = await running;

    assert.equal(failed.ok, false);
    assert.equal(deletesFromA, 1);
    assert.deepEqual(await storeA.forcedDeleteIds(), [score.id]);
    await storeB.markDeletionsSynced([score.id]);
    assert.equal((await storeA.loadGameEvents(GAME_ID))[0].synced, true);

    const retried = await managerA.syncNow();
    assert.equal(retried.ok, true);
    assert.equal(deletesFromA, 2);
    assert.deepEqual(await storeA.forcedDeleteIds(), []);
    assert.equal((await storeA.loadGameEvents(GAME_ID))[0].synced, true);
    assert.equal((await storeA.loadGameEvents(GAME_ID))[0].deleted, true);
  });
});
