import { describe, expect, test } from "bun:test";
import { InMemoryConversationStore } from "../src/store.ts";

describe("InMemoryConversationStore", () => {
  test("expires entries after the TTL", async () => {
    const store = new InMemoryConversationStore(20, 10);
    store.set("a", [{ role: "user", content: "hola" }]);
    expect(store.get("a")).toHaveLength(1);
    await Bun.sleep(30);
    expect(store.get("a")).toBeUndefined();
  });

  test("evicts the oldest entries above the cap", () => {
    const store = new InMemoryConversationStore(60_000, 2);
    store.set("a", []);
    store.set("b", []);
    store.set("c", []);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
  });
});
