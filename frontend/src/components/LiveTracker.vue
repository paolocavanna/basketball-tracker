<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { commitTap, commitUndo, formatPpp, isPending, mergeStoredEvents } from "../lib/liveLog.js";
import { computeStats } from "../lib/stats.js";

const ACTIONS = [
  { type: "SCORE", points: 2, label: "+2", tone: "score" },
  { type: "SCORE", points: 3, label: "+3", tone: "score" },
  { type: "EMPTY", points: 0, label: "EMPTY", tone: "empty" },
  { type: "TOV", points: 0, label: "TOV", tone: "turnover" },
  { type: "OFF_REB", points: 0, label: "OFF REB", tone: "rebound" },
  { type: "DEF_REB", points: 0, label: "DEF REB", tone: "rebound" },
];

const props = defineProps({
  gameId: { type: String, required: true },
  store: { type: Object, required: true },
  sync: { type: Object, required: true },
  statusTick: { type: Number, required: true },
});

const emit = defineEmits(["navigate"]);

const game = ref(null);
const events = ref([]);
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

function record(type, points) {
  if (!ready.value || missing.value || failed.value) return;
  notice.value = "";
  const result = commitTap({
    store: props.store,
    sync: props.sync,
    gameId: props.gameId,
    type,
    points,
    events: events.value,
  });
  events.value = result.events;
  void result.persisted.then((outcome) => {
    if (outcome.ok) return;
    events.value = events.value.filter((event) => event.id !== outcome.event.id);
    notice.value = "Not saved";
  });
}

function undo() {
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
    notice.value = "Not saved";
  });
}

// A pass can settle while the log is still opening, and two refreshes can
// overlap. Only the newest read may paint, and opening refreshes once it is
// ready so that early pass is not dropped on the floor.
async function refreshSyncFlags() {
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
    <h1>Game not on this device</h1>
    <p>Stats recorded on this phone stay in its local log. Start a game here to track a new one.</p>
    <button type="button" class="start" @click="emit('navigate', '/')">Start a game</button>
  </section>

  <section v-else-if="failed" class="bench bench-message">
    <h1>Local log unavailable</h1>
    <p>This browser could not open the on-device game log, so taps cannot be saved.</p>
  </section>

  <section v-else class="bench">
    <header class="top">
      <img class="club-mark" src="/campus-monferrato.png" alt="Campus Monferrato U13" />
      <p class="opponent">{{ game?.opponent_name || "Live tracker" }}</p>
      <p
        class="sync-pill"
        :class="{ 'sync-pill-pending': pending && !notice, 'sync-pill-alert': notice }"
        role="status"
        :aria-label="notice ? 'That change was not saved on this device. Try again.' : undefined"
      >
        <span class="sync-dot" aria-hidden="true"></span>
        <span>{{ notice || (pending ? "Pending" : "Synced") }}</span>
      </p>
    </header>

    <div class="scoreboard">
      <p class="score">{{ stats.points }}</p>
      <p class="score-label">Points</p>
    </div>

    <div class="tally" aria-live="polite">
      <p class="stat">
        <span class="stat-value">{{ stats.possessions }}</span>
        <span class="stat-label">Poss</span>
      </p>
      <p class="stat">
        <span class="stat-value">{{ ppp }}</span>
        <span class="stat-label">PPP</span>
      </p>
      <p class="stat">
        <span class="stat-value"
          >{{ stats.offensive_rebounds }}/{{ stats.defensive_rebounds }}</span
        >
        <span class="stat-label">Reb off/def</span>
      </p>
      <p class="stat">
        <span class="stat-value">{{ stats.turnovers }}</span>
        <span class="stat-label">TOV</span>
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
        @click="record(action.type, action.points)"
      >
        {{ action.label }}
      </button>
    </div>

    <button type="button" class="undo" :disabled="!ready || !canUndo" @click="undo">
      <span class="undo-caption">Undo</span>
      <span v-if="undoLabel" class="undo-target">{{ undoLabel }}</span>
    </button>
  </section>
</template>
