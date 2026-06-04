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
}
