<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import text from "../text/en.json";
import { applyFinishChoice, persistDerivedScore } from "../lib/gameLifecycle.ts";
import { commitTap, commitUndo, formatPpp, isPending, mergeStoredEvents } from "../lib/liveLog.ts";
import { gameStatus } from "../lib/localStore.ts";
import type { LocalStore } from "../lib/localStore.ts";
import { summaryPath } from "../lib/route.ts";
import { computeStats } from "../lib/stats.ts";
import {
  calculateUsage,
  elapsedGameSeconds,
  formatPlayingTime,
  pauseGameClock,
  startGameClock,
  substitutePlayers,
  undoSubstitution,
} from "../lib/playingTime.ts";
import type { SubstitutionUndo } from "../lib/playingTime.ts";
import type { SyncManager } from "../lib/syncManager.ts";
import type {
  EventPayload,
  GameTimerRecord,
  StoredEvent,
  StoredGame,
  StoredGamePlayer,
  StoredPlayerShift,
} from "../../../types.ts";

type LabeledAction = EventPayload & {
  label: string;
  tone: "score" | "empty" | "turnover" | "rebound";
  place: "points" | "rest";
};

const ACTIONS = [
  { type: "FT", points: 1, label: text.actions.one, tone: "score", place: "points" },
  { type: "SCORE", points: 2, label: text.actions.two, tone: "score", place: "points" },
  { type: "SCORE", points: 3, label: text.actions.three, tone: "score", place: "points" },
  { type: "EMPTY", points: 0, label: text.actions.empty, tone: "empty", place: "rest" },
  { type: "TOV", points: 0, label: text.actions.turnover, tone: "turnover", place: "rest" },
  {
    type: "OFF_REB",
    points: 0,
    label: text.actions.offensiveRebound,
    tone: "rebound",
    place: "rest",
  },
  {
    type: "DEF_REB",
    points: 0,
    label: text.actions.defensiveRebound,
    tone: "rebound",
    place: "rest",
  },
] satisfies LabeledAction[];

const props = defineProps<{
  gameId: string;
  store: LocalStore;
  sync: SyncManager;
  statusTick: number;
}>();

const emit = defineEmits<{ navigate: [path: string] }>();

const game = ref<StoredGame | null>(null);
const events = ref<StoredEvent[]>([]);
const ready = ref(false);
const missing = ref(false);
const failed = ref(false);
const notice = ref("");
const finishing = ref(false);
const finishError = ref("");
const finishDialog = ref<HTMLDialogElement | null>(null);
const lineupDialog = ref<HTMLDialogElement | null>(null);
const players = ref<StoredGamePlayer[]>([]);
const shifts = ref<StoredPlayerShift[]>([]);
const timer = ref<GameTimerRecord | null>(null);
const clockNow = ref(Date.now());
const selectedOut = ref("");
const selectedIn = ref("");
const lastSubstitution = ref<SubstitutionUndo | null>(null);
let clockInterval: ReturnType<typeof setInterval> | undefined;
let refreshToken = 0;

// One source of truth for the button captions, so Undo can name the tap it
// would reverse without repeating the labels.
const EVENT_LABELS = new Map(
  ACTIONS.map((action) => [`${action.type}:${action.points}`, action.label]),
);

const stats = computed(() => computeStats(events.value));
const pending = computed(() => isPending(game.value, events.value));
const canUndo = computed(() => events.value.some((event) => !event.deleted));
const finished = computed(() => (game.value ? gameStatus(game.value) === "finished" : false));
const ppp = computed(() => formatPpp(stats.value.points_per_possession));
const gameSeconds = computed(() => elapsedGameSeconds(timer.value, clockNow.value));
const clockLabel = computed(() => formatPlayingTime(gameSeconds.value));
const running = computed(() => timer.value?.running_since != null);
const usage = computed(() => calculateUsage(players.value, shifts.value, clockNow.value));
const onCourt = computed(() =>
  players.value.filter((player) => player.on_court && player.available),
);
const benchPlayers = computed(() =>
  players.value.filter((player) => player.available && !player.on_court),
);
const undoLabel = computed(() => {
  const last = events.value.findLast((event) => !event.deleted);
  return last ? (EVENT_LABELS.get(`${last.type}:${last.points}`) ?? "") : "";
});

function rememberFinishedScore(next: StoredEvent[]): void {
  const current = game.value;
  if (!current || gameStatus(current) !== "finished") return;
  void persistDerivedScore(props.store, current, next).then(
    (saved) => {
      if (saved) game.value = saved;
    },
    () => {
      notice.value = text.tracker.notSaved;
    },
  );
}

function record(action: (typeof ACTIONS)[number]): void {
  if (!ready.value || missing.value || failed.value) return;
  notice.value = "";
  const result = commitTap({
    store: props.store,
    sync: props.sync,
    gameId: props.gameId,
    payload: action,
    events: events.value,
  });
  events.value = result.events;
  void result.persisted.then((outcome) => {
    if (!outcome.ok) {
      events.value = events.value.filter((event) => event.id !== outcome.event.id);
      notice.value = text.tracker.notSaved;
      return;
    }
    rememberFinishedScore(events.value);
  });
}

function undo(): void {
  if (!ready.value || !canUndo.value) return;
  notice.value = "";
  const result = commitUndo({
    store: props.store,
    sync: props.sync,
    events: events.value,
  });
  events.value = result.events;
  void result.persisted.then((outcome) => {
    if (!outcome.ok) {
      if (!outcome.event) return;
      events.value = events.value.map((event) =>
        event.id === outcome.event.id ? outcome.event : event,
      );
      notice.value = text.tracker.notSaved;
      return;
    }
    rememberFinishedScore(events.value);
  });
}

function requestFinish(): void {
  const current = game.value;
  if (!current || !ready.value || missing.value || failed.value) return;
  if (gameStatus(current) === "finished") {
    emit("navigate", summaryPath(props.gameId));
    return;
  }
  finishError.value = "";
  const dialog = finishDialog.value;
  if (dialog && !dialog.open) dialog.showModal();
}

function closeFinish(): void {
  finishDialog.value?.close();
}

async function confirmFinish(): Promise<void> {
  const current = game.value;
  if (!current || finishing.value) return;
  finishing.value = true;
  finishError.value = "";
  try {
    await pauseGameClock(props.store, props.gameId);
    await refreshPlayingTime();
    game.value = await applyFinishChoice(props.store, "confirm", current, events.value);
  } catch {
    finishing.value = false;
    finishError.value = text.tracker.finishSaveError;
    return;
  }
  props.sync.kick();
  finishDialog.value?.close();
  finishing.value = false;
  emit("navigate", summaryPath(props.gameId));
}

async function refreshPlayingTime(): Promise<void> {
  const [storedPlayers, storedShifts, storedTimer] = await Promise.all([
    props.store.loadGamePlayers(props.gameId),
    props.store.loadPlayerShifts(props.gameId),
    props.store.loadGameTimer(props.gameId),
  ]);
  players.value = storedPlayers;
  shifts.value = storedShifts;
  timer.value = storedTimer;
  clockNow.value = Date.now();
}

async function toggleClock(): Promise<void> {
  if (!ready.value || finished.value) return;
  if (running.value) await pauseGameClock(props.store, props.gameId);
  else await startGameClock(props.store, props.gameId);
  lastSubstitution.value = null;
  await refreshPlayingTime();
}

function openLineup(): void {
  selectedOut.value = "";
  selectedIn.value = "";
  lineupDialog.value?.showModal();
}

async function confirmSubstitution(): Promise<void> {
  if (!selectedOut.value || !selectedIn.value) return;
  lastSubstitution.value = await substitutePlayers(
    props.store,
    props.gameId,
    selectedOut.value,
    selectedIn.value,
  );
  await refreshPlayingTime();
  lineupDialog.value?.close();
}

async function undoLastSubstitution(): Promise<void> {
  if (!lastSubstitution.value) return;
  await undoSubstitution(props.store, lastSubstitution.value);
  lastSubstitution.value = null;
  await refreshPlayingTime();
}

// A pass can settle while the log is still opening, and two refreshes can
// overlap. Only the newest read may paint, and opening refreshes once it is
// ready so that early pass is not dropped on the floor.
async function refreshSyncFlags(): Promise<void> {
  if (!ready.value || missing.value || failed.value) return;
  const token = ++refreshToken;
  const [storedGame, storedEvents] = await Promise.all([
    props.store.loadGame(props.gameId),
    props.store.loadGameEvents(props.gameId),
  ]);
  if (token !== refreshToken || !ready.value || missing.value) return;
  if (storedGame) game.value = storedGame;
  events.value = mergeStoredEvents(events.value, storedEvents);
  await refreshPlayingTime();
}

onMounted(async () => {
  try {
    const [storedGame, storedEvents] = await Promise.all([
      props.store.loadGame(props.gameId),
      props.store.loadGameEvents(props.gameId),
    ]);
    if (!storedGame) {
      missing.value = true;
    } else {
      game.value = storedGame;
      events.value = storedEvents;
    }
  } catch {
    failed.value = true;
  } finally {
    ready.value = true;
  }
  await refreshPlayingTime();
  await refreshSyncFlags();
  clockInterval = globalThis.setInterval(() => {
    clockNow.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (clockInterval) globalThis.clearInterval(clockInterval);
});

watch(
  () => props.statusTick,
  () => {
    void refreshSyncFlags();
  },
);
</script>

<template>
  <section v-if="missing" class="bench bench-message">
    <h1>{{ text.tracker.notOnDeviceTitle }}</h1>
    <p>{{ text.tracker.notOnDeviceBody }}</p>
    <button type="button" class="start" @click="emit('navigate', '/')">
      {{ text.tracker.startGame }}
    </button>
  </section>

  <section v-else-if="failed" class="bench bench-message">
    <h1>{{ text.tracker.logUnavailableTitle }}</h1>
    <p>{{ text.tracker.logUnavailableBody }}</p>
  </section>

  <section v-else class="bench">
    <header class="top">
      <a href="/" @click.prevent="$emit('navigate', '/')">
        <img class="club-mark" src="/campus-monferrato.png" :alt="text.brand.team" />
      </a>
      <p class="opponent">vs {{ game?.opponent_name || text.tracker.live }}</p>
      <p
        class="sync-pill"
        :class="{ 'sync-pill-pending': pending && !notice, 'sync-pill-alert': notice }"
        role="status"
        :aria-label="notice ? text.tracker.saveFailureLabel : undefined"
      >
        <span class="sync-dot" aria-hidden="true"></span>
        <span>{{ notice || (pending ? text.tracker.pending : text.tracker.synced) }}</span>
      </p>
    </header>

    <div class="playing-time-strip">
      <div class="game-clock" role="timer" :aria-label="`${text.tracker.gameClock} ${clockLabel}`">
        <span class="clock-caption">{{ text.tracker.gameClock }}</span>
        <span class="clock-value">{{ clockLabel }}</span>
      </div>
      <button type="button" class="clock-toggle" :disabled="finished" @click="toggleClock">
        {{ running ? text.tracker.pauseClock : text.tracker.startClock }}
      </button>
      <button type="button" class="lineup-open" @click="openLineup">
        {{ text.tracker.lineup }} · {{ onCourt.length }}/5
      </button>
    </div>
    <div class="court-names" :aria-label="text.tracker.playersOnCourt">
      <span
        v-for="player in usage.filter((entry) => entry.on_court)"
        :key="player.player_id"
        class="court-name"
      >
        {{ player.player_name }} · {{ formatPlayingTime(player.seconds) }}
      </span>
    </div>

    <div class="scoreboard">
      <p class="score">{{ stats.points }}</p>
      <p class="score-label">{{ text.tracker.points }}</p>
      <p v-if="finished" class="finished-flag">{{ text.tracker.finished }}</p>
    </div>

    <div class="tally" aria-live="polite">
      <p class="stat">
        <span class="stat-value">{{ stats.possessions }}</span>
        <span class="stat-label">{{ text.tracker.possessionsShort }}</span>
      </p>
      <p class="stat">
        <span class="stat-value">{{ ppp }}</span>
        <span class="stat-label">{{ text.tracker.ppp }}</span>
      </p>
      <p class="stat">
        <span class="stat-value"
          >{{ stats.offensive_rebounds }}/{{ stats.defensive_rebounds }}</span
        >
        <span class="stat-label">{{ text.tracker.reboundsShort }}</span>
      </p>
      <p class="stat">
        <span class="stat-value">{{ stats.turnovers }}</span>
        <span class="stat-label">{{ text.tracker.turnoversShort }}</span>
      </p>
    </div>

    <div class="actions">
      <button
        v-for="action in ACTIONS"
        :key="action.label"
        type="button"
        class="action"
        :class="[`action-${action.tone}`, `span-${action.place}`]"
        :disabled="!ready"
        @click="record(action)"
      >
        {{ action.label }}
      </button>
    </div>

    <div class="bench-footer">
      <button type="button" class="undo" :disabled="!ready || !canUndo" @click="undo">
        <span class="undo-caption">{{ text.tracker.undo }}</span>
        <span v-if="undoLabel" class="undo-target">{{ undoLabel }}</span>
      </button>
      <button type="button" class="end-game" @click="requestFinish">
        {{ finished ? text.tracker.gameSummary : text.tracker.endGame }}
      </button>
    </div>

    <dialog
      ref="finishDialog"
      class="finish-dialog"
      aria-labelledby="finish-title"
      aria-describedby="finish-body"
    >
      <h2 id="finish-title">{{ text.tracker.finishTitle }}</h2>
      <p id="finish-body">{{ text.tracker.finishBody }}</p>
      <p v-if="finishError" class="form-error" role="alert">{{ finishError }}</p>
      <div class="finish-actions">
        <button type="button" class="finish-cancel" @click="closeFinish">
          {{ text.tracker.finishCancel }}
        </button>
        <button type="button" class="finish-confirm" :disabled="finishing" @click="confirmFinish">
          {{ text.tracker.finishConfirm }}
        </button>
      </div>
    </dialog>

    <dialog ref="lineupDialog" class="lineup-dialog" aria-labelledby="lineup-title">
      <h2 id="lineup-title">{{ text.tracker.lineup }}</h2>
      <p>{{ text.tracker.chooseOutgoing }}</p>
      <div class="lineup-options">
        <button
          v-for="player in onCourt"
          :key="player.player_id"
          type="button"
          class="lineup-option"
          :class="{ selected: selectedOut === player.player_id }"
          @click="selectedOut = player.player_id"
        >
          {{ player.player_name }}
        </button>
      </div>
      <p>{{ text.tracker.chooseIncoming }}</p>
      <div class="lineup-options">
        <button
          v-for="player in benchPlayers"
          :key="player.player_id"
          type="button"
          class="lineup-option"
          :class="{ selected: selectedIn === player.player_id }"
          @click="selectedIn = player.player_id"
        >
          {{ player.player_name }}
        </button>
      </div>
      <div class="finish-actions">
        <button type="button" class="finish-cancel" @click="lineupDialog?.close()">
          {{ text.tracker.finishCancel }}
        </button>
        <button
          type="button"
          class="finish-confirm"
          :disabled="!selectedOut || !selectedIn"
          @click="confirmSubstitution"
        >
          {{ text.tracker.confirmSubstitution }}
        </button>
      </div>
      <button
        v-if="lastSubstitution"
        type="button"
        class="lineup-undo"
        @click="undoLastSubstitution"
      >
        {{ text.tracker.undoSubstitution }}
      </button>
    </dialog>
  </section>
</template>
