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
  clearTimingIfLeaving(parseRoute(path));
  history.pushState(null, "", path);
  route.value = parseRoute(location.pathname);
}

function onPopState(): void {
  clearTimingIfLeaving(parseRoute(location.pathname));
  route.value = parseRoute(location.pathname);
}

function clearTimingIfLeaving(next: AppRoute): void {
  const currentId =
    route.value.name === "live" || route.value.name === "summary" ? route.value.gameId : null;
  const nextId = next.name === "live" || next.name === "summary" ? next.gameId : null;
  if (currentId && nextId !== currentId) {
    void store.clearGamePlayingTime(currentId).catch(() => undefined);
  }
}

onMounted(() => {
  const gameId =
    route.value.name === "live" || route.value.name === "summary" ? route.value.gameId : null;
  void store.clearGamePlayingTimeExcept(gameId).catch(() => undefined);
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
