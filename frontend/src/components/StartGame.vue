<script setup lang="ts">
import { onMounted, ref } from "vue";
import text from "../text/en.json";
import RecentGames from "./RecentGames.vue";
import type { LocalStore } from "../lib/localStore.ts";
import { livePath } from "../lib/route.ts";
import type { SyncManager } from "../lib/syncManager.ts";
import { SEEDED_TEAM_ID, loadTeamId } from "../lib/team.ts";
import type { GameRecord } from "../../../types.ts";

const props = defineProps<{ store: LocalStore; sync: SyncManager }>();

const emit = defineEmits<{ navigate: [path: string] }>();

const opponent = ref("");
const date = ref(localDate());
const teamId = ref(SEEDED_TEAM_ID);
const saving = ref(false);
const error = ref("");

function localDate(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

onMounted(async () => {
  teamId.value = await loadTeamId();
});

async function start(): Promise<void> {
  const name = opponent.value.trim();
  if (!name || saving.value) return;
  saving.value = true;
  error.value = "";
  const id = crypto.randomUUID();
  try {
    const game: GameRecord = {
      id,
      team_id: teamId.value,
      date: date.value,
      opponent_name: name,
      created_at: new Date().toISOString(),
      status: "in-progress",
    };
    await props.store.saveGame(game);
  } catch {
    saving.value = false;
    error.value = text.start.saveError;
    return;
  }
  props.sync.kick();
  emit("navigate", livePath(id));
}
</script>

<template>
  <section class="bench bench-message">
    <img class="club-mark" src="/campus-monferrato.png" alt="" />
    <h1>{{ text.brand.team }}</h1>
    <RecentGames :store="store" @navigate="emit('navigate', $event)" />
    <form class="start-form" @submit.prevent="start">
      <label>
        {{ text.start.opponent }}
        <input v-model="opponent" name="opponent" type="text" required autocomplete="off" />
      </label>
      <label>
        {{ text.start.date }}
        <input v-model="date" name="date" type="date" required />
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button type="submit" class="start" :disabled="saving">
        {{ saving ? text.start.saving : text.start.startGame }}
      </button>
    </form>
    <a
      class="start-dashboard-link"
      href="/dashboard"
      @click.prevent="$emit('navigate', '/dashboard')"
      >{{ text.start.dashboard }}</a
    >
  </section>
</template>
