<script setup lang="ts">
import { onMounted, ref } from "vue";
import text from "../text/en.json";
import {
  formatGameDate,
  gameResult,
  recentGames,
  recoveryPath,
  resultLabel,
  type GameResult,
} from "../lib/gameLifecycle.ts";
import type { LocalStore } from "../lib/localStore.ts";
import type { StoredGame } from "../../../types.ts";

const props = defineProps<{ store: LocalStore }>();

const emit = defineEmits<{ navigate: [path: string] }>();

const games = ref<StoredGame[]>([]);
const opponentWonTail = text.result.opponentWon.replace("{opponent}", "");

onMounted(async () => {
  try {
    games.value = recentGames(await props.store.listGames());
  } catch {
    games.value = [];
  }
});

function scoreLine(game: StoredGame): string {
  if (game.final_score_for == null) return "";
  if (game.final_score_against == null) return String(game.final_score_for);
  return `${game.final_score_for}-${game.final_score_against}`;
}

function savedResult(game: StoredGame): GameResult | null {
  if (game.final_scores_confirmed !== true) return null;
  return gameResult(game.final_score_for, game.final_score_against);
}

function winnerLine(game: StoredGame): string {
  const result = savedResult(game);
  if (!result) return "";
  return resultLabel(result, game.opponent_name, text.result);
}

function open(game: StoredGame): void {
  emit("navigate", recoveryPath(game));
}
</script>

<template>
  <section v-if="games.length" class="recent-games">
    <h2>{{ text.recent.title }}</h2>
    <ul>
      <li v-for="game in games" :key="game.id">
        <div class="recent-copy">
          <p class="recent-opponent">
            {{ text.recent.vs }}
            <span class="opponent-name">{{ game.opponent_name }}</span>
          </p>
          <p class="recent-meta">{{ formatGameDate(game.date) }} · {{ text.recent.finished }}</p>
          <p v-if="scoreLine(game)" class="recent-score">{{ scoreLine(game) }}</p>
          <p
            v-if="winnerLine(game)"
            class="recent-result game-result"
            :class="`game-result-${savedResult(game)}`"
          >
            <template v-if="savedResult(game) === 'loss'">
              <span class="opponent-name">{{ game.opponent_name }}</span
              >{{ opponentWonTail }}
            </template>
            <template v-else>{{ winnerLine(game) }}</template>
          </p>
        </div>
        <button type="button" class="recent-action recent-open" @click="open(game)">
          {{ text.recent.openGame }}
        </button>
      </li>
    </ul>
  </section>
</template>
