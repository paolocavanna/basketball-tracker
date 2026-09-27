<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import DashboardView from "./components/DashboardView.vue";
import GameSummary from "./components/GameSummary.vue";
import LiveTracker from "./components/LiveTracker.vue";
import StartGame from "./components/StartGame.vue";
import { createLocalStore } from "./lib/localStore.ts";
import { parseRoute } from "./lib/route.ts";
import { createSyncManager } from "./lib/syncManager.ts";
import type { AppRoute } from "./lib/route.ts";

const store = createLocalStore();
const route = ref<AppRoute>(parseRoute(location.pathname));
const statusTick = ref(0);

const sync = createSyncManager({
  store,
  onSettled() {
    statusTick.value += 1;
  },
});

function navigate(path: string): void {
  history.pushState(null, "", path);
  route.value = parseRoute(location.pathname);
}

function onPopState(): void {
  route.value = parseRoute(location.pathname);
}

onMounted(() => {
  sync.start();
  window.addEventListener("popstate", onPopState);
});

onUnmounted(() => {
  sync.stop();
  window.removeEventListener("popstate", onPopState);
});
</script>

<template>
  <DashboardView v-if="route.name === 'dashboard'" :store="store" @navigate="navigate" />
  <GameSummary
    v-else-if="route.name === 'summary'"
    :key="route.gameId"
    :game-id="route.gameId"
    :store="store"
    :sync="sync"
    @navigate="navigate"
  />
  <LiveTracker
    v-else-if="route.name === 'live'"
    :key="route.gameId"
    :game-id="route.gameId"
    :store="store"
    :sync="sync"
    :status-tick="statusTick"
    @navigate="navigate"
  />
  <StartGame v-else :store="store" :sync="sync" @navigate="navigate" />
</template>
