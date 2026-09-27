<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import text from "../text/en.json";
import { formatPpp } from "../lib/liveLog.ts";
import { saveOpponentScore } from "../lib/gameLifecycle.ts";
import { gameStatus } from "../lib/localStore.ts";
import type { LocalStore } from "../lib/localStore.ts";
import { livePath } from "../lib/route.ts";
import { computeStats } from "../lib/stats.ts";
import type { SyncManager } from "../lib/syncManager.ts";
import type { StoredEvent, StoredGame } from "../../../types.ts";

const props = defineProps<{
  gameId: string;
  store: LocalStore;
  sync: SyncManager;
}>();

const emit = defineEmits<{ navigate: [path: string] }>();

const game = ref<StoredGame | null>(null);
const events = ref<StoredEvent[]>([]);
const ready = ref(false);
const missing = ref(false);
const failed = ref(false);
const scoreInput = ref("");
const scoreError = ref("");
const scoreMessage = ref("");
const savingScore = ref(false);

const stats = computed(() => computeStats(events.value));
const ppp = computed(() => formatPpp(stats.value.points_per_possession));
const finished = computed(() => (game.value ? gameStatus(game.value) === "finished" : false));

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
      scoreInput.value =
        storedGame.final_score_against == null ? "" : String(storedGame.final_score_against);
    }
  } catch {
    failed.value = true;
  } finally {
    ready.value = true;
  }
});

function onScoreInput(): void {
  scoreError.value = "";
  scoreMessage.value = "";
}

async function saveScore(): Promise<void> {
  const current = game.value;
  if (!current || savingScore.value) return;
  savingScore.value = true;
  scoreError.value = "";
  scoreMessage.value = "";
  try {
    const result = await saveOpponentScore(props.store, current, events.value, scoreInput.value);
    if (!result.ok) {
      scoreError.value = text.summary.invalidScore;
      return;
    }
    game.value = result.game;
    scoreMessage.value = text.summary.scoreSaved;
    props.sync.kick();
  } catch {
    scoreError.value = text.summary.saveError;
  } finally {
    savingScore.value = false;
  }
}
</script>

<template>
  <section v-if="!ready" class="bench bench-message">
    <p>{{ text.summary.loading }}</p>
  </section>

  <section v-else-if="missing" class="bench bench-message">
    <h1>{{ text.tracker.notOnDeviceTitle }}</h1>
    <p>{{ text.tracker.notOnDeviceBody }}</p>
    <button type="button" class="start" @click="emit('navigate', '/')">
      {{ text.tracker.startGame }}
    </button>
  </section>

  <section v-else-if="failed || !game" class="bench bench-message">
    <h1>{{ text.tracker.logUnavailableTitle }}</h1>
    <p>{{ text.tracker.logUnavailableBody }}</p>
  </section>

  <section v-else-if="!finished" class="bench bench-message">
    <h1>{{ text.summary.inProgress }}</h1>
    <p>{{ text.recent.vs }} {{ game.opponent_name }}</p>
    <button type="button" class="start" @click="emit('navigate', livePath(gameId))">
      {{ text.recent.continueGame }}
    </button>
  </section>

  <section v-else class="bench bench-message summary">
    <header class="top">
      <a href="/" @click.prevent="emit('navigate', '/')">
        <img class="club-mark" src="/campus-monferrato.png" :alt="text.brand.team" />
      </a>
      <p class="opponent">{{ text.recent.vs }} {{ game.opponent_name }}</p>
      <p class="finished-flag">{{ text.tracker.finished }}</p>
    </header>

    <div class="scoreboard">
      <p class="score">{{ stats.points }}</p>
      <p class="score-label">{{ text.summary.team }}</p>
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

    <form class="summary-score-form" @submit.prevent="saveScore">
      <label>
        {{ text.summary.opponentScore }}
        <input
          v-model="scoreInput"
          name="opponent-score"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          @input="onScoreInput"
        />
      </label>
      <p v-if="scoreError" class="form-error" role="alert">{{ scoreError }}</p>
      <p v-else-if="scoreMessage" class="score-saved" role="status">{{ scoreMessage }}</p>
      <button type="submit" class="start" :disabled="savingScore">
        {{ text.summary.saveScore }}
      </button>
    </form>

    <div class="summary-actions">
      <button type="button" class="start" @click="emit('navigate', livePath(gameId))">
        {{ text.summary.correctLog }}
      </button>
      <button type="button" class="summary-done" @click="emit('navigate', '/')">
        {{ text.summary.backToStart }}
      </button>
    </div>
    <a
      class="start-dashboard-link"
      href="/dashboard"
      @click.prevent="emit('navigate', '/dashboard')"
    >
      {{ text.start.dashboard }}
    </a>
  </section>
</template>
