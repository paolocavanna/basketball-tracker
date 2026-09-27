import { syncEvents } from "../../../../../lib/events.ts";
import { getDb } from "../../../../../lib/db.ts";
import { error, handle, json, readJson } from "../../../../../lib/http.ts";
import { parseEventBatch, requireUuid } from "../../../../../lib/validators.ts";
import type { PagesContext } from "../../../../../types.ts";

export async function onRequestPost(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const idError = requireUuid(context.params.id, "id");
    if (idError) return error(400, idError);

    const body = await readJson(context.request);
    if ("error" in body) return error(400, body.error);
    const parsed = parseEventBatch(body.value);
    if ("error" in parsed) return error(400, parsed.error);

    const db = getDb(context.env);
    const game = await db.execute({
      sql: "SELECT id FROM games WHERE id = ?",
      args: [context.params.id],
    });
    if (game.rows.length === 0) return error(404, "Game not found");

    const result = await syncEvents(db, context.params.id, parsed.events);
    if ("error" in result) return error(result.status, result.error);
    return json({ synced: result.synced });
  });
}
