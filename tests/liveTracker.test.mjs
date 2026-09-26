import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  commitTap,
  commitUndo,
  formatPpp,
  isPending,
  mergeStoredEvents,
} from "../frontend/src/lib/liveLog.js";
import { createLocalStore } from "../frontend/src/lib/localStore.js";
import { parseRoute, livePath } from "../frontend/src/lib/route.js";
import { computeStats } from "../frontend/src/lib/stats.js";
import { createSyncManager } from "../frontend/src/lib/syncManager.js";
import { SEEDED_TEAM_ID, loadTeamId } from "../frontend/src/lib/team.js";

const GAME_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function game(opponent = "Novi Ligure") {
  return {
    id: GAME_ID,
    team_id: 1,
    date: "2026-10-04",
    opponent_name: opponent,
    created_at: "2026-10-04T18:00:00.000Z",
  };
}

function event(id, type, points, extras = {}) {
  return {
    id,
    game_id: GAME_ID,
    type,
    points,
    created_at: `2026-10-04T10:00:0${id}.000Z`,
    synced: false,
    deleted: false,
    ...extras,
  };
}

function deferred() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function clock() {
  const idle = [];
  return {
    idle,
    setInterval() {
      return { fn() {} };
    },
    clearInterval() {},
    setTimeout(fn) {
      return { fn };
    },
    clearTimeout() {},
    requestIdleCallback(fn) {
      const handle = { fn };
      idle.push(handle);
      return handle;
    },
    cancelIdleCallback() {},
  };
}

describe("live route", () => {
  it("reads the bench path and leaves unknown paths on the start screen", () => {
    assert.deepEqual(parseRoute(`/game/${GAME_ID}/live`), { name: "live", gameId: GAME_ID });
    assert.deepEqual(parseRoute(`/game/${GAME_ID}/live/`), { name: "live", gameId: GAME_ID });
    assert.deepEqual(parseRoute("/"), { name: "start" });
    assert.deepEqual(parseRoute("/missing"), { name: "start" });
    assert.equal(livePath(GAME_ID), `/game/${GAME_ID}/live`);
  });

  it("uses the seeded team when the team list cannot be read", async () => {
    assert.equal(
      await loadTeamId(async () => {
        throw new Error("offline");
      }),
      SEEDED_TEAM_ID,
    );
    assert.equal(await loadTeamId(async () => ({ ok: false })), SEEDED_TEAM_ID);
    assert.equal(
      await loadTeamId(async () => ({
        ok: true,
        json: async () => [{ id: 4, name: "Campus Monferrato", category: "U13" }],
      })),
      4,
    );
  });
});

describe("bench log", () => {
  it("formats PPP and treats a scoreless log as pending until the game is synced", () => {
    assert.equal(formatPpp(null), "-");
    assert.equal(formatPpp(1.5), "1.50");
    assert.equal(isPending({ synced: false }, []), true);
    assert.equal(isPending({ synced: true }, [event("1", "SCORE", 2, { synced: true })]), false);
    assert.equal(isPending({ synced: true }, [event("1", "SCORE", 2, { deleted: true })]), true);
  });

  it("shows a tap in the tally before the local write finishes and without a network call", async () => {
    const gate = deferred();
    let kicks = 0;
    const store = {
      saveEvent(row) {
        return gate.opened.then(() => row);
      },
    };
    const result = commitTap({
      store,
      sync: {
        kick() {
          kicks += 1;
        },
      },
      gameId: GAME_ID,
      type: "SCORE",
      points: 2,
      events: [],
      clock: { now: () => "2026-10-04T10:00:01.000Z", newId: () => "score-1" },
    });

    assert.equal(computeStats(result.events).points, 2);
    assert.equal(computeStats(result.events).possessions, 1);
    assert.equal(kicks, 0);

    let settled = false;
    void result.persisted.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);

    gate.open();
    const outcome = await result.persisted;
    assert.equal(outcome.ok, true);
    assert.equal(kicks, 1);
    assert.equal(outcome.event.points, 2);
  });

  it("keeps every rapid tap in the tally while each write is still queued", async () => {
    const pending = [];
    const store = {
      saveEvent(row) {
        const gate = deferred();
        pending.push(gate);
        return gate.opened.then(() => row);
      },
    };
    let events = [];
    events = commitTap({
      store,
      sync: { kick() {} },
      gameId: GAME_ID,
      type: "SCORE",
      points: 2,
      events,
      clock: { now: () => "2026-10-04T10:00:01.000Z", newId: () => "a" },
    }).events;
    events = commitTap({
      store,
      sync: { kick() {} },
      gameId: GAME_ID,
      type: "SCORE",
      points: 3,
      events,
      clock: { now: () => "2026-10-04T10:00:02.000Z", newId: () => "b" },
    }).events;

    const stats = computeStats(events);
    assert.equal(stats.points, 5);
    assert.equal(stats.possessions, 2);
    assert.equal(pending.length, 0);

    await Promise.resolve();
    assert.equal(pending.length, 2);
  });

  it("drops the latest tap immediately, including one that already synced", async () => {
    const deleted = [];
    let kicks = 0;
    const events = [
      event("1", "SCORE", 2, { synced: true }),
      event("2", "OFF_REB", 0, { synced: true }),
    ];
    const result = commitUndo({
      store: {
        deleteEvent(id) {
          deleted.push(id);
          return Promise.resolve(events[1]);
        },
      },
      sync: {
        kick() {
          kicks += 1;
        },
      },
      events,
    });

    assert.equal(result.undone.id, "2");
    assert.equal(result.events[1].deleted, true);
    assert.equal(computeStats(result.events).offensive_rebounds, 0);
    assert.equal(computeStats(result.events).possessions, 1);
    assert.equal(kicks, 0);
    await result.persisted;
    assert.deepEqual(deleted, ["2"]);
    assert.equal(kicks, 1);
  });

  it("retries a local save once and does not kick when both writes fail", async () => {
    let attempts = 0;
    let kicks = 0;
    const result = commitTap({
      store: {
        saveEvent() {
          attempts += 1;
          return Promise.reject(new Error("quota"));
        },
      },
      sync: {
        kick() {
          kicks += 1;
        },
      },
      gameId: GAME_ID,
      type: "SCORE",
      points: 2,
      events: [],
      clock: { now: () => "2026-10-04T10:00:01.000Z", newId: () => "score-1" },
    });

    assert.equal(computeStats(result.events).points, 2);
    const outcome = await result.persisted;
    assert.equal(attempts, 2);
    assert.equal(outcome.ok, false);
    assert.equal(kicks, 0);
  });

  it("keeps a tap when the first local write fails and the retry succeeds", async () => {
    let attempts = 0;
    let kicks = 0;
    const result = commitTap({
      store: {
        saveEvent(row) {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("aborted"));
          return Promise.resolve(row);
        },
      },
      sync: {
        kick() {
          kicks += 1;
        },
      },
      gameId: GAME_ID,
      type: "TOV",
      points: 0,
      events: [],
      clock: { now: () => "2026-10-04T10:00:01.000Z", newId: () => "tov-1" },
    });

    const outcome = await result.persisted;
    assert.equal(attempts, 2);
    assert.equal(outcome.ok, true);
    assert.equal(kicks, 1);
  });

  it("leaves a failed undo in place when the local delete itself fails", async () => {
    const events = [event("1", "TOV", 0)];
    const result = commitUndo({
      store: {
        deleteEvent() {
          return Promise.reject(new Error("quota"));
        },
      },
      sync: {
        kick() {
          throw new Error("kick should wait for the delete");
        },
      },
      events,
    });
    assert.equal(result.events[0].deleted, true);
    const outcome = await result.persisted;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.event.deleted, false);
  });

  it("keeps an uncommitted tap and a local undo ahead of a stale store snapshot", () => {
    const local = [event("1", "SCORE", 2, { deleted: true }), event("2", "SCORE", 3)];
    const stored = [
      event("1", "SCORE", 2, { synced: true }),
      event("3", "EMPTY", 0, { synced: true, created_at: "2026-10-04T10:00:09.000Z" }),
    ];
    const merged = mergeStoredEvents(local, stored);
    assert.deepEqual(
      merged.map((row) => [row.id, row.deleted, row.synced]),
      [
        ["1", true, false],
        ["2", false, false],
        ["3", false, true],
      ],
    );
    assert.equal(computeStats(merged).points, 3);
    assert.equal(computeStats(merged).possessions, 2);
  });

  it("keeps tap order when two taps share a timestamp and their ids would sort the other way", () => {
    const createdAt = "2026-10-04T10:00:01.000Z";
    const local = [
      event("b", "SCORE", 2, { created_at: createdAt }),
      event("a", "TOV", 0, { created_at: createdAt }),
    ];
    const stored = local.map((row) => ({ ...row, synced: true }));
    const merged = mergeStoredEvents(local, stored);
    assert.deepEqual(
      merged.map((row) => row.id),
      ["b", "a"],
    );
    assert.equal(merged.findLast((row) => !row.deleted).type, "TOV");
  });
});

describe("bench sync", { concurrency: false }, () => {
  it("updates the tally while a hung batch is outstanding and retries nothing on its own", async () => {
    const store = createLocalStore({ indexedDB: new IDBFactory(), IDBKeyRange });
    await store.saveGame(game());
    await store.markGameSynced(GAME_ID, game());

    const timers = clock();
    let release = () => {};
    const hung = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    let settled = 0;
    const sync = createSyncManager({
      store,
      fetch(url, options = {}) {
        calls.push({ url: String(url), method: options.method });
        return hung.then(() => new Response(null, { status: 500 }));
      },
      onSettled() {
        settled += 1;
      },
      ...timers,
    });

    const tapped = commitTap({
      store,
      sync,
      gameId: GAME_ID,
      type: "SCORE",
      points: 2,
      events: [],
    });
    assert.equal(computeStats(tapped.events).points, 2);
    assert.equal(calls.length, 0);

    await tapped.persisted;
    assert.equal(timers.idle.length, 1);
    assert.equal(calls.length, 0);

    timers.idle[0].fn();
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `/api/games/${GAME_ID}/events/sync`);

    const during = commitTap({
      store,
      sync,
      gameId: GAME_ID,
      type: "TOV",
      points: 0,
      events: tapped.events,
    });
    assert.equal(computeStats(during.events).turnovers, 1);
    assert.equal(computeStats(during.events).possessions, 2);
    assert.equal(calls.length, 1);

    release();
    const result = await sync.settled();
    assert.equal(result.ok, false);
    assert.equal(settled, 1);
    assert.equal(calls.length, 1);
    assert.equal(
      (await store.loadGameEvents(GAME_ID)).some((row) => row.type === "SCORE"),
      true,
    );
    assert.equal((await store.pendingEventIds(GAME_ID)).length >= 1, true);
  });

  it("marks only the saved batch and leaves a newer tap pending", async () => {
    const store = createLocalStore({ indexedDB: new IDBFactory(), IDBKeyRange });
    await store.saveGame(game());
    await store.markGameSynced(GAME_ID, game());
    const timers = clock();
    const sync = createSyncManager({
      store,
      fetch(_url, options = {}) {
        const body = JSON.parse(options.body);
        return Response.json({ synced: body.length });
      },
      ...timers,
    });

    const first = commitTap({
      store,
      sync,
      gameId: GAME_ID,
      type: "SCORE",
      points: 3,
      events: [],
    });
    await first.persisted;
    timers.idle[0].fn();
    await sync.settled();

    const second = commitTap({
      store,
      sync,
      gameId: GAME_ID,
      type: "DEF_REB",
      points: 0,
      events: first.events,
    });
    const merged = mergeStoredEvents(second.events, await store.loadGameEvents(GAME_ID));
    const stats = computeStats(merged);
    assert.equal(stats.points, 3);
    assert.equal(stats.defensive_rebounds, 1);
    assert.equal(merged.find((row) => row.type === "SCORE").synced, true);
    assert.equal(merged.find((row) => row.type === "DEF_REB").synced, false);
    assert.equal(isPending({ synced: true }, merged), true);
  });
});
