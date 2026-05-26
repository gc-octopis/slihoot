export const env = {
  port: Number(Bun.env.PORT ?? 3000),
  adminPassword: Bun.env.ADMIN_PASSWORD ?? "change-me",
  jwtSecret: Bun.env.JWT_SECRET ?? "replace-with-a-long-random-secret",
  db: {
    host: Bun.env.DB_HOST ?? "127.0.0.1",
    port: Number(Bun.env.DB_PORT ?? 3306),
    user: Bun.env.DB_USER ?? "slihoot",
    password: Bun.env.DB_PASSWORD ?? "slihoot",
    database: Bun.env.DB_NAME ?? "slihoot"
  },
  autoMigrate: (Bun.env.DB_AUTO_MIGRATE ?? "true") !== "false"
};

export function assertRuntimeConfig() {
  if (env.jwtSecret === "replace-with-a-long-random-secret") {
    console.warn("[slihoot] JWT_SECRET is using the default development value.");
  }

  if (env.adminPassword === "change-me") {
    console.warn("[slihoot] ADMIN_PASSWORD is using the default development value.");
  }
}

