import type { Row } from "@libsql/client";
import { getDb } from "../../lib/db.ts";
import { handle, json } from "../../lib/http.ts";
import type { PagesContext, TeamRecord } from "../../types.ts";

function stringColumn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`Unexpected database value for ${column}`);
  return value;
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const db = getDb(context.env);
    const result = await db.execute("SELECT id, name, category, slug FROM teams ORDER BY id ASC");
    const teams: TeamRecord[] = result.rows.map((row) => ({
      id: Number(row.id),
      name: stringColumn(row, "name"),
      category: stringColumn(row, "category"),
      slug: stringColumn(row, "slug"),
    }));
    return json(teams);
  });
}
