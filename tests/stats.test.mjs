import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeEvents, computeStats, endsPossession } from "../frontend/src/lib/stats.js";

describe("possession rules", () => {
  it("ends a possession on SCORE, EMPTY and TOV only", () => {
    assert.equal(endsPossession("SCORE"), true);
    assert.equal(endsPossession("EMPTY"), true);
    assert.equal(endsPossession("TOV"), true);
    assert.equal(endsPossession("OFF_REB"), false);
    assert.equal(endsPossession("DEF_REB"), false);
  });
});

describe("game statistics", () => {
  it("returns an empty stat line for a game with no events", () => {
    assert.deepEqual(computeStats([]), {
      points: 0,
      possessions: 0,
      points_per_possession: null,
      offensive_rebounds: 0,
      defensive_rebounds: 0,
      turnovers: 0,
    });
  });

  it("counts a two point and a three point score as two possessions", () => {
    const stats = computeStats([event("SCORE", 2), event("SCORE", 3)]);
    assert.equal(stats.points, 5);
    assert.equal(stats.possessions, 2);
    assert.equal(stats.points_per_possession, 2.5);
  });

  it("counts EMPTY possessions without adding points", () => {
    const stats = computeStats([event("SCORE", 2), event("EMPTY", 0), event("EMPTY", 0)]);
    assert.equal(stats.points, 2);
    assert.equal(stats.possessions, 3);
    assert.equal(stats.points_per_possession, 2 / 3);
    assert.equal(stats.turnovers, 0);
  });

  it("counts turnovers as possessions ended with no points", () => {
    const stats = computeStats([event("TOV", 0), event("TOV", 0), event("SCORE", 3)]);
    assert.equal(stats.turnovers, 2);
    assert.equal(stats.possessions, 3);
    assert.equal(stats.points, 3);
    assert.equal(stats.points_per_possession, 1);
  });

  it("counts offensive rebounds without ending a possession", () => {
    const stats = computeStats([
      event("SCORE", 2),
      event("OFF_REB", 0),
      event("OFF_REB", 0),
      event("SCORE", 2),
    ]);
    assert.equal(stats.offensive_rebounds, 2);
    assert.equal(stats.possessions, 2);
    assert.equal(stats.points, 4);
    assert.equal(stats.points_per_possession, 2);
  });

  it("counts defensive rebounds without touching the possession count", () => {
    const stats = computeStats([
      event("DEF_REB", 0),
      event("DEF_REB", 0),
      event("DEF_REB", 0),
      event("SCORE", 3),
    ]);
    assert.equal(stats.defensive_rebounds, 3);
    assert.equal(stats.possessions, 1);
    assert.equal(stats.points, 3);
    assert.equal(stats.points_per_possession, 3);
  });

  it("keeps rebounds out of the possession count in a mixed sequence", () => {
    const stats = computeStats([
      event("SCORE", 2),
      event("OFF_REB", 0),
      event("SCORE", 3),
      event("EMPTY", 0),
      event("DEF_REB", 0),
      event("TOV", 0),
      event("OFF_REB", 0),
    ]);
    assert.deepEqual(stats, {
      points: 5,
      possessions: 4,
      points_per_possession: 1.25,
      offensive_rebounds: 2,
      defensive_rebounds: 1,
      turnovers: 1,
    });
  });

  it("leaves points per possession null with zero possessions", () => {
    const stats = computeStats([event("OFF_REB", 0), event("DEF_REB", 0)]);
    assert.equal(stats.possessions, 0);
    assert.equal(stats.points, 0);
    assert.equal(stats.points_per_possession, null);
  });

  it("does not count a repeated event id twice", () => {
    const score = event("SCORE", 3);
    const stats = computeStats([score, { ...score }, { ...score }, event("TOV", 0)]);
    assert.equal(stats.possessions, 2);
    assert.equal(stats.points, 3);
    assert.equal(stats.turnovers, 1);
    assert.equal(stats.points_per_possession, 1.5);
  });

  it("keeps events that share a type but not an id", () => {
    const stats = computeStats([event("DEF_REB", 0), event("DEF_REB", 0)]);
    assert.equal(stats.defensive_rebounds, 2);
  });

  it("drops an undone event from the statistics", () => {
    const score = event("SCORE", 2);
    const stats = computeStats([{ ...score, deleted: true }, event("TOV", 0)]);
    assert.equal(stats.possessions, 1);
    assert.equal(stats.points, 0);
    assert.equal(stats.turnovers, 1);
    assert.equal(stats.points_per_possession, 0);
  });

  it("still counts an event whose duplicate carries the undo flag", () => {
    const score = event("SCORE", 2);
    const stats = computeStats([score, { ...score, deleted: true }]);
    assert.equal(stats.possessions, 1);
    assert.equal(stats.points, 2);
  });
});

describe("activeEvents", () => {
  it("keeps the first copy of an id and drops undone events", () => {
    const first = event("SCORE", 2);
    const second = { ...first, points: 3 };
    assert.deepEqual(activeEvents([first, second, { ...first, deleted: true }]), [first]);
  });

  it("ignores a duplicate that is marked deleted wherever it appears", () => {
    const score = event("SCORE", 2);
    assert.deepEqual(activeEvents([{ ...score, deleted: true }, score]), [score]);
  });
});

let nextId = 0;

function event(type, points) {
  nextId += 1;
  return {
    id: `event-${nextId}`,
    game_id: "game-1",
    type,
    points,
    created_at: `2026-10-04T10:${String(nextId).padStart(2, "0")}:00.000Z`,
    synced: false,
  };
}
