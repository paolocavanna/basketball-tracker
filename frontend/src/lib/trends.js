// Hand-rolled chart geometry for the season dashboard. One ceiling is shared by
// a line and its dots so a smaller series cannot be drawn on top of a larger one.

const TREND_TOP = 20;
const TREND_BOTTOM = 106;
const TREND_LEFT = 24;
const TREND_WIDTH = 272;
export const PPP_CEILING = 2.5;

export function trendX(index, count) {
  if (count < 2) return 160;
  return TREND_LEFT + (index * TREND_WIDTH) / (count - 1);
}

export function trendY(value, ceiling) {
  const safe = ceiling > 0 ? ceiling : 1;
  return TREND_BOTTOM - (value / safe) * (TREND_BOTTOM - TREND_TOP);
}

export function sharedCeiling(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 1;
  return Math.max(1, ...finite);
}

export function polylinePoints(values, ceiling, count) {
  return values
    .map((value, index) => `${trendX(index, count)},${trendY(value, ceiling)}`)
    .join(" ");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// A game with no possessions has a null PPP. Plotting that as zero would show
// a scoreless trip that never happened, so the line breaks around it.
export function pppSeries(games) {
  const segments = [];
  let current = [];
  const dots = [];

  games.forEach((game, index) => {
    const value = game.points_per_possession;
    if (!finiteNumber(value)) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    const point = `${trendX(index, games.length)},${trendY(value, PPP_CEILING)}`;
    current.push(point);
    dots.push({ id: game.id, x: trendX(index, games.length), y: trendY(value, PPP_CEILING) });
  });
  if (current.length > 1) segments.push(current.join(" "));
  return { segments, dots };
}

function perTen(count, possessions) {
  return possessions ? (count / possessions) * 10 : 0;
}

// Offensive and defensive rates share one scale. Separate scales draw a rate
// of 2 on the same gridline as a rate of 10.
export function reboundSeries(games) {
  const offensive = games.map((game) => perTen(game.offensive_rebounds, game.possessions));
  const defensive = games.map((game) => perTen(game.defensive_rebounds, game.possessions));
  const ceiling = sharedCeiling([...offensive, ...defensive]);
  const count = games.length;
  return {
    ceiling,
    offensive: polylinePoints(offensive, ceiling, count),
    defensive: polylinePoints(defensive, ceiling, count),
    dots: games.map((game, index) => ({
      id: game.id,
      x: trendX(index, count),
      offensiveY: trendY(offensive[index], ceiling),
      defensiveY: trendY(defensive[index], ceiling),
    })),
  };
}
