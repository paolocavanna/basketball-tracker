// The schema seed gives Campus Monferrato U13 id 1. The start screen asks
// `/api/teams` once when it can, and uses this id when that read fails so
// tip-off does not wait on the network.
export const SEEDED_TEAM_ID = 1;

type TeamResponse = Pick<Response, "ok"> & { json(): Promise<unknown> };
type TeamFetcher = (input: string) => Promise<TeamResponse>;

export async function loadTeamId(fetchImpl: TeamFetcher = globalThis.fetch): Promise<number> {
  try {
    const response = await fetchImpl("/api/teams");
    if (!response.ok) return SEEDED_TEAM_ID;
    const teams: unknown = await response.json();
    const firstTeam = Array.isArray(teams) ? teams[0] : null;
    const id =
      firstTeam !== null && typeof firstTeam === "object" && "id" in firstTeam
        ? firstTeam.id
        : null;
    if (Number.isInteger(id) && id > 0) return id;
  } catch {
    // Offline or a bad payload. The seeded row is enough to record a game.
  }
  return SEEDED_TEAM_ID;
}
