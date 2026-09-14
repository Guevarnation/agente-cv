import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { env } from "../env.ts";
import { tooManyRequests, unauthorized } from "../openresponses/errors.ts";

/** Constant-time comparison over hashes, so neither the value nor its length leaks. */
function secureCompare(a: string, b: string): boolean {
  const ha = new Bun.CryptoHasher("sha256").update(a).digest();
  const hb = new Bun.CryptoHasher("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** `Authorization: Bearer <AGENT_API_KEY>`. An unset key leaves the endpoint open, for local use only. */
export async function requireApiKey(c: Context, next: Next) {
  const expected = env.AGENT_API_KEY;
  if (!expected) return next();
  const presented = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization")?.trim() ?? "")?.[1]?.trim();
  if (!presented || !secureCompare(presented, expected)) throw unauthorized();
  return next();
}

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();

/**
 * Token bucket per client IP, refilled continuously. The client controls the start of x-forwarded-for;
 * the last hop is the one the proxy adds and the only one it cannot forge.
 */
export function rateLimitFor(rpm: number) {
  return async (c: Context, next: Next) => {
    const hops =
      c.req
        .header("x-forwarded-for")
        ?.split(",")
        .map((h) => h.trim())
        .filter(Boolean) ?? [];
    const key = hops.at(-1) || c.req.header("x-real-ip") || "unknown";
    const now = Date.now();

    const b = buckets.get(key) ?? { tokens: rpm, updatedAt: now };
    b.tokens = Math.min(rpm, b.tokens + ((now - b.updatedAt) / 60_000) * rpm);
    b.updatedAt = now;
    buckets.set(key, b);
    if (b.tokens < 1) {
      c.header("Retry-After", String(Math.ceil(((1 - b.tokens) / rpm) * 60)));
      throw tooManyRequests();
    }
    b.tokens -= 1;

    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.updatedAt > 300_000) buckets.delete(k);
    return next();
  };
}

export const rateLimit = rateLimitFor(env.RATE_LIMIT_RPM);

export async function requestId(c: Context, next: Next) {
  const given = c.req.header("x-request-id");
  const id = given && /^[A-Za-z0-9._-]{1,128}$/.test(given) ? given : crypto.randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  return next();
}
