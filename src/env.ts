import { z } from "zod";

export const PROVIDER_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const;

/** "anthropic:claude-sonnet-5" -> { providerId, modelId }. A bare id means anthropic. */
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const i = ref.indexOf(":");
  return i === -1
    ? { providerId: "anthropic", modelId: ref }
    : { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

const Schema = z
  .object({
    AGENT_MODEL: z.string().default("anthropic:claude-sonnet-5"),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    AGENT_API_KEY: z.string().optional(),
    RATE_LIMIT_RPM: z.coerce.number().int().positive().default(30),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
    // The platform drops a stream after 120 s of silence; the turn budget must stay below that.
    TURN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(110_000).default(90_000),
    GITHUB_USERNAME: z.string().default("guevarnation"),
  })
  .superRefine((cfg, ctx) => {
    // Fail at boot when the chosen provider has no key: a red healthcheck beats a broken first conversation.
    const { providerId } = parseModelRef(cfg.AGENT_MODEL);
    if (providerId === "mock") return;
    const key = PROVIDER_KEYS[providerId as keyof typeof PROVIDER_KEYS];
    if (!key) {
      ctx.addIssue({
        code: "custom",
        path: ["AGENT_MODEL"],
        message: `Unknown provider "${providerId}". Use anthropic, openai, google or mock.`,
      });
    } else if (!cfg[key]) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for AGENT_MODEL=${cfg.AGENT_MODEL}.` });
    }
  });

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
