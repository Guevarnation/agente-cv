import { z } from "zod";

/**
 * The subset of the Open Responses CreateResponseBody (spec 2026-04-24) this agent reads.
 * Unknown keys are accepted and ignored: clients may send provider-specific parameters.
 */
const MessageItem = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(z.unknown())]),
  id: z.string().optional(),
  status: z.string().optional(),
});

const FunctionCallItem = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

const FunctionCallOutputItem = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.unknown(),
});

/** Reasoning, item_reference and vendor extensions pass through untouched. */
const OtherItem = z.object({ type: z.string() }).catchall(z.unknown());

const BY_TYPE = {
  message: MessageItem,
  function_call: FunctionCallItem,
  function_call_output: FunctionCallOutputItem,
} as const;

type KnownItem =
  | z.infer<typeof MessageItem>
  | z.infer<typeof FunctionCallItem>
  | z.infer<typeof FunctionCallOutputItem>;
type AnyItem = KnownItem | z.infer<typeof OtherItem>;

/** Dispatch on `type` before validating, so a malformed known item reports its real field (input.N.content). */
export const InputItem = z.unknown().transform((item, ctx): AnyItem => {
  const type = item && typeof item === "object" ? (item as { type?: unknown }).type : undefined;
  const schema = typeof type === "string" && type in BY_TYPE ? BY_TYPE[type as keyof typeof BY_TYPE] : OtherItem;
  const parsed = schema.safeParse(item);
  if (parsed.success) return parsed.data as AnyItem;
  for (const issue of parsed.error.issues)
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path as PropertyKey[] });
  return z.NEVER;
});

/** `input` is a string or an item array. Dispatching by shape keeps element paths (input.N.field) in errors. */
const InputField = z.unknown().transform((value, ctx): string | AnyItem[] => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parsed = z.array(InputItem).safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues)
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path as PropertyKey[] });
    return z.NEVER;
  }
  ctx.addIssue({
    code: "custom",
    message: value === undefined ? "Required" : "Expected a string or an array of items",
  });
  return z.NEVER;
});

export const CreateResponseBody = z.object({
  model: z.string().nullish(),
  input: InputField,
  instructions: z.string().nullish(),
  previous_response_id: z.string().nullish(),
  store: z.boolean().optional(),
  stream: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  max_tool_calls: z.number().int().nonnegative().nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  tool_choice: z.enum(["auto", "none"]).nullish(),
  parallel_tool_calls: z.boolean().nullish(),
});

export type CreateResponseBodyT = z.infer<typeof CreateResponseBody>;
