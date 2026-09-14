import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry, type LanguageModel, type ToolSet, tool } from "ai";
import { z } from "zod";
import { env, parseModelRef } from "./env.ts";
import { log } from "./logger.ts";
import { createMockModel, mockTools } from "./mock-model.ts";
import { badRequest } from "./openresponses/errors.ts";

/** AGENT_MODEL="<provider>:<model>": switching vendors is configuration, not code. */
const registry = createProviderRegistry({
  anthropic: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" }),
  openai: createOpenAI({ apiKey: env.OPENAI_API_KEY ?? "" }),
  google: createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY ?? "" }),
});

export type ResolvedModel = { model: LanguageModel; modelRef: string; providerId: string; tools: ToolSet };

/** Any model the configured providers can serve, for internal use (the eval judge). Not reachable from a request. */
export function modelFor(ref: string): ResolvedModel {
  const { providerId, modelId } = parseModelRef(ref);
  if (providerId === "mock") return { model: createMockModel(modelId), modelRef: ref, providerId, tools: mockTools };
  return { model: registry.languageModel(ref as never), modelRef: ref, providerId, tools };
}

/**
 * The operator chooses the model through AGENT_MODEL. A request may name that same model and nothing
 * else, so a client cannot route to a pricier model or to a provider without a key.
 */
export function resolveModel(requested?: string | null): ResolvedModel {
  const ref = requested?.trim() || env.AGENT_MODEL;
  const mockMode = parseModelRef(env.AGENT_MODEL).providerId === "mock" && parseModelRef(ref).providerId === "mock";
  if (!mockMode && ref !== env.AGENT_MODEL) {
    throw badRequest(
      `Modelo no soportado: "${ref}". Este agente usa "${env.AGENT_MODEL}".`,
      "model",
      "model_not_found",
    );
  }
  return modelFor(ref);
}

/** Claude 5 rejects temperature/top_p outright; dropping them beats a 400 the operator never sees. */
export function samplingFor(providerId: string, temperature: number | null, topP: number | null) {
  if (providerId === "anthropic") return {};
  return {
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof topP === "number" ? { topP } : {}),
  };
}

type Repo = {
  name: string;
  description: string | null;
  language: string | null;
  url: string;
  updatedAt: string;
  stars: number;
};
type RepoCache = { at: number; repos?: Repo[]; error?: string };

let repoCache: RepoCache | null = null;
const OK_TTL_MS = 10 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;

async function fetchRepos(): Promise<Repo[]> {
  if (repoCache) {
    const ttl = repoCache.error ? ERROR_TTL_MS : OK_TTL_MS;
    if (Date.now() - repoCache.at < ttl) {
      if (repoCache.repos) return repoCache.repos;
      throw new Error(repoCache.error);
    }
  }
  try {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(env.GITHUB_USERNAME)}/repos?sort=updated&per_page=30`,
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "cv-agent" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`GitHub respondio ${res.status}`);
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    const repos = raw
      .filter((r) => r.fork !== true)
      .map((r) => ({
        name: String(r.name ?? ""),
        description: (r.description as string | null) ?? null,
        language: (r.language as string | null) ?? null,
        url: String(r.html_url ?? ""),
        updatedAt: String(r.updated_at ?? "").slice(0, 10),
        stars: Number(r.stargazers_count ?? 0),
      }));
    repoCache = { at: Date.now(), repos };
    return repos;
  } catch (err) {
    repoCache = { at: Date.now(), error: String(err) };
    throw err;
  }
}

/**
 * The only tool. The CV already sits in the prompt, so a "search the CV" tool would be decoration;
 * GitHub is live data the CV cannot contain.
 */
export const tools = {
  listar_repositorios_github: tool({
    description:
      "Consulta en vivo los repositorios publicos de GitHub de Eugenio Guevara. Usar cuando pregunten por su GitHub, su codigo publico o sus proyectos mas recientes.",
    inputSchema: z.object({
      limite: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(10)
        .describe("Cuantos repositorios devolver, ordenados por actualizacion reciente."),
    }),
    execute: async ({ limite }) => {
      try {
        const repos = await fetchRepos();
        return { usuario: env.GITHUB_USERNAME, total: repos.length, repositorios: repos.slice(0, limite) };
      } catch (err) {
        log.warn("github tool failed", { error: String(err) });
        return {
          error: "No fue posible consultar GitHub en este momento.",
          sugerencia: `https://github.com/${env.GITHUB_USERNAME}`,
        };
      }
    },
  }),
};
