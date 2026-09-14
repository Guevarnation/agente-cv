import { describe, expect, test } from "bun:test";
import { createResponse, failResponse } from "../src/openresponses/response.ts";

/** The 31 fields the spec marks as required on every ResponseResource. */
const REQUIRED = [
  "id",
  "object",
  "created_at",
  "completed_at",
  "status",
  "incomplete_details",
  "model",
  "previous_response_id",
  "instructions",
  "output",
  "error",
  "tools",
  "tool_choice",
  "truncation",
  "parallel_tool_calls",
  "text",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "top_logprobs",
  "temperature",
  "reasoning",
  "usage",
  "max_output_tokens",
  "max_tool_calls",
  "store",
  "background",
  "service_tier",
  "metadata",
  "safety_identifier",
  "prompt_cache_key",
];

describe("ResponseResource", () => {
  const r = createResponse({ input: "x" }, "mock:echo", false);

  test("emits exactly the 31 required fields", () => {
    expect(Object.keys(r).sort()).toEqual([...REQUIRED].sort());
  });

  test("nullable fields are null, required numerics carry spec defaults", () => {
    expect(r.completed_at).toBeNull();
    expect(r.error).toBeNull();
    expect(r.temperature).toBe(1);
    expect(r.top_p).toBe(1);
    expect(r.presence_penalty).toBe(0);
    expect(r.text).toEqual({ format: { type: "text" } });
  });

  test("failResponse marks a terminal failure with usage present", () => {
    const f = failResponse(createResponse({ input: "x" }, "mock:echo", false), "upstream_error", "boom");
    expect(f.status).toBe("failed");
    expect(f.error).toEqual({ code: "upstream_error", message: "boom" });
    expect(f.usage?.total_tokens).toBe(0);
  });
});
