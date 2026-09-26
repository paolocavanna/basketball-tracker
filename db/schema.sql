CREATE TABLE teams (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,           -- e.g. 'U13', 'U14'
  slug     TEXT NOT NULL UNIQUE     -- e.g. 'campus-monferrato-u13'
);

CREATE TABLE games (
  id                  TEXT PRIMARY KEY,  -- client-generated UUID, see § offline architecture
  team_id             INTEGER NOT NULL REFERENCES teams(id),
  date                TEXT NOT NULL,   -- ISO 8601, e.g. '2026-10-04'
  opponent_name       TEXT NOT NULL,
  final_score_for     INTEGER,
  final_score_against INTEGER,
  created_at          TEXT NOT NULL   -- set by the client at creation time, not by the server
);

CREATE INDEX idx_games_team_id ON games(team_id);

CREATE TABLE events (
  id         TEXT PRIMARY KEY,  -- client-generated UUID, see § offline architecture
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('SCORE', 'EMPTY', 'TOV', 'OFF_REB', 'DEF_REB')),
  points     INTEGER NOT NULL DEFAULT 0
             CHECK ((type = 'SCORE' AND points IN (2, 3)) OR (type != 'SCORE' AND points = 0)),
  created_at TEXT NOT NULL   -- the moment it happened courtside, not the moment it synced
);

CREATE INDEX idx_events_game_id ON events(game_id);

-- Seed the one team you actually have right now:
INSERT INTO teams (name, category, slug)
VALUES ('Campus Monferrato', 'U13', 'campus-monferrato-u13');
