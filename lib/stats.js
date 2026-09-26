const AGGREGATE_SQL = `
SELECT
  g.id,
  g.team_id,
  g.date,
  g.opponent_name,
  g.final_score_for,
  g.final_score_against,
  g.created_at,
  COUNT(e.id) FILTER (WHERE e.type IN ('SCORE', 'EMPTY', 'TOV')) AS possessions,
  COALESCE(SUM(e.points), 0) AS points,
  COUNT(e.id) FILTER (WHERE e.type = 'OFF_REB') AS offensive_rebounds,
  COUNT(e.id) FILTER (WHERE e.type = 'DEF_REB') AS defensive_rebounds,
  COUNT(e.id) FILTER (WHERE e.type = 'TOV') AS turnovers
FROM games g
LEFT JOIN events e ON e.game_id = g.id
`;

const GROUP_BY = `
GROUP BY g.id, g.team_id, g.date, g.opponent_name, g.final_score_for, g.final_score_against, g.created_at
`;

function pointsPerPossession(points, possessions) {
  if (possessions === 0) return null;
  return points / possessions;
}

function mapGameRecord(row) {
  return {
    id: row.id,
    team_id: Number(row.team_id),
    date: row.date,
    opponent_name: row.opponent_name,
    final_score_for: row.final_score_for == null ? null : Number(row.final_score_for),
    final_score_against: row.final_score_against == null ? null : Number(row.final_score_against),
    created_at: row.created_at,
  };
}

function mapStats(row) {
  const points = Number(row.points ?? 0);
  const possessions = Number(row.possessions ?? 0);
  return {
    points,
    possessions,
    points_per_possession: pointsPerPossession(points, possessions),
    offensive_rebounds: Number(row.offensive_rebounds ?? 0),
    defensive_rebounds: Number(row.defensive_rebounds ?? 0),
    turnovers: Number(row.turnovers ?? 0),
  };
}

function mapGameWithStats(row) {
  return {
    ...mapGameRecord(row),
    stats: mapStats(row),
  };
}

export async function findGame(db, id) {
  const result = await db.execute({
    sql: `SELECT id, team_id, date, opponent_name, final_score_for, final_score_against, created_at
          FROM games WHERE id = ?`,
    args: [id],
  });
  return result.rows[0] ? mapGameRecord(result.rows[0]) : null;
}

export async function listGames(db, teamId) {
  const result = await db.execute({
    sql: `${AGGREGATE_SQL}
          WHERE g.team_id = ?
          ${GROUP_BY}
          ORDER BY g.date ASC, g.created_at ASC, g.id ASC`,
    args: [teamId],
  });
  return result.rows.map(mapGameWithStats);
}

export async function getGameDetail(db, id) {
  const result = await db.execute({
    sql: `${AGGREGATE_SQL} WHERE g.id = ? ${GROUP_BY}`,
    args: [id],
  });
  if (result.rows.length === 0) return null;

  const events = await db.execute({
    sql: `SELECT id, game_id, type, points, created_at
          FROM events
          WHERE game_id = ?
          ORDER BY created_at ASC, id ASC`,
    args: [id],
  });

  return {
    ...mapGameWithStats(result.rows[0]),
    events: events.rows.map((row) => ({
      id: row.id,
      game_id: row.game_id,
      type: row.type,
      points: Number(row.points),
      created_at: row.created_at,
    })),
  };
}

export async function teamExists(db, teamId) {
  const result = await db.execute({
    sql: "SELECT id FROM teams WHERE id = ?",
    args: [teamId],
  });
  return result.rows.length > 0;
}

export function summarizeSeason(teamId, games) {
  const totals = {
    points: 0,
    possessions: 0,
    offensive_rebounds: 0,
    defensive_rebounds: 0,
    turnovers: 0,
  };

  const seasonGames = games.map((game) => {
    totals.points += game.stats.points;
    totals.possessions += game.stats.possessions;
    totals.offensive_rebounds += game.stats.offensive_rebounds;
    totals.defensive_rebounds += game.stats.defensive_rebounds;
    totals.turnovers += game.stats.turnovers;
    return {
      id: game.id,
      date: game.date,
      opponent_name: game.opponent_name,
      ...game.stats,
    };
  });

  totals.points_per_possession = pointsPerPossession(totals.points, totals.possessions);
  return { team_id: teamId, games: seasonGames, totals };
}
