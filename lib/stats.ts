import type { Client, Row } from "@libsql/client";
import type {
  EventRecord,
  EventType,
  GameDetail,
  GameStatistics,
  GameWithStats,
  SeasonSummary,
} from "../types.ts";

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

function pointsPerPossession(points: number, possessions: number): number | null {
  if (possessions === 0) return null;
  return points / possessions;
}

function textColumn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`Unexpected database value for ${column}`);
  return value;
}

function numberColumn(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Unexpected database value for ${column}`);
}

function nullableNumberColumn(row: Row, column: string): number | null {
  const value = row[column];
  return value == null ? null : numberColumn(row, column);
}

function isEventType(value: string): value is EventType {
  return (
    value === "SCORE" ||
    value === "EMPTY" ||
    value === "TOV" ||
    value === "OFF_REB" ||
    value === "DEF_REB"
  );
}

function mapGameRecord(row: Row) {
  return {
    id: textColumn(row, "id"),
    team_id: numberColumn(row, "team_id"),
    date: textColumn(row, "date"),
    opponent_name: textColumn(row, "opponent_name"),
    final_score_for: nullableNumberColumn(row, "final_score_for"),
    final_score_against: nullableNumberColumn(row, "final_score_against"),
    created_at: textColumn(row, "created_at"),
  };
}

function mapStats(row: Row): GameStatistics {
  const points = numberColumn(row, "points");
  const possessions = numberColumn(row, "possessions");
  return {
    points,
    possessions,
    points_per_possession: pointsPerPossession(points, possessions),
    offensive_rebounds: numberColumn(row, "offensive_rebounds"),
    defensive_rebounds: numberColumn(row, "defensive_rebounds"),
    turnovers: numberColumn(row, "turnovers"),
  };
}

function mapGameWithStats(row: Row): GameWithStats {
  return { ...mapGameRecord(row), stats: mapStats(row) };
}

function mapEvent(row: Row): EventRecord {
  const id = textColumn(row, "id");
  const game_id = textColumn(row, "game_id");
  const type = textColumn(row, "type");
  const created_at = textColumn(row, "created_at");
  if (!isEventType(type)) throw new Error("Unexpected database event type");

  const points = numberColumn(row, "points");
  if (type === "SCORE") {
    if (points !== 2 && points !== 3) throw new Error("Unexpected database score value");
    return { id, game_id, type, points, created_at };
  }
  if (points !== 0) throw new Error("Unexpected database event points");
  return { id, game_id, type, points: 0, created_at };
}

export async function findGame(db: Client, id: string) {
  const result = await db.execute({
    sql: `SELECT id, team_id, date, opponent_name, final_score_for, final_score_against, created_at
          FROM games WHERE id = ?`,
    args: [id],
  });
  return result.rows[0] ? mapGameRecord(result.rows[0]) : null;
}

export async function listGames(db: Client, teamId: number): Promise<GameWithStats[]> {
  const result = await db.execute({
    sql: `${AGGREGATE_SQL}
          WHERE g.team_id = ?
          ${GROUP_BY}
          ORDER BY g.date ASC, g.created_at ASC, g.id ASC`,
    args: [teamId],
  });
  return result.rows.map(mapGameWithStats);
}

export async function getGameDetail(db: Client, id: string): Promise<GameDetail | null> {
  const result = await db.execute({
    sql: `${AGGREGATE_SQL} WHERE g.id = ? ${GROUP_BY}`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;

  const events = await db.execute({
    sql: `SELECT id, game_id, type, points, created_at
          FROM events
          WHERE game_id = ?
          ORDER BY created_at ASC, id ASC`,
    args: [id],
  });

  return {
    ...mapGameWithStats(row),
    events: events.rows.map(mapEvent),
  };
}

export async function teamExists(db: Client, teamId: number): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT id FROM teams WHERE id = ?",
    args: [teamId],
  });
  return result.rows.length > 0;
}

export function summarizeSeason(teamId: number, games: readonly GameWithStats[]): SeasonSummary {
  const totals: GameStatistics = {
    points: 0,
    possessions: 0,
    points_per_possession: null,
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
