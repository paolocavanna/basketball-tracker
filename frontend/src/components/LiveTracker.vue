<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import text from "../text/en.json";
import { commitTap, commitUndo, formatPpp, isPending, mergeStoredEvents } from "../lib/liveLog.ts";
import type { LocalStore } from "../lib/localStore.ts";
import { computeStats } from "../lib/stats.ts";
import type { SyncManager } from "../lib/syncManager.ts";
import type { EventPayload, StoredEvent, StoredGame } from "../../../types.ts";

type LabeledAction = EventPayload & {
  label: string;
  tone: "score" | "empty" | "turnover" | "rebound";
};

const ACTIONS = [
  { type: "SCORE", points: 2, label: text.actions.two, tone: "score" },
  { type: "SCORE", points: 3, label: text.actions.three, tone: "score" },
  { type: "EMPTY", points: 0, label: text.actions.empty, tone: "empty" },
  { type: "TOV", points: 0, label: text.actions.turnover, tone: "turnover" },
  { type: "OFF_REB", points: 0, label: text.actions.offensiveRebound, tone: "rebound" },
  { type: "DEF_REB", points: 0, label: text.actions.defensiveRebound, tone: "rebound" },
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
let refreshToken = 0;

// One source of truth for the button captions, so Undo can name the tap it
// would reverse without repeating the labels.
const EVENT_LABELS = new Map(
  ACTIONS.map((action) => [`${action.type}:${action.points}`, action.label]),
);

const stats = computed(() => computeStats(events.value));
const pending = computed(() => isPending(game.value, events.value));
const canUndo = computed(() => events.value.some((event) => !event.deleted));
const ppp = computed(() => formatPpp(stats.value.points_per_possession));
const undoLabel = computed(() => {
  const last = events.value.findLast((event) => !event.deleted);
  return last ? (EVENT_LABELS.get(`${last.type}:${last.points}`) ?? "") : "";
});

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
    if (outcome.ok) return;
    events.value = events.value.filter((event) => event.id !== outcome.event.id);
    notice.value = text.tracker.notSaved;
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
    if (outcome.ok || !outcome.event) return;
    events.value = events.value.map((event) =>
      event.id === outcome.event.id ? outcome.event : event,
    );
    notice.value = text.tracker.notSaved;
  });
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
  await refreshSyncFlags();
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

    <div class="scoreboard">
      <p class="score">{{ stats.points }}</p>
      <p class="score-label">{{ text.tracker.points }}</p>
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
        :class="`action-${action.tone}`"
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
      <button type="button" class="end-game" @click="emit('navigate', '/')">
        {{ text.tracker.endGame }}
      </button>
    </div>
  </section>
</template>
