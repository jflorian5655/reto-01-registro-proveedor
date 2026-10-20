import { z } from "zod"
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

export type Ctx = { directory: string; sessionId: string }
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
export type Resultado = { ok: true; data: unknown; resumen: string } | { ok: false; error: string }

export const CASO = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,80}$/, "Nombre de caso inválido: solo minúsculas, números y guiones")
  .describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, ej. co-industrias-delta")

export const rutas = (ctx: Ctx, caso = "") => ({
  fixtures: join(ctx.directory, "fixtures/reto-01"),
  caso: join(ctx.directory, "fixtures/reto-01/casos", caso),
  repo: join(ctx.directory, "fixtures/reto-01/repositorio"),
  out: join(ctx.directory, "out", caso),
})

/** Error de negocio con mensaje apto para el usuario (nunca una traza). */
export class Falla extends Error {}

export async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, nombre: string): Promise<T> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    throw new Falla(`No se encontró ${nombre}`)
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    throw new Falla(`${nombre} está corrupto (JSON inválido)`)
  }
  const r = esquema.safeParse(crudo)
  if (!r.success) throw new Falla(`${nombre} no tiene la estructura esperada: ${r.error.issues[0]?.message ?? ""}`)
  return r.data
}

export async function exigirCaso(ctx: Ctx, caso: string) {
  const casos = await readdir(rutas(ctx).caso).catch(() => [] as string[])
  if (!casos.includes(caso)) throw new Falla(`El caso "${caso}" no existe. Casos disponibles: ${casos.sort().join(", ") || "ninguno"}`)
}

/** Fecha de ejecución YYYY-MM-DD (FECHA_EJECUCION fija la fecha para pruebas reproducibles). */
export const hoy = () => process.env.FECHA_EJECUCION || new Date().toISOString().slice(0, 10)

export const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()

export function valorEn(obj: Json, ruta: string): Json | undefined {
  let actual: Json | undefined = obj
  for (const parte of ruta.split(".")) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return undefined
    actual = actual[parte]
  }
  return actual
}

export const comoTexto = (v: Json): string => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v))

async function registrar(ctx: Ctx, caso: string | undefined, linea: object) {
  const texto = JSON.stringify({ ts: new Date().toISOString(), sesion: ctx.sessionId, ...linea }) + "\n"
  const base = join(ctx.directory, "out")
  await mkdir(base, { recursive: true })
  await appendFile(join(base, "log.jsonl"), texto)
  if (caso && /^[a-z0-9-]+$/.test(caso)) {
    await mkdir(join(base, caso), { recursive: true })
    await appendFile(join(base, caso, "log.jsonl"), texto)
  }
}

/**
 * Construye una herramienta con el contrato del reto: valida args con zod,
 * nunca lanza, devuelve JSON `{ ok, data }` / `{ ok: false, error }` y deja log.
 */
export function herramienta<S extends z.ZodRawShape>(
  nombre: string,
  description: string,
  args: S,
  fn: (a: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<Resultado>,
) {
  const esquema = z.object(args)
  return {
    description,
    args,
    async execute(entrada: unknown, ctx: Ctx): Promise<string> {
      const parsed = esquema.safeParse(entrada)
      const caso = typeof (entrada as { caso?: unknown })?.caso === "string" ? (entrada as { caso: string }).caso : undefined
      let r: Resultado
      if (!parsed.success) {
        r = { ok: false, error: `Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }
      } else {
        try {
          r = await fn(parsed.data, ctx)
        } catch (e) {
          r = { ok: false, error: e instanceof Falla ? e.message : "Error interno de la herramienta" }
          if (!(e instanceof Falla)) console.error(`[${nombre}]`, e)
        }
      }
      await registrar(ctx, caso, { herramienta: nombre, ok: r.ok, resumen: r.ok ? r.resumen : r.error }).catch(() => {})
      return JSON.stringify(r.ok ? { ok: true, data: r.data } : r)
    },
  }
}
