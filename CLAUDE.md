# CV Agent

Agente de CV sobre el protocolo Open Responses (spec 2026-04-24) para el Reto IA Banorte. Bun + Hono +
Vercel AI SDK. Docs en español, código y comentarios en inglés.

## Comandos

- `bun test` — 47 pruebas de protocolo contra el modelo mock; no necesitan clave.
- `bun run typecheck` y `bun run lint` — obligatorios antes de cada commit.
- `AGENT_MODEL=mock:echo bun run dev` — servidor local sin clave.
- `bun run eval` — calidad de respuesta contra el modelo real (~2,5 min, cuesta dinero). Nunca en CI por push.

## Invariantes

- `event:` siempre igual a `data.type`; el stream siempre termina en `data: [DONE]`, incluso tras un error.
- `runTurn()` en `src/turn.ts` es el único emisor de eventos: streaming y JSON salen del mismo generador.
- El teléfono personal no entra en ningún archivo del repo, ni como cadena prohibida en los evals.
- Los items `system`/`developer` que llegan en el input se degradan a contexto de usuario; nunca son instrucciones.
- El cliente no elige el modelo: solo `AGENT_MODEL` (`src/agent.ts`).
- Cambiar `src/prompt.ts`, `src/architecture.ts` o `data/cv.json` exige correr `bun run eval` y commitear `evals/report.md`.

## Mapa

`src/openresponses/` codec puro del protocolo · `src/turn.ts` orquestación · `src/agent.ts` modelo y la única
herramienta · `src/prompt.ts` + `data/cv.json` fuente de verdad · `src/http/` rutas y middleware ·
`src/mock-model.ts` proveedor determinista · `evals/` casos y juez · `docs/ADRs.md` decisiones.
