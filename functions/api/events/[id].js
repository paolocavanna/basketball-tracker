import { getDb } from "../../../lib/db.js";
import { error, handle } from "../../../lib/http.js";
import { requireUuid } from "../../../lib/validators.js";

export async function onRequestDelete(context) {
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
