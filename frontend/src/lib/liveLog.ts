import type { EventPayload, StoredEvent, StoredGame } from "../../../types.ts";
import type { LocalStore } from "./localStore.ts";
import type { SyncManager } from "./syncManager.ts";

// The bench tally is derived from this in-memory log. A tap appends to it
// synchronously, before IndexedDB or the network has answered, so the screen
// can repaint from the same record the store is about to persist.
//
// Kick runs only after that local write settles. An earlier kick can open a
// sync pass that reads the store before the row exists, then succeed with
// nothing to send and leave the tap waiting for the next trigger.

export interface TapClock {
  now?: () => string;
  newId?: () => string;
}

export function tapEvent(gameId: string, payload: EventPayload, clock: TapClock = {}): StoredEvent {
  const now = clock.now ?? (() => new Date().toISOString());
  const newId = clock.newId ?? (() => crypto.randomUUID());
  return {
    ...payload,
    id: newId(),
    game_id: gameId,
    created_at: now(),
    synced: false,
    deleted: false,
  };
}

// One retry covers a transient aborted transaction. The id is stable, so the
// second put replaces the first instead of creating a second tap.
function persist<T>(action: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(action).catch(action);
}

export type TapPersistOutcome =
  { ok: true; event: StoredEvent } | { ok: false; event: StoredEvent };
export type UndoPersistOutcome =
  { ok: true; event: StoredEvent | null } | { ok: false; event: StoredEvent };

export interface CommitTapOptions {
  store: Pick<LocalStore, "saveEvent">;
  sync: Pick<SyncManager, "kick">;
  gameId: string;
  payload: EventPayload;
  events: StoredEvent[];
  clock?: TapClock;
}

export function commitTap({ store, sync, gameId, payload, events, clock }: CommitTapOptions): {
  events: StoredEvent[];
  event: StoredEvent;
  persisted: Promise<TapPersistOutcome>;
} {
  const event = tapEvent(gameId, payload, clock);
  const next = [...events, event];
  const persisted = persist(() => store.saveEvent(event)).then(
    () => {
      sync.kick();
      return { ok: true as const, event };
    },
    () => ({ ok: false as const, event }),
  );
  return { events: next, event, persisted };
}

// Undo walks the log backwards so a tap that already synced can still be
// reversed. The store keeps that row as a tombstone and the sync manager
// DELETEs it later. `lastEvent` is a different question: it only reports rows
// that have not been uploaded yet.
export function commitUndo({
  store,
  sync,
  events,
}: {
  store: Pick<LocalStore, "deleteEvent">;
  sync: Pick<SyncManager, "kick">;
  events: StoredEvent[];
}): {
  events: StoredEvent[];
  undone: StoredEvent | null;
  persisted: Promise<UndoPersistOutcome>;
} {
  const index = events.findLastIndex((event) => !event.deleted);
  if (index < 0)
    return { events, undone: null, persisted: Promise.resolve({ ok: true, event: null }) };

  const undone = events[index];
  if (!undone)
    return { events, undone: null, persisted: Promise.resolve({ ok: true, event: null }) };
  const next = events.slice();
  next[index] = { ...undone, deleted: true, synced: false };
  const persisted = persist(() => store.deleteEvent(undone.id)).then(
    () => {
      sync.kick();
      return { ok: true as const, event: undone };
    },
    () => ({ ok: false as const, event: undone }),
  );
  return { events: next, undone, persisted };
}

export function formatPpp(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

export function isPending(
  game: Pick<StoredGame, "synced"> | null,
  events: readonly StoredEvent[],
): boolean {
  if (!game?.synced) return true;
  return events.some((event) => !event.synced);
}

// Copy only sync flags from the store. A tap or undo that has not reached
// IndexedDB yet stays as the screen already shows it, and a refresh must not
// put an undone row back into the tally.
export function mergeStoredEvents(
  local: readonly StoredEvent[],
  stored: readonly StoredEvent[],
): StoredEvent[] {
  const storedById = new Map(stored.map((event) => [event.id, event]));
  const localIds = new Set<string>();
  const merged = local.map((event) => {
    localIds.add(event.id);
    const saved = storedById.get(event.id);
    if (!saved) return event;
    if (event.deleted && !saved.deleted) return event;
    return { ...event, synced: saved.synced, deleted: saved.deleted };
  });
  for (const saved of stored) {
    if (!localIds.has(saved.id)) merged.push(saved);
  }
  // Same-millisecond taps share a timestamp. Their id order is random, so a
  // refresh must keep the order the bench already showed or Undo reverses the
  // other tap. Stored rows this screen has not seen yet still sort by time.
  const localOrder = new Map(local.map((event, index) => [event.id, index]));
  merged.sort((a, b) => {
    const time = a.created_at.localeCompare(b.created_at);
    if (time !== 0) return time;
    const aIndex = localOrder.get(a.id);
    const bIndex = localOrder.get(b.id);
    if (aIndex != null && bIndex != null) return aIndex - bIndex;
    return a.id.localeCompare(b.id);
  });
  return merged;
}
