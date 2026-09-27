import type {
  EventRecord,
  GameDetail,
  GameStatistics,
  SeasonGame,
  SeasonSummary,
} from "../../../types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isGameStatistics(value: unknown): value is GameStatistics {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.points) &&
    isFiniteNumber(value.possessions) &&
    (value.points_per_possession === null || isFiniteNumber(value.points_per_possession)) &&
    isFiniteNumber(value.offensive_rebounds) &&
    isFiniteNumber(value.defensive_rebounds) &&
    isFiniteNumber(value.turnovers)
  );
}

function hasOptionalScores(value: Record<string, unknown>): boolean {
  return (
    (!("final_score_for" in value) ||
      value.final_score_for === null ||
      isFiniteNumber(value.final_score_for)) &&
    (!("final_score_against" in value) ||
      value.final_score_against === null ||
      isFiniteNumber(value.final_score_against))
  );
}

function isSeasonGame(value: unknown): value is SeasonGame {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.date === "string" &&
    typeof value.opponent_name === "string" &&
    hasOptionalScores(value) &&
    isGameStatistics(value)
  );
}

function isSeasonSummary(value: unknown): value is SeasonSummary {
  return (
    isRecord(value) &&
    Number.isInteger(value.team_id) &&
    Array.isArray(value.games) &&
    value.games.every(isSeasonGame) &&
    isGameStatistics(value.totals)
  );
}

function isEventRecord(value: unknown): value is EventRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.game_id !== "string" ||
    typeof value.created_at !== "string"
  ) {
    return false;
  }
  if (value.type === "SCORE") return value.points === 2 || value.points === 3;
  return (
    (value.type === "EMPTY" ||
      value.type === "TOV" ||
      value.type === "OFF_REB" ||
      value.type === "DEF_REB") &&
    value.points === 0
  );
}

function isGameDetail(value: unknown): value is GameDetail {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Number.isInteger(value.team_id) &&
    typeof value.date === "string" &&
    typeof value.opponent_name === "string" &&
    typeof value.created_at === "string" &&
    hasOptionalScores(value) &&
    isGameStatistics(value.stats) &&
    Array.isArray(value.events) &&
    value.events.every(isEventRecord)
  );
}

export function readSeasonSummary(value: unknown): SeasonSummary {
  if (!isSeasonSummary(value)) throw new Error("Invalid season response");
  return value;
}

export function readGameDetail(value: unknown): GameDetail {
  if (!isGameDetail(value)) throw new Error("Invalid game response");
  return value;
}
