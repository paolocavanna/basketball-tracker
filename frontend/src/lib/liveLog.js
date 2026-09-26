// The bench tally is derived from this in-memory log. A tap appends to it
// synchronously, before IndexedDB or the network has answered, so the screen
// can repaint from the same record the store is about to persist.
//
// Kick runs only after that local write settles. An earlier kick can open a
// sync pass that reads the store before the row exists, then succeed with
// nothing to send and leave the tap waiting for the next trigger.

export function tapEvent(gameId, type, points, clock = {}) {
  const now = clock.now ?? (() => new Date().toISOString());
  const newId = clock.newId ?? (() => crypto.randomUUID());
  return {
    id: newId(),
    game_id: gameId,
    type,
    points,
    created_at: now(),
    synced: false,
    deleted: false,
  };
}

// One retry covers a transient aborted transaction. The id is stable, so the
// second put replaces the first instead of creating a second tap.
function persist(action) {
  return Promise.resolve().then(action).catch(action);
}

export function commitTap({ store, sync, gameId, type, points, events, clock }) {
  const event = tapEvent(gameId, type, points, clock);
  const next = [...events, event];
  const persisted = persist(() => store.saveEvent(event)).then(
    () => {
      sync.kick();
      return { ok: true, event };
    },
    () => ({ ok: false, event }),
  );
  return { events: next, event, persisted };
}

// Undo walks the log backwards so a tap that already synced can still be
// reversed. The store keeps that row as a tombstone and the sync manager
// DELETEs it later. `lastEvent` is a different question: it only reports rows
// that have not been uploaded yet.
export function commitUndo({ store, sync, events }) {
  const index = events.findLastIndex((event) => !event.deleted);
  if (index < 0)
    return { events, undone: null, persisted: Promise.resolve({ ok: true, event: null }) };

  const undone = events[index];
  const next = events.slice();
  next[index] = { ...undone, deleted: true, synced: false };
  const persisted = persist(() => store.deleteEvent(undone.id)).then(
    () => {
      sync.kick();
      return { ok: true, event: undone };
    },
    () => ({ ok: false, event: undone }),
  );
  return { events: next, undone, persisted };
}

export function formatPpp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

export function isPending(game, events) {
  if (!game?.synced) return true;
  return events.some((event) => !event.synced);
}

// Copy only sync flags from the store. A tap or undo that has not reached
// IndexedDB yet stays as the screen already shows it, and a refresh must not
// put an undone row back into the tally.
export function mergeStoredEvents(local, stored) {
  const storedById = new Map(stored.map((event) => [event.id, event]));
  const localIds = new Set();
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
