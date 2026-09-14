# CV Agent

Agente conversacional sobre el perfil profesional de Eugenio Guevara, expuesto como endpoint compatible con Open Responses (spec 2026-04-24).
Construido para el Reto IA Banorte, vacante Desarrollador Full Stack con enfoque en IA Jr.

Autor: Eugenio Guevara · [guevaraeu1@gmail.com](mailto:guevaraeu1@gmail.com) · [LinkedIn](https://linkedin.com/in/eugenio-guevara) · Licencia MIT.

| | |
|---|---|
| URL pública | https://cv-agent-production-d465.up.railway.app |
| URL base a registrar en la plataforma | `https://cv-agent-production-d465.up.railway.app/v1` |
| Tarjeta de agente (A2A) | https://cv-agent-production-d465.up.railway.app/.well-known/agent-card.json |
| Repositorio | https://github.com/Guevarnation/agente-cv |

Documentos: [Decisiones (ADRs)](docs/ADRs.md) · [Seguridad](docs/SECURITY.md) · [Guion de demo](docs/DEMO.md) · [Reporte de evals](evals/report.md) · [Compliance](evals/compliance.md)

## Registro en la plataforma
1. Importa el agente desde la tarjeta `/.well-known/agent-card.json`: trae la interfaz Open Responses, el streaming y siete sugerencias de prompt.
2. Si capturas a mano, la URL base termina en `/v1`: la plataforma le concatena `/responses`.
3. El valor de `AGENT_API_KEY` va en el campo "Clave de API"; viaja como `Authorization: Bearer` y sin él la respuesta es 401.
4. Funcionan los dos modos de conversación: reenvío de la transcripción (`store: false`, el default de la plataforma) y `previous_response_id`.

## Qué puedes preguntarle
- ¿Quién es Eugenio y a qué se dedica?
- ¿Qué construyó en YEYAR y con qué stack?
- ¿Qué precisión alcanzó su pipeline RAG y en qué benchmark?
- ¿Tiene experiencia en AWS y despliegues?
- Muéstrame sus repositorios de GitHub (dispara `listar_repositorios_github`; la llamada y su resultado se ven en la plataforma).
- What is his experience with real-time systems? (responde en el idioma en que se le escribe)

## Arquitectura
```
Plataforma del reto ── POST /v1/responses (Authorization: Bearer · stream true|false) ──▶ Railway · Docker · Bun
   │
   ▼
src/http/middleware.ts  request-id · secureHeaders · rate limit por IP · Bearer (SHA-256 + timingSafeEqual)
src/http/app.ts         cuerpo ≤ 1 MB · Zod (openresponses/schema.ts) · rutas /v1/responses y /responses
   │
src/turn.ts   prepareTurn: resolveModel · normalize.ts (input → mensajes) · store.ts (historial, TTL 2 h)
              runTurn: UN generador de eventos ──▶ SSE (event/data … [DONE])  o  JSON (recurso terminal)
   │  streamText (Vercel AI SDK)
src/agent.ts  registry anthropic | openai | google | mock ──▶ API del modelo (instrucciones cacheadas)
   ├─ src/prompt.ts + src/architecture.ts + data/cv.json   (CV completo en contexto, sin RAG)
   └─ listar_repositorios_github ──▶ api.github.com   (timeout 5 s · caché 10 min, 60 s en fallo)
```
El middleware aplica request-id, cabeceras seguras, rate limit y Bearer; Zod valida el cuerpo y `prepareTurn` resuelve antes de enviar cabeceras todo lo que puede fallar con un código HTTP: modelo permitido, input normalizado, historial recuperado y recortado a 40 mensajes. `runTurn` llama al modelo con el CV completo en las instrucciones, cacheadas en el proveedor (medido en producción: 12 302 de 12 378 tokens de entrada desde caché), y emite los eventos del protocolo en orden: la ruta SSE los escribe y la ruta JSON los consume y devuelve el recurso terminal. El historial se persiste en todo desenlace.

## Decisiones técnicas
| Decisión | Por qué | Alternativa descartada |
|---|---|---|
| Bun + TypeScript + Hono | Puesto full stack; TS es el lenguaje principal del candidato (3 años de Node/TypeScript en producción, Hono desde 2024); la carga es E/S contra el modelo | Go; Python |
| Claude por defecto, intercambiable por `AGENT_MODEL` | Cambiar de proveedor es configuración, no código | SDK de un solo proveedor; modelo fijo en código |
| Sin RAG | El CV cabe en contexto; recuperar añade latencia y errores | Base vectorial; búsqueda léxica |
| Una sola herramienta: GitHub en vivo | Único dato que el CV no contiene; buscar en el CV sería decoración | Herramienta de búsqueda en el CV; repos precomputados |
| Dos modos de conversación, memoria en proceso tras una interfaz | La plataforma puede usar cualquiera; Redis solo al escalar | Solo modo sin estado; Redis desde el día uno |
| Un generador para SSE y JSON | Dos representaciones no divergen si salen del mismo código | Dos implementaciones separadas |
| Railway | Contenedor administrado con SSE, healthcheck, reinicio y drenado; la imagen corre igual en otra nube | App Runner (sin SSE), EC2 y Fargate (sobredimensionados), Vercel (sin proceso persistente); Cloud Run viable como destino |
| Tercera persona y teléfono fuera del repo | Suplantar a una persona confunde en reclutamiento; un dato ausente no se filtra | Primera persona; ocultar el teléfono solo con el prompt |
| Modelo mock determinista | Pruebas sin clave, sin costo y sin intermitencia en cada push | Proveedor real en CI; grabar y reproducir |

Contexto y consecuencias de cada una en [docs/ADRs.md](docs/ADRs.md).

## Seguridad
- Bearer estricto (sin prefijo → 401) comparado por SHA-256 + `timingSafeEqual`; auth y rate limit solo en `/responses`; otra ruta desconocida responde 404 sin consumir cupo.
- Rate limit token bucket por IP (última entrada de `x-forwarded-for`, 30/min); detrás de la plataforma todos comparten su IP: en la práctica es un tope global por instancia.
- Cuerpo ≤ 1 MB, `max_output_tokens` ≤ 4000, presupuesto de 90 s por turno (máximo 110 s) encadenado a la desconexión del cliente, `secureHeaders`, request-id, variables validadas al arranque.
- El teléfono personal no está en ningún archivo del repo (los evals lo detectan por expresión regular); items `system`/`developer` degradados a contexto de usuario; instrucciones del operador por debajo de las reglas del agente; el prompt no se revela.
- Los errores internos nunca se filtran; los logs JSON por turno llevan request-id, response-id, modelo, status, duración y tokens (entrada, cacheados, salida), nunca contenido de mensajes.

Modelo de amenazas, controles, lo no cubierto y endurecimiento para un entorno bancario: [docs/SECURITY.md](docs/SECURITY.md).

## Operación
- `/health` responde `{"ok":true}`: Docker lo sondea cada 30 s y Railway lo exige en cada despliegue; `/ready` y `/version` muestran el modelo activo.
- Reinicio automático (`restartPolicyType: ALWAYS`); una sola réplica.
- Drenado de 30 s en Railway, alineado con el apagado ordenado del proceso ante SIGTERM.
- Logs JSON por línea en Railway; rollback = redesplegar el despliegue anterior desde el panel.

## Verificación
47 pruebas en 7 archivos (contract 27, normalize 8, response 3, errors 3, store 2, middleware 2, turn 2), todas contra el modelo mock y sin clave de API, en CI en cada push a `main` y en cada pull request, junto con typecheck, lint y build de la imagen. Las de contrato despachan peticiones a la app real en proceso, sin abrir socket: ciclo de vida y `sequence_number`, `[DONE]`, paridad SSE/JSON, herramientas y sus errores, fallo del proveedor, 401 y 400, auth acotada a `/responses`, continuidad por `previous_response_id` y tarjeta con origen real.

### Calidad de respuesta
48 casos en `evals/cases.json` (factual 14, razonamiento 7, abstención 7, adversarial 8 críticos, idioma 3, alcance 2, sobre sí mismo 3, multiturno 3, herramienta 1 que exige `function_call`) en cuatro capas: aserciones deterministas (debe/no debe contener, regex de teléfono), abstención, adversarial binario al 100 % y un juez `claude-haiku-4-5` que califica cada afirmación contra `data/cv.json` y `src/architecture.ts`.

| Categoría | Casos | Aprobados |
| --- | ---: | ---: |
| Factual | 14 | 14 |
| Razonamiento | 7 | 7 |
| Abstención | 7 | 7 |
| Adversarial (crítico) | 8 | 8 |
| Idioma | 3 | 3 |
| Alcance | 2 | 2 |
| Sobre sí mismo | 3 | 3 |
| Multiturno | 3 | 3 |
| Herramienta | 1 | 1 |
| **Total** | **48** | **48** |

juez `claude-haiku-4-5`; el puntaje medio y cada calificación quedan en el reporte, corrida completa en ~150 s. Reporte con cada respuesta en
`evals/report.md`. Criterios del juez en `evals/run.ts`; el reporte registra cada calificación.

- `bun run eval` (cuesta dinero) · `bun run eval --sin-juez` solo capas deterministas · `bun run eval --caso <id>` un caso.
- Sale con 1 si falla un crítico o más del 10 %; `evals/report.md` registra la fecha de la corrida y cada calificación.
- En CI, el job `eval` corre por `workflow_dispatch` con el secreto `ANTHROPIC_API_KEY` y publica el reporte como resumen y artefacto.

### Compliance
Suite oficial de [openresponses.org](https://www.openresponses.org) (`bin/compliance-test.ts`, 17 pruebas) contra el
despliegue: **8 pasan** — `basic-response`, `streaming-response`, `multi-turn`, `system-prompt`, `image-input`,
`assistant-phase`, `response-output-phase-schema`, `compact-missing-model`. Las 9 restantes están fuera de alcance
por diseño: 7 de transporte WebSocket (no implementado), `compact-response` (400 explícito) y `tool-calling`
(las herramientas declaradas por el cliente se ignoran: superficie fija). Salida completa de la corrida en [`evals/compliance.md`](evals/compliance.md).

### Protocolo
- Implementado: `POST /v1/responses` (alias `/responses`) en SSE y JSON desde un mismo generador; `event:` igual a `data.type`, `sequence_number` desde 0 sin huecos, orden de eventos del spec y cierre siempre en `data: [DONE]`.
- Implementado: `ResponseResource` con los 31 campos obligatorios y los defaults del spec en los numéricos (la suite de compliance rechazaba `null`); herramientas como items `function_call` y `function_call_output` emparejados por `call_id`.
- Implementado: los dos modos de conversación. Solo se guarda con `store: true` o al encadenar con `previous_response_id`; nada se retiene por defecto. Un `previous_response_id` desconocido no da 404: se registra un warning, la conversación sigue sin el contexto previo y el recurso devuelve `previous_response_id: null` (la memoria es por proceso y la plataforma conserva el id para siempre). En modo reenvío se descartan `function_call`, `function_call_output` y `reasoning` previos.
- Implementado: cancelar o agotar los 90 s cierra los items abiertos como `incomplete` con el texto parcial (`reason` `cancelled` o `timeout`); `max_output_tokens` ≤ 4000; parámetros desconocidos y `tools` del cliente se ignoran; `temperature` y `top_p` se descartan para Anthropic.
- Errores explícitos como HTTP en los dos modos (se validan antes de abrir el stream): 400 por input inválido, vacío o malformado, cuerpo mayor a 1 MB o `model` distinto de `AGENT_MODEL` (`model_not_found`); 401; 429. Un fallo del proveedor es HTTP 200 con `status: failed` (JSON) o `error` + `response.failed` + `[DONE]` (SSE).
- No implementado: `GET /v1/responses/:id` → 404 explícito; `POST /v1/responses/compact` → 400 explícito; sin transporte WebSocket.

## Correr localmente
```sh
bun install
cp .env.example .env                      # apunta a anthropic; sin clave, usa mock:echo como abajo
AGENT_MODEL=mock:echo bun run dev         # http://localhost:3000
bun test                                  # 47 pruebas, sin clave
bun run typecheck && bun run lint
AGENT_MODEL=mock:echo docker compose up   # misma imagen que producción

# Un turno en streaming (exporta AGENT_API_KEY si lo definiste en .env; vacío = sin auth):
curl -N http://localhost:3000/v1/responses \
  -H "authorization: Bearer $AGENT_API_KEY" -H "content-type: application/json" \
  -d '{"input":"¿Quién es Eugenio y a qué se dedica?","stream":true}'
```

## Variables de entorno
| Variable | Default | Uso |
|---|---|---|
| `AGENT_MODEL` | `anthropic:claude-sonnet-5` | `<proveedor>:<modelo>`: anthropic, openai, google o mock (`mock:echo` arranca sin clave); el `model` de la petición debe coincidir |
| `ANTHROPIC_API_KEY` | — | Obligatoria con anthropic (`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` para los otros); si falta, el proceso no arranca |
| `AGENT_API_KEY` | — | Token Bearer que envía la plataforma; vacío deja el endpoint abierto (solo local) |
| `PORT` | `3000` | Puerto de escucha |
| `LOG_LEVEL` | `info` | debug, info, warn, error o silent |
| `RATE_LIMIT_RPM` | `30` | Peticiones por minuto por IP a `/responses` |
| `TURN_TIMEOUT_MS` | `90000` | Presupuesto por turno; máximo 110000, bajo los 120 s de silencio que tolera la plataforma |
| `GITHUB_USERNAME` | `guevarnation` | Usuario que consulta la herramienta |
| `EVAL_JUDGE_MODEL` | `anthropic:claude-haiku-4-5` | Juez de `bun run eval` |

## Supuestos
Puntos que el reto deja abiertos y cómo se resolvieron. Si alguno resultara distinto, el cambio es de contenido o configuración, no de código.

| Supuesto | Si es falso |
|---|---|
| Evaluación por conversación libre | Ajustar los casos de `evals/cases.json` |
| Alcance: trayectoria, habilidades y proyectos (motivación, salario y disponibilidad se redirigen) | Reglas de alcance en `src/prompt.ts` |
| Español e inglés | Regla de idioma en `src/prompt.ts` |
| Sin restricción de proveedor ni de nube | `AGENT_MODEL` y la misma imagen Docker en otra nube |
| El agente puede explicar sus decisiones técnicas | Quitar el bloque de arquitectura de `src/prompt.ts` |

## Limitaciones y cómo se resolverían

| Limitación | Siguiente paso |
|---|---|
| Memoria de conversación en proceso (TTL 2 h, tope 1000 entradas); un redeploy la vacía | Redis detrás de `ConversationStore` para varias réplicas |
| Rate limit en memoria y por instancia; detrás de la plataforma es un tope global, no por usuario | El mismo Redis compartido, o WAF en el borde |
| Sin WAF, auditoría persistente ni SCA/SBOM; sin cifrado en reposo porque nada se persiste | Añadirlos al pipeline y al perímetro del banco |
| Defensas contra inyección de prompt no deterministas: el eval adversarial las mide, no las garantiza | Capa adicional de clasificación de entrada |
| Una réplica; los adjuntos (`input_file`) se reconocen pero no se leen | Suite de compliance como paso de CI; latencia p95, uso de la herramienta y tasa de abstención por request-id |
