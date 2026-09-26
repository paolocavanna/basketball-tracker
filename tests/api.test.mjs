import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { closeDb, getDb } from "../lib/db.js";
import { onRequestDelete } from "../functions/api/events/[id].js";
import { onRequestGet as onRequestGameGet, onRequestPut } from "../functions/api/games/[id].js";
import { onRequestGet as onRequestGamesGet } from "../functions/api/games/index.js";
import { onRequestPost as onRequestSync } from "../functions/api/games/[id]/events/sync.js";
import { onRequestGet as onRequestSeason } from "../functions/api/stats/season.js";
import { onRequestGet as onRequestTeams } from "../functions/api/teams.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("games and events API", { concurrency: false }, () => {
  let env;
  let dir;

  async function call(handler, { url, params = {}, body }) {
    const method =
      handler === onRequestPut
        ? "PUT"
        : handler === onRequestDelete
          ? "DELETE"
          : handler === onRequestSync
            ? "POST"
            : "GET";
    const response = await handler({
      request: new Request(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      params,
      env,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bball-"));
    const url = `file:${join(dir, "test.db")}`;
    env = { TURSO_DATABASE_URL: url };
    const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
    const setup = createClient({ url, intMode: "number" });
    await setup.executeMultiple(schema);
    setup.close();
  });

  afterEach(() => {
    closeDb(env);
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds Campus Monferrato U13 and the required indexes", async () => {
    const response = await call(onRequestTeams, { url: "http://localhost/api/teams" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [
      {
        id: 1,
        name: "Campus Monferrato",
        category: "U13",
        slug: "campus-monferrato-u13",
      },
    ]);

    const db = getDb(env);
    const objects = await db.execute(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
    );
    const names = objects.rows.map((row) => row.name);
    for (const name of ["teams", "games", "events", "idx_games_team_id", "idx_events_game_id"]) {
      assert.ok(names.includes(name), name);
    }
    const eventsSql = await db.execute("SELECT sql FROM sqlite_master WHERE name = 'events'");
    assert.match(eventsSql.rows[0].sql, /ON DELETE CASCADE/);
    assert.match(eventsSql.rows[0].sql, /CHECK/);
  });

  it("rejects rows the statistics rules do not allow", async () => {
    const db = getDb(env);
    const gameId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO games (id, team_id, date, opponent_name, created_at)
            VALUES (?, 1, '2026-10-04', 'Novi', '2026-10-04T09:00:00.000Z')`,
      args: [gameId],
    });

    await assert.rejects(() => insertEvent(db, gameId, "SCORE", 0), /CHECK constraint/);
    await assert.rejects(() => insertEvent(db, gameId, "SCORE", 1), /CHECK constraint/);
    await assert.rejects(() => insertEvent(db, gameId, "TOV", 2), /CHECK constraint/);
    await assert.rejects(() => insertEvent(db, gameId, "MISS", 0), /CHECK constraint/);
    await assert.rejects(
      () =>
        db.execute({
          sql: `INSERT INTO games (id, team_id, date, opponent_name, created_at)
              VALUES (?, 99, '2026-10-04', 'Ghost', '2026-10-04T09:00:00.000Z')`,
          args: [crypto.randomUUID()],
        }),
      /FOREIGN KEY/,
    );

    await insertEvent(db, gameId, "OFF_REB", 0);
    await insertEvent(db, gameId, "DEF_REB", 0);
    await db.execute({ sql: "DELETE FROM games WHERE id = ?", args: [gameId] });
    const remaining = await db.execute("SELECT COUNT(*) AS n FROM events");
    assert.equal(Number(remaining.rows[0].n), 0);
  });

  it("creates a game once and ignores a repeated put", async () => {
    const id = crypto.randomUUID();
    const first = await putGame(id, { opponent: "Novi Ligure", final_score_for: 42 });
    assert.equal(first.status, 201);
    assert.equal(first.body.opponent_name, "Novi Ligure");
    assert.equal(first.body.final_score_for, 42);
    assert.equal(first.body.team_id, 1);
    assert.equal(first.body.created_at, "2026-10-04T18:00:00.000Z");

    const second = await putGame(id, {
      opponent: "Someone else",
      created_at: "2026-10-05T18:00:00.000Z",
      final_score_for: 10,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.opponent_name, "Novi Ligure");
    assert.equal(second.body.final_score_for, 42);
    assert.equal(second.body.created_at, "2026-10-04T18:00:00.000Z");

    const count = await getDb(env).execute("SELECT COUNT(*) AS n FROM games");
    assert.equal(Number(count.rows[0].n), 1);
  });

  it("rejects a game for an unknown team or a mismatched id", async () => {
    const id = crypto.randomUUID();
    const missingTeam = await putGame(id, { team_id: 9 });
    assert.equal(missingTeam.status, 404);

    const mismatch = await putGame(id, { id: crypto.randomUUID() });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, "id must match the URL");
  });

  it("lists and aggregates only the requested team", async () => {
    const db = getDb(env);
    await db.execute(
      "INSERT INTO teams (name, category, slug) VALUES ('Other', 'U14', 'other-u14')",
    );
    const ours = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    await putGame(ours, { opponent: "Novi", date: "2026-10-04" });
    await putGame(theirs, { opponent: "Away", date: "2026-10-02", team_id: 2 });
    await sync(ours, [tap("SCORE", 2, "2026-10-04T10:00:00.000Z")]);
    await sync(theirs, [tap("SCORE", 3, "2026-10-02T10:00:00.000Z")]);

    const missing = await call(onRequestGamesGet, { url: "http://localhost/api/games" });
    assert.equal(missing.status, 400);

    const unknown = await call(onRequestGamesGet, {
      url: "http://localhost/api/games?team_id=99",
    });
    assert.equal(unknown.status, 404);

    const list = await call(onRequestGamesGet, {
      url: "http://localhost/api/games?team_id=1",
    });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.map((game) => game.opponent_name),
      ["Novi"],
    );
    assert.equal(list.body[0].stats.points, 2);
    assert.equal(list.body[0].stats.possessions, 1);

    const season = await call(onRequestSeason, {
      url: "http://localhost/api/stats/season?team_id=1",
    });
    assert.equal(season.status, 200);
    assert.equal(season.body.team_id, 1);
    assert.equal(season.body.games.length, 1);
    assert.equal(season.body.totals.points, 2);
    assert.equal(season.body.totals.possessions, 1);
    assert.equal(season.body.totals.points_per_possession, 2);
  });

  it("counts possession-ending events and leaves rebounds out of the possession total", async () => {
    const id = crypto.randomUUID();
    await putGame(id);
    const events = [
      tap("SCORE", 2, "2026-10-04T10:00:00.000Z"),
      tap("OFF_REB", 0, "2026-10-04T10:01:00.000Z"),
      tap("SCORE", 3, "2026-10-04T10:02:00.000Z"),
      tap("EMPTY", 0, "2026-10-04T10:03:00.000Z"),
      tap("DEF_REB", 0, "2026-10-04T10:04:00.000Z"),
      tap("TOV", 0, "2026-10-04T10:05:00.000Z"),
      tap("OFF_REB", 0, "2026-10-04T10:06:00.000Z"),
    ];
    const synced = await sync(id, events);
    assert.equal(synced.status, 200);
    assert.equal(synced.body.synced, 7);

    const detail = await call(onRequestGameGet, {
      url: `http://localhost/api/games/${id}`,
      params: { id },
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(
      detail.body.events.map((event) => event.type),
      ["SCORE", "OFF_REB", "SCORE", "EMPTY", "DEF_REB", "TOV", "OFF_REB"],
    );
    assert.deepEqual(detail.body.stats, {
      points: 5,
      possessions: 4,
      points_per_possession: 1.25,
      offensive_rebounds: 2,
      defensive_rebounds: 1,
      turnovers: 1,
    });
  });

  it("returns null points per possession when a game has no possession-ending event", async () => {
    const id = crypto.randomUUID();
    await putGame(id);
    await sync(id, [
      tap("OFF_REB", 0, "2026-10-04T10:00:00.000Z"),
      tap("DEF_REB", 0, "2026-10-04T10:01:00.000Z"),
    ]);
    const detail = await call(onRequestGameGet, {
      url: `http://localhost/api/games/${id}`,
      params: { id },
    });
    assert.deepEqual(detail.body.stats, {
      points: 0,
      possessions: 0,
      points_per_possession: null,
      offensive_rebounds: 1,
      defensive_rebounds: 1,
      turnovers: 0,
    });
  });

  it("does not duplicate events when the same batch is synced again", async () => {
    const id = crypto.randomUUID();
    await putGame(id);
    const batch = [
      tap("SCORE", 2, "2026-10-04T10:00:00.000Z"),
      tap("TOV", 0, "2026-10-04T10:01:00.000Z"),
    ];
    const first = await sync(id, batch);
    const second = await sync(id, batch);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.synced, 2);

    const count = await getDb(env).execute({
      sql: "SELECT COUNT(*) AS n FROM events WHERE game_id = ?",
      args: [id],
    });
    assert.equal(Number(count.rows[0].n), 2);

    const detail = await call(onRequestGameGet, {
      url: `http://localhost/api/games/${id}`,
      params: { id },
    });
    assert.equal(detail.body.stats.possessions, 2);
    assert.equal(detail.body.stats.points, 2);
    assert.equal(detail.body.stats.turnovers, 1);
  });

  it("rejects an invalid event without writing the rest of the batch", async () => {
    const id = crypto.randomUUID();
    await putGame(id);
    const response = await sync(id, [
      tap("SCORE", 2, "2026-10-04T10:00:00.000Z"),
      tap("TOV", 2, "2026-10-04T10:01:00.000Z"),
      tap("EMPTY", 0, "2026-10-04T10:02:00.000Z"),
    ]);
    assert.equal(response.status, 400);
    assert.match(response.body.error, /TOV points must be 0/);

    const badScore = await sync(id, [tap("SCORE", 1, "2026-10-04T10:03:00.000Z")]);
    assert.equal(badScore.status, 400);
    assert.match(badScore.body.error, /SCORE points must be 2 or 3/);

    const count = await getDb(env).execute("SELECT COUNT(*) AS n FROM events");
    assert.equal(Number(count.rows[0].n), 0);
  });

  it("rejects a reused event id whose payload changed", async () => {
    const id = crypto.randomUUID();
    await putGame(id);
    const original = tap("SCORE", 2, "2026-10-04T10:00:00.000Z");
    assert.equal((await sync(id, [original])).status, 200);

    const changed = { ...original, points: 3 };
    const response = await sync(id, [changed]);
    assert.equal(response.status, 409);

    const detail = await call(onRequestGameGet, {
      url: `http://localhost/api/games/${id}`,
      params: { id },
    });
    assert.equal(detail.body.events[0].points, 2);
    assert.equal(detail.body.stats.points, 2);
  });

  it("removes an undone event from the statistics and treats a second delete as success", async () => {
    const id = crypto.randomUUID();
    await putGame(id);
    const score = tap("SCORE", 2, "2026-10-04T10:00:00.000Z");
    const rebound = tap("DEF_REB", 0, "2026-10-04T10:01:00.000Z");
    await sync(id, [score, rebound]);

    const deleted = await call(onRequestDelete, {
      url: `http://localhost/api/events/${score.id}`,
      params: { id: score.id },
    });
    assert.equal(deleted.status, 204);
    assert.equal(deleted.body, null);

    const again = await call(onRequestDelete, {
      url: `http://localhost/api/events/${score.id}`,
      params: { id: score.id },
    });
    assert.equal(again.status, 204);

    const detail = await call(onRequestGameGet, {
      url: `http://localhost/api/games/${id}`,
      params: { id },
    });
    assert.deepEqual(detail.body.stats, {
      points: 0,
      possessions: 0,
      points_per_possession: null,
      offensive_rebounds: 0,
      defensive_rebounds: 1,
      turnovers: 0,
    });
  });

  it("aggregates season points per possession across games in date order", async () => {
    const later = crypto.randomUUID();
    const earlier = crypto.randomUUID();
    await putGame(later, {
      opponent: "Later",
      date: "2026-10-11",
      created_at: "2026-10-11T18:00:00.000Z",
    });
    await putGame(earlier, {
      opponent: "Earlier",
      date: "2026-10-04",
      created_at: "2026-10-04T18:00:00.000Z",
    });
    await sync(earlier, [tap("SCORE", 2, "2026-10-04T10:00:00.000Z")]);
    await sync(later, [
      tap("SCORE", 3, "2026-10-11T10:00:00.000Z"),
      tap("EMPTY", 0, "2026-10-11T10:01:00.000Z"),
      tap("TOV", 0, "2026-10-11T10:02:00.000Z"),
    ]);

    const season = await call(onRequestSeason, {
      url: "http://localhost/api/stats/season?team_id=1",
    });
    assert.deepEqual(
      season.body.games.map((game) => game.opponent_name),
      ["Earlier", "Later"],
    );
    assert.equal(season.body.games[0].points_per_possession, 2);
    assert.equal(season.body.games[1].possessions, 3);
    assert.equal(season.body.games[1].turnovers, 1);
    assert.equal(season.body.totals.points, 5);
    assert.equal(season.body.totals.possessions, 4);
    assert.equal(season.body.totals.points_per_possession, 1.25);
    assert.equal(season.body.totals.turnovers, 1);
  });

  it("applies the schema script more than once", () => {
    const url = `file:${join(dir, "script.db")}`;
    const script = fileURLToPath(new URL("../scripts/apply-schema.mjs", import.meta.url));
    const run = () =>
      spawnSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, TURSO_DATABASE_URL: url },
        encoding: "utf8",
      });
    const first = run();
    const second = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /Schema applied/);
    assert.match(second.stdout, /Schema applied/);
  });

  function putGame(id, overrides = {}) {
    const body = {
      id,
      team_id: 1,
      date: "2026-10-04",
      opponent: "Novi Ligure",
      created_at: "2026-10-04T18:00:00.000Z",
      ...overrides,
    };
    return call(onRequestPut, {
      url: `http://localhost/api/games/${id}`,
      params: { id },
      body,
    });
  }

  function sync(id, events) {
    return call(onRequestSync, {
      url: `http://localhost/api/games/${id}/events/sync`,
      params: { id },
      body: events,
    });
  }
});

function tap(type, points, createdAt) {
  return {
    id: crypto.randomUUID(),
    type,
    points,
    created_at: createdAt,
  };
}

async function insertEvent(db, gameId, type, points) {
  await db.execute({
    sql: `INSERT INTO events (id, game_id, type, points, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), gameId, type, points, "2026-10-04T10:00:00.000Z"],
  });
}
