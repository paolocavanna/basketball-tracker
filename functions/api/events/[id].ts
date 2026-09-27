import { getDb } from "../../../lib/db.ts";
import { error, handle } from "../../../lib/http.ts";
import { requireUuid } from "../../../lib/validators.ts";
import type { PagesContext } from "../../../types.ts";

export async function onRequestDelete(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const idError = requireUuid(context.params.id, "id");
    if (idError) return error(400, idError);

    const db = getDb(context.env);
    await db.execute({
      sql: "DELETE FROM events WHERE id = ?",
      args: [context.params.id],
    });
    return new Response(null, { status: 204 });
  });
}
