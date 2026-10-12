<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import text from "../text/en.json";
import { gameResult, parseFinalScore, resultLabel, saveFinalScores } from "../lib/gameLifecycle.ts";
import { formatPpp } from "../lib/liveLog.ts";
import { gameStatus } from "../lib/localStore.ts";
import type { LocalStore } from "../lib/localStore.ts";
import { livePath } from "../lib/route.ts";
import { computeStats } from "../lib/stats.ts";
import type { SyncManager } from "../lib/syncManager.ts";
import type { StoredEvent, StoredGame } from "../../../types.ts";
import type { GameTimerRecord, StoredGamePlayer, StoredPlayerShift } from "../../../types.ts";
import {
  calculateUsage,
  elapsedGameSeconds,
  formatPlayingTime,
  savePlayingTimeOverride,
} from "../lib/playingTime.ts";

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
const campusInput = ref("");
const opponentInput = ref("");
const scoreError = ref("");
const scoreMessage = ref("");
const savingScore = ref(false);
const gamePlayers = ref<StoredGamePlayer[]>([]);
const playerShifts = ref<StoredPlayerShift[]>([]);
const gameTimer = ref<GameTimerRecord | null>(null);
const minuteInputs = ref<Record<string, string>>({});
const minuteError = ref("");
const savingPlayerId = ref("");

const stats = computed(() => computeStats(events.value));
const ppp = computed(() => formatPpp(stats.value.points_per_possession));
const finished = computed(() => (game.value ? gameStatus(game.value) === "finished" : false));
const campusScore = computed(() => parseFinalScore(campusInput.value));
const opponentScore = computed(() => parseFinalScore(opponentInput.value));
const previewResult = computed(() => gameResult(campusScore.value, opponentScore.value));
const winnerText = computed(() => {
  const current = game.value;
  const result = previewResult.value;
  if (!current || !result) return "";
  return resultLabel(result, current.opponent_name, text.result);
});
const playerUsage = computed(() => calculateUsage(gamePlayers.value, playerShifts.value));
const gameDuration = computed(() => elapsedGameSeconds(gameTimer.value));

function parsePlayingTime(value: string): number | null {
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

async function savePlayerMinutes(playerId: string): Promise<void> {
  const player = gamePlayers.value.find((entry) => entry.player_id === playerId);
  const seconds = parsePlayingTime(minuteInputs.value[playerId] ?? "");
  if (!player || seconds == null || seconds > gameDuration.value) {
    minuteError.value = text.tracker.invalidMinutes;
    return;
  }
  savingPlayerId.value = playerId;
  minuteError.value = "";
  try {
    const saved = await savePlayingTimeOverride(props.store, player, seconds, gameDuration.value);
    if (!saved) {
      minuteError.value = text.tracker.invalidMinutes;
      return;
    }
    gamePlayers.value = await props.store.loadGamePlayers(props.gameId);
    minuteInputs.value[playerId] = formatPlayingTime(seconds);
  } catch {
    minuteError.value = text.tracker.notSaved;
  } finally {
    savingPlayerId.value = "";
  }
}

onMounted(async () => {
  try {
    const [storedGame, storedEvents, storedPlayers, storedShifts, storedTimer] = await Promise.all([
      props.store.loadGame(props.gameId),
      props.store.loadGameEvents(props.gameId),
      props.store.loadGamePlayers(props.gameId),
      props.store.loadPlayerShifts(props.gameId),
      props.store.loadGameTimer(props.gameId),
    ]);
    if (!storedGame) {
      missing.value = true;
    } else {
      game.value = storedGame;
      events.value = storedEvents;
      gamePlayers.value = storedPlayers;
      playerShifts.value = storedShifts;
      gameTimer.value = storedTimer;
      minuteInputs.value = Object.fromEntries(
        calculateUsage(storedPlayers, storedShifts).map((entry) => [
          entry.player_id,
          formatPlayingTime(entry.seconds),
        ]),
      );
      campusInput.value =
        storedGame.final_score_for == null ? "" : String(storedGame.final_score_for);
      opponentInput.value =
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
    const result = await saveFinalScores(
      props.store,
      current,
      events.value,
      campusInput.value,
      opponentInput.value,
    );
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
    <button type="button" class="summary-done" @click="emit('navigate', '/')">
      {{ text.summary.backToStart }}
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
      <p v-if="campusScore != null && opponentScore != null" class="score">
        {{ campusScore }}<span class="score-sep">-</span>{{ opponentScore }}
      </p>
      <p v-else class="score">{{ stats.points }}</p>
      <p v-if="winnerText" class="game-result" :class="`game-result-${previewResult}`">
        {{ winnerText }}
      </p>
      <p v-else class="score-label">{{ text.tracker.points }}</p>
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

    <section
      v-if="playerUsage.length"
      class="player-time-summary"
      aria-labelledby="player-time-title"
    >
      <h2 id="player-time-title">{{ text.tracker.playingTime }}</h2>
      <div v-for="player in playerUsage" :key="player.player_id" class="player-time-row">
        <div class="player-time-name">
          <strong>{{ player.player_name }}</strong>
        </div>
        <span class="player-time-value">{{ formatPlayingTime(player.seconds) }}</span>
        <label class="player-time-edit">
          <span class="visually-hidden">{{ text.tracker.minutes }}: {{ player.player_name }}</span>
          <input
            v-model="minuteInputs[player.player_id]"
            :aria-label="`${text.tracker.minutes}: ${player.player_name}`"
            type="text"
            inputmode="numeric"
            :placeholder="text.tracker.timeFormat"
          />
        </label>
        <button
          type="button"
          class="player-time-save"
          :disabled="savingPlayerId === player.player_id"
          @click="savePlayerMinutes(player.player_id)"
        >
          {{ text.tracker.saveMinutes }}
        </button>
      </div>
      <p v-if="minuteError" class="form-error" role="alert">{{ minuteError }}</p>
    </section>

    <form class="summary-score-form" @submit.prevent="saveScore">
      <p class="score-hint">{{ text.summary.scoreHint }}</p>
      <div class="summary-score-fields">
        <label>
          {{ text.summary.campusScore }}
          <input
            v-model="campusInput"
            name="campus-score"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            @input="onScoreInput"
          />
        </label>
        <label>
          {{ text.summary.opponentScore }}
          <input
            v-model="opponentInput"
            name="opponent-score"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            @input="onScoreInput"
          />
        </label>
      </div>
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
