// The local-first store. Every bench tap lands here first and never waits for
// the network, so the tracker can run with no connectivity at all.
//
// A record stays `synced: false` until the background sync manager has
// confirmed it. An undone event is soft-deleted rather than removed: it has to
// survive until its DELETE reaches the server, and `computeStats` ignores it
// in the meantime.
import type {
  EventType,
  GameRecord,
  GameStatus,
  NewStoredEvent,
  StoredEvent,
  StoredGame,
} from "../../../types.ts";

const DB_NAME = "basketball-tracker";
// Version 2 adds `forcedDeletes`. A posted event can be reinserted after another
// tab has already marked its tombstone synced, and that flag lives outside the
// event row so the other tab's sync write cannot clear it.
const DB_VERSION = 2;
const GAMES = "games";
const EVENTS = "events";
const FORCED_DELETES = "forcedDeletes";
const BY_GAME = "by_game";
interface ForcedDelete {
  id: string;
}

// The points a type carries unless the caller says otherwise. A SCORE is 2 or 3,
// everything else is 0, which is what the server's CHECK constraints allow.
const EVENT_POINTS: Record<EventType, 0 | 2> = {
  SCORE: 2,
  EMPTY: 0,
  TOV: 0,
  OFF_REB: 0,
  DEF_REB: 0,
};

// The log reads back in tap order. Equal timestamps are only possible for taps
// inside the same millisecond, where the id is as good an order as any and no
// derived stat changes either way.
const byCourtTime = (a: StoredEvent, b: StoredEvent) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

const byNewestGame = (a: StoredGame, b: StoredGame) =>
  String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) ||
  String(b.id).localeCompare(String(a.id));

// Rows written before `status` existed are still resumable games.
export function gameStatus(game: { status?: GameStatus | null }): GameStatus {
  return game.status === "finished" ? "finished" : "in-progress";
}

// Compared inside the write that flips `synced`, so a game edited while its
// upload was in flight is left pending instead of being marked sent.
function sameGame(game: StoredGame, expected: StoredGame): boolean {
  return (
    game.team_id === expected.team_id &&
    game.date === expected.date &&
    game.opponent_name === expected.opponent_name &&
    game.created_at === expected.created_at &&
    (game.final_score_for ?? null) === (expected.final_score_for ?? null) &&
    (game.final_score_against ?? null) === (expected.final_score_against ?? null)
  );
}

// IndexedDB's platform types do not associate a record shape with a store.
// Values crossing these helpers are records written by this module.
function readRecord<T>(request: IDBRequest<unknown>): Promise<T | null> {
  return onDone(request).then((record) => (record == null ? null : (record as T)));
}

function readRecords<T>() {
  return <TRecords extends unknown[]>(request: IDBRequest<TRecords>): Promise<T[]> =>
    onDone(request).then((records) => {
      if (!Array.isArray(records)) throw new Error("Unexpected IndexedDB result");
      return records as T[];
    });
}

function onDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Only oncomplete settles, so a write is never reported as done while its
// transaction can still abort.
function onTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
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
export interface LocalStoreOptions {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
}

export interface LocalStore {
  open(): Promise<IDBDatabase>;
  saveGame(game: GameRecord): Promise<StoredGame>;
  loadGame(id: string): Promise<StoredGame | null>;
  listGames(): Promise<StoredGame[]>;
  pendingGames(): Promise<StoredGame[]>;
  markGameSynced(id: string, expected?: StoredGame): Promise<boolean>;
  markGamePending(id: string): Promise<boolean>;
  saveEvent(event: NewStoredEvent): Promise<StoredEvent>;
  loadGameEvents(gameId: string): Promise<StoredEvent[]>;
  lastEvent(gameId: string): Promise<StoredEvent | null>;
  deleteEvent(id: string): Promise<StoredEvent | null>;
  pendingEventIds(gameId: string): Promise<string[]>;
  pendingEvents(): Promise<StoredEvent[]>;
  pendingDeletions(): Promise<StoredEvent[]>;
  markEventsSynced(ids: string[]): Promise<number>;
  settlePostedEvents(ids: string[]): Promise<string[]>;
  forcedDeleteIds(): Promise<string[]>;
  clearForcedDeletes(ids: string[]): Promise<void>;
  markDeletionsSynced(ids: string[]): Promise<number>;
}

export function createLocalStore({
  indexedDB,
  IDBKeyRange: keyRange,
}: LocalStoreOptions = {}): LocalStore {
  const factory = indexedDB ?? globalThis.indexedDB;
  const range = keyRange ?? globalThis.IDBKeyRange;
  if (!factory) {
    throw new Error("IndexedDB is not available");
  }
  if (!range) {
    throw new Error("IndexedDB key ranges are not available");
  }

  let dbPromise: Promise<IDBDatabase> | undefined;

  // Opened on first use, so nothing on the tap path has to remember an
  // initialisation step.
  const database = (): Promise<IDBDatabase> => (dbPromise ??= openDatabase(factory));

  function read<T>(storeName: string, run: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
    return database().then((db: IDBDatabase) => {
      const tx = db.transaction(storeName, "readonly");
      return run(tx.objectStore(storeName));
    });
  }

  function withWriteTransaction<T>(
    names: string[],
    run: (stores: IDBObjectStore[]) => Promise<T> | T,
  ): Promise<T> {
    return database().then(async (db: IDBDatabase) => {
      const tx = db.transaction(names, "readwrite");
      const stores = names.map((name) => tx.objectStore(name));
      const result = await run(stores);
      await onTransaction(tx);
      return result;
    });
  }

  function write<T>(storeName: string, run: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
    return withWriteTransaction([storeName], (stores) => run(stores[0]!));
  }

  function writeMany<T>(
    storeNames: string[],
    run: (stores: IDBObjectStore[]) => Promise<T> | T,
  ): Promise<T> {
    return withWriteTransaction(storeNames, run);
  }

  function log(store: IDBObjectStore, gameId: string): Promise<StoredEvent[]> {
    return readRecords<StoredEvent>()(store.index(BY_GAME).getAll(range.only(gameId))).then(
      (events) => events.sort(byCourtTime),
    );
  }

  // A game is a few hundred events, so the still-pending ones are picked out of
  // the log rather than kept in a second index.
  const queued = (store: IDBObjectStore, gameId: string): Promise<StoredEvent[]> =>
    log(store, gameId).then((events) => events.filter((event) => !event.synced && !event.deleted));

  const everyEvent = (store: IDBObjectStore): Promise<StoredEvent[]> =>
    readRecords<StoredEvent>()(store.getAll()).then((events) => events.sort(byCourtTime));

  return {
    open: database,

    saveGame(game: GameRecord) {
      const record: StoredGame = {
        id: game.id,
        team_id: game.team_id,
        date: game.date,
        opponent_name: game.opponent_name,
        created_at: game.created_at,
        status: game.status === "finished" ? "finished" : "in-progress",
        final_score_for: game.final_score_for ?? null,
        final_score_against: game.final_score_against ?? null,
        final_scores_confirmed: game.final_scores_confirmed === true,
        synced: false,
      };
      return write(GAMES, async (store) => {
        await onDone(store.put(record));
        return record;
      });
    },

    loadGame(id: string) {
      return read(GAMES, (store) => readRecord<StoredGame>(store.get(id)));
    },

    listGames() {
      return read(GAMES, (store) =>
        readRecords<StoredGame>()(store.getAll()).then((games) => games.sort(byNewestGame)),
      );
    },

    pendingGames() {
      return read(GAMES, (store) =>
        readRecords<StoredGame>()(store.getAll()).then((games) =>
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
    markGameSynced(id: string, expected?: StoredGame) {
      return write(GAMES, async (store) => {
        const game = await readRecord<StoredGame>(store.get(id));
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
    markGamePending(id: string) {
      return write(GAMES, async (store) => {
        const game = await readRecord<StoredGame>(store.get(id));
        if (!game) return false;
        if (!game.synced) return true;
        await onDone(store.put({ ...game, synced: false }));
        return true;
      });
    },

    // A local write always leaves the record queued: anything written here has
    // to reach the server, whether it is a fresh tap or a correction.
    saveEvent(event: NewStoredEvent) {
      const defaultPoints = EVENT_POINTS[event.type];
      if (defaultPoints === undefined) {
        return Promise.reject(new Error(`Unknown event type: ${event?.type}`));
      }
      const common = {
        id: event.id ?? crypto.randomUUID(),
        game_id: event.game_id,
        created_at: event.created_at ?? new Date().toISOString(),
        synced: false,
        deleted: false,
      };
      const record: StoredEvent =
        event.type === "SCORE"
          ? { ...common, type: "SCORE", points: event.points ?? 2 }
          : { ...common, type: event.type, points: 0 };
      return write(EVENTS, async (store) => {
        await onDone(store.put(record));
        return record;
      });
    },

    loadGameEvents(gameId: string) {
      return read(EVENTS, (store) => log(store, gameId));
    },

    // Latest tap that has not been uploaded yet. The bench Undo walks the
    // in-memory log instead, so an already-synced tap can still be reversed.
    lastEvent(gameId: string) {
      return read(EVENTS, (store) =>
        queued(store, gameId).then((events) => events[events.length - 1] ?? null),
      );
    },

    // The row stays in the log so the live tally can drop it immediately, and
    // stays unsynced so a later pass can DELETE it, even if it was already posted.
    deleteEvent(id: string) {
      return write(EVENTS, async (store) => {
        const event = await readRecord<StoredEvent>(store.get(id));
        if (!event) return null;
        await onDone(store.put({ ...event, deleted: true, synced: false }));
        return event;
      });
    },

    pendingEventIds(gameId: string) {
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
    markEventsSynced(ids: string[]) {
      return write(EVENTS, async (store) => {
        const found = (
          await Promise.all(ids.map((id) => readRecord<StoredEvent>(store.get(id))))
        ).filter((event) => event != null && !event.deleted);
        await Promise.all(found.map((event) => onDone(store.put({ ...event, synced: true }))));
        return found.length;
      });
    },

    // Called after a batch POST is accepted. Live rows are marked synced.
    // Tombstones are queued again, including ones another tab already marked
    // synced: that tab's DELETE can have landed before this POST reinserted
    // the row, and its later write must not erase the new delete.
    settlePostedEvents(ids: string[]) {
      return writeMany([EVENTS, FORCED_DELETES], async ([events, forced]) => {
        if (!events || !forced) throw new Error("Local database stores are unavailable");
        const found = (
          await Promise.all(ids.map((id) => readRecord<StoredEvent>(events.get(id))))
        ).filter((event) => event != null);
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
        readRecords<ForcedDelete>()(store.getAll()).then((rows) =>
          rows.map((row) => row.id).sort(),
        ),
      );
    },

    clearForcedDeletes(ids: string[]) {
      return write(FORCED_DELETES, async (store) => {
        await Promise.all(ids.map((id) => onDone(store.delete(id))));
      });
    },

    markDeletionsSynced(ids: string[]) {
      return write(EVENTS, async (store) => {
        const found = (
          await Promise.all(ids.map((id) => readRecord<StoredEvent>(store.get(id))))
        ).filter((event) => event != null && event.deleted);
        await Promise.all(found.map((event) => onDone(store.put({ ...event, synced: true }))));
        return found.length;
      });
    },
  };
}
