<script setup lang="ts">
import { onMounted, ref } from "vue";
import text from "../text/en.json";
import { formatGameDate, recentGames, recoveryAction, recoveryPath } from "../lib/gameLifecycle.ts";
import { gameStatus } from "../lib/localStore.ts";
import type { LocalStore } from "../lib/localStore.ts";
import type { StoredGame } from "../../../types.ts";

const props = defineProps<{ store: LocalStore }>();

const emit = defineEmits<{ navigate: [path: string] }>();

const games = ref<StoredGame[]>([]);

onMounted(async () => {
  try {
    games.value = recentGames(await props.store.listGames());
  } catch {
    games.value = [];
  }
});

function statusLabel(game: StoredGame): string {
  return gameStatus(game) === "finished" ? text.recent.finished : text.recent.inProgress;
}

function scoreLine(game: StoredGame): string {
  if (game.final_score_for == null) return "";
  if (game.final_score_against == null) return String(game.final_score_for);
  return `${game.final_score_for}-${game.final_score_against}`;
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
          <p class="recent-opponent">{{ text.recent.vs }} {{ game.opponent_name }}</p>
          <p class="recent-meta">{{ formatGameDate(game.date) }} · {{ statusLabel(game) }}</p>
          <p v-if="scoreLine(game)" class="recent-score">{{ scoreLine(game) }}</p>
        </div>
        <button
          type="button"
          class="recent-action"
          :class="recoveryAction(game) === 'continue' ? 'recent-continue' : 'recent-open'"
          @click="open(game)"
        >
          {{
            recoveryAction(game) === "continue" ? text.recent.continueGame : text.recent.openGame
          }}
        </button>
      </li>
    </ul>
  </section>
</template>
