import { getDb } from "../../../../../lib/db.ts";
import { error, handle, json, readJson } from "../../../../../lib/http.ts";
import { parsePlayer, parsePositiveInt, requireUuid } from "../../../../../lib/validators.ts";
import { teamExists } from "../../../../../lib/stats.ts";
import type { PagesContext } from "../../../../../types.ts";

export async function onRequestPut(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const teamId = parsePositiveInt(context.params.teamId);
    if (teamId == null) return error(400, "team id must be a positive integer");
    const idError = requireUuid(context.params.playerId, "player id");
    if (idError) return error(400, idError);
    const body = await readJson(context.request);
    if ("error" in body) return error(400, body.error);
    const parsed = parsePlayer(body.value, teamId, context.params.playerId);
    if ("error" in parsed) return error(400, parsed.error);
    const db = getDb(context.env);
    if (!(await teamExists(db, teamId))) return error(404, "Team not found");
    const player = parsed.value;
    const existing = await db.execute({
      sql: "SELECT team_id FROM players WHERE id = ?",
      args: [player.id],
    });
    if (existing.rows[0] && Number(existing.rows[0].team_id) !== teamId) {
      return error(409, "Player id belongs to a different team");
    }
    await db.execute({
      sql: `INSERT INTO players (id, team_id, name, active, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, active = excluded.active`,
      args: [player.id, player.team_id, player.name, player.active ? 1 : 0, player.created_at],
    });
    return json(player);
  });
}
