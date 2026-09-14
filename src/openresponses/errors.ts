/** Open Responses error envelope: { error: { message, type, param, code } }. */
type ErrorType = "invalid_request_error" | "authentication_error" | "not_found" | "too_many_requests" | "server_error";

const STATUS: Record<ErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  not_found: 404,
  too_many_requests: 429,
  server_error: 500,
};

export class AgentError extends Error {
  readonly status: number;
  constructor(
    readonly type: ErrorType,
    message: string,
    readonly code: string,
    readonly param: string | null = null,
  ) {
    super(message);
    this.name = "AgentError";
    this.status = STATUS[type];
  }
  toEnvelope() {
    return { error: { message: this.message, type: this.type, param: this.param, code: this.code } };
  }
}

export const badRequest = (message: string, param: string | null = null, code = "invalid_request") =>
  new AgentError("invalid_request_error", message, code, param);
export const unauthorized = () =>
  new AgentError("authentication_error", "Clave de API invalida o ausente.", "invalid_api_key");
export const notFound = (message: string) => new AgentError("not_found", message, "not_found");
export const tooManyRequests = () =>
  new AgentError("too_many_requests", "Demasiadas peticiones. Intenta de nuevo en un momento.", "rate_limit_exceeded");

/** Internal errors never leak details to the client. */
export function toEnvelope(err: unknown) {
  const e =
    err instanceof AgentError ? err : new AgentError("server_error", "Error interno del agente.", "internal_error");
  return { status: e.status, body: e.toEnvelope() };
}
