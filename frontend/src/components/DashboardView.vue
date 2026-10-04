<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import text from "../text/en.json";
import RecentGames from "./RecentGames.vue";
import type { LocalStore } from "../lib/localStore.ts";
import { gameResult, resultLabel } from "../lib/gameLifecycle.ts";
import { SEEDED_TEAM_ID, loadTeamId } from "../lib/team.ts";
import { readGameDetail, readSeasonSummary } from "../lib/api.ts";
import {
  polylinePoints,
  pppSeries,
  reboundSeries,
  sharedCeiling,
  trendX,
  trendY,
} from "../lib/trends.ts";
import type { GameDetail, SeasonGame } from "../../../types.ts";

defineProps<{ store: LocalStore }>();

const emit = defineEmits<{ navigate: [path: string] }>();

interface Possession {
  points: number;
  offensiveRebounds: number;
  result: string;
}

const games = ref<SeasonGame[]>([]);
const selectedId = ref("");
const selectedGame = ref<GameDetail | null>(null);
const loading = ref(true);
const seasonError = ref("");
const detailError = ref("");
const teamId = ref(SEEDED_TEAM_ID);

const selectedSummary = computed(() => games.value.find((game) => game.id === selectedId.value));
const selectedResult = computed(() => {
  const game = selectedSummary.value;
  if (!game) return null;
  return gameResult(game.final_score_for, game.final_score_against);
});
const selectedResultText = computed(() => {
  const game = selectedSummary.value;
  const result = selectedResult.value;
  if (!game || !result) return "";
  return resultLabel(result, game.opponent_name, text.result);
});
const firstGame = computed(() => games.value[0] ?? null);
const latestGame = computed(() => games.value.at(-1) ?? null);

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatPpp(value: number | null | undefined): string {
  return value == null ? "—" : Number(value).toFixed(2);
}

async function selectGame(id: string): Promise<void> {
  selectedId.value = id;
  selectedGame.value = null;
  detailError.value = "";
  if (!id) return;
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(text.dashboard.detailLoadError);
    const payload: unknown = await response.json();
    const detail = readGameDetail(payload);
    if (selectedId.value !== id) return;
    selectedGame.value = detail;
  } catch {
    if (selectedId.value !== id) return;
    detailError.value = text.dashboard.detailLoadError;
  }
}

onMounted(async () => {
  teamId.value = await loadTeamId();
  try {
    const response = await fetch(`/api/stats/season?team_id=${teamId.value}`);
    if (!response.ok) throw new Error(text.dashboard.seasonLoadError);
    const payload: unknown = await response.json();
    const season = readSeasonSummary(payload);
    games.value = season.games;
    if (latestGame.value) await selectGame(latestGame.value.id);
  } catch {
    seasonError.value = text.dashboard.seasonLoadError;
  } finally {
    loading.value = false;
  }
});

const possessions = computed<Possession[]>(() => {
  if (!selectedGame.value) return [];
  const result = [];
  let current: Possession = { points: 0, offensiveRebounds: 0, result: "" };
  for (const event of selectedGame.value.events || []) {
    if (event.type === "OFF_REB") current.offensiveRebounds += 1;
    if (event.type === "SCORE") current.points += Number(event.points || 0);
    if (["SCORE", "EMPTY", "TOV"].includes(event.type)) {
      current.result =
        event.type === "TOV"
          ? text.dashboard.turnover
          : event.type === "EMPTY"
            ? text.dashboard.empty
            : `+${event.points}`;
      result.push(current);
      current = { points: 0, offensiveRebounds: 0, result: "" };
    }
  }
  return result;
});

const maxPossessionPoints = computed(() =>
  Math.max(3, ...possessions.value.map((possession) => possession.points)),
);

const ppp = computed(() => pppSeries(games.value));
const rebounds = computed(() => reboundSeries(games.value));
const turnoverCeiling = computed(() =>
  sharedCeiling(games.value.map((game) => Number(game.turnovers) || 0)),
);
const turnoverLine = computed(() =>
  polylinePoints(
    games.value.map((game) => Number(game.turnovers) || 0),
    turnoverCeiling.value,
    games.value.length,
  ),
);

function turnoverY(value: number): number {
  return trendY(Number(value) || 0, turnoverCeiling.value);
}

function possessionAlt(count: number): string {
  return text.dashboard.pointsEachPossessionAlt.replace("{count}", String(count));
}

function possessionTitle(index: number, possession: Possession): string {
  const rebounds = possession.offensiveRebounds
    ? `, ${possession.offensiveRebounds} ${text.dashboard.offensiveReboundsCount}`
    : "";
  return text.dashboard.possessionLabel
    .replace("{number}", String(index + 1))
    .replace("{points}", String(possession.points))
    .replace("{result}", possession.result)
    .replace("{rebounds}", rebounds);
}
</script>

<template>
  <main class="dashboard">
    <a class="dashboard-home" href="/" @click.prevent="emit('navigate', '/')"
      >{{ text.dashboard.backToTracker }} <span aria-hidden="true">↗</span></a
    >
    <header class="dashboard-header">
      <a href="/" class="logo-wrapper" @click.prevent="emit('navigate', '/')">
        <img
          class="club-mark club-mark-small"
          src="/campus-monferrato.png"
          :alt="text.dashboard.logoAlt"
        />
      </a>
      <div class="dashboard-heading">
        <p class="eyebrow">{{ text.brand.short }}</p>
        <h1>{{ text.dashboard.title }}</h1>
      </div>
    </header>

    <RecentGames :store="store" @navigate="emit('navigate', $event)" />

    <p v-if="loading" class="dashboard-message">{{ text.dashboard.loadingSeason }}</p>
    <p v-else-if="seasonError" class="dashboard-message dashboard-error" role="alert">
      {{ seasonError }}
    </p>
    <p v-else-if="!games.length" class="dashboard-message">
      {{ text.dashboard.noGames }}
    </p>

    <template v-else>
      <section class="season-section">
        <div class="section-title">
          <div>
            <p class="eyebrow">{{ text.dashboard.seasonSoFar }}</p>
            <h2>{{ text.dashboard.teamTrends }}</h2>
          </div>
          <span>{{ games.length }} {{ text.dashboard.gamesCount }}</span>
        </div>
        <div class="trend-grid">
          <article class="trend-card">
            <div class="trend-heading">
              <h3>{{ text.dashboard.pointsPerPossession }}</h3>
              <span class="trend-current">{{ formatPpp(latestGame?.points_per_possession) }}</span>
            </div>
            <svg
              class="trend-chart"
              viewBox="0 0 320 124"
              role="img"
              :aria-label="text.dashboard.pppByGameAlt"
            >
              <path class="chart-gridline" d="M24 20H296 M24 63H296 M24 106H296" />
              <polyline
                v-for="(points, index) in ppp.segments"
                :key="`ppp-${index}`"
                class="trend-line trend-blue"
                :points="points"
              />
              <circle
                v-for="dot in ppp.dots"
                :key="dot.id"
                class="trend-dot trend-blue-fill"
                :cx="dot.x"
                :cy="dot.y"
                r="4"
              />
            </svg>
            <div class="chart-caption">
              <span>{{ formatDate(firstGame?.date ?? "") }}</span
              ><span>{{ text.dashboard.chronological }}</span
              ><span>{{ formatDate(latestGame?.date ?? "") }}</span>
            </div>
          </article>
          <article class="trend-card">
            <div class="trend-heading">
              <h3>{{ text.dashboard.turnovers }}</h3>
              <span class="trend-current">{{ latestGame?.turnovers ?? 0 }}</span>
            </div>
            <svg
              class="trend-chart"
              viewBox="0 0 320 124"
              role="img"
              :aria-label="text.dashboard.turnoversByGameAlt"
            >
              <path class="chart-gridline" d="M24 20H296 M24 63H296 M24 106H296" />
              <polyline
                v-if="games.length > 1"
                class="trend-line trend-red"
                :points="turnoverLine"
              />
              <circle
                v-for="(game, index) in games"
                :key="game.id"
                class="trend-dot trend-red-fill"
                :cx="trendX(index, games.length)"
                :cy="turnoverY(game.turnovers)"
                r="4"
              />
            </svg>
            <div class="chart-caption">
              <span>{{ formatDate(firstGame?.date ?? "") }}</span
              ><span>{{ text.dashboard.chronological }}</span
              ><span>{{ formatDate(latestGame?.date ?? "") }}</span>
            </div>
          </article>
          <article class="trend-card trend-card-wide">
            <div class="trend-heading">
              <h3>{{ text.dashboard.reboundsPerTen }}</h3>
              <div class="legend">
                <span><i class="legend-off"></i>{{ text.dashboard.offensive }}</span
                ><span><i class="legend-def"></i>{{ text.dashboard.defensive }}</span>
              </div>
            </div>
            <svg
              class="trend-chart"
              viewBox="0 0 320 124"
              role="img"
              :aria-label="text.dashboard.reboundsByGameAlt"
            >
              <path class="chart-gridline" d="M24 20H296 M24 63H296 M24 106H296" />
              <polyline
                v-if="games.length > 1"
                class="trend-line trend-gold"
                :points="rebounds.offensive"
              />
              <polyline
                v-if="games.length > 1"
                class="trend-line trend-red"
                :points="rebounds.defensive"
              />
              <circle
                v-for="dot in rebounds.dots"
                :key="`${dot.id}-off`"
                class="trend-dot trend-gold-fill"
                :cx="dot.x"
                :cy="dot.offensiveY"
                r="4"
              />
              <circle
                v-for="dot in rebounds.dots"
                :key="`${dot.id}-def`"
                class="trend-dot trend-red-fill"
                :cx="dot.x"
                :cy="dot.defensiveY"
                r="4"
              />
            </svg>
            <div class="chart-caption">
              <span>{{ formatDate(firstGame?.date ?? "") }}</span
              ><span>{{ text.dashboard.chronological }}</span
              ><span>{{ formatDate(latestGame?.date ?? "") }}</span>
            </div>
          </article>
        </div>
      </section>

      <section class="game-section">
        <aside class="game-list-panel">
          <div class="section-title section-title-compact">
            <div>
              <p class="eyebrow">{{ text.dashboard.gameByGame }}</p>
              <h2>{{ text.dashboard.games }}</h2>
            </div>
          </div>
          <label class="game-picker-label" for="game-picker">{{ text.dashboard.chooseGame }}</label>
          <select
            id="game-picker"
            v-model="selectedId"
            class="game-picker"
            @change="selectGame(selectedId)"
          >
            <option v-for="game in [...games].reverse()" :key="game.id" :value="game.id">
              {{ formatDate(game.date) }} · {{ game.opponent_name }}
            </option>
          </select>
          <button
            v-for="game in [...games].reverse()"
            :key="game.id"
            class="game-list-item"
            :class="{ 'game-list-item-selected': selectedId === game.id }"
            @click="selectGame(game.id)"
          >
            <span
              ><strong>{{ game.opponent_name }}</strong
              ><small>{{ formatDate(game.date) }}</small></span
            ><span class="game-list-ppp"
              >{{ formatPpp(game.points_per_possession)
              }}<small>{{ text.dashboard.ppp }}</small></span
            >
          </button>
        </aside>

        <div class="game-detail">
          <template v-if="selectedSummary">
            <div class="game-detail-title">
              <div>
                <p class="eyebrow">{{ formatDate(selectedSummary.date) }}</p>
                <h2>{{ text.dashboard.vs }} {{ selectedSummary.opponent_name }}</h2>
              </div>
              <div v-if="selectedSummary.final_score_for != null" class="final-score-block">
                <div class="final-score">
                  {{ selectedSummary.final_score_for }}<span>-</span
                  >{{ selectedSummary.final_score_against }}
                </div>
                <p
                  v-if="selectedResultText"
                  class="game-result"
                  :class="`game-result-${selectedResult}`"
                >
                  {{ selectedResultText }}
                </p>
              </div>
            </div>
            <div class="game-stat-grid">
              <div>
                <strong>{{ selectedSummary.possessions }}</strong
                ><span>{{ text.dashboard.possessions }}</span>
              </div>
              <div>
                <strong>{{ formatPpp(selectedSummary.points_per_possession) }}</strong
                ><span>{{ text.dashboard.pointsPerPossessionShort }}</span>
              </div>
              <div>
                <strong>{{ selectedSummary.turnovers }}</strong
                ><span>{{ text.dashboard.turnoversLabel }}</span>
              </div>
              <div>
                <strong
                  >{{ selectedSummary.offensive_rebounds }} <i>/</i>
                  {{ selectedSummary.defensive_rebounds }}</strong
                ><span>{{ text.dashboard.reboundSplit }}</span>
              </div>
            </div>
            <article class="possession-card">
              <div class="possession-heading">
                <div>
                  <p class="eyebrow">{{ text.dashboard.possessionByPossession }}</p>
                  <h3>{{ text.dashboard.pointsOnTrip }}</h3>
                </div>
                <span
                  >{{ text.dashboard.pppEquals }}
                  {{ formatPpp(selectedSummary.points_per_possession) }}</span
                >
              </div>
              <p v-if="detailError" class="detail-error" role="alert">{{ detailError }}</p>
              <p v-else-if="!selectedGame" class="chart-loading">
                {{ text.dashboard.loadingDetail }}
              </p>
              <p v-else-if="!possessions.length" class="chart-loading">
                {{ text.dashboard.noPossessions }}
              </p>
              <div v-else class="possession-chart-scroll">
                <svg
                  class="possession-chart"
                  :viewBox="`0 0 ${Math.max(360, possessions.length * 42 + 32)} 180`"
                  role="img"
                  :aria-label="possessionAlt(possessions.length)"
                >
                  <path class="chart-gridline" d="M24 132H10000 M24 82H10000 M24 32H10000" />
                  <g v-for="(possession, index) in possessions" :key="index">
                    <rect
                      class="possession-bar"
                      :class="
                        possession.points
                          ? 'possession-bar-score'
                          : possession.result === 'Turnover'
                            ? 'possession-bar-turnover'
                            : 'possession-bar-empty'
                      "
                      :x="30 + index * 42"
                      :y="132 - (possession.points / maxPossessionPoints) * 100"
                      width="22"
                      :height="Math.max(4, (possession.points / maxPossessionPoints) * 100)"
                      rx="5"
                    />
                    <text
                      class="bar-value"
                      :x="41 + index * 42"
                      :y="Math.max(20, 123 - (possession.points / maxPossessionPoints) * 100)"
                      text-anchor="middle"
                    >
                      {{ possession.points }}
                    </text>
                    <text class="bar-label" :x="41 + index * 42" y="154" text-anchor="middle">
                      {{ index + 1 }}
                    </text>
                    <title>{{ possessionTitle(index, possession) }}</title>
                  </g>
                </svg>
              </div>
              <div class="possession-legend">
                <span><i class="legend-score"></i>{{ text.dashboard.pointsScored }}</span
                ><span><i class="legend-zero"></i>{{ text.dashboard.noPoints }}</span
                ><span>{{ text.dashboard.reboundsContinue }}</span>
              </div>
            </article>
          </template>
        </div>
      </section>
    </template>
  </main>
</template>
