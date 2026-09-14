import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import pkg from "../../package.json" with { type: "json" };
import { env } from "../env.ts";
import { log } from "../logger.ts";
import { AgentError, badRequest, notFound, toEnvelope } from "../openresponses/errors.ts";
import type { ResponseResource } from "../openresponses/response.ts";
import { CreateResponseBody } from "../openresponses/schema.ts";
import { prepareTurn, runTurn } from "../turn.ts";
import { agentCard } from "./agent-card.ts";
import { rateLimit, requestId, requireApiKey } from "./middleware.ts";

type Vars = { requestId: string };
export const app = new Hono<{ Variables: Vars }>();

app.use("*", requestId);
app.use("*", secureHeaders());
app.use(
  "*",
  cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "OPTIONS"] }),
);

app.onError((err, c) => {
  const { status, body } = toEnvelope(err);
  if (!(err instanceof AgentError)) log.error("unhandled error", { requestId: c.get("requestId"), error: String(err) });
  return c.json(body, status as never);
});
app.notFound((c) => {
  const { status, body } = toEnvelope(notFound("No se encontro el recurso."));
  return c.json(body, status as never);
});

/** Public origin of this request, honouring the deployment proxy. */
function publicOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const safeHost = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : url.host;
  return `${proto === "http" ? "http" : "https"}://${safeHost}`;
}

app.get("/health", (c) => c.json({ ok: true }));
app.get("/ready", (c) => c.json({ ok: true, model: env.AGENT_MODEL }));
app.get("/version", (c) =>
  c.json({ name: pkg.name, version: pkg.version, protocol: "openresponses/2026-04-24", model: env.AGENT_MODEL }),
);
app.get("/.well-known/agent-card.json", (c) => c.json(agentCard(publicOrigin(c))));
app.get("/", (c) =>
  c.json({
    name: "CV Agent — Eugenio Guevara",
    endpoint: `${publicOrigin(c)}/v1/responses`,
    agentCard: `${publicOrigin(c)}/.well-known/agent-card.json`,
    repository: "https://github.com/Guevarnation/agente-cv",
  }),
);

const responses = new Hono<{ Variables: Vars }>();
// Auth and rate limiting cover the protocol routes only; anything else falls through to 404.
// In Hono "/responses/*" also matches "/responses", so one registration covers both.
responses.use("/responses/*", rateLimit, requireApiKey);

const limit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: () => {
    throw badRequest("El cuerpo excede 1 MB.", null, "payload_too_large");
  },
});

responses.post("/responses", limit, async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("El cuerpo debe ser JSON valido.", null, "invalid_json");
  }
  const parsed = CreateResponseBody.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || null;
    throw badRequest(`${path ?? "body"}: ${issue?.message ?? "Peticion invalida."}`, path);
  }

  const body = parsed.data;
  const rid = c.get("requestId");
  const turn = prepareTurn(body, rid);
  const events = runTurn(turn, c.req.raw.signal, rid);

  if (body.stream !== true) {
    let final: ResponseResource | null = null;
    for await (const e of events) {
      if (e.type === "response.completed" || e.type === "response.incomplete" || e.type === "response.failed")
        final = e.response as ResponseResource;
    }
    if (!final) throw new Error("El turno no produjo un evento terminal.");
    // Always 200: the outcome is in `status`. A 5xx would send the client looking for an error envelope this body lacks.
    return c.json(final, 200);
  }

  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let lastSeq = -1;
    try {
      for await (const e of events) {
        lastSeq = e.sequence_number;
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
    } catch (err) {
      // runTurn already emits error + response.failed for provider failures; anything reaching here is a bug.
      log.error("stream failed", { requestId: rid, error: String(err) });
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          type: "error",
          sequence_number: lastSeq + 1,
          error: { type: "server_error", code: "internal_error", message: "Error interno del agente.", param: null },
        }),
      });
    } finally {
      await stream.writeSSE({ data: "[DONE]" });
    }
  });
});

responses.get("/responses/:id", () => {
  throw notFound("Este agente no expone respuestas almacenadas; usa previous_response_id para continuar.");
});
responses.post("/responses/compact", () => {
  throw badRequest("Este agente no implementa /responses/compact.", null, "unsupported_endpoint");
});

app.route("/v1", responses);
app.route("/", responses);
