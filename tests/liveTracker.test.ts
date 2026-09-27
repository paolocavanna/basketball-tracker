import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  commitTap,
  commitUndo,
  formatPpp,
  isPending,
  mergeStoredEvents,
} from "../frontend/src/lib/liveLog.ts";
import { createLocalStore } from "../frontend/src/lib/localStore.ts";
import { parseRoute, livePath, summaryPath } from "../frontend/src/lib/route.ts";
import { computeStats } from "../frontend/src/lib/stats.ts";
import { createSyncManager } from "../frontend/src/lib/syncManager.ts";
import { SEEDED_TEAM_ID, loadTeamId } from "../frontend/src/lib/team.ts";
import type { EventPayload, EventType, NewStoredEvent, StoredEvent, StoredGame } from "../types.ts";

const GAME_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function game(opponent = "Novi Ligure"): StoredGame {
  return {
    id: GAME_ID,
    team_id: 1,
    date: "2026-10-04",
    opponent_name: opponent,
    created_at: "2026-10-04T18:00:00.000Z",
    synced: false,
  };
}

function event(
  id: string,
  type: EventType,
  points: number,
  extras: Partial<Pick<StoredEvent, "synced" | "deleted" | "created_at">> = {},
): StoredEvent {
  let payload: EventPayload;
  if (type === "SCORE") {
    if (points !== 2 && points !== 3) throw new Error("Score points must be 2 or 3");
    payload = { type, points };
  } else {
    payload = { type, points: 0 };
  }
  return {
    id,
    game_id: GAME_ID,
    ...payload,
    created_at: `2026-10-04T10:00:0${id}.000Z`,
    synced: false,
    deleted: false,
    ...extras,
  };
}

function materializeEvent(row: NewStoredEvent): StoredEvent {
  let payload: EventPayload;
  if (row.type === "SCORE") {
    if (row.points !== 2 && row.points !== 3) throw new Error("Score points must be 2 or 3");
    payload = { type: row.type, points: row.points };
  } else {
    payload = { type: row.type, points: 0 };
  }
  return {
    ...payload,
    id: row.id ?? "test-event",
    game_id: row.game_id,
    created_at: row.created_at ?? "2026-10-04T10:00:00.000Z",
    synced: false,
    deleted: false,
  };
}

function deferred() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function clock() {
  const idle: Array<{ fn: () => void }> = [];
  return {
    idle,
    setInterval(_fn: () => void) {
      return { fn() {} };
    },
    clearInterval(_handle: unknown) {},
    setTimeout(fn: () => void) {
      return { fn };
    },
    clearTimeout(_handle: unknown) {},
    requestIdleCallback(fn: () => void) {
      const handle = { fn };
      idle.push(handle);
      return handle;
    },
    cancelIdleCallback(_handle: unknown) {},
  };
}

describe("live route", () => {
  it("reads the bench path, the dashboard, and leaves unknown paths on the start screen", () => {
    assert.deepEqual(parseRoute(`/game/${GAME_ID}/live`), { name: "live", gameId: GAME_ID });
    assert.deepEqual(parseRoute(`/game/${GAME_ID}/live/`), { name: "live", gameId: GAME_ID });
    assert.deepEqual(parseRoute("/"), { name: "start" });
    assert.deepEqual(parseRoute("/dashboard"), { name: "dashboard" });
    assert.deepEqual(parseRoute("/dashboard/"), { name: "dashboard" });
    assert.deepEqual(parseRoute("/missing"), { name: "start" });
    assert.deepEqual(parseRoute(`/game/${GAME_ID}/summary`), {
      name: "summary",
      gameId: GAME_ID,
    });
    assert.deepEqual(parseRoute(`/game/${GAME_ID}/summary/`), {
      name: "summary",
      gameId: GAME_ID,
    });
    assert.equal(livePath(GAME_ID), `/game/${GAME_ID}/live`);
    assert.equal(summaryPath(GAME_ID), `/game/${GAME_ID}/summary`);
  });

  it("uses the seeded team when the team list cannot be read", async () => {
    assert.equal(
      await loadTeamId(async () => {
        throw new Error("offline");
      }),
      SEEDED_TEAM_ID,
    );
    assert.equal(
      await loadTeamId(async () => ({ ok: false, json: async () => null })),
      SEEDED_TEAM_ID,
    );
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
      saveEvent(row: NewStoredEvent) {
        return gate.opened.then(() => materializeEvent(row));
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
      payload: { type: "SCORE", points: 2 },
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
    const pending: Array<ReturnType<typeof deferred>> = [];
    const store = {
      saveEvent(row: NewStoredEvent) {
        const gate = deferred();
        pending.push(gate);
        return gate.opened.then(() => materializeEvent(row));
      },
    };
    let events: StoredEvent[] = [];
    events = commitTap({
      store,
      sync: { kick() {} },
      gameId: GAME_ID,
      payload: { type: "SCORE", points: 2 },
      events,
      clock: { now: () => "2026-10-04T10:00:01.000Z", newId: () => "a" },
    }).events;
    events = commitTap({
      store,
      sync: { kick() {} },
      gameId: GAME_ID,
      payload: { type: "SCORE", points: 3 },
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
    const deleted: string[] = [];
    let kicks = 0;
    const events = [
      event("1", "SCORE", 2, { synced: true }),
      event("2", "OFF_REB", 0, { synced: true }),
    ];
    const result = commitUndo({
      store: {
        deleteEvent(id) {
          deleted.push(id);
          const undone = events[1];
          assert.ok(undone);
          return Promise.resolve(undone);
        },
      },
      sync: {
        kick() {
          kicks += 1;
        },
      },
      events,
    });

    assert.ok(result.undone);
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
      payload: { type: "SCORE", points: 2 },
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
        saveEvent(row: NewStoredEvent) {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("aborted"));
          return Promise.resolve(materializeEvent(row));
        },
      },
      sync: {
        kick() {
          kicks += 1;
        },
      },
      gameId: GAME_ID,
      payload: { type: "TOV", points: 0 },
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
    const last = merged.findLast((row) => !row.deleted);
    assert.ok(last);
    assert.equal(last.type, "TOV");
  });
});

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(body) as unknown;
}

describe("bench sync", { concurrency: false }, () => {
  it("updates the tally while a hung batch is outstanding and retries nothing on its own", async () => {
    const store = createLocalStore({ indexedDB: new IDBFactory(), IDBKeyRange });
    await store.saveGame(game());
    await store.markGameSynced(GAME_ID, game());

    const timers = clock();
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<{ url: string; method: string | undefined }> = [];
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
      payload: { type: "SCORE", points: 2 },
      events: [],
    });
    assert.equal(computeStats(tapped.events).points, 2);
    assert.equal(calls.length, 0);

    await tapped.persisted;
    assert.equal(timers.idle.length, 1);
    assert.equal(calls.length, 0);

    const firstIdle = timers.idle[0];
    assert.ok(firstIdle);
    firstIdle.fn();
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(calls.length, 1);
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.method, "POST");
    assert.equal(firstCall.url, `/api/games/${GAME_ID}/events/sync`);

    const during = commitTap({
      store,
      sync,
      gameId: GAME_ID,
      payload: { type: "TOV", points: 0 },
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
        const body = parseRequestBody(options.body);
        if (!Array.isArray(body)) throw new Error("Expected an event batch");
        return Promise.resolve(Response.json({ synced: body.length }));
      },
      ...timers,
    });

    const first = commitTap({
      store,
      sync,
      gameId: GAME_ID,
      payload: { type: "SCORE", points: 3 },
      events: [],
    });
    await first.persisted;
    const firstIdle = timers.idle[0];
    assert.ok(firstIdle);
    firstIdle.fn();
    await sync.settled();

    const second = commitTap({
      store,
      sync,
      gameId: GAME_ID,
      payload: { type: "DEF_REB", points: 0 },
      events: first.events,
    });
    const merged = mergeStoredEvents(second.events, await store.loadGameEvents(GAME_ID));
    const stats = computeStats(merged);
    assert.equal(stats.points, 3);
    assert.equal(stats.defensive_rebounds, 1);
    const score = merged.find((row) => row.type === "SCORE");
    const rebound = merged.find((row) => row.type === "DEF_REB");
    assert.ok(score);
    assert.ok(rebound);
    assert.equal(score.synced, true);
    assert.equal(rebound.synced, false);
    assert.equal(isPending({ synced: true }, merged), true);
  });
});
