import { env } from "./env.ts";
import { app } from "./http/app.ts";
import { log } from "./logger.ts";

// Bun closes idle connections after 10 s, which would cut a stream while the model thinks; TURN_TIMEOUT_MS is the real bound.
const server = Bun.serve({ port: env.PORT, hostname: "0.0.0.0", idleTimeout: 0, fetch: app.fetch });

log.info("cv-agent listening", { port: server.port, model: env.AGENT_MODEL, authRequired: Boolean(env.AGENT_API_KEY) });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("shutting down", { signal });
    server.stop(false);
    // Matches drainingSeconds in railway.json: in-flight streams get the same grace on both sides.
    setTimeout(() => process.exit(0), 30_000).unref();
  });
}
