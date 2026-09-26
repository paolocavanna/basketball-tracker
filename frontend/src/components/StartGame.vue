<script setup>
import { onMounted, ref } from "vue";
import text from "../text/en.json";
import { livePath } from "../lib/route.js";
import { SEEDED_TEAM_ID, loadTeamId } from "../lib/team.js";

const props = defineProps({
  store: { type: Object, required: true },
  sync: { type: Object, required: true },
});

const emit = defineEmits(["navigate"]);

const opponent = ref("");
const date = ref(localDate());
const teamId = ref(SEEDED_TEAM_ID);
const saving = ref(false);
const error = ref("");

function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

onMounted(async () => {
  teamId.value = await loadTeamId();
});

async function start() {
  const name = opponent.value.trim();
  if (!name || saving.value) return;
  saving.value = true;
  error.value = "";
  const id = crypto.randomUUID();
  try {
    await props.store.saveGame({
      id,
      team_id: teamId.value,
      date: date.value,
      opponent_name: name,
      created_at: new Date().toISOString(),
    });
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
