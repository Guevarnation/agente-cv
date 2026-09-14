import type { ModelMessage } from "ai";
import type { CreateResponseBodyT } from "./schema.ts";

/**
 * Open Responses `input` -> AI SDK messages.
 *
 * In the platform's default mode the whole transcript is resent every turn, including this agent's
 * own earlier function_call / function_call_output / reasoning items. Those are dropped: the CV is in
 * the system prompt, so replaying tool traffic adds tokens and brittleness without adding information.
 * Vendor extension items are dropped for the same reason. User and assistant text carry the conversation.
 */
const MAX_ITEMS = 200;
const MAX_TEXT_CHARS = 24_000;

type Part = { type: "text"; text: string } | { type: "file"; mediaType: string; data: string };

const clamp = (text: string) => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text);

function mediaType(url: string): string {
  const m = /^data:([^;,]+)/.exec(url);
  if (m?.[1]) return m[1];
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function partsOf(content: unknown): { text: string; files: Part[] } {
  if (typeof content === "string") return { text: clamp(content), files: [] };
  if (!Array.isArray(content)) return { text: "", files: [] };

  const chunks: string[] = [];
  const files: Part[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      chunks.push(raw);
      continue;
    }
    const part = raw as Record<string, unknown>;
    switch (part?.type) {
      case "input_text":
      case "output_text":
      case "text":
        if (typeof part.text === "string") chunks.push(part.text);
        break;
      case "refusal":
        if (typeof part.refusal === "string") chunks.push(part.refusal);
        break;
      case "input_image":
        if (typeof part.image_url === "string")
          files.push({ type: "file", mediaType: mediaType(part.image_url), data: part.image_url });
        break;
      case "input_file":
        // This agent answers about a CV; attachments are acknowledged, not ingested.
        chunks.push(
          `[El usuario adjunto un archivo: ${typeof part.filename === "string" ? part.filename : "archivo"}]`,
        );
        break;
    }
  }
  return { text: clamp(chunks.join("\n\n").trim()), files };
}

export function normalizeInput(input: CreateResponseBodyT["input"]): ModelMessage[] {
  if (typeof input === "string") {
    const text = clamp(input.trim());
    return text ? [{ role: "user", content: text }] : [];
  }

  const messages: ModelMessage[] = [];
  for (const item of input.slice(-MAX_ITEMS)) {
    if (item.type !== "message") continue;
    const { text, files } = partsOf(item.content);
    if (!text && files.length === 0) continue;

    if (item.role === "assistant") {
      messages.push({ role: "assistant", content: text });
    } else if (item.role === "user") {
      const parts: Part[] = text ? [{ type: "text", text }, ...files] : files;
      messages.push({ role: "user", content: parts as never });
    } else {
      // Operator text arriving inside the transcript is untrusted relative to the system prompt.
      messages.push({ role: "user", content: `[Nota del operador] ${text}` });
    }
  }
  return messages;
}
