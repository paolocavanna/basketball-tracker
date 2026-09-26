import { syncEvents } from "../../../../../lib/events.js";
import { getDb } from "../../../../../lib/db.js";
import { error, handle, json, readJson } from "../../../../../lib/http.js";
import { parseEventBatch, requireUuid } from "../../../../../lib/validators.js";

export async function onRequestPost(context) {
  return handle(async () => {
    const idError = requireUuid(context.params.id, "id");
    if (idError) return error(400, idError);

    const body = await readJson(context.request);
    if (body.error) return error(400, body.error);
    const parsed = parseEventBatch(body.value);
    if (parsed.error) return error(400, parsed.error);

    const db = getDb(context.env);
    const game = await db.execute({
      sql: "SELECT id FROM games WHERE id = ?",
      args: [context.params.id],
    });
    if (game.rows.length === 0) return error(404, "Game not found");

    const result = await syncEvents(db, context.params.id, parsed.events);
    if (result.error) return error(result.status, result.error);
    return json({ synced: result.synced });
  });
}
