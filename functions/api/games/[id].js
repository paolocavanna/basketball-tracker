import { getDb } from "../../../lib/db.js";
import { error, handle, json, readJson } from "../../../lib/http.js";
import { findGame, getGameDetail, teamExists } from "../../../lib/stats.js";
import { parseGame, requireUuid } from "../../../lib/validators.js";

export async function onRequestGet(context) {
  return handle(async () => {
    const idError = requireUuid(context.params.id, "id");
    if (idError) return error(400, idError);

    const db = getDb(context.env);
    const game = await getGameDetail(db, context.params.id);
    if (!game) return error(404, "Game not found");
    return json(game);
  });
}

export async function onRequestPut(context) {
  return handle(async () => {
    const idError = requireUuid(context.params.id, "id");
    if (idError) return error(400, idError);

    const body = await readJson(context.request);
    if (body.error) return error(400, body.error);
    const parsed = parseGame(body.value, context.params.id);
    if (parsed.error) return error(400, parsed.error);

    const db = getDb(context.env);
    const game = parsed.value;
    if (!(await teamExists(db, game.team_id))) return error(404, "Team not found");

    // The first write wins. A retry of the same client id is a no-op.
    const inserted = await db.execute({
      sql: `INSERT INTO games (
              id, team_id, date, opponent_name, final_score_for, final_score_against, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO NOTHING`,
      args: [
        game.id,
        game.team_id,
        game.date,
        game.opponent_name,
        game.final_score_for,
        game.final_score_against,
        game.created_at,
      ],
    });

    const stored = await findGame(db, game.id);
    if (!stored) return error(500, "Internal server error");
    return json(stored, inserted.rowsAffected > 0 ? 201 : 200);
  });
}
