import { describe, expect, test } from "bun:test";
import { badRequest, notFound, toEnvelope, tooManyRequests, unauthorized } from "../src/openresponses/errors.ts";

describe("error envelope", () => {
  test("maps each type to the spec status code", () => {
    expect(badRequest("x").status).toBe(400);
    expect(unauthorized().status).toBe(401);
    expect(notFound("x").status).toBe(404);
    expect(tooManyRequests().status).toBe(429);
  });

  test("keeps the { error: { message, type, param, code } } shape", () => {
    expect(toEnvelope(badRequest("falta input", "input")).body.error).toEqual({
      message: "falta input",
      type: "invalid_request_error",
      param: "input",
      code: "invalid_request",
    });
  });

  test("an unexpected error never leaks internals", () => {
    const { status, body } = toEnvelope(new Error("connection string secreta"));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("secreta");
  });
});
