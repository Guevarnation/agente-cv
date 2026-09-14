import { randomUUIDv7 } from "bun";
import type { CreateResponseBodyT } from "./schema.ts";

export type ItemStatus = "in_progress" | "completed" | "incomplete";
export type OutputTextContent = { type: "output_text"; text: string; annotations: unknown[] };
export type MessageItem = {
  type: "message";
  id: string;
  status: ItemStatus;
  role: "assistant";
  content: OutputTextContent[];
};
export type FunctionCallItem = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: ItemStatus;
};
export type FunctionCallOutputItem = {
  type: "function_call_output";
  id: string;
  call_id: string;
  output: string;
  status: ItemStatus;
};
export type OutputItem = MessageItem | FunctionCallItem | FunctionCallOutputItem;

export type Usage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
};

export type ResponseStatus = "queued" | "in_progress" | "completed" | "incomplete" | "failed";

/** The spec's ResponseResource: 31 required fields. Required numerics carry the spec defaults rather than null. */
export type ResponseResource = {
  id: string;
  object: "response";
  created_at: number;
  completed_at: number | null;
  status: ResponseStatus;
  incomplete_details: { reason: string } | null;
  model: string;
  previous_response_id: string | null;
  instructions: string | null;
  output: OutputItem[];
  error: { code: string; message: string } | null;
  tools: unknown[];
  tool_choice: string;
  truncation: "auto" | "disabled";
  parallel_tool_calls: boolean;
  text: { format: { type: "text" } };
  top_p: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_logprobs: number;
  temperature: number;
  reasoning: null;
  usage: Usage | null;
  max_output_tokens: number | null;
  max_tool_calls: number | null;
  store: boolean;
  background: boolean;
  service_tier: string;
  metadata: Record<string, string>;
  safety_identifier: string | null;
  prompt_cache_key: string | null;
};

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const newId = (prefix: "resp" | "msg" | "fc" | "fco") => `${prefix}_${randomUUIDv7("hex")}`;

export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 0,
});

export function createResponse(body: CreateResponseBodyT, model: string, store: boolean): ResponseResource {
  return {
    id: newId("resp"),
    object: "response",
    created_at: nowSeconds(),
    completed_at: null,
    status: "queued",
    incomplete_details: null,
    model,
    previous_response_id: body.previous_response_id ?? null,
    instructions: body.instructions ?? null,
    output: [],
    error: null,
    tools: [],
    tool_choice: body.tool_choice ?? "auto",
    truncation: "disabled",
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    text: { format: { type: "text" } },
    top_p: body.top_p ?? 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    temperature: body.temperature ?? 1,
    reasoning: null,
    usage: null,
    max_output_tokens: body.max_output_tokens ?? null,
    max_tool_calls: body.max_tool_calls ?? null,
    store,
    background: false,
    service_tier: "default",
    metadata: body.metadata ?? {},
    safety_identifier: null,
    prompt_cache_key: null,
  };
}

export function failResponse(r: ResponseResource, code: string, message: string): ResponseResource {
  r.status = "failed";
  r.error = { code, message };
  r.completed_at = nowSeconds();
  r.usage ??= emptyUsage();
  return r;
}
