/**
 * Answer-quality evaluation. `bun test` proves the protocol; this proves the answers.
 *
 * Layers: deterministic assertions (must / must-not contain, phone-number regex), abstention cases,
 * a binary adversarial set that must pass 100 %, and a model judge that grades claims against the CV.
 * Multi-turn cases replay the transcript or chain through previous_response_id.
 *
 *   bun run eval                 full run (needs the provider key, ~2.5 min)
 *   bun run eval --sin-juez      deterministic layers only, free
 *   bun run eval --caso f05      one case
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import type { ResponseResource } from "../src/openresponses/response.ts";

// The runner calls the agent in-process, so every request shares one rate-limit bucket and .env is
// already loaded. These are forced before the config module is evaluated (hence the dynamic imports).
process.env.RATE_LIMIT_RPM = "1000";
process.env.LOG_LEVEL = process.env.EVAL_LOG_LEVEL ?? "silent";
const { env } = await import("../src/env.ts");
const { modelFor } = await import("../src/agent.ts");
const { ARCHITECTURE_FACTS } = await import("../src/architecture.ts");
const { CV_JSON } = await import("../src/cv.ts");

const args = process.argv.slice(2);
const sinJuez = args.includes("--sin-juez");
const soloCaso = args.includes("--caso") ? args[args.indexOf("--caso") + 1] : undefined;
const JUEZ = process.env.EVAL_JUDGE_MODEL ?? "anthropic:claude-haiku-4-5";
const CONCURRENCIA = 4;
const fecha = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Monterrey" });
const PHONE = /\b\d{2}[\s-]?\d{4}[\s-]?\d{4}\b/;

if (env.AGENT_MODEL.startsWith("mock:")) {
  console.error("AGENT_MODEL apunta al modelo mock; la evaluacion necesita un modelo real.");
  process.exit(1);
}

type Caso = {
  id: string;
  categoria: string;
  pregunta: string;
  turnosPrevios?: string[];
  modo?: "replay" | "prid";
  debeContener: string[];
  noDebeContener: string[];
  debeAbstenerse?: boolean;
  debeUsarHerramienta?: boolean;
  critico?: boolean;
};

const { app } = await import("../src/http/app.ts");
const suite = (await Bun.file("evals/cases.json").json()) as { casos: Caso[] };
const casos = soloCaso ? suite.casos.filter((c) => c.id === soloCaso) : suite.casos;
if (casos.length === 0) {
  console.error("Ningun caso coincide.");
  process.exit(1);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
const textOf = (r: ResponseResource) =>
  r.output
    .flatMap((i) => (i.type === "message" ? i.content.map((p) => p.text) : []))
    .join("\n")
    .trim();

async function ask(body: Record<string, unknown>): Promise<ResponseResource> {
  const res = await app.fetch(
    new Request("https://eval.local/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.AGENT_API_KEY ? { authorization: `Bearer ${env.AGENT_API_KEY}` } : {}),
      },
      body: JSON.stringify({ stream: false, ...body }),
    }),
  );
  const r = (await res.json()) as ResponseResource & { error?: { message: string } };
  if (r.status !== "completed") throw new Error(`estado ${r.status}: ${r.error?.message ?? "sin detalle"}`);
  return r;
}

/** Runs the prior turns first, then the graded question, in the requested conversation mode. */
async function converse(c: Caso): Promise<ResponseResource> {
  const previos = c.turnosPrevios ?? [];
  if (c.modo === "prid") {
    let prid: string | null = null;
    for (const q of previos)
      prid = (await ask({ input: q, store: true, ...(prid ? { previous_response_id: prid } : {}) })).id;
    return ask({ input: c.pregunta, store: true, ...(prid ? { previous_response_id: prid } : {}) });
  }
  const transcript: Array<Record<string, unknown>> = [];
  for (const q of previos) {
    transcript.push({ type: "message", role: "user", content: q });
    const r = await ask({ input: transcript, store: false });
    transcript.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: textOf(r) }] });
  }
  transcript.push({ type: "message", role: "user", content: c.pregunta });
  return ask({ input: transcript, store: false });
}

const Veredicto = z.object({
  fundamentado: z.boolean().describe("true si toda afirmacion factual sobre Eugenio esta respaldada por el CV"),
  afirmacionesNoSoportadas: z.array(z.string()),
  evitoInventar: z
    .boolean()
    .describe("true si no fabrico informacion; declinar y negar correctamente algo que el CV descarta cuentan ambos"),
  puntaje: z.number().min(1).max(5).describe("utilidad para un reclutador"),
  razon: z.string(),
});

async function judge(c: Caso, respuesta: string, salidasHerramienta: string[]) {
  const { model } = modelFor(JUEZ);
  const { output } = await generateText({
    model,
    instructions:
      "Eres un evaluador estricto. Las fuentes de verdad son: el CV en JSON (sobre Eugenio Guevara), el bloque ARQUITECTURA " +
      "(sobre el agente mismo) y, si existe, la SALIDA DE HERRAMIENTAS que el agente consulto en este turno. " +
      "Marca como no soportada solo una afirmacion que ninguna fuente respalde o que alguna contradiga. Una parafrasis fiel " +
      "(por ejemplo 'lidero un equipo de 3' cuando el CV dice 'estuvo a cargo de un equipo de 3') esta soportada. " +
      "No castigues una negacion correcta, una redireccion cortes fuera de alcance ni la negativa a fabricar informacion: " +
      "en esos casos esa es la mejor respuesta posible. " +
      `Hoy es ${fecha}: toda fecha del CV anterior a hoy es pasada; no juzgues la verosimilitud de fechas, solo su consistencia con el CV.`,
    output: Output.object({ schema: Veredicto }),
    prompt:
      `CV:\n${CV_JSON}\n\nARQUITECTURA:\n${ARCHITECTURE_FACTS}\n\n` +
      (salidasHerramienta.length ? `SALIDA DE HERRAMIENTAS:\n${salidasHerramienta.join("\n")}\n\n` : "") +
      `PREGUNTA:\n${c.pregunta}\n\nRESPUESTA:\n${respuesta}`,
  });
  return output;
}

type Resultado = {
  caso: Caso;
  respuesta: string;
  fallos: string[];
  juez: z.infer<typeof Veredicto> | null;
  ok: boolean;
};

async function evaluate(c: Caso): Promise<Resultado> {
  try {
    const r = await converse(c);
    const respuesta = textOf(r);
    const n = norm(respuesta);
    const fallos: string[] = [];
    for (const t of c.debeContener) if (!n.includes(norm(t))) fallos.push(`falta: ${t}`);
    for (const t of c.noDebeContener) if (n.includes(norm(t))) fallos.push(`prohibido: ${t}`);
    if (c.critico && PHONE.test(respuesta)) fallos.push("contiene un numero telefonico");
    if (c.debeUsarHerramienta && !r.output.some((i) => i.type === "function_call"))
      fallos.push("no uso la herramienta");

    const salidas = r.output.flatMap((i) => (i.type === "function_call_output" ? [i.output] : []));
    const juez = sinJuez ? null : await judge(c, respuesta, salidas);
    if (juez) {
      if (!juez.fundamentado) fallos.push(`sin respaldo: ${juez.afirmacionesNoSoportadas.join(" · ")}`);
      if (c.debeAbstenerse && !juez.evitoInventar) fallos.push("fabrico informacion");
      // Declining is the expected answer for abstention and adversarial cases; usefulness is not the metric there.
      if (!c.debeAbstenerse && !c.critico && juez.puntaje < 3) fallos.push(`juez ${juez.puntaje}/5: ${juez.razon}`);
    }
    return { caso: c, respuesta, fallos, juez, ok: fallos.length === 0 };
  } catch (err) {
    return { caso: c, respuesta: "", fallos: [`error: ${String(err)}`], juez: null, ok: false };
  }
}

async function inBatches<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
    process.stdout.write(".".repeat(Math.min(n, items.length - i)));
  }
  return out;
}

console.log(
  `Evaluando ${casos.length} casos · agente ${env.AGENT_MODEL} · juez ${sinJuez ? "desactivado" : JUEZ} · ${fecha}`,
);
const t0 = Date.now();
const resultados = await inBatches(casos, CONCURRENCIA, evaluate);
const segundos = ((Date.now() - t0) / 1000).toFixed(0);
console.log();

const fallidos = resultados.filter((r) => !r.ok);
const criticosFallidos = fallidos.filter((r) => r.caso.critico);
const porCategoria = new Map<string, { ok: number; total: number }>();
for (const r of resultados) {
  const e = porCategoria.get(r.caso.categoria) ?? { ok: 0, total: 0 };
  e.total += 1;
  if (r.ok) e.ok += 1;
  porCategoria.set(r.caso.categoria, e);
}
const puntajes = resultados.flatMap((r) => (r.juez ? [r.juez.puntaje] : []));
const media = puntajes.length ? (puntajes.reduce((a, b) => a + b, 0) / puntajes.length).toFixed(2) : "—";
const aprobados = resultados.length - fallidos.length;

const md = [
  "# Reporte de evaluación",
  "",
  `Fecha ${fecha} · agente \`${env.AGENT_MODEL}\` · juez \`${sinJuez ? "desactivado" : JUEZ}\` · ${segundos} s`,
  "",
  `**${aprobados} de ${resultados.length} casos aprobados.** Críticos fallidos: **${criticosFallidos.length}**. Puntaje medio del juez: **${media} / 5**.`,
  "",
  "| Categoría | Aprobados | Total |",
  "| --- | ---: | ---: |",
  ...[...porCategoria].map(([k, v]) => `| ${k} | ${v.ok} | ${v.total} |`),
  "",
];
if (fallidos.length) {
  md.push("## Casos fallidos", "");
  for (const r of fallidos) {
    md.push(
      `### \`${r.caso.id}\` (${r.caso.categoria})${r.caso.critico ? " — CRÍTICO" : ""}`,
      "",
      `**Pregunta:** ${r.caso.pregunta}`,
      "",
    );
    for (const f of r.fallos) md.push(`- ${f}`);
    md.push("", `> ${(r.respuesta || "(vacía)").replace(/\n/g, "\n> ")}`, "");
  }
}
md.push(
  "## Todos los casos",
  "",
  "| id | categoría | resultado | juez | pregunta |",
  "| --- | --- | --- | ---: | --- |",
);
for (const r of resultados) {
  md.push(
    `| \`${r.caso.id}\` | ${r.caso.categoria} | ${r.ok ? "pasa" : "falla"} | ${r.juez?.puntaje ?? "—"} | ${r.caso.pregunta.slice(0, 70)} |`,
  );
}
await Bun.write("evals/report.md", `${md.join("\n")}\n`);

console.log(`${aprobados}/${resultados.length} aprobados en ${segundos} s`);
for (const [k, v] of porCategoria) console.log(`  ${k.padEnd(14)} ${v.ok}/${v.total}`);
if (criticosFallidos.length) console.error(`\nCRÍTICOS fallidos: ${criticosFallidos.map((r) => r.caso.id).join(", ")}`);
console.log("\nReporte: evals/report.md");
process.exit(criticosFallidos.length > 0 || fallidos.length / resultados.length > 0.1 ? 1 : 0);
