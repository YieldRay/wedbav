import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { sign, verify } from "hono/jwt";
import { env } from "./env.ts";
import type { WedbavOptions } from "./wedbav.ts";

export const SESSION_COOKIE = "wedbav_session";

const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * Resolve the JWT signing secret. Precedence:
 * 1. `options.jwtSecret`
 * 2. `WEDBAV_JWT_SECRET`
 * 3. sha256 of `WEDBAV_PASSWORD` — stable across restarts so cookies survive a
 *    server restart with zero extra configuration.
 * 4. A random per-process secret — only when the server is intentionally public
 *    (no password configured); cookies then expire on restart.
 */
export function resolveJwtSecret(options: WedbavOptions): string {
  if (options.jwtSecret) return options.jwtSecret;
  if (env.WEDBAV_JWT_SECRET) return env.WEDBAV_JWT_SECRET;
  if (env.WEDBAV_PASSWORD) {
    return createHash("sha256").update(`wedbav:${env.WEDBAV_PASSWORD}`).digest("hex");
  }
  return randomBytes(32).toString("hex");
}

/** Session lifetime in seconds: `options.sessionMaxAge` → `WEDBAV_JWT_MAX_AGE` → 30 days. */
export function resolveSessionMaxAge(options: WedbavOptions): number {
  if (typeof options.sessionMaxAge === "number" && Number.isFinite(options.sessionMaxAge)) {
    return Math.max(0, Math.floor(options.sessionMaxAge));
  }
  const fromEnv = Number(env.WEDBAV_JWT_MAX_AGE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_MAX_AGE;
}

/**
 * The session cookie is only allowed over HTTPS (direct TLS, or TLS terminated
 * by a reverse proxy that sets `X-Forwarded-Proto: https`). On plain HTTP the
 * cookie is neither issued nor accepted.
 */
export function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) {
    return forwarded
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .includes("https");
  }
  return new URL(c.req.url).protocol === "https:";
}

export async function signSessionToken(username: string, secret: string, maxAge: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: username, iat: now, exp: now + maxAge }, secret);
}

/** Returns the session username, or null when the token is invalid or expired. */
export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  try {
    const payload = await verify(token, secret, "HS256");
    const { sub } = payload as { sub?: unknown };
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

export function buildSessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export function readSessionCookie(c: Context): string | undefined {
  const header = c.req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}
