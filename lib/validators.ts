import type { ApiEvent, EventType, ParsedGame, ValidationResult } from "../types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEventType(value: unknown): value is EventType {
  return (
    value === "SCORE" ||
    value === "FT" ||
    value === "EMPTY" ||
    value === "TOV" ||
    value === "OFF_REB" ||
    value === "DEF_REB"
  );
}

export function requireUuid(value: unknown, label: string): string | null {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return `${label} must be a UUID`;
  }
  return null;
}

export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function parseTeamIdParam(raw: string | null): ValidationResult<number> {
  if (raw == null || raw === "") return { error: "team_id is required" };
  const value = parsePositiveInt(raw);
  if (value == null) return { error: "team_id must be a positive integer" };
  return { value };
}

function requireDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return "date must be YYYY-MM-DD";
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return "date must be YYYY-MM-DD";
  }
  return null;
}

function requireTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "created_at is required";
  }
  if (Number.isNaN(Date.parse(value))) {
    return "created_at must be an ISO 8601 timestamp";
  }
  return null;
}

function optionalScore(value: unknown, label: string): ValidationResult<number | null> {
  if (value == null) return { value: null };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { value };
  }
  return { error: `${label} must be a non-negative integer` };
}

export function parseGame(body: unknown, urlId: string): ValidationResult<ParsedGame> {
  if (!isRecord(body)) return { error: "Expected a JSON object" };
  if (typeof body.id !== "string") return { error: "id must be a UUID" };
  const idError = requireUuid(body.id, "id");
  if (idError) return { error: idError };
  if (body.id !== urlId) return { error: "id must match the URL" };

  const teamId = parsePositiveInt(body.team_id);
  if (teamId == null) return { error: "team_id must be a positive integer" };

  if (typeof body.date !== "string") return { error: "date must be YYYY-MM-DD" };
  const dateError = requireDate(body.date);
  if (dateError) return { error: dateError };
  if (typeof body.opponent !== "string" || body.opponent.trim() === "") {
    return { error: "opponent is required" };
  }
  if (typeof body.created_at !== "string") return { error: "created_at is required" };
  const createdError = requireTimestamp(body.created_at);
  if (createdError) return { error: createdError };

  const scoreFor = optionalScore(body.final_score_for, "final_score_for");
  if ("error" in scoreFor) return scoreFor;
  const scoreAgainst = optionalScore(body.final_score_against, "final_score_against");
  if ("error" in scoreAgainst) return scoreAgainst;

  return {
    value: {
      id: body.id,
      team_id: teamId,
      date: body.date,
      opponent_name: body.opponent.trim(),
      final_score_for: scoreFor.value,
      final_score_against: scoreAgainst.value,
      created_at: body.created_at,
    },
  };
}

export function parseEventBatch(body: unknown): { events: ApiEvent[] } | { error: string } {
  if (!Array.isArray(body)) return { error: "Expected an array of events" };

  const events: ApiEvent[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.length; index += 1) {
    const item: unknown = body[index];
    if (!isRecord(item)) return { error: `Invalid event at index ${index}` };

    if (typeof item.id !== "string") {
      return { error: `Invalid event at index ${index}: id must be a UUID` };
    }
    const idError = requireUuid(item.id, "id");
    if (idError) return { error: `Invalid event at index ${index}: ${idError}` };
    if (seen.has(item.id)) {
      return { error: `Duplicate event id at index ${index}` };
    }
    seen.add(item.id);

    if (!isEventType(item.type)) {
      return {
        error: `Invalid event at index ${index}: type must be SCORE, FT, EMPTY, TOV, OFF_REB, or DEF_REB`,
      };
    }

    const createdAt = item.created_at;
    if (typeof createdAt !== "string") {
      return { error: `Invalid event at index ${index}: created_at is required` };
    }
    const createdError = requireTimestamp(createdAt);
    if (createdError) {
      return { error: `Invalid event at index ${index}: ${createdError}` };
    }

    if (item.type === "SCORE") {
      if (item.points !== 2 && item.points !== 3) {
        return { error: `Invalid event at index ${index}: SCORE points must be 2 or 3` };
      }
      events.push({ id: item.id, type: item.type, points: item.points, created_at: createdAt });
      continue;
    }

    if (item.type === "FT") {
      if (item.points !== 1) {
        return { error: `Invalid event at index ${index}: FT points must be 1` };
      }
      events.push({ id: item.id, type: item.type, points: 1, created_at: createdAt });
      continue;
    }

    if (item.points != null && item.points !== 0) {
      return { error: `Invalid event at index ${index}: ${item.type} points must be 0` };
    }
    events.push({ id: item.id, type: item.type, points: 0, created_at: createdAt });
  }

  return { events };
}
