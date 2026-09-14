# Suite oficial de compliance de Open Responses

Corrida el 2026-09-13 contra `https://cv-agent-production-d465.up.railway.app/v1` con `anthropic:claude-sonnet-5`,
usando `bin/compliance-test.ts` del repositorio [openresponses/openresponses](https://github.com/openresponses/openresponses):

```bash
bun run bin/compliance-test.ts --base-url https://cv-agent-production-d465.up.railway.app/v1 --api-key $AGENT_API_KEY --model anthropic:claude-sonnet-5
```

**8 de 17 pruebas pasan.** Las 9 restantes están fuera de alcance por diseño.

| Prueba | Resultado | Nota |
| --- | --- | --- |
| `assistant-phase` | pasa | |
| `basic-response` | pasa | |
| `compact-missing-model` | pasa | |
| `image-input` | pasa | |
| `multi-turn` | pasa | |
| `response-output-phase-schema` | pasa | |
| `streaming-response` | pasa | |
| `system-prompt` | pasa | |
| `compact-response` | falla | no implementado, responde 400 explícito |
| `tool-calling` | falla | herramientas del cliente ignoradas por diseño |
| `websocket-compact-new-chain` | falla | transporte WebSocket, no implementado |
| `websocket-continuation` | falla | transporte WebSocket, no implementado |
| `websocket-failed-continuation-evicts-cache` | falla | transporte WebSocket, no implementado |
| `websocket-previous-response-not-found` | falla | transporte WebSocket, no implementado |
| `websocket-reconnect-store-false-recovery` | falla | transporte WebSocket, no implementado |
| `websocket-response` | falla | transporte WebSocket, no implementado |
| `websocket-sequential-responses` | falla | transporte WebSocket, no implementado |
