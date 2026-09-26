import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pppSeries, reboundSeries, trendY } from "../frontend/src/lib/trends.js";

function game(id, stats) {
  return {
    id,
    possessions: 0,
    points_per_possession: null,
    offensive_rebounds: 0,
    defensive_rebounds: 0,
    turnovers: 0,
    ...stats,
  };
}

describe("season charts", () => {
  it("draws rebound lines and dots on one scale", () => {
    const series = reboundSeries([
      game("low", { possessions: 5, offensive_rebounds: 1, defensive_rebounds: 5 }),
      game("high", { possessions: 5, offensive_rebounds: 5, defensive_rebounds: 1 }),
    ]);

    assert.equal(series.ceiling, 10);
    const [low, high] = series.dots;
    assert.ok(low.offensiveY > low.defensiveY);
    assert.equal(low.defensiveY, trendY(10, 10));
    assert.equal(low.offensiveY, trendY(2, 10));
    assert.equal(series.offensive.split(" ")[0], `${low.x},${low.offensiveY}`);
    assert.equal(series.defensive.split(" ")[1], `${high.x},${high.defensiveY}`);
  });

  it("breaks the PPP line around a game with no possessions instead of drawing zero", () => {
    const series = pppSeries([
      game("scored", { points_per_possession: 2 }),
      game("none", { points_per_possession: null }),
      game("zero", { points_per_possession: 0 }),
      game("again", { points_per_possession: 1 }),
    ]);

    assert.deepEqual(
      series.dots.map((dot) => dot.id),
      ["scored", "zero", "again"],
    );
    assert.equal(series.dots.find((dot) => dot.id === "zero").y, trendY(0, 2.5));
    assert.equal(series.segments.length, 1);
    assert.equal(series.segments[0].split(" ").length, 2);
  });
});
