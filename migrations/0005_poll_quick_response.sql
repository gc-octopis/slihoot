-- Adds poll/no-score activity state and persistent quick-response records.

ALTER TABLE live_sessions
  ADD COLUMN no_score_activity_ids JSON NULL AFTER completed_activity_ids;

CREATE TABLE IF NOT EXISTS quick_response_runs (
  id VARCHAR(36) PRIMARY KEY,
  live_session_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'waiting',
  started_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_quick_runs_live_created (live_session_id, created_at),
  INDEX idx_quick_runs_live_status (live_session_id, status),
  CONSTRAINT fk_quick_runs_live FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quick_response_entries (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  live_session_id VARCHAR(36) NOT NULL,
  participant_id VARCHAR(36) NOT NULL,
  rank_order INT NOT NULL,
  clicked_at DATETIME(3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_quick_entry_participant (run_id, participant_id),
  UNIQUE KEY uniq_quick_entry_rank (run_id, rank_order),
  INDEX idx_quick_entries_live (live_session_id, clicked_at),
  CONSTRAINT fk_quick_entries_run FOREIGN KEY (run_id) REFERENCES quick_response_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_quick_entries_live FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_quick_entries_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
);
