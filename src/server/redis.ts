import { RedisClient } from "bun";
import { env } from "./env";

/**
 * Single Redis instance used as an *optimisation layer* — cache, rate limiting
 * and presence. It is intentionally NOT a hard dependency: every helper here
 * degrades gracefully (cache miss / "allow" / no-op) when Redis is disabled or
 * unreachable, so the app keeps working off MySQL alone.
 */

export const redisEnabled = env.redis.enabled;

let client: RedisClient | null = null;
let warnedDown = false;

function getClient(): RedisClient | null {
  if (!redisEnabled) return null;
  if (!client) {
    client = new RedisClient(env.redis.url);
    client.onclose = (error) => {
      if (error && !warnedDown) {
        warnedDown = true;
        console.warn("[slihoot] redis connection closed:", error.message);
      }
    };
  }
  return client;
}

export async function redisPing(): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    const result = await c.send("PING", []);
    return result === "PONG" || result === "OK";
  } catch {
    return false;
  }
}

/** Returns the cached string, or null on miss / unavailable. */
export async function cacheGet(key: string): Promise<string | null> {
  const c = getClient();
  if (!c) return null;
  try {
    return await c.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.send("SET", [key, value, "EX", String(Math.max(1, Math.floor(ttlSeconds)))]);
  } catch {
    /* best effort */
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const c = getClient();
  if (!c || keys.length === 0) return;
  try {
    await c.send("DEL", keys);
  } catch {
    /* best effort */
  }
}

/**
 * Fixed-window rate limit. Returns the request count within the current window,
 * or `null` when Redis is unavailable (caller should fail-open and allow it).
 */
export async function rateLimitHit(key: string, windowSeconds: number): Promise<number | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const count = Number(await c.incr(key));
    if (count === 1) {
      await c.expire(key, Math.max(1, Math.floor(windowSeconds)));
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Presence tracking via a per-room sorted set scored by last-seen timestamp.
 * Stale members are pruned on read so counts reflect only recently-active
 * participants without needing a background sweeper.
 */
export async function presenceTouch(
  liveId: string,
  participantId: string,
  ttlSeconds: number
): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    const key = `live:${liveId}:online`;
    await c.send("ZADD", [key, String(Date.now()), participantId]);
    await c.expire(key, Math.max(ttlSeconds * 2, 60));
  } catch {
    /* best effort */
  }
}

/** Online count within the freshness window, or null when unavailable. */
export async function presenceCount(liveId: string, ttlSeconds: number): Promise<number | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const key = `live:${liveId}:online`;
    const cutoff = Date.now() - ttlSeconds * 1000;
    await c.send("ZREMRANGEBYSCORE", [key, "-inf", String(cutoff)]);
    const count = await c.send("ZCARD", [key]);
    return Number(count);
  } catch {
    return null;
  }
}

export async function presenceRemove(liveId: string, participantId: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.send("ZREM", [`live:${liveId}:online`, participantId]);
  } catch {
    /* best effort */
  }
}

/** Close the Redis connection (used during graceful shutdown). */
export function closeRedis(): void {
  if (!client) return;
  try {
    client.close();
  } catch {
    /* already closed */
  }
  client = null;
}
