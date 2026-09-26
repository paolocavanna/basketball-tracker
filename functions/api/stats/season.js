import { getDb } from "../../../lib/db.js";
import { error, handle, json } from "../../../lib/http.js";
import { listGames, summarizeSeason, teamExists } from "../../../lib/stats.js";
import { parseTeamIdParam } from "../../../lib/validators.js";

export async function onRequestGet(context) {
  return handle(async () => {
    const team = parseTeamIdParam(new URL(context.request.url).searchParams.get("team_id"));
    if (team.error) return error(400, team.error);

    const db = getDb(context.env);
    if (!(await teamExists(db, team.value))) return error(404, "Team not found");

    const games = await listGames(db, team.value);
    return json(summarizeSeason(team.value, games));
  });
}
