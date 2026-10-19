import type {
  GamePlayerRecord,
  PlayerShift,
  StoredGamePlayer,
  StoredPlayerShift,
} from "../../../types.ts";
import type { LocalStore } from "./localStore.ts";

export const PLAYERS_ON_COURT = 5;

export interface PlayerUsage {
  player_id: string;
  player_name: string;
  seconds: number;
  on_court: boolean;
}

export interface SubstitutionUndo {
  outgoing: StoredGamePlayer;
  incoming: StoredGamePlayer;
  closedShift: StoredPlayerShift | null;
  openedShiftId: string | null;
}

const timestamp = (now: number): string => new Date(now).toISOString();

function shiftSeconds(shifts: readonly StoredPlayerShift[], playerId: string, now: number): number {
  return shifts
    .filter((shift) => shift.player_id === playerId)
    .reduce((total, shift) => {
      const start = Date.parse(shift.started_at);
      const end = shift.ended_at == null ? now : Date.parse(shift.ended_at);
      return (
        total +
        (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) / 1000 : 0)
      );
    }, 0);
}

export function calculateUsage(
  players: readonly StoredGamePlayer[],
  shifts: readonly StoredPlayerShift[],
  now = Date.now(),
): PlayerUsage[] {
  return players
    .filter((player) => player.available)
    .map((player) => ({
      player_id: player.player_id,
      player_name: player.player_name,
      seconds: player.manual_playing_time_seconds ?? shiftSeconds(shifts, player.player_id, now),
      on_court: player.on_court,
    }))
    .sort((a, b) => a.player_name.localeCompare(b.player_name));
}

export function formatPlayingTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

export function elapsedGameSeconds(
  timer: { elapsed_ms: number; running_since: string | null } | null,
  now = Date.now(),
): number {
  if (!timer) return 0;
  const current =
    timer.running_since == null ? 0 : Math.max(0, now - Date.parse(timer.running_since));
  return Math.floor((timer.elapsed_ms + current) / 1000);
}

export function gameRoster(
  gameId: string,
  roster: readonly { id: string; name: string; active: boolean }[],
  availableIds: readonly string[],
  starterIds: readonly string[],
): GamePlayerRecord[] {
  const available = new Set(availableIds);
  const starters = new Set(starterIds);
  return roster
    .filter((player) => player.active)
    .map((player) => ({
      game_id: gameId,
      player_id: player.id,
      player_name: player.name,
      available: available.has(player.id),
      starter: starters.has(player.id),
      on_court: starters.has(player.id),
      manual_playing_time_seconds: null,
    }));
}

export async function startGameClock(
  store: LocalStore,
  gameId: string,
  now = Date.now(),
): Promise<boolean> {
  const timer = await store.loadGameTimer(gameId);
  if (timer?.running_since) return true;
  const lineup = (await store.loadGamePlayers(gameId)).filter((player) => player.on_court);
  if (lineup.length !== PLAYERS_ON_COURT) return false;
  const at = timestamp(now);
  await Promise.all([
    store.saveGameTimer({
      game_id: gameId,
      elapsed_ms: timer?.elapsed_ms ?? 0,
      running_since: at,
    }),
    ...lineup.map((player) => {
      const shift: PlayerShift = {
        id: crypto.randomUUID(),
        game_id: gameId,
        player_id: player.player_id,
        started_at: at,
        ended_at: null,
      };
      return store.savePlayerShift(shift);
    }),
  ]);
  return true;
}

export async function pauseGameClock(
  store: LocalStore,
  gameId: string,
  now = Date.now(),
): Promise<void> {
  const timer = await store.loadGameTimer(gameId);
  if (!timer?.running_since) return;
  const at = timestamp(now);
  const shifts = await store.loadPlayerShifts(gameId);
  const open = shifts.filter((shift) => shift.ended_at == null);
  const elapsed = Math.max(0, now - Date.parse(timer.running_since));
  await Promise.all([
    store.saveGameTimer({
      game_id: gameId,
      elapsed_ms: timer.elapsed_ms + elapsed,
      running_since: null,
    }),
    ...open.map((shift) => store.savePlayerShift({ ...shift, ended_at: at })),
  ]);
}

export async function substitutePlayers(
  store: LocalStore,
  gameId: string,
  outgoingId: string,
  incomingId: string,
  now = Date.now(),
): Promise<SubstitutionUndo | null> {
  const [players, timer, shifts] = await Promise.all([
    store.loadGamePlayers(gameId),
    store.loadGameTimer(gameId),
    store.loadPlayerShifts(gameId),
  ]);
  const outgoing = players.find((player) => player.player_id === outgoingId && player.on_court);
  const incoming = players.find(
    (player) => player.player_id === incomingId && player.available && !player.on_court,
  );
  if (!outgoing || !incoming) return null;

  const outShift = timer?.running_since
    ? (shifts.find((shift) => shift.player_id === outgoingId && shift.ended_at == null) ?? null)
    : null;
  const openedShiftId = timer?.running_since ? crypto.randomUUID() : null;
  const at = timestamp(now);
  const nextOut = { ...outgoing, on_court: false };
  const nextIn = { ...incoming, on_court: true };
  const operations: Promise<unknown>[] = [
    store.updateGamePlayer(nextOut),
    store.updateGamePlayer(nextIn),
  ];
  if (outShift) operations.push(store.savePlayerShift({ ...outShift, ended_at: at }));
  if (openedShiftId) {
    operations.push(
      store.savePlayerShift({
        id: openedShiftId,
        game_id: gameId,
        player_id: incomingId,
        started_at: at,
        ended_at: null,
      }),
    );
  }
  await Promise.all(operations);
  return { outgoing, incoming, closedShift: outShift, openedShiftId };
}

export async function undoSubstitution(store: LocalStore, undo: SubstitutionUndo): Promise<void> {
  await Promise.all([
    store.updateGamePlayer(undo.outgoing),
    store.updateGamePlayer(undo.incoming),
    ...(undo.openedShiftId ? [store.deletePlayerShift(undo.openedShiftId)] : []),
    ...(undo.closedShift ? [store.savePlayerShift(undo.closedShift)] : []),
  ]);
}

export async function savePlayingTimeOverride(
  store: LocalStore,
  player: StoredGamePlayer,
  seconds: number,
  gameDurationSeconds: number,
): Promise<boolean> {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > gameDurationSeconds) return false;
  await store.updateGamePlayer({
    ...player,
    manual_playing_time_seconds: seconds,
  });
  return true;
}
