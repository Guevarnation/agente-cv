# Seguridad

Solo lo implementado, con el archivo donde vive cada control. El README resume esta página y enlaza aquí.

## 1. Superficie expuesta

| Ruta | Auth | Qué hace |
|---|---|---|
| `POST /v1/responses` (alias `/responses`) | Bearer + rate limit | Crea una respuesta (JSON o SSE); el único endpoint que llama al modelo. |
| `GET /v1/responses/:id` | Bearer + rate limit | `404`: no se exponen respuestas almacenadas. |
| `POST /v1/responses/compact` | Bearer + rate limit | `400`: no implementado. |
| `GET /health` | Ninguna | `{"ok":true}`; healthcheck de Docker y Railway. |
| `GET /ready`, `GET /version` | Ninguna | Estado, versión, protocolo y nombre del modelo (público). |
| `GET /.well-known/agent-card.json` | Ninguna | Tarjeta A2A con la URL real del despliegue. |
| `GET /` | Ninguna | Índice: endpoint, tarjeta y repositorio. |
| Cualquier ruta fuera del prefijo `/responses` | Ninguna | `404` sin consumir cupo; bajo `/responses` toda petición pasa por rate limit y auth. |

Egreso: solo la API del proveedor configurado en `AGENT_MODEL` (Anthropic por defecto) y `api.github.com` para la única
herramienta (timeout 5 s, caché 10 min en éxito y 60 s en fallo). No hay otra llamada saliente en `src/`.

## 2. Modelo de amenazas

| Amenaza | Control | Estado |
|---|---|---|
| Acceso no autorizado | Bearer estricto en `/responses` (SHA-256 + `timingSafeEqual`); sin prefijo o clave distinta → `401`. | Probado en CI. |
| Abuso de cuota | Token bucket por IP (30/min); `model` ≠ `AGENT_MODEL` → `400`; `max_output_tokens` ≤ 4000; 4 pasos por turno; `tools` del cliente ignoradas. | Implementado; en memoria. |
| Inyección desde el usuario | El prompt trata texto, archivos e imágenes del usuario como datos, no órdenes. | 8 adversariales críticos al 100 %; no determinista. |
| Inyección desde el operador o la transcripción | `system`/`developer` → mensaje de usuario `[Nota del operador]`; `instructions` con prioridad menor; `function_call`/`reasoning` previos descartados. | Probado en `tests/normalize.test.ts`. |
| Extracción del prompt | Regla de no revelar ni parafrasear; solo `src/architecture.ts` es compartible. | Evaluado; no determinista. |
| Datos personales | Teléfono y domicilio fuera del repo y del prompt; canales públicos: correo, LinkedIn, GitHub y sitio web; regex en evals. | Verificado en el árbol y en el historial. |
| DoS: cuerpo grande y turnos colgados | Cuerpo > 1 MB → `400`; presupuesto de 90 s unido a la desconexión del cliente (`AbortSignal.any`); input recortado a 200 items, 24 000 caracteres y 40 mensajes; memoria con TTL 2 h y tope 1000. | Implementado. |
| Fuga de secretos o detalles internos | Error no controlado → envelope genérico `internal_error`; fallo del proveedor → `upstream_error` genérico; logs sin contenido ni variables. | Probado en CI (fallo del proveedor). |

## 3. Notas sobre los controles

- Autenticación (`src/http/middleware.ts`): presentado y esperado se hashean con SHA-256 y se comparan con `timingSafeEqual`, así ni valor ni longitud se filtran por tiempo. Sin `AGENT_API_KEY` el endpoint queda abierto (uso local; el arranque registra `authRequired: false`).
- Rate limit: la clave es la última entrada de `x-forwarded-for`, el único salto que el cliente no puede falsificar. Detrás de la plataforma todos comparten su IP: en la práctica es un tope global por instancia. Corre antes de la autenticación: un flood sin clave también se frena, y también consume el cupo.
- Degradación (`src/openresponses/normalize.ts`): solo sobreviven items `message`; los roles `system`/`developer` se reescriben como usuario con prefijo `[Nota del operador]` y nunca tocan el bloque de instrucciones.
- Precedencia (`src/prompt.ts`): `instructions` de la petición se anexa al final como "Notas del operador (prioridad menor)"; en conflicto mandan las reglas del agente.
- Teléfono: ningún archivo del repo lo contiene, por eso tampoco va como cadena prohibida; `evals/run.ts` aplica la regex `\b\d{2}[\s-]?\d{4}[\s-]?\d{4}\b` a cada caso crítico.
- Validación al arranque (`src/env.ts`): sin la clave del proveedor elegido el proceso sale con código 1 nombrando la variable, no su valor. `TURN_TIMEOUT_MS` acepta de 1 000 a 110 000 ms.

## 4. Secretos

- Solo en variables de entorno (Railway en producción, `.env` en local), leídas únicamente en `src/env.ts`; en CI, `ANTHROPIC_API_KEY` es un secreto de GitHub Actions del job `eval` manual.
- Nunca en logs: `src/logger.ts` emite JSON con campos fijos (`requestId`, `responseId`, `model`, `status`, `outputItems`, `durationMs`, tokens); ni contenido ni variables.
- Rotación: clave nueva (`openssl rand -base64 32`), cambiar la variable en Railway y en la plataforma, redesplegar. La imagen no contiene claves.
- `.gitignore` excluye `.env*` (salvo `.env.example`) y `.dockerignore` excluye `.env*`, `tests`, `evals` y `docs`.

## 5. No cubierto

- Rate limit en memoria: se reinicia con el proceso y no se comparte entre réplicas.
- Sin WAF ni protección contra conexiones lentas (`Bun.serve` usa `idleTimeout: 0` para no cortar streams); solo el proxy de Railway.
- Sin auditoría persistente: los logs viven en Railway, no en un SIEM ni almacén inmutable.
- Sin cifrado en reposo: nada se persiste más allá de la memoria del proceso.
- Defensas contra inyección no deterministas: viven en el prompt y se miden con evals, no se garantizan.
- Sin SCA/SBOM ni escaneo de la imagen en CI.
- Sin allowlist de IP ni mTLS: cualquiera con la clave puede llamar; CORS es `*` (la seguridad descansa en el token, no en cookies).

## 6. Para un entorno bancario

- Red privada y egreso restringido: contenedor alcanzable solo desde la plataforma, con salida únicamente a la API del proveedor y `api.github.com`.
- Secretos en el gestor de la nube elegida, inyectados al arranque, con rotación programada y sin `.env` en ninguna máquina.
- Al escalar: Redis compartido para conversaciones (la interfaz `ConversationStore` ya lo aísla) y rate limit, más WAF y auditoría persistente.

## 7. Reportar

Escribe a guevaraeu1@gmail.com con el asunto "Seguridad cv-agent"; no abras un issue público con los detalles.
