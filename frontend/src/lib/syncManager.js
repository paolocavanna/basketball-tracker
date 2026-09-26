// Background sync. A bench tap writes locally and then calls kick(), which
// returns immediately. This module never reads or writes the fields the live
// tally is computed from; after the server accepts a row it only flips `synced`.
//
// One pass runs at a time. A second trigger that arrives mid-pass is remembered
// and, when this pass succeeded, folded into a single follow-up so events saved
// during the request are not left behind and are not uploaded twice at once.
// A failed pass clears that follow-up. It does not schedule its own retry.
// The next online event, idle callback, or 10s tick is what tries again.
// Uploads are idempotent: a later pass may resend the same client ids.

const INTERVAL_MS = 10_000;
const JSON_HEADERS = { "Content-Type": "application/json" };

function apiGame(game) {
  const body = {
    id: game.id,
    team_id: game.team_id,
    date: game.date,
    opponent: game.opponent_name,
    created_at: game.created_at,
  };
  if (game.final_score_for != null) body.final_score_for = game.final_score_for;
  if (game.final_score_against != null) body.final_score_against = game.final_score_against;
  return body;
}

function apiEvent(event) {
  return {
    id: event.id,
    type: event.type,
    points: event.points,
    created_at: event.created_at,
  };
}

function accepted(response) {
  return Boolean(response && response.ok);
}

export function createSyncManager({
  store,
  fetch: fetchImpl = globalThis.fetch,
  target = globalThis,
  intervalMs = INTERVAL_MS,
  onSettled,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
  setInterval: scheduleInterval = globalThis.setInterval,
  clearInterval: cancelInterval = globalThis.clearInterval,
  ...timers
} = {}) {
  if (!store) throw new Error("createSyncManager requires a store");

  // `in` so a test can force the Safari fallback by passing undefined,
  // rather than inheriting a requestIdleCallback from the environment.
  const requestIdle =
    "requestIdleCallback" in timers ? timers.requestIdleCallback : globalThis.requestIdleCallback;
  const cancelIdle =
    "cancelIdleCallback" in timers ? timers.cancelIdleCallback : globalThis.cancelIdleCallback;

  let started = false;
  let stopped = false;
  let running = false;
  let rerun = false;
  let inflight = null;
  let intervalId = null;
  let idleHandle = null;
  let idleMode = null;

  function scheduleIdle() {
    if (stopped || idleHandle != null) return;
    const run = () => {
      idleHandle = null;
      idleMode = null;
      if (!stopped) void syncNow();
    };
    if (typeof requestIdle === "function") {
      idleMode = "ric";
      idleHandle = requestIdle(run);
      return;
    }
    // Safari has no requestIdleCallback. A timer still gets the work off the
    // tap turn, which is the property the live tracker needs.
    idleMode = "timeout";
    idleHandle = scheduleTimeout(run, 0);
  }

  function clearIdle() {
    if (idleHandle == null) return;
    if (idleMode === "ric") cancelIdle?.(idleHandle);
    else cancelTimeout(idleHandle);
    idleHandle = null;
    idleMode = null;
  }

  async function send(url, options) {
    try {
      return accepted(await fetchImpl(url, options));
    } catch {
      return false;
    }
  }

  async function syncGames() {
    let ok = true;
    const games = await store.pendingGames();
    for (const game of games) {
      const sent = await send(`/api/games/${encodeURIComponent(game.id)}`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(apiGame(game)),
      });
      if (!sent) {
        ok = false;
        continue;
      }
      const marked = await store.markGameSynced(game.id, game);
      if (!marked) ok = false;
    }
    return ok;
  }

  async function syncEventBatches() {
    let ok = true;
    const events = await store.pendingEvents();
    const groups = new Map();
    for (const event of events) {
      const batch = groups.get(event.game_id);
      if (batch) batch.push(event);
      else groups.set(event.game_id, [event]);
    }

    for (const [gameId, batch] of groups) {
      const game = await store.loadGame(gameId);
      // The sync route rejects events for a game the server has not stored yet.
      if (!game || !game.synced) {
        ok = false;
        continue;
      }
      const current = await store.loadGameEvents(gameId);
      const stillLive = new Set(current.filter((event) => !event.deleted).map((event) => event.id));
      const liveBatch = batch.filter((event) => stillLive.has(event.id));
      if (liveBatch.length === 0) continue;

      const sent = await send(`/api/games/${encodeURIComponent(gameId)}/events/sync`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(liveBatch.map(apiEvent)),
      });
      if (!sent) {
        ok = false;
        continue;
      }
      // Re-reads the rows inside the store. Anything undone while this POST was
      // in flight, including by another tab that already marked its tombstone
      // synced, is queued for DELETE again. The POST can recreate a row whose
      // DELETE already reached the server.
      await store.settlePostedEvents(liveBatch.map((event) => event.id));
    }
    return ok;
  }

  // One request per undone event: the API has no batch delete. A tombstone
  // that never reached the server still gets a DELETE, and that call is a
  // no-op there, which covers an undo that landed while the POST was in flight.
  // `forcedDeleteIds` covers the case where that DELETE already succeeded and
  // another tab marked the tombstone synced before this POST reinserted the row.
  async function syncDeletions() {
    let ok = true;
    const [deletions, forced] = await Promise.all([
      store.pendingDeletions(),
      store.forcedDeleteIds(),
    ]);
    const ids = [...new Set([...deletions.map((event) => event.id), ...forced])];
    for (const id of ids) {
      const sent = await send(`/api/events/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!sent) {
        ok = false;
        continue;
      }
      await store.markDeletionsSynced([id]);
      await store.clearForcedDeletes([id]);
    }
    return ok;
  }

  async function runPass() {
    const gamesOk = await syncGames();
    const eventsOk = await syncEventBatches();
    const deletionsOk = await syncDeletions();
    return gamesOk && eventsOk && deletionsOk;
  }

  async function execute() {
    try {
      for (;;) {
        rerun = false;
        if (stopped) return { ok: false };
        const ok = await runPass();
        if (!ok || stopped || !rerun) {
          rerun = false;
          return { ok: Boolean(ok) && !stopped };
        }
      }
    } catch {
      rerun = false;
      return { ok: false };
    }
  }

  function syncNow() {
    if (stopped) return Promise.resolve({ ok: false });
    if (running) {
      rerun = true;
      return inflight;
    }
    running = true;
    inflight = execute().finally(() => {
      running = false;
      inflight = null;
      // The hook is how the bench refreshes its dot. It must not change the
      // pass result, and it must not be awaited: a thrown or async listener
      // would either fail the sync or hold the single-flight lock.
      try {
        onSettled?.();
      } catch {
        // Status is advisory. The log is already in the state this pass left it.
      }
    });
    return inflight;
  }

  function onOnline() {
    void syncNow();
  }

  function kick() {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    scheduleIdle();
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    target.addEventListener("online", onOnline);
    intervalId = scheduleInterval(() => {
      void syncNow();
    }, intervalMs);
    scheduleIdle();
  }

  function stop() {
    stopped = true;
    if (started) target.removeEventListener("online", onOnline);
    started = false;
    if (intervalId != null) {
      cancelInterval(intervalId);
      intervalId = null;
    }
    clearIdle();
  }

  function settled() {
    return inflight ?? Promise.resolve({ ok: true });
  }

  return { start, stop, kick, syncNow, settled };
}
