import { getDb } from "../../../lib/db.ts";
import { error, handle, json } from "../../../lib/http.ts";
import { listGames, teamExists } from "../../../lib/stats.ts";
import { parseTeamIdParam } from "../../../lib/validators.ts";
import type { PagesContext } from "../../../types.ts";

export async function onRequestGet(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const team = parseTeamIdParam(new URL(context.request.url).searchParams.get("team_id"));
    if ("error" in team) return error(400, team.error);

    const db = getDb(context.env);
    if (!(await teamExists(db, team.value))) return error(404, "Team not found");
    return json(await listGames(db, team.value));
  });
}
