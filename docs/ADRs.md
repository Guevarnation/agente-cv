# Registros de decisión de arquitectura

Nueve decisiones del agente de CV de Eugenio Guevara para el Reto IA Banorte, cada una con su contexto, las alternativas descartadas y sus consecuencias, incluidas las negativas.

## ADR-001 — Bun, TypeScript y Hono como stack

**Contexto.** Servicio HTTP con streaming SSE para una vacante full stack; la carga es E/S contra el modelo. TypeScript es el lenguaje principal del candidato: tres años de Node/TypeScript en producción, Hono desde 2024.

**Decisión.** Bun 1.4.2, TypeScript 7 strict, Hono 4.13.7, Vercel AI SDK 7.0.99 y Zod 4.6.5 para validar entrada y entorno; Biome para lint y formato.

**Alternativas.** Go: su rendimiento no aporta cuando el turno se pasa esperando tokens; Python: un segundo ecosistema sin nada que el AI SDK no dé en TypeScript.

**Consecuencias.** Tipos estrictos y Zod atrapan temprano errores que el protocolo castiga en ejecución. Negativa: Bun es menos maduro que Node; cierra conexiones inactivas a los 10 s y `src/index.ts` fija `idleTimeout: 0`.

## ADR-002 — Claude por defecto, proveedor intercambiable por entorno

**Contexto.** Un buen modelo hoy sin casarse con un proveedor; el cliente no debe escalar el costo ni enrutar a un proveedor sin clave.

**Decisión.** `AGENT_MODEL` en formato `proveedor:modelo` (anthropic, openai, google), default `anthropic:claude-sonnet-5`; sin la clave del proveedor elegido el proceso no arranca. Un `model` distinto en la petición responde 400 `model_not_found`; `temperature`/`top_p` se descartan para Anthropic porque Claude 5 los rechaza.

**Alternativas.** SDK nativo de un proveedor: cambiar de modelo sería editar código; aceptar cualquier `model`: cede costo y enrutamiento al cliente; propagar `temperature`/`top_p`: un 400 invisible para el operador.

**Consecuencias.** Cambiar de proveedor es cambiar una cadena. Negativas: se programa contra el denominador común del AI SDK y el prompt caching (ADR-003) solo existe para Anthropic.

## ADR-003 — CV completo en el prompt, sin RAG

**Contexto.** El corpus es un solo documento, `data/cv.json`: la entrada medida por turno está entre 11 600 y 12 400 tokens, lejos del límite del modelo.

**Decisión.** `src/cv.ts` serializa el CV y `src/prompt.ts` lo pone entero en las instrucciones con `cacheControl` ephemeral para Anthropic; en producción, 12 302 de 12 378 tokens de entrada llegaron desde caché.

**Alternativas.** Base vectorial: latencia, costo y errores de recuperación sin beneficio; búsqueda léxica: recall parcial sobre datos que sí están; resumen más recuperación: dos fuentes para algo que cabe entero.

**Consecuencias.** Si está en el CV, el modelo lo tiene. Negativas: cada turno paga esos tokens (el caché solo existe en Anthropic) y la decisión no se sostiene si el corpus crece.

## ADR-004 — Una sola herramienta: GitHub en vivo

**Contexto.** La pregunta no es cuántas herramientas lucen bien, sino qué dato cambia después de editar el CV.

**Decisión.** `listar_repositorios_github` consulta `api.github.com` con timeout de 5 s, caché de 10 min en éxito y 60 s en fallo; si GitHub falla, devuelve el error y el enlace al perfil. Las `tools` del cliente se ignoran: superficie fija.

**Alternativas.** Buscar en el CV: ya está entero en contexto (ADR-003), pura decoración; lista precomputada: envejece como el CV; sin herramientas: se pierde el único dato vivo.

**Consecuencias.** Las llamadas son visibles en la plataforma como `function_call` y `function_call_output` emparejados por `call_id`. Negativas: un tercero en el camino caliente del turno; timeout y caché acotan el daño sin eliminarlo.

## ADR-005 — Dos modos de conversación con memoria en proceso

**Contexto.** La plataforma reenvía toda la transcripción (`store:false`, su default) o solo el turno nuevo con `previous_response_id`. Nada se persiste salvo que el cliente lo pida (`store: true`) o encadene con `previous_response_id`: minimización de datos por defecto.

**Decisión.** Ambos, con memoria en proceso tras la interfaz `ConversationStore`. Un `previous_response_id` desconocido no devuelve 404: se registra un warning y la conversación sigue sin contexto previo, porque la memoria es por proceso (redeploy o TTL la vacían) y la plataforma conserva el mismo id para siempre: un 404 la mataría.

**Alternativas.** Solo modo sin estado: turnos encadenados fallarían; Redis de entrada: un servicio más para una réplica; 404 al id desconocido: sin salida.

**Consecuencias.** Funciona en ambos modos. Negativas: con varias réplicas el id puede caer en la equivocada y la degradación vuelve la pérdida de contexto un olvido silencioso.

## ADR-006 — Un generador para SSE y JSON

**Contexto.** El protocolo exige un stream SSE con el ciclo de vida completo y un `ResponseResource` terminal en JSON del mismo turno.

**Decisión.** `runTurn()` (`src/turn.ts`) es un generador: la ruta SSE escribe sus eventos conforme llegan; la JSON los drena y devuelve el recurso terminal. La validación corre antes de abrir el stream: 400, 401 y 429 son códigos HTTP en ambos modos.

**Alternativas.** Dos implementaciones: divergen en la primera corrección; generar todo y trocearlo: mata el streaming; solo streaming: el protocolo exige ambos.

**Consecuencias.** Una prueba de paridad lo verifica. Negativas: el modo JSON genera eventos que nadie ve, y los errores dentro del stream se manejan aparte: con las cabeceras enviadas, `onError` ya no interviene.

## ADR-007 — Railway como plataforma de despliegue

**Contexto.** Hace falta un proceso persistente con SSE, healthcheck, reinicio, drenado y logs, en horas.

**Decisión.** Imagen Docker multi-stage sobre `oven/bun:1.4.2-alpine`, usuario no root, desplegada en Railway con `railway.json`: healthcheck `/health`, `restartPolicyType: ALWAYS` y `drainingSeconds: 30`, alineado con el apagado de 30 s de `src/index.ts`. Una réplica.

**Alternativas.** App Runner: no soporta SSE; EC2: parcheo, TLS y proxy por cuenta propia; Fargate con ALB: sobredimensionado para una réplica; Vercel: sin proceso persistente; Cloud Run: viable; queda como destino de migración.

**Consecuencias.** El compromiso está en la imagen, no en la plataforma; corre igual en cualquiera. Negativas: Railway no es una nube con la que un banco tenga acuerdos ni control de red, y la réplica única limita la disponibilidad.

## ADR-008 — Tercera persona y teléfono fuera del repo

**Contexto.** La primera persona es más inmersiva, pero quien lee es un reclutador decidiendo si confía en el texto.

**Decisión.** El agente habla sobre Eugenio, no como Eugenio; no revela su prompt y las notas del operador pesan menos que sus reglas. El teléfono no existe en el repo, ni como cadena prohibida en los evals, que usan una expresión regular.

**Alternativas.** Primera persona: siembra dudas sobre quién responde; tono a cargo del operador: reabre la suplantación; teléfono oculto solo por prompt: una regla se elude, un dato ausente no.

**Consecuencias.** El evaluador sabe qué lee y quién lo generó. Negativas: la tercera persona es menos cálida y ni un reclutador legítimo obtiene el teléfono; queda el correo.

## ADR-009 — Modelo mock para pruebas sin clave

**Contexto.** Cada push verifica el protocolo, no la prosa del modelo, sin clave ni gasto.

**Decisión.** `src/mock-model.ts` implementa un `LanguageModelV3` determinista, elegido con `AGENT_MODEL=mock:<modo>`: `echo` (texto fijo), `count` (mensajes vistos), `tool` (llama una herramienta y responde), `tool-error` (la herramienta lanza) y `fail` (error del proveedor). Las 47 pruebas corren contra él en cada push.

**Alternativas.** Proveedor real en CI: secretos, costo por push y pruebas intermitentes; grabar y reproducir: envejece y aún requiere clave; interceptar `fetch`: prueba el transporte, no el stream del SDK.

**Consecuencias.** La suite corre sin configurar nada. Negativas: el mock puede desviarse del proveedor real y no mide la calidad de las respuestas; eso lo hace `bun run eval`, bajo demanda y con costo.
