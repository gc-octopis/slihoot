export const env = {
  port: Number(Bun.env.PORT ?? 3000),
  adminPassword: Bun.env.ADMIN_PASSWORD ?? "change-me",
  jwtSecret: Bun.env.JWT_SECRET ?? "replace-with-a-long-random-secret",
  cloudflaredPath: Bun.env.CLOUDFLARED_PATH ?? "",
  db: {
    host: Bun.env.DB_HOST ?? "127.0.0.1",
    port: Number(Bun.env.DB_PORT ?? 3306),
    user: Bun.env.DB_USER ?? "slihoot",
    password: Bun.env.DB_PASSWORD ?? "slihoot",
    database: Bun.env.DB_NAME ?? "slihoot"
  },
  redis: {
    url: Bun.env.REDIS_URL ?? "",
    enabled: Boolean(Bun.env.REDIS_URL)
  },
  rateLimit: {
    // Per-IP join cap. Kept generous on purpose: an in-room audience often
    // shares one NAT/Wi-Fi egress IP, so many legitimate joins come from the
    // same address. High enough for a full room, low enough to stop a script
    // hammering thousands of fake joins.
    joinPerMinute: Number(Bun.env.RATE_LIMIT_JOIN_PER_MIN ?? 300)
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

