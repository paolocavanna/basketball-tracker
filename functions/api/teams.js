import { getDb } from "../../lib/db.js";
import { handle, json } from "../../lib/http.js";

export async function onRequestGet(context) {
  return handle(async () => {
    const db = getDb(context.env);
    const result = await db.execute("SELECT id, name, category, slug FROM teams ORDER BY id ASC");
    return json(
      result.rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        category: row.category,
        slug: row.slug,
      })),
    );
  });
}
