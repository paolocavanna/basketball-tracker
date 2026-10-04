import { getDb } from "../../../lib/db.ts";
import { error, handle, json, readJson } from "../../../lib/http.ts";
import { findGame, getGameDetail, teamExists } from "../../../lib/stats.ts";
import { parseGame, requireUuid } from "../../../lib/validators.ts";
import type { PagesContext } from "../../../types.ts";

export async function onRequestGet(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const idError = requireUuid(context.params.id, "id");
    if (idError) return error(400, idError);

    const db = getDb(context.env);
    const game = await getGameDetail(db, context.params.id);
    if (!game) return error(404, "Game not found");
    return json(game);
  });
}

export async function onRequestPut(context: PagesContext): Promise<Response> {
  return handle(async () => {
    const idError = requireUuid(context.params.id, "id");
    if (idError) return error(400, idError);

    const body = await readJson(context.request);
    if ("error" in body) return error(400, body.error);
    const parsed = parseGame(body.value, context.params.id);
    if ("error" in parsed) return error(400, parsed.error);

    const db = getDb(context.env);
    const game = parsed.value;
    if (!(await teamExists(db, game.team_id))) return error(404, "Team not found");

    // The opponent and the timestamp stay as first written. Final scores are
    // entered after the game, and a later correction must replace them. A
    // retry that omits a score leaves the stored number in place.
    // An update still changes a row, so the status comes from whether this id
    // was already stored, not from the write count.
    const existing = await findGame(db, game.id);
    await db.execute({
      sql: `INSERT INTO games (
              id, team_id, date, opponent_name, final_score_for, final_score_against, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              final_score_for = COALESCE(excluded.final_score_for, games.final_score_for),
              final_score_against = COALESCE(excluded.final_score_against, games.final_score_against)`,
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
    return json(stored, existing ? 200 : 201);
  });
}
