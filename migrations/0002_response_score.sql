-- Per-response score for Kahoot-style scoring + leaderboard.
-- Computed at answer time: 0 if wrong, otherwise scaled by how fast the
-- participant answered relative to the question's time limit.
ALTER TABLE responses ADD COLUMN score INT NOT NULL DEFAULT 0;
