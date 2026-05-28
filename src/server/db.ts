import mysql from "mysql2/promise";
import { env } from "./env";

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});

const migrations = [
  `CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS activities (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36) NOT NULL,
    type VARCHAR(32) NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    options_json JSON NULL,
    correct_answer_json JSON NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_activities_event_order (event_id, sort_order),
    CONSTRAINT fk_activities_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS live_sessions (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36) NOT NULL,
    join_code VARCHAR(8) NOT NULL UNIQUE,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    current_activity_id VARCHAR(36) NULL,
    current_activity_index INT NOT NULL DEFAULT 0,
    show_results BOOLEAN NOT NULL DEFAULT FALSE,
    show_participant_names BOOLEAN NOT NULL DEFAULT FALSE,
    started_at DATETIME NULL,
    ended_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_live_sessions_event (event_id),
    INDEX idx_live_sessions_join_code (join_code),
    CONSTRAINT fk_live_sessions_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS participants (
    id VARCHAR(36) PRIMARY KEY,
    live_session_id VARCHAR(36) NOT NULL,
    nickname VARCHAR(80) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_participants_live (live_session_id),
    CONSTRAINT fk_participants_live FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS responses (
    id VARCHAR(36) PRIMARY KEY,
    live_session_id VARCHAR(36) NOT NULL,
    activity_id VARCHAR(36) NOT NULL,
    participant_id VARCHAR(36) NOT NULL,
    answer_json JSON NOT NULL,
    received_at DATETIME(3) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_response_once (live_session_id, activity_id, participant_id),
    INDEX idx_responses_activity (live_session_id, activity_id),
    CONSTRAINT fk_responses_live FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_responses_activity FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
    CONSTRAINT fk_responses_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS live_messages (
    id VARCHAR(36) PRIMARY KEY,
    live_session_id VARCHAR(36) NOT NULL,
    participant_id VARCHAR(36) NOT NULL,
    content VARCHAR(200) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'visible',
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    moderated_at DATETIME NULL,
    INDEX idx_messages_live_created (live_session_id, created_at),
    CONSTRAINT fk_messages_live FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
  )`
];

async function addColumnIfMissing(tableName: string, columnName: string, definition: string) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = :tableName
       AND COLUMN_NAME = :columnName
     LIMIT 1`,
    { tableName, columnName }
  );

  if ((rows as any[]).length > 0) return;

  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

export async function migrate() {
  for (const statement of migrations) {
    await pool.query(statement);
  }

  await addColumnIfMissing(
    "live_sessions",
    "show_participant_names",
    "show_participant_names BOOLEAN NOT NULL DEFAULT FALSE AFTER show_results"
  );

  await addColumnIfMissing(
    "live_sessions",
    "current_activity_started_at",
    "current_activity_started_at DATETIME NULL AFTER current_activity_index"
  );

  await addColumnIfMissing(
    "activities",
    "explanation",
    "explanation TEXT NULL AFTER description"
  );

  await addColumnIfMissing(
    "activities",
    "time_limit_seconds",
    "time_limit_seconds INT NOT NULL DEFAULT 0 AFTER explanation"
  );

  await addColumnIfMissing(
    "live_sessions",
    "completed_activity_ids",
    "completed_activity_ids JSON NULL AFTER current_activity_started_at"
  );
}
