// The schema seed gives Campus Monferrato U13 id 1. The start screen asks
// `/api/teams` once when it can, and uses this id when that read fails so
// tip-off does not wait on the network.
export const SEEDED_TEAM_ID = 1;

export async function loadTeamId(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl("/api/teams");
    if (!response?.ok) return SEEDED_TEAM_ID;
    const teams = await response.json();
    const id = Array.isArray(teams) ? teams[0]?.id : null;
    if (Number.isInteger(id) && id > 0) return id;
  } catch {
    // Offline or a bad payload. The seeded row is enough to record a game.
  }
  return SEEDED_TEAM_ID;
}
