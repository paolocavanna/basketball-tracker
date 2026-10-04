import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { migrateFreeThrowEvents } from "../lib/migrateFreeThrow.ts";

const OLD_SCHEMA = `
CREATE TABLE teams (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  slug     TEXT NOT NULL UNIQUE
);
CREATE TABLE games (
  id                  TEXT PRIMARY KEY,
  team_id             INTEGER NOT NULL REFERENCES teams(id),
  date                TEXT NOT NULL,
  opponent_name       TEXT NOT NULL,
  final_score_for     INTEGER,
  final_score_against INTEGER,
  created_at          TEXT NOT NULL
);
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('SCORE', 'EMPTY', 'TOV', 'OFF_REB', 'DEF_REB')),
  points     INTEGER NOT NULL DEFAULT 0
             CHECK ((type = 'SCORE' AND points IN (2, 3)) OR (type != 'SCORE' AND points = 0)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_game_id ON events(game_id);
`;

describe("free throw migration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds an existing events table and keeps the rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bball-ft-"));
    dirs.push(dir);
    const db = createClient({ url: `file:${join(dir, "test.db")}`, intMode: "number" });
    try {
      await db.executeMultiple(OLD_SCHEMA);
      await db.execute(
        `INSERT INTO teams (name, category, slug) VALUES ('Campus Monferrato', 'U13', 'campus-monferrato-u13')`,
      );
      await db.execute({
        sql: `INSERT INTO games (id, team_id, date, opponent_name, created_at)
              VALUES ('game-1', 1, '2026-10-04', 'Novara', '2026-10-04T15:00:00.000Z')`,
      });
      await db.execute({
        sql: `INSERT INTO events (id, game_id, type, points, created_at)
              VALUES ('score-1', 'game-1', 'SCORE', 2, '2026-10-04T15:01:00.000Z')`,
      });

      assert.equal(await migrateFreeThrowEvents(db), "migrated");
      assert.equal(await migrateFreeThrowEvents(db), "already");

      const kept = await db.execute("SELECT type, points FROM events WHERE id = 'score-1'");
      assert.equal(kept.rows[0].type, "SCORE");
      assert.equal(kept.rows[0].points, 2);

      await db.execute({
        sql: `INSERT INTO events (id, game_id, type, points, created_at)
              VALUES ('ft-1', 'game-1', 'FT', 1, '2026-10-04T15:02:00.000Z')`,
      });
      const freeThrow = await db.execute("SELECT points FROM events WHERE id = 'ft-1'");
      assert.equal(freeThrow.rows[0].points, 1);

      await assert.rejects(
        db.execute({
          sql: `INSERT INTO events (id, game_id, type, points, created_at)
                VALUES ('bad-1', 'game-1', 'SCORE', 1, '2026-10-04T15:03:00.000Z')`,
        }),
        /CHECK/i,
      );

      const index = await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_game_id'",
      );
      assert.equal(index.rows.length, 1);
    } finally {
      db.close();
    }
  });
});
