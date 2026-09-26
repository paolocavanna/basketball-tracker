// Possession rules from the specification: SCORE, EMPTY and TOV end a
// possession, OFF_REB continues the current one, DEF_REB is standalone.
const POSSESSION_ENDING_TYPES = new Set(["SCORE", "EMPTY", "TOV"]);

export function endsPossession(type) {
  return POSSESSION_ENDING_TYPES.has(type);
}

// A repeated sync can hand back an event already held locally, and an undone
// event is kept around only until its DELETE syncs. Undo therefore wins over a
// duplicate regardless of which copy comes first.
export function activeEvents(events) {
  const seen = new Set();
  const active = [];
  for (const event of events) {
    if (event.deleted || seen.has(event.id)) continue;
    seen.add(event.id);
    active.push(event);
  }
  return active;
}

export function computeStats(events) {
  const stats = {
    points: 0,
    possessions: 0,
    points_per_possession: null,
    offensive_rebounds: 0,
    defensive_rebounds: 0,
    turnovers: 0,
  };

  for (const event of activeEvents(events)) {
    if (endsPossession(event.type)) stats.possessions += 1;
    if (event.type === "TOV") stats.turnovers += 1;
    if (event.type === "OFF_REB") stats.offensive_rebounds += 1;
    if (event.type === "DEF_REB") stats.defensive_rebounds += 1;
    stats.points += event.points ?? 0;
  }

  if (stats.possessions > 0) {
    stats.points_per_possession = stats.points / stats.possessions;
  }

  return stats;
}
