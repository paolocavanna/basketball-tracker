<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import LiveTracker from "./components/LiveTracker.vue";
import StartGame from "./components/StartGame.vue";
import DashboardView from "./components/DashboardView.vue";
import { createLocalStore } from "./lib/localStore.js";
import { parseRoute } from "./lib/route.js";
import { createSyncManager } from "./lib/syncManager.js";

const store = createLocalStore();
const route = ref(parseRoute(location.pathname));
const statusTick = ref(0);

const sync = createSyncManager({
  store,
  onSettled() {
    statusTick.value += 1;
  },
});

function navigate(path) {
  history.pushState(null, "", path);
  route.value = parseRoute(location.pathname);
}

function onPopState() {
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
  <DashboardView v-if="route.name === 'dashboard'" @navigate="navigate" />
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
