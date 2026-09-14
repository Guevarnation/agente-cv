import { beforeAll, describe, expect, test } from "bun:test";

/**
 * End-to-end contract against the real HTTP surface, driven by the mock model: protocol conformance
 * is checked on every push with no API key and no spend. Environment comes from tests/setup.ts.
 */

type Json = Record<string, any>;
let app: { fetch: (req: Request) => Response | Promise<Response> };

beforeAll(async () => {
  ({ app } = await import("../src/http/app.ts"));
});

const request = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`https://agent.example.com${path}`, init));
const post = (body: unknown, key = "secret-test-key") =>
  request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

type Frame = { event: string | null; data: string };
function parseSse(raw: string): Frame[] {
  return raw
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => ({
      event:
        block
          .split("\n")
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? null,
      data:
        block
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "",
    }));
}
const types = (frames: Frame[]) => frames.slice(0, -1).map((f) => JSON.parse(f.data).type);

describe("streaming", () => {
  let frames: Frame[];
  beforeAll(async () => {
    const res = await post({ input: "¿Quién es Eugenio?", stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    frames = parseSse(await res.text());
  });

  test("ends with [DONE]", () => expect(frames.at(-1)?.data).toBe("[DONE]"));

  test("every event: line matches data.type", () => {
    for (const f of frames.slice(0, -1)) expect(f.event).toBe(JSON.parse(f.data).type);
  });

  test("emits the spec lifecycle in order", () => {
    expect(types(frames)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  test("sequence_number is gapless from zero", () => {
    const seqs = frames.slice(0, -1).map((f) => JSON.parse(f.data).sequence_number);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  test("the terminal event carries the full resource", () => {
    const last = JSON.parse(frames.at(-2)!.data);
    expect(last.response.status).toBe("completed");
    expect(last.response.output[0].content[0].text).toBe("Eugenio es desarrollador full stack.");
    expect(last.response.usage.total_tokens).toBeGreaterThan(0);
  });
});

describe("non-streaming", () => {
  test("returns 200 with a terminal resource identical to the stream's", async () => {
    const input = "¿Quién es Eugenio?";
    const fromStream = JSON.parse(parseSse(await (await post({ input, stream: true })).text()).at(-2)!.data).response;
    const res = await post({ input, stream: false });
    expect(res.status).toBe(200);
    const fromJson = await json(res);

    const strip = (r: Json) => {
      const { id, created_at, completed_at, ...rest } = r;
      return { ...rest, output: (rest.output as Json[]).map((i) => ({ ...i, id: "<id>" })) };
    };
    expect(strip(fromStream)).toEqual(strip(fromJson));
    expect(Object.keys(fromJson)).toHaveLength(31);
  });
});

describe("tool path", () => {
  test("emits function_call and function_call_output paired by call_id, then the answer", async () => {
    const frames = parseSse(await (await post({ input: "repos", stream: true, model: "mock:tool" })).text());
    const t = types(frames);
    expect(t.slice(0, 2)).toEqual(["response.created", "response.in_progress"]);
    expect(t).toContain("response.function_call_arguments.done");
    const final = JSON.parse(frames.at(-2)!.data).response;
    const [call, output, message] = final.output;
    expect(call.type).toBe("function_call");
    expect(output.type).toBe("function_call_output");
    expect(output.call_id).toBe(call.call_id);
    expect(JSON.parse(output.output)).toMatchObject({ ok: true });
    expect(message.type).toBe("message");
    expect(final.status).toBe("completed");
  });

  test("a tool that throws still produces its function_call_output", async () => {
    const final = await json(await post({ input: "x", stream: false, model: "mock:tool-error" }));
    const output = final.output.find((i: Json) => i.type === "function_call_output");
    expect(JSON.parse(output.output).error).toContain("boom");
    expect(final.status).toBe("completed");
  });
});

describe("failures close the protocol", () => {
  test("a provider error emits error then response.failed then [DONE]", async () => {
    const res = await post({ input: "x", stream: true, model: "mock:fail" });
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    expect(types(frames).slice(-2)).toEqual(["error", "response.failed"]);
    expect(frames.at(-1)?.data).toBe("[DONE]");
  });

  test("a provider error in JSON mode is a 200 with status failed", async () => {
    const final = await json(await post({ input: "x", stream: false, model: "mock:fail" }));
    expect(final.status).toBe("failed");
    expect(final.error.code).toBe("upstream_error");
  });
});

describe("authentication", () => {
  test("wrong key -> 401 with envelope", async () => {
    const res = await post({ input: "x" }, "wrong");
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("invalid_api_key");
  });

  test("header without the Bearer prefix -> 401", async () => {
    const res = await request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "secret-test-key" },
      body: JSON.stringify({ input: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("auth is scoped to the responses routes", async () => {
    expect((await request("/v1/health")).status).toBe(404);
    expect((await request("/health")).status).toBe(200);
  });
});

describe("validation", () => {
  test("missing input -> 400 naming the param", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await json(res)).error.param).toBe("input");
  });

  test("a malformed message item -> 400, never a silent empty answer", async () => {
    const res = await post({ input: [{ type: "message", role: "user", content: null }] });
    expect(res.status).toBe(400);
  });

  test("empty input -> 400", async () => {
    expect((await post({ input: "   " })).status).toBe(400);
  });

  test("a model other than the configured one -> 400", async () => {
    const res = await post({ input: "x", model: "anthropic:claude-opus-5" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("model_not_found");
  });

  test("a malformed message item names the real field", async () => {
    const res = await post({ input: [{ type: "message", role: "user", content: null }] });
    expect((await json(res)).error.param).toBe("input.0.content");
  });

  test("temperature outside the spec range -> 400", async () => {
    expect((await post({ input: "x", temperature: 99 })).status).toBe(400);
  });

  test("unknown extra parameters are accepted", async () => {
    expect(
      (await post({ input: "hola", temperature: 0.7, reasoning: { effort: "medium" }, futuro: true })).status,
    ).toBe(200);
  });
});

describe("conversation continuity", () => {
  test("previous_response_id replays the stored history", async () => {
    const first = await json(await post({ input: "primera", stream: false, model: "mock:count", store: true }));
    const second = await json(
      await post({ input: "segunda", stream: false, model: "mock:count", previous_response_id: first.id }),
    );
    expect(second.previous_response_id).toBe(first.id);
    // 1 user message the first time; user + assistant + user the second time.
    expect(first.output[0].content[0].text).toBe("mensajes:1");
    expect(second.output[0].content[0].text).toBe("mensajes:3");
  });

  test("an unknown previous_response_id degrades to a fresh conversation instead of killing it", async () => {
    const res = await post({ input: "x", previous_response_id: "resp_desconocido" });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("completed");
  });

  test("an unknown previous_response_id is reported as null in the resource", async () => {
    const r = await json(await post({ input: "x", previous_response_id: "resp_desconocido", stream: false }));
    expect(r.previous_response_id).toBeNull();
  });

  test("input made only of function_call_output items is legal and yields an empty completed turn", async () => {
    const r = await json(
      await post({ input: [{ type: "function_call_output", call_id: "c1", output: "ok" }], stream: false }),
    );
    expect(r.status).toBe("completed");
    expect(r.output).toEqual([]);
  });

  test("a failed turn still anchors the next one", async () => {
    const failed = await json(await post({ input: "x", stream: false, model: "mock:fail", store: true }));
    expect(failed.status).toBe("failed");
    const next = await json(await post({ input: "y", stream: false, previous_response_id: failed.id }));
    expect(next.status).toBe("completed");
  });
});

describe("discovery", () => {
  test("/health", async () => expect(await json(await request("/health"))).toEqual({ ok: true }));

  test("the agent card derives its URL from the request and declares the Open Responses binding", async () => {
    const card = await json(
      await request("/.well-known/agent-card.json", {
        headers: { "x-forwarded-host": "agente-cv.up.railway.app", "x-forwarded-proto": "https" },
      }),
    );
    expect(card.supportedInterfaces[0]).toMatchObject({
      url: "https://agente-cv.up.railway.app/v1",
      protocolBinding: "https://openresponses.org/v1",
    });
    expect(card.promptSuggestions.length).toBeLessThanOrEqual(8);
  });
});
