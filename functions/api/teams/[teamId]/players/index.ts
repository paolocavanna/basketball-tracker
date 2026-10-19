import { getDb } from "../../../../../lib/db.ts";
import { error, handle, json } from "../../../../../lib/http.ts";
import { parsePositiveInt } from "../../../../../lib/validators.ts";
import { teamExists } from "../../../../../lib/stats.ts";
import type { PagesContext } from "../../../../../types.ts";

export async function onRequestGet(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const teamId = parsePositiveInt(context.params.teamId);
    if (teamId == null) return error(400, "team id must be a positive integer");
    const db = getDb(context.env);
    if (!(await teamExists(db, teamId))) return error(404, "Team not found");
    const result = await db.execute({
      sql: "SELECT id, team_id, name, active, created_at FROM players WHERE team_id = ? ORDER BY name COLLATE NOCASE",
      args: [teamId],
    });
    return json(
      result.rows.map((row) => ({
        id: String(row.id),
        team_id: Number(row.team_id),
        name: String(row.name),
        active: Number(row.active) === 1,
        created_at: String(row.created_at),
      })),
    );
  });
}
