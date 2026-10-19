<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import text from "../text/en.json";
import RecentGames from "./RecentGames.vue";
import type { LocalStore } from "../lib/localStore.ts";
import { livePath } from "../lib/route.ts";
import type { SyncManager } from "../lib/syncManager.ts";
import { SEEDED_TEAM_ID, loadTeamId } from "../lib/team.ts";
import type { GameRecord } from "../../../types.ts";
import type { PlayerRecord, StoredPlayer } from "../../../types.ts";
import { readPlayerList } from "../lib/api.ts";
import { gameRoster, PLAYERS_ON_COURT } from "../lib/playingTime.ts";

const props = defineProps<{ store: LocalStore; sync: SyncManager }>();

const emit = defineEmits<{ navigate: [path: string] }>();

const opponent = ref("");
const date = ref(localDate());
const teamId = ref(SEEDED_TEAM_ID);
const saving = ref(false);
const error = ref("");
const roster = ref<StoredPlayer[]>([]);
const newPlayerName = ref("");
const playerNames = ref<Record<string, string>>({});
const rosterError = ref("");
const availableIds = ref<string[]>([]);
const starterIds = ref<string[]>([]);
const activeRoster = computed(() => roster.value.filter((player) => player.active));

function localDate(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

onMounted(async () => {
  teamId.value = await loadTeamId();
  await refreshRoster();
});

async function refreshRoster(): Promise<void> {
  roster.value = await props.store.listPlayers(teamId.value);
  playerNames.value = Object.fromEntries(roster.value.map((player) => [player.id, player.name]));
  try {
    const response = await fetch(`/api/teams/${teamId.value}/players`);
    if (!response.ok) return;
    const players = readPlayerList(await response.json());
    await props.store.cachePlayers(players);
    roster.value = await props.store.listPlayers(teamId.value);
    playerNames.value = Object.fromEntries(roster.value.map((player) => [player.id, player.name]));
    if (availableIds.value.length === 0) {
      availableIds.value = activeRoster.value.map((player) => player.id);
    }
  } catch {
    // The local roster is enough to prepare an offline game.
  }
  if (availableIds.value.length === 0) {
    availableIds.value = activeRoster.value.map((player) => player.id);
  }
}

async function addPlayer(): Promise<void> {
  const name = newPlayerName.value.trim();
  if (!name || name.length > 80) return;
  const player: PlayerRecord = {
    id: crypto.randomUUID(),
    team_id: teamId.value,
    name,
    active: true,
    created_at: new Date().toISOString(),
  };
  const saved = await props.store.savePlayer(player);
  roster.value = [...roster.value, saved].sort((a, b) => a.name.localeCompare(b.name));
  playerNames.value[saved.id] = saved.name;
  availableIds.value = [...availableIds.value, saved.id];
  newPlayerName.value = "";
  props.sync.kick();
}

async function savePlayerName(player: StoredPlayer): Promise<void> {
  const name = playerNames.value[player.id]?.trim() ?? "";
  if (!name || name.length > 80) {
    playerNames.value[player.id] = player.name;
    return;
  }
  if (name === player.name) return;
  rosterError.value = "";
  try {
    const saved = await props.store.savePlayer({ ...player, name });
    roster.value = roster.value.map((entry) => (entry.id === player.id ? saved : entry));
    props.sync.kick();
  } catch {
    playerNames.value[player.id] = player.name;
    rosterError.value = text.start.rosterSaveError;
  }
}

function setAvailable(player: StoredPlayer, isAvailable: boolean): void {
  availableIds.value = isAvailable
    ? [...availableIds.value, player.id]
    : availableIds.value.filter((id) => id !== player.id);
  if (!isAvailable) starterIds.value = starterIds.value.filter((id) => id !== player.id);
}

function setStarter(player: StoredPlayer, isStarter: boolean): void {
  if (isStarter && starterIds.value.length >= PLAYERS_ON_COURT) return;
  starterIds.value = isStarter
    ? [...starterIds.value, player.id]
    : starterIds.value.filter((id) => id !== player.id);
}

async function archivePlayer(player: StoredPlayer): Promise<void> {
  const saved = await props.store.savePlayer({ ...player, active: false });
  roster.value = roster.value.map((entry) => (entry.id === player.id ? saved : entry));
  setAvailable(player, false);
  props.sync.kick();
}

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
    await props.store.saveGamePlayers(
      gameRoster(id, activeRoster.value, availableIds.value, starterIds.value),
    );
    await props.store.saveGame(game);
  } catch {
    await props.store.clearGamePlayingTime(id).catch(() => undefined);
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
      <section class="roster-setup" aria-labelledby="roster-title">
        <h2 id="roster-title">{{ text.start.roster }}</h2>
        <div class="roster-add">
          <label>
            {{ text.start.playerName }}
            <input
              v-model="newPlayerName"
              maxlength="80"
              autocomplete="off"
              @keydown.enter.prevent="addPlayer"
            />
          </label>
          <button
            class="roster-add-button"
            type="button"
            :disabled="!newPlayerName.trim()"
            @click="addPlayer"
          >
            {{ text.start.addPlayer }}
          </button>
        </div>
        <p v-if="activeRoster.length === 0" class="roster-hint">{{ text.start.rosterEmpty }}</p>
        <p v-if="rosterError" class="form-error" role="alert">{{ rosterError }}</p>
        <div v-for="player in activeRoster" :key="player.id" class="roster-player">
          <input
            v-model="playerNames[player.id]"
            class="roster-player-name"
            :aria-label="`${text.start.playerName}: ${player.name}`"
            maxlength="80"
            @change="savePlayerName(player)"
          />
          <label class="roster-check">
            <input
              type="checkbox"
              :checked="availableIds.includes(player.id)"
              @change="setAvailable(player, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ text.start.available }}</span>
          </label>
          <label class="roster-check">
            <input
              type="checkbox"
              :checked="starterIds.includes(player.id)"
              :disabled="!availableIds.includes(player.id)"
              @change="setStarter(player, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ text.start.starter }}</span>
          </label>
          <button type="button" class="roster-archive" @click="archivePlayer(player)">
            {{ text.start.archivePlayer }}
          </button>
        </div>
        <p v-if="starterIds.length !== 5" class="roster-hint">{{ text.start.selectFive }}</p>
      </section>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button type="submit" class="start" :disabled="saving || starterIds.length !== 5">
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
