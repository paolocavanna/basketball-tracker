// The local-first store. Every bench tap lands here first and never waits for
// the network, so the tracker can run with no connectivity at all.
//
// A record stays `synced: false` until the background sync manager has
// confirmed it. An undone event is soft-deleted rather than removed: it has to
// survive until its DELETE reaches the server, and `computeStats` ignores it
// in the meantime.
const DB_NAME = "basketball-tracker";
// Version 2 adds `forcedDeletes`. A posted event can be reinserted after another
// tab has already marked its tombstone synced, and that flag lives outside the
// event row so the other tab's sync write cannot clear it.
const DB_VERSION = 2;
const GAMES = "games";
const EVENTS = "events";
const FORCED_DELETES = "forcedDeletes";
const BY_GAME = "by_game";

// The points a type carries unless the caller says otherwise. A SCORE is 2 or 3,
// everything else is 0, which is what the server's CHECK constraints allow.
const EVENT_POINTS = {
  SCORE: 2,
  EMPTY: 0,
  TOV: 0,
  OFF_REB: 0,
  DEF_REB: 0,
};

// The log reads back in tap order. Equal timestamps are only possible for taps
// inside the same millisecond, where the id is as good an order as any and no
// derived stat changes either way.
const byCourtTime = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

// Compared inside the write that flips `synced`, so a game edited while its
// upload was in flight is left pending instead of being marked sent.
function sameGame(game, expected) {
  return (
    game.team_id === expected.team_id &&
    game.date === expected.date &&
    game.opponent_name === expected.opponent_name &&
    game.created_at === expected.created_at &&
    (game.final_score_for ?? null) === (expected.final_score_for ?? null) &&
    (game.final_score_against ?? null) === (expected.final_score_against ?? null)
  );
}

function onDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Reading a single row is on the opening path, so a missing record resolves to
// null rather than an error the caller has to filter out.
function onOptional(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

// Only oncomplete settles, so a write is never reported as done while its
// transaction can still abort.
function onTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GAMES)) {
        db.createObjectStore(GAMES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(EVENTS)) {
        const store = db.createObjectStore(EVENTS, { keyPath: "id" });
        store.createIndex(BY_GAME, "game_id");
      }
      if (!db.objectStoreNames.contains(FORCED_DELETES)) {
        db.createObjectStore(FORCED_DELETES, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local database upgrade blocked"));
  });
}

// The factory is a parameter so tests can point the same code at an isolated
// database instead of the real one.
export function createLocalStore({ indexedDB, IDBKeyRange: keyRange } = {}) {
  const factory = indexedDB ?? globalThis.indexedDB;
  const range = keyRange ?? globalThis.IDBKeyRange;
  if (!factory) {
    throw new Error("IndexedDB is not available");
  }

  let dbPromise;

  // Opened on first use, so nothing on the tap path has to remember an
  // initialisation step.
  const database = () => (dbPromise ??= openDatabase(factory));

  function read(storeName, run) {
    return database().then((db) => {
      const tx = db.transaction(storeName, "readonly");
      return run(tx.objectStore(storeName));
    });
  }

  function write(storeName, run) {
    const names = Array.isArray(storeName) ? storeName : [storeName];
    return database().then(async (db) => {
      const tx = db.transaction(names, "readwrite");
      const stores = names.map((name) => tx.objectStore(name));
      const result = await run(names.length === 1 ? stores[0] : stores);
      await onTransaction(tx);
      return result;
    });
  }

  function log(store, gameId) {
    return onDone(store.index(BY_GAME).getAll(range.only(gameId))).then((events) =>
      events.sort(byCourtTime),
    );
  }

  // A game is a few hundred events, so the still-pending ones are picked out of
  // the log rather than kept in a second index.
  const queued = (store, gameId) =>
    log(store, gameId).then((events) => events.filter((event) => !event.synced && !event.deleted));

  const everyEvent = (store) => onDone(store.getAll()).then((events) => events.sort(byCourtTime));

  return {
    open: database,

    saveGame(game) {
      const record = { ...game, synced: false };
      return write(GAMES, async (store) => {
        await onDone(store.put(record));
        return record;
      });
    },

    loadGame(id) {
      return read(GAMES, (store) => onOptional(store.get(id)));
    },

    pendingGames() {
      return read(GAMES, (store) =>
        onDone(store.getAll()).then((games) =>
          games
            .filter((game) => !game.synced)
            .sort(
              (a, b) =>
                String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
                String(a.id).localeCompare(String(b.id)),
            ),
        ),
      );
    },

    // `expected` is the row that was uploaded. The flag flips only when that
    // row is still the one stored, so a newer local edit stays queued.
    markGameSynced(id, expected) {
      return write(GAMES, async (store) => {
        const game = await onOptional(store.get(id));
        if (!game) return false;
        if (expected && !sameGame(game, expected)) return false;
        if (game.synced) return true;
        await onDone(store.put({ ...game, synced: true }));
        return true;
      });
    },

    // The inverse of markGameSynced, for when the server turns out not to have
    // the row after all: a wiped database, a restore from backup. The game goes
    // back in the queue so the next pass PUTs it again.
    markGamePending(id) {
      return write(GAMES, async (store) => {
        const game = await onOptional(store.get(id));
        if (!game) return false;
        if (!game.synced) return true;
        await onDone(store.put({ ...game, synced: false }));
        return true;
      });
    },

    // A local write always leaves the record queued: anything written here has
    // to reach the server, whether it is a fresh tap or a correction.
    saveEvent(event) {
      const defaultPoints = EVENT_POINTS[event?.type];
      if (defaultPoints === undefined) {
        return Promise.reject(new Error(`Unknown event type: ${event?.type}`));
      }
      const record = {
        id: event.id ?? crypto.randomUUID(),
        game_id: event.game_id,
        type: event.type,
        points: event.points ?? defaultPoints,
        created_at: event.created_at ?? new Date().toISOString(),
        synced: false,
        deleted: false,
      };
      return write(EVENTS, async (store) => {
        await onDone(store.put(record));
        return record;
      });
    },

    loadGameEvents(gameId) {
      return read(EVENTS, (store) => log(store, gameId));
    },

    // Latest tap that has not been uploaded yet. The bench Undo walks the
    // in-memory log instead, so an already-synced tap can still be reversed.
    lastEvent(gameId) {
      return read(EVENTS, (store) =>
        queued(store, gameId).then((events) => events[events.length - 1] ?? null),
      );
    },

    // The row stays in the log so the live tally can drop it immediately, and
    // stays unsynced so a later pass can DELETE it, even if it was already posted.
    deleteEvent(id) {
      return write(EVENTS, async (store) => {
        const event = await onOptional(store.get(id));
        if (!event) return null;
        await onDone(store.put({ ...event, deleted: true, synced: false }));
        return event;
      });
    },

    pendingEventIds(gameId) {
      return read(EVENTS, (store) =>
        queued(store, gameId).then((events) => events.map((event) => event.id)),
      );
    },

    pendingEvents() {
      return read(EVENTS, (store) =>
        everyEvent(store).then((events) =>
          events.filter((event) => !event.synced && !event.deleted),
        ),
      );
    },

    pendingDeletions() {
      return read(EVENTS, (store) =>
        everyEvent(store).then((events) =>
          events.filter((event) => event.deleted && !event.synced),
        ),
      );
    },

    // One get per id: getAll would read its argument as a key range.
    // A row undone while this batch was uploading is left untouched, so the
    // delete pass can still see it.
    markEventsSynced(ids) {
      return write(EVENTS, async (store) => {
        const found = (await Promise.all(ids.map((id) => onOptional(store.get(id))))).filter(
          (event) => event != null && !event.deleted,
        );
        await Promise.all(found.map((event) => onDone(store.put({ ...event, synced: true }))));
        return found.length;
      });
    },

    // Called after a batch POST is accepted. Live rows are marked synced.
    // Tombstones are queued again, including ones another tab already marked
    // synced: that tab's DELETE can have landed before this POST reinserted
    // the row, and its later write must not erase the new delete.
    settlePostedEvents(ids) {
      return write([EVENTS, FORCED_DELETES], async ([events, forced]) => {
        const found = (await Promise.all(ids.map((id) => onOptional(events.get(id))))).filter(
          (event) => event != null,
        );
        const deletedIds = found.filter((event) => event.deleted).map((event) => event.id);
        await Promise.all([
          ...found.map((event) =>
            onDone(events.put({ ...event, synced: event.deleted ? false : true })),
          ),
          ...deletedIds.map((id) => onDone(forced.put({ id }))),
        ]);
        return deletedIds;
      });
    },

    forcedDeleteIds() {
      return read(FORCED_DELETES, (store) =>
        onDone(store.getAll()).then((rows) => rows.map((row) => row.id).sort()),
      );
    },

    clearForcedDeletes(ids) {
      return write(FORCED_DELETES, async (store) => {
        await Promise.all(ids.map((id) => onDone(store.delete(id))));
      });
    },

    markDeletionsSynced(ids) {
      return write(EVENTS, async (store) => {
        const found = (await Promise.all(ids.map((id) => onOptional(store.get(id))))).filter(
          (event) => event != null && event.deleted,
        );
        await Promise.all(found.map((event) => onDone(store.put({ ...event, synced: true }))));
        return found.length;
      });
    },
  };
}
