export type EventType = "SCORE" | "EMPTY" | "TOV" | "OFF_REB" | "DEF_REB";
export type NonScoreEventType = Exclude<EventType, "SCORE">;

export type EventPayload =
  { type: "SCORE"; points: 2 | 3 } | { type: NonScoreEventType; points: 0 };

export type NewEventPayload =
  { type: "SCORE"; points?: 2 | 3 } | { type: NonScoreEventType; points?: 0 };

interface EventMetadata {
  id: string;
  game_id: string;
  created_at: string;
}

export type EventRecord = EventMetadata & EventPayload;
export type ApiEvent = { id: string; created_at: string } & EventPayload;
export type StoredEvent = EventRecord & { synced: boolean; deleted: boolean };
export type NewStoredEvent = NewEventPayload & {
  id?: string;
  game_id: string;
  created_at?: string;
};

export interface TeamRecord {
  id: number;
  name: string;
  category: string;
  slug: string;
}

export type GameStatus = "in-progress" | "finished";

export interface GameRecord {
  id: string;
  team_id: number;
  date: string;
  opponent_name: string;
  created_at: string;
  // Missing on rows saved before the field existed. Readers treat that as in-progress.
  status?: GameStatus;
  final_score_for?: number | null;
  final_score_against?: number | null;
  // Set on this device once the coach saves both final scores. The winner is
  // derived from those scores and is not stored on its own.
  final_scores_confirmed?: boolean;
}

export interface ParsedGame extends GameRecord {
  final_score_for: number | null;
  final_score_against: number | null;
}

export type StoredGame = GameRecord & { synced: boolean };

export interface GameStatistics {
  points: number;
  possessions: number;
  points_per_possession: number | null;
  offensive_rebounds: number;
  defensive_rebounds: number;
  turnovers: number;
}

export type GameWithStats = GameRecord & { stats: GameStatistics };
export type SeasonGame = Pick<
  GameRecord,
  "id" | "date" | "opponent_name" | "final_score_for" | "final_score_against"
> &
  GameStatistics;

export interface GameDetail extends GameWithStats {
  events: EventRecord[];
}

export interface SeasonSummary {
  team_id: number;
  games: SeasonGame[];
  totals: GameStatistics;
}

export interface PutGameRequest {
  id: string;
  team_id: number;
  date: string;
  opponent: string;
  created_at: string;
  final_score_for?: number;
  final_score_against?: number;
}

export type ValidationResult<T> = { value: T } | { error: string };

export interface DatabaseEnv {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export interface PagesContext<Params extends Record<string, string> = Record<string, string>> {
  request: Request;
  params: Params;
  env: DatabaseEnv;
}

export type EventSyncResult = { synced: number } | { status: 409; error: string };
