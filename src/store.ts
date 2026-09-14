import type { ModelMessage } from "ai";

/**
 * Conversation memory for the platform's previous_response_id mode. Behind an interface on purpose:
 * this Map is right for one container, and swapping in Redis is the only change several replicas need.
 */
export interface ConversationStore {
  get(responseId: string): ModelMessage[] | undefined;
  set(responseId: string, messages: ModelMessage[]): void;
}

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

export class InMemoryConversationStore implements ConversationStore {
  #map = new Map<string, { messages: ModelMessage[]; expiresAt: number }>();

  constructor(
    private readonly ttlMs = TTL_MS,
    private readonly maxEntries = MAX_ENTRIES,
  ) {}

  get(responseId: string) {
    const hit = this.#map.get(responseId);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.#map.delete(responseId);
      return undefined;
    }
    return hit.messages;
  }

  set(responseId: string, messages: ModelMessage[]) {
    this.#map.set(responseId, { messages, expiresAt: Date.now() + this.ttlMs });
    const now = Date.now();
    for (const [k, v] of this.#map) if (v.expiresAt <= now) this.#map.delete(k);
    while (this.#map.size > this.maxEntries) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }
}

export const conversationStore: ConversationStore = new InMemoryConversationStore();
