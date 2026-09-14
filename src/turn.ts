import {
  isStepCount,
  type ModelMessage,
  type StopCondition,
  type SystemModelMessage,
  streamText,
  type ToolSet,
} from "ai";
import { type ResolvedModel, resolveModel, samplingFor } from "./agent.ts";
import { env } from "./env.ts";
import { log } from "./logger.ts";
import { badRequest } from "./openresponses/errors.ts";
import { normalizeInput } from "./openresponses/normalize.ts";
import {
  createResponse,
  emptyUsage,
  type FunctionCallItem,
  type FunctionCallOutputItem,
  failResponse,
  type MessageItem,
  newId,
  nowSeconds,
} from "./openresponses/response.ts";
import type { CreateResponseBodyT } from "./openresponses/schema.ts";
import { buildInstructions } from "./prompt.ts";
import { conversationStore } from "./store.ts";

export type OREvent = { type: string; sequence_number: number } & Record<string, unknown>;

const MAX_STEPS = 4;
const MAX_OUTPUT_TOKENS = 4000;
const MAX_HISTORY = 40;

export type PreparedTurn = {
  body: CreateResponseBodyT;
  resolved: ResolvedModel;
  messages: ModelMessage[];
  store: boolean;
  /** The id whose history was actually loaded; null when nothing was found. */
  previousResponseId: string | null;
};

/** Everything that can fail with an HTTP status happens here, before any headers are sent. */
export function prepareTurn(body: CreateResponseBodyT, requestId: string): PreparedTurn {
  const resolved = resolveModel(body.model);
  const prid = body.previous_response_id?.trim() || null;
  // Nothing is kept unless asked: store:true, or a chain that must continue. Data minimisation by default.
  const store = body.store === true || (prid !== null && body.store !== false);

  let history: ModelMessage[] = [];
  let previousResponseId: string | null = null;
  if (prid) {
    const found = conversationStore.get(prid);
    if (found) {
      history = found;
      previousResponseId = prid;
    } else {
      // Memory is per process, so a redeploy or the TTL empties it. Continuing without the earlier context
      // beats a 404 the platform never recovers from; the resource reports previous_response_id: null.
      log.warn("previous_response_not_found", { requestId, previousResponseId: prid });
    }
  }

  const emptyInput = typeof body.input === "string" ? body.input.trim() === "" : body.input.length === 0;
  if (emptyInput) throw badRequest("input vacio.", "input");

  let messages = [...history, ...normalizeInput(body.input)];
  if (messages.length > MAX_HISTORY) {
    log.info("history trimmed", { requestId, dropped: messages.length - MAX_HISTORY });
    messages = messages.slice(-MAX_HISTORY);
  }
  // Providers require the window to open with a user turn.
  const firstUser = messages.findIndex((m) => m.role === "user");
  messages = firstUser === -1 ? [] : messages.slice(firstUser);

  return { body, resolved, messages, store, previousResponseId };
}

/** Persisted history keeps text only: image payloads are never worth their memory a second time. */
function textOnly(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    const text = m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    return { role: "user", content: text };
  });
}

/**
 * One turn as a stream of Open Responses events, in spec order:
 * created, in_progress, [item lifecycle...], completed | incomplete | error + failed.
 * The SSE route writes these; the JSON route drains them and returns the terminal resource.
 */
export async function* runTurn(
  turn: PreparedTurn,
  clientSignal: AbortSignal,
  requestId: string,
): AsyncGenerator<OREvent> {
  const { body, resolved, messages, store } = turn;
  const startedAt = Date.now();
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown>): OREvent => ({
    type,
    sequence_number: seq++,
    ...payload,
  });

  const response = createResponse(body, resolved.modelRef, store);
  response.previous_response_id = turn.previousResponseId;
  yield ev("response.created", { response: structuredClone(response) });
  response.status = "in_progress";
  yield ev("response.in_progress", { response: structuredClone(response) });

  const texts = new Map<string, { item: MessageItem; index: number }>();
  const pendingCalls = new Set<string>();
  let aborted = false;
  let truncated = false;

  const push = (item: MessageItem | FunctionCallItem | FunctionCallOutputItem) => response.output.push(item) - 1;

  function* closeText(t: { item: MessageItem; index: number }, status: "completed" | "incomplete") {
    if (t.item.status !== "in_progress") return;
    t.item.status = status;
    const part = t.item.content[0];
    yield ev("response.output_text.done", {
      item_id: t.item.id,
      output_index: t.index,
      content_index: 0,
      text: part?.text ?? "",
    });
    yield ev("response.content_part.done", { item_id: t.item.id, output_index: t.index, content_index: 0, part });
    yield ev("response.output_item.done", { output_index: t.index, item: structuredClone(t.item) });
  }

  function* toolOutput(callId: string, output: string) {
    pendingCalls.delete(callId);
    const item: FunctionCallOutputItem = {
      type: "function_call_output",
      id: newId("fco"),
      call_id: callId,
      output,
      status: "completed",
    };
    const index = push(item);
    yield ev("response.output_item.added", { output_index: index, item });
    yield ev("response.output_item.done", { output_index: index, item });
  }

  /** Closes whatever is still open so no item is ever left in_progress or without its output. */
  function* closeAll(status: "completed" | "incomplete", reason: string) {
    for (const t of texts.values()) yield* closeText(t, status);
    for (const callId of [...pendingCalls]) yield* toolOutput(callId, JSON.stringify({ error: reason }));
  }

  try {
    if (messages.length === 0) {
      // Legal input that carries no user turn (for example only function_call_output items): nothing to say.
      response.status = "completed";
      response.completed_at = nowSeconds();
      response.usage = emptyUsage();
      yield ev("response.completed", { response: structuredClone(response) });
      return;
    }

    const instructions: SystemModelMessage = {
      role: "system",
      content: buildInstructions(body.instructions),
      // The instruction block carries the whole CV and is identical on every request: cache it.
      ...(resolved.providerId === "anthropic"
        ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
        : {}),
    };
    const timeout = AbortSignal.timeout(env.TURN_TIMEOUT_MS);
    const maxToolCalls = body.max_tool_calls ?? null;
    const toolChoice = body.tool_choice === "none" || maxToolCalls === 0 ? "none" : "auto";
    const toolCallBudget: StopCondition<ToolSet> = ({ steps }) =>
      maxToolCalls !== null && steps.reduce((n, s) => n + s.toolCalls.length, 0) >= maxToolCalls;

    const result = streamText({
      model: resolved.model,
      instructions,
      messages,
      tools: resolved.tools,
      toolChoice,
      stopWhen: [isStepCount(MAX_STEPS), toolCallBudget],
      maxOutputTokens: Math.min(body.max_output_tokens ?? 1500, MAX_OUTPUT_TOKENS),
      abortSignal: AbortSignal.any([clientSignal, timeout]),
      // Errors arrive as stream parts and are handled below; this only silences the SDK's console default.
      onError: ({ error }) => log.debug("model stream error", { requestId, error: String(error) }),
      ...samplingFor(resolved.providerId, body.temperature ?? null, body.top_p ?? null),
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case "text-start": {
          const item: MessageItem = {
            type: "message",
            id: newId("msg"),
            status: "in_progress",
            role: "assistant",
            content: [],
          };
          const index = push(item);
          yield ev("response.output_item.added", { output_index: index, item: structuredClone(item) });
          item.content.push({ type: "output_text", text: "", annotations: [] });
          texts.set(part.id, { item, index });
          yield ev("response.content_part.added", {
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: structuredClone(item.content[0]),
          });
          break;
        }
        case "text-delta": {
          const t = texts.get(part.id);
          if (!t?.item.content[0] || !part.text) break;
          t.item.content[0].text += part.text;
          yield ev("response.output_text.delta", {
            item_id: t.item.id,
            output_index: t.index,
            content_index: 0,
            delta: part.text,
          });
          break;
        }
        case "text-end": {
          const t = texts.get(part.id);
          if (t) yield* closeText(t, "completed");
          break;
        }
        case "tool-call": {
          const args = JSON.stringify(part.input ?? {});
          const item: FunctionCallItem = {
            type: "function_call",
            id: newId("fc"),
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: "",
            status: "in_progress",
          };
          const index = push(item);
          pendingCalls.add(part.toolCallId);
          yield ev("response.output_item.added", { output_index: index, item: structuredClone(item) });
          yield ev("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: args });
          yield ev("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: args });
          item.arguments = args;
          item.status = "completed";
          yield ev("response.output_item.done", { output_index: index, item: structuredClone(item) });
          break;
        }
        case "tool-result":
          yield* toolOutput(part.toolCallId, JSON.stringify(part.output ?? null));
          break;
        case "tool-error":
          yield* toolOutput(part.toolCallId, JSON.stringify({ error: String(part.error) }));
          break;
        case "finish": {
          const u = part.totalUsage;
          response.usage = {
            input_tokens: u.inputTokens ?? 0,
            input_tokens_details: { cached_tokens: u.inputTokenDetails?.cacheReadTokens ?? 0 },
            output_tokens: u.outputTokens ?? 0,
            output_tokens_details: { reasoning_tokens: u.outputTokenDetails?.reasoningTokens ?? 0 },
            total_tokens: u.totalTokens ?? 0,
          };
          truncated = part.finishReason === "length";
          break;
        }
        case "abort":
          aborted = true;
          break;
        case "error":
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }

    const reason = aborted
      ? timeout.aborted && !clientSignal.aborted
        ? "timeout"
        : "cancelled"
      : truncated
        ? "max_output_tokens"
        : null;
    yield* closeAll(reason ? "incomplete" : "completed", reason ?? "");
    if (truncated) {
      const last = [...response.output].reverse().find((i): i is MessageItem => i.type === "message");
      if (last) last.status = "incomplete";
    }
    response.usage ??= emptyUsage();
    response.completed_at = nowSeconds();
    response.incomplete_details = reason ? { reason } : null;
    response.status = reason ? "incomplete" : "completed";
    yield ev(`response.${response.status}`, { response: structuredClone(response) });
  } catch (err) {
    yield* closeAll("incomplete", "failed");
    log.error("turn failed", { requestId, responseId: response.id, error: String(err) });
    failResponse(response, "upstream_error", "El proveedor del modelo no pudo completar la respuesta.");
    yield ev("error", {
      error: { type: "server_error", code: "upstream_error", message: response.error?.message, param: null },
    });
    yield ev("response.failed", { response: structuredClone(response) });
  } finally {
    // Persist on every outcome so the next turn always has an anchor.
    if (store && messages.length > 0) {
      const text = [...texts.values()]
        .map((t) => t.item.content[0]?.text ?? "")
        .filter(Boolean)
        .join("\n\n");
      conversationStore.set(
        response.id,
        textOnly(text ? [...messages, { role: "assistant", content: text }] : messages),
      );
    }
    log.info("turn finished", {
      requestId,
      responseId: response.id,
      model: response.model,
      status: response.status,
      outputItems: response.output.length,
      durationMs: Date.now() - startedAt,
      inputTokens: response.usage?.input_tokens,
      cachedTokens: response.usage?.input_tokens_details.cached_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  }
}
