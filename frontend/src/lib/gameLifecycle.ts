import type { GameRecord, StoredEvent, StoredGame } from "../../../types.ts";
import { gameStatus } from "./localStore.ts";
import type { LocalStore } from "./localStore.ts";
import { livePath, summaryPath } from "./route.ts";
import { computeStats } from "./stats.ts";

export const RECENT_GAME_LIMIT = 8;

// Whole numbers a coach can actually enter for an opponent. Empty and
// decimals stay invalid so a slip does not wipe a score that was already saved.
const OPPONENT_SCORE = /^(0|[1-9]\d{0,2})$/;

export function recentGames(games: readonly StoredGame[], limit = RECENT_GAME_LIMIT): StoredGame[] {
  return [...games]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export type RecoveryAction = "continue" | "open";

export function recoveryAction(game: Pick<GameRecord, "status">): RecoveryAction {
  return gameStatus(game) === "finished" ? "open" : "continue";
}

export function recoveryPath(game: Pick<GameRecord, "id" | "status">): string {
  return recoveryAction(game) === "continue" ? livePath(game.id) : summaryPath(game.id);
}

export function formatGameDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

// The team score always comes from the log. Finishing stores that number
// beside the opponent score; it does not replace the events that produced it.
export function toGameRecord(
  game: StoredGame,
  events: readonly StoredEvent[],
  status = gameStatus(game),
): GameRecord {
  return {
    id: game.id,
    team_id: game.team_id,
    date: game.date,
    opponent_name: game.opponent_name,
    created_at: game.created_at,
    status,
    final_score_for: computeStats(events).points,
    final_score_against: game.final_score_against ?? null,
  };
}

export async function applyFinishChoice(
  store: Pick<LocalStore, "loadGame" | "saveGame">,
  choice: "cancel" | "confirm",
  game: StoredGame,
  events: readonly StoredEvent[],
): Promise<StoredGame> {
  if (choice === "cancel") return (await store.loadGame(game.id)) ?? game;
  return store.saveGame(toGameRecord(game, events, "finished"));
}

export function parseOpponentScore(raw: string): number | null {
  const text = raw.trim();
  if (!OPPONENT_SCORE.test(text)) return null;
  return Number(text);
}

export async function saveOpponentScore(
  store: Pick<LocalStore, "saveGame">,
  game: StoredGame,
  events: readonly StoredEvent[],
  raw: string,
): Promise<{ ok: true; game: StoredGame } | { ok: false }> {
  const score = parseOpponentScore(raw);
  if (score == null) return { ok: false };
  const saved = await store.saveGame({
    ...toGameRecord(game, events),
    final_score_against: score,
  });
  return { ok: true, game: saved };
}

// Corrections on a finished game keep the finished state and refresh the
// stored team score from the log. In-progress games are left untouched.
export async function persistDerivedScore(
  store: Pick<LocalStore, "saveGame">,
  game: StoredGame,
  events: readonly StoredEvent[],
): Promise<StoredGame | null> {
  if (gameStatus(game) !== "finished") return null;
  return store.saveGame(toGameRecord(game, events, "finished"));
}
