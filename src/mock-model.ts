import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { z } from "zod";

/**
 * Deterministic provider for tests and keyless local runs, selected with AGENT_MODEL="mock:<mode>".
 * Modes: echo (fixed text), count (text carries the number of messages seen), tool (calls a tool,
 * then answers), tool-error (calls a tool that throws), fail (provider error).
 */
const USAGE = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};
const stop = { unified: "stop" as const, raw: "stop" };
const toolCalls = { unified: "tool-calls" as const, raw: "tool_use" };

export const mockTools = {
  herramienta_de_prueba: tool({
    description: "Test tool",
    inputSchema: z.object({ q: z.string().optional() }),
    execute: async ({ q }) => ({ ok: true, q: q ?? null }),
  }),
  herramienta_que_falla: tool({
    description: "Test tool that throws",
    inputSchema: z.object({ q: z.string().optional() }),
    // Explicit return type: a throwing body infers `never` and breaks tool() overload resolution.
    execute: async ({ q }): Promise<{ ok: boolean }> => {
      throw new Error(`boom${q ?? ""}`);
    },
  }),
};

function text(chunks: string[]): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    ...chunks.map((delta) => ({ type: "text-delta" as const, id: "t0", delta })),
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: stop, usage: USAGE },
  ];
}

function callTool(toolName: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "call_mock_1", toolName, input: "{}" },
    { type: "finish", finishReason: toolCalls, usage: USAGE },
  ];
}

export function createMockModel(mode: string): LanguageModelV3 {
  let calls = 0;
  const partsFor = (messageCount: number): LanguageModelV3StreamPart[] => {
    calls += 1;
    switch (mode) {
      case "count":
        return text([`mensajes:${messageCount}`]);
      case "tool":
        return calls === 1 ? callTool("herramienta_de_prueba") : text(["Consulte la herramienta."]);
      case "tool-error":
        return calls === 1 ? callTool("herramienta_que_falla") : text(["La herramienta fallo."]);
      case "fail":
        return [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("mock provider failure") },
        ];
      default:
        return text(["Eugenio ", "es desarrollador ", "full stack."]);
    }
  };

  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: mode,
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: "Eugenio es desarrollador full stack." }],
        finishReason: stop,
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream({ prompt }) {
      const parts = partsFor(prompt.filter((m) => m.role !== "system").length);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };
}
