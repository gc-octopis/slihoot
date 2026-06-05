import mysql from "mysql2/promise";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Strip line comments and split a .sql file into individual statements. */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Versioned, file-based migration runner. Each `migrations/NNNN_*.sql` file is
 * applied at most once; applied versions are recorded in `schema_migrations`.
 * Replaces the previous hand-rolled migration array + addColumnIfMissing.
 */
export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const [appliedRows] = await pool.query(`SELECT version FROM schema_migrations`);
  const applied = new Set((appliedRows as any[]).map((row) => row.version as string));

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), "utf8");
    for (const statement of splitStatements(sql)) {
      await pool.query(statement);
    }
    await pool.query(`INSERT INTO schema_migrations (version) VALUES (?)`, [file]);
    console.log(`[slihoot] applied migration ${file}`);
  }

  await ensureLegacySchemaCompatibility();
}

async function tableExists(tableName: string) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number((rows as any[])[0]?.total ?? 0) > 0;
}

async function columnExists(tableName: string, columnName: string) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number((rows as any[])[0]?.total ?? 0) > 0;
}

async function addColumnIfMissing(tableName: string, columnName: string, definition: string) {
  if (!(await tableExists(tableName))) return;
  if (await columnExists(tableName, columnName)) return;
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

async function ensureLegacySchemaCompatibility() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS event_presentations (
      id VARCHAR(36) PRIMARY KEY,
      event_id VARCHAR(36) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      file_size BIGINT NOT NULL DEFAULT 0,
      page_count INT NOT NULL DEFAULT 0,
      page_sizes_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_event_presentation (event_id),
      CONSTRAINT fk_presentations_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    )`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS event_timeline_items (
      id VARCHAR(36) PRIMARY KEY,
      event_id VARCHAR(36) NOT NULL,
      type VARCHAR(24) NOT NULL,
      activity_id VARCHAR(36) NULL,
      presentation_id VARCHAR(36) NULL,
      page_number INT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_timeline_event_order (event_id, sort_order),
      INDEX idx_timeline_activity (activity_id),
      CONSTRAINT fk_timeline_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      CONSTRAINT fk_timeline_activity FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
      CONSTRAINT fk_timeline_presentation FOREIGN KEY (presentation_id) REFERENCES event_presentations(id) ON DELETE CASCADE
    )`
  );

  await addColumnIfMissing(
    "live_sessions",
    "current_timeline_item_id",
    "current_timeline_item_id VARCHAR(36) NULL AFTER status"
  );
  await addColumnIfMissing(
    "live_sessions",
    "current_timeline_index",
    "current_timeline_index INT NOT NULL DEFAULT 0 AFTER current_timeline_item_id"
  );
  await addColumnIfMissing(
    "live_sessions",
    "current_activity_started_at",
    "current_activity_started_at DATETIME NULL AFTER current_activity_index"
  );
  await addColumnIfMissing(
    "live_sessions",
    "completed_activity_ids",
    "completed_activity_ids JSON NULL AFTER current_activity_started_at"
  );
  await addColumnIfMissing(
    "live_sessions",
    "show_participant_names",
    "show_participant_names BOOLEAN NOT NULL DEFAULT FALSE AFTER show_results"
  );

  await addColumnIfMissing("activities", "explanation", "explanation TEXT NULL AFTER description");
  await addColumnIfMissing(
    "activities",
    "time_limit_seconds",
    "time_limit_seconds INT NOT NULL DEFAULT 0 AFTER explanation"
  );
  await addColumnIfMissing(
    "event_presentations",
    "page_sizes_json",
    "page_sizes_json JSON NULL AFTER page_count"
  );
  await addColumnIfMissing("responses", "score", "score INT NOT NULL DEFAULT 0");

  if (await tableExists("activities")) {
    await pool.query("ALTER TABLE activities MODIFY COLUMN title TEXT NOT NULL");
  }
}
