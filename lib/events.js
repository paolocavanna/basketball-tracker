// A repeated sync sends the same client id. Keep the original courtside row,
// and reject a different payload so another game cannot reuse that id.
export async function syncEvents(db, gameId, events) {
  if (events.length === 0) return { synced: 0 };

  const tx = await db.transaction("write");
  try {
    const placeholders = events.map(() => "?").join(", ");
    const existing = await tx.execute({
      sql: `SELECT id, game_id, type, points, created_at
            FROM events
            WHERE id IN (${placeholders})`,
      args: events.map((event) => event.id),
    });
    const byId = new Map(existing.rows.map((row) => [row.id, row]));

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const row = byId.get(event.id);
      if (!row) continue;
      const same =
        row.game_id === gameId &&
        row.type === event.type &&
        Number(row.points) === event.points &&
        row.created_at === event.created_at;
      if (!same) {
        return {
          status: 409,
          error: `Event at index ${index} already exists with different data`,
        };
      }
    }

    for (const event of events) {
      if (byId.has(event.id)) continue;
      await tx.execute({
        sql: `INSERT INTO events (id, game_id, type, points, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (id) DO NOTHING`,
        args: [event.id, gameId, event.type, event.points, event.created_at],
      });
    }

    await tx.commit();
    return { synced: events.length };
  } finally {
    tx.close();
  }
}
