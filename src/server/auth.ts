import type { Context, Next } from "hono";
import { sign, verify } from "hono/jwt";
import { env } from "./env";

const adminTtlSeconds = 60 * 60 * 24;

function bearerToken(value: string | undefined) {
  if (!value) return null;
  const [scheme, token] = value.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export async function issueAdminToken() {
  return sign(
    {
      role: "admin",
      exp: Math.floor(Date.now() / 1000) + adminTtlSeconds
    },
    env.jwtSecret
  );
}

export async function verifyAdminToken(token: string | null | undefined) {
  if (!token) return null;

  try {
    const payload = await verify(token, env.jwtSecret, "HS256");
    return payload.role === "admin" ? payload : null;
  } catch {
    return null;
  }
}

export async function requireAdmin(c: Context, next: Next) {
  const payload = await verifyAdminToken(bearerToken(c.req.header("authorization")));
  if (!payload) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}

export async function isAdminRequest(c: Context) {
  return Boolean(await verifyAdminToken(bearerToken(c.req.header("authorization"))));
}

export function tokenFromAuthorization(value: string | undefined) {
  return bearerToken(value);
}
