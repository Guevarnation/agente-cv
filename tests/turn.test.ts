import { describe, expect, test } from "bun:test";

const { prepareTurn } = await import("../src/turn.ts");

const msg = (role: "user" | "assistant", i: number) => ({ type: "message", role, content: `m${i}` });

describe("prepareTurn", () => {
  test("a trimmed window always opens with a user turn", () => {
    // 41 alternating items starting with user: the naive last-40 slice would start with an assistant turn.
    const input = Array.from({ length: 41 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", i));
    const turn = prepareTurn({ input }, "t");
    expect(turn.messages.length).toBeLessThanOrEqual(40);
    expect(turn.messages[0]?.role).toBe("user");
  });

  test("store is explicit: absent means nothing is kept", () => {
    expect(prepareTurn({ input: "hola" }, "t").store).toBe(false);
    expect(prepareTurn({ input: "hola", store: true }, "t").store).toBe(true);
    expect(prepareTurn({ input: "hola", previous_response_id: "resp_x" }, "t").store).toBe(true);
  });
});
