import type { GameRecord, StoredEvent, StoredGame } from "../../../types.ts";
import { gameStatus } from "./localStore.ts";
import type { LocalStore } from "./localStore.ts";
import { summaryPath } from "./route.ts";
import { computeStats } from "./stats.ts";

export const RECENT_GAME_LIMIT = 8;

// Whole numbers a coach can enter for either final score. Empty and decimals
// stay invalid so a slip does not wipe a result that was already saved.
const FINAL_SCORE = /^(0|[1-9]\d{0,2})$/;

// Finished games only. An in-progress game stays on the live page and is not
// listed, so leaving that page does not offer a way back in.
export function recentGames(games: readonly StoredGame[], limit = RECENT_GAME_LIMIT): StoredGame[] {
  return [...games]
    .filter((game) => gameStatus(game) === "finished")
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export function recoveryPath(game: Pick<GameRecord, "id">): string {
  return summaryPath(game.id);
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

// Until the coach saves both final scores, the team number is the log.
// After that, the saved pair is the result and log corrections leave it alone.
export function toGameRecord(
  game: StoredGame,
  events: readonly StoredEvent[],
  status = gameStatus(game),
): GameRecord {
  const confirmed = game.final_scores_confirmed === true;
  return {
    id: game.id,
    team_id: game.team_id,
    date: game.date,
    opponent_name: game.opponent_name,
    created_at: game.created_at,
    status,
    final_score_for: confirmed ? (game.final_score_for ?? null) : computeStats(events).points,
    final_score_against: game.final_score_against ?? null,
    final_scores_confirmed: confirmed,
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

export function parseFinalScore(raw: string): number | null {
  const text = raw.trim();
  if (!FINAL_SCORE.test(text)) return null;
  return Number(text);
}

export type GameResult = "win" | "loss" | "draw";

// The higher of the two saved scores wins. Equal scores are a draw.
export function gameResult(
  ours: number | null | undefined,
  theirs: number | null | undefined,
): GameResult | null {
  if (ours == null || theirs == null) return null;
  if (ours > theirs) return "win";
  if (ours < theirs) return "loss";
  return "draw";
}

export function resultLabel(
  result: GameResult,
  opponentName: string,
  copy: { campusWon: string; opponentWon: string; draw: string },
): string {
  if (result === "win") return copy.campusWon;
  if (result === "draw") return copy.draw;
  return copy.opponentWon.replace("{opponent}", opponentName);
}

export async function saveFinalScores(
  store: Pick<LocalStore, "saveGame">,
  game: StoredGame,
  events: readonly StoredEvent[],
  rawFor: string,
  rawAgainst: string,
): Promise<{ ok: true; game: StoredGame } | { ok: false }> {
  const ours = parseFinalScore(rawFor);
  const theirs = parseFinalScore(rawAgainst);
  if (ours == null || theirs == null) return { ok: false };
  const saved = await store.saveGame({
    ...toGameRecord(game, events),
    final_score_for: ours,
    final_score_against: theirs,
    final_scores_confirmed: true,
  });
  return { ok: true, game: saved };
}

// Corrections on a finished game keep the finished state. The stored team
// score follows the log until both final scores are saved. In-progress games
// are left untouched.
export async function persistDerivedScore(
  store: Pick<LocalStore, "saveGame">,
  game: StoredGame,
  events: readonly StoredEvent[],
): Promise<StoredGame | null> {
  if (gameStatus(game) !== "finished") return null;
  return store.saveGame(toGameRecord(game, events, "finished"));
}
