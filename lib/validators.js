const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPES = new Set(["SCORE", "EMPTY", "TOV", "OFF_REB", "DEF_REB"]);

export function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return `${label} must be a UUID`;
  }
  return null;
}

export function parsePositiveInt(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function parseTeamIdParam(raw) {
  if (raw == null || raw === "") return { error: "team_id is required" };
  const value = parsePositiveInt(raw);
  if (value == null) return { error: "team_id must be a positive integer" };
  return { value };
}

function requireDate(value) {
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

function requireTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "created_at is required";
  }
  if (Number.isNaN(Date.parse(value))) {
    return "created_at must be an ISO 8601 timestamp";
  }
  return null;
}

function optionalScore(value, label) {
  if (value == null) return { value: null };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { value };
  }
  return { error: `${label} must be a non-negative integer` };
}

export function parseGame(body, urlId) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Expected a JSON object" };
  }
  const idError = requireUuid(body.id, "id");
  if (idError) return { error: idError };
  if (body.id !== urlId) return { error: "id must match the URL" };

  const teamId = parsePositiveInt(body.team_id);
  if (teamId == null) return { error: "team_id must be a positive integer" };

  const dateError = requireDate(body.date);
  if (dateError) return { error: dateError };
  if (typeof body.opponent !== "string" || body.opponent.trim() === "") {
    return { error: "opponent is required" };
  }
  const createdError = requireTimestamp(body.created_at);
  if (createdError) return { error: createdError };

  const scoreFor = optionalScore(body.final_score_for, "final_score_for");
  if (scoreFor.error) return scoreFor;
  const scoreAgainst = optionalScore(body.final_score_against, "final_score_against");
  if (scoreAgainst.error) return scoreAgainst;

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

export function parseEventBatch(body) {
  if (!Array.isArray(body)) return { error: "Expected an array of events" };

  const events = [];
  const seen = new Set();
  for (let index = 0; index < body.length; index += 1) {
    const item = body[index];
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      return { error: `Invalid event at index ${index}` };
    }
    const idError = requireUuid(item.id, "id");
    if (idError) return { error: `Invalid event at index ${index}: ${idError}` };
    if (seen.has(item.id)) {
      return { error: `Duplicate event id at index ${index}` };
    }
    seen.add(item.id);

    if (!EVENT_TYPES.has(item.type)) {
      return {
        error: `Invalid event at index ${index}: type must be SCORE, EMPTY, TOV, OFF_REB, or DEF_REB`,
      };
    }

    let points = item.points;
    if (item.type === "SCORE") {
      if (points !== 2 && points !== 3) {
        return { error: `Invalid event at index ${index}: SCORE points must be 2 or 3` };
      }
    } else if (points == null) {
      points = 0;
    } else if (points !== 0) {
      return { error: `Invalid event at index ${index}: ${item.type} points must be 0` };
    }

    const createdError = requireTimestamp(item.created_at);
    if (createdError) {
      return { error: `Invalid event at index ${index}: ${createdError}` };
    }

    events.push({
      id: item.id,
      type: item.type,
      points,
      created_at: item.created_at,
    });
  }

  return { events };
}
