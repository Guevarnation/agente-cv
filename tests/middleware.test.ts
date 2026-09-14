import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

const { rateLimitFor } = await import("../src/http/middleware.ts");
const { toEnvelope } = await import("../src/openresponses/errors.ts");

describe("rateLimitFor", () => {
  test("allows exactly N requests per minute, then 429 with Retry-After", async () => {
    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toEnvelope(err);
      return c.json(body, status as never);
    });
    app.use("/responses/*", rateLimitFor(2));
    app.post("/responses", (c) => c.json({ ok: true }));

    const hit = () =>
      app.fetch(new Request("http://x/responses", { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" } }));
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const third = await hit();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("buckets are keyed by the last forwarded hop, the one the proxy adds", async () => {
    const app = new Hono();
    app.onError((err, c) => c.json(toEnvelope(err).body, toEnvelope(err).status as never));
    app.use("/responses/*", rateLimitFor(1));
    app.post("/responses", (c) => c.json({ ok: true }));
    const hit = (xff: string) =>
      app.fetch(new Request("http://x/responses", { method: "POST", headers: { "x-forwarded-for": xff } }));
    expect((await hit("1.1.1.1, 10.0.0.1")).status).toBe(200);
    expect((await hit("2.2.2.2, 10.0.0.1")).status).toBe(429);
    expect((await hit("3.3.3.3, 10.0.0.2")).status).toBe(200);
  });
});
