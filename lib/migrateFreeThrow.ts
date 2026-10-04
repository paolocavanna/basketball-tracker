import type { Client } from "@libsql/client";

// SQLite cannot change a CHECK constraint in place. This rebuilds `events`
// so a made free throw (`FT`, 1 point) can be stored, and copies every
// existing row across. The new definition matches `db/schema.sql`.
const EVENTS_NEXT_SQL = `
CREATE TABLE events_next (
  id         TEXT PRIMARY KEY,
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('SCORE', 'FT', 'EMPTY', 'TOV', 'OFF_REB', 'DEF_REB')),
  points     INTEGER NOT NULL DEFAULT 0
             CHECK (
               (type = 'SCORE' AND points IN (2, 3)) OR
               (type = 'FT' AND points = 1) OR
               (type NOT IN ('SCORE', 'FT') AND points = 0)
             ),
  created_at TEXT NOT NULL
)`;

export async function eventsAllowFreeThrow(db: Client): Promise<boolean> {
  const result = await db.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'",
  );
  const sql = result.rows[0]?.sql;
  return typeof sql === "string" && sql.includes("'FT'");
}

export async function migrateFreeThrowEvents(db: Client): Promise<"migrated" | "already"> {
  if (await eventsAllowFreeThrow(db)) return "already";

  const tx = await db.transaction("write");
  try {
    await tx.execute("DROP TABLE IF EXISTS events_next");
    await tx.execute(EVENTS_NEXT_SQL);
    await tx.execute(
      `INSERT INTO events_next (id, game_id, type, points, created_at)
       SELECT id, game_id, type, points, created_at FROM events`,
    );
    await tx.execute("DROP TABLE events");
    await tx.execute("ALTER TABLE events_next RENAME TO events");
    await tx.execute("CREATE INDEX idx_events_game_id ON events(game_id)");
    await tx.commit();
    return "migrated";
  } finally {
    tx.close();
  }
}
