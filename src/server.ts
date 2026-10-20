import { join, normalize } from "node:path"
import { nuevaSesion, turno, type Sesion } from "./agent.ts"
import { crearAnthropic } from "./llm/anthropic.ts"

const ROOT = join(import.meta.dir, "..")
const PORT = Number(process.env.PORT) || 3000
const ACCESS_KEY = process.env.ACCESS_KEY || ""
const MAX_SESIONES = 200
const MAX_MENSAJE = 4000

const llm = crearAnthropic()
const sesiones = new Map<string, Sesion>()
const ocupadas = new Set<string>()

const json = (data: unknown, status = 200) => Response.json(data, { status })
const autorizado = (req: Request, url: URL) =>
  !ACCESS_KEY || req.headers.get("x-access-key") === ACCESS_KEY || url.searchParams.get("k") === ACCESS_KEY

function sesion(id: string) {
  let s = sesiones.get(id)
  if (!s) {
    if (sesiones.size >= MAX_SESIONES) sesiones.delete(sesiones.keys().next().value!) // ponytail: expulsa la más antigua; usar archivo/redis si hay más usuarios
    s = nuevaSesion(id)
    sesiones.set(id, s)
  }
  return s
}

async function chat(req: Request) {
  const body = (await req.json().catch(() => null)) as { sessionId?: unknown; message?: unknown } | null
  const id = typeof body?.sessionId === "string" && /^[\w-]{1,64}$/.test(body.sessionId) ? body.sessionId : null
  const message = typeof body?.message === "string" ? body.message.trim() : ""
  if (!id || !message) return json({ error: "Se requiere { sessionId, message }" }, 400)
  if (message.length > MAX_MENSAJE) return json({ error: `Mensaje demasiado largo (máx. ${MAX_MENSAJE} caracteres)` }, 400)
  if (!process.env.ANTHROPIC_API_KEY) return json({ reply: "El servidor no tiene configurada la clave del modelo (ANTHROPIC_API_KEY).", toolCalls: [], needsConfirmation: false, error: true })
  if (ocupadas.has(id)) return json({ error: "La sesión está procesando otro mensaje" }, 409)
  ocupadas.add(id)
  try {
    return json(await turno(sesion(id), message, llm, ROOT))
  } finally {
    ocupadas.delete(id)
  }
}

/** Descarga de artefactos generados en out/ (solo lectura, sin salir de out/). */
function archivoOut(pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^\/+/, "")
  if (!rel.startsWith("out/") || rel.includes("..")) return json({ error: "Ruta inválida" }, 400)
  const f = Bun.file(join(ROOT, rel))
  return f.exists().then((ok) => (ok ? new Response(f) : json({ error: "No existe" }, 404)))
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === "/" || p === "/index.html") return new Response(Bun.file(join(ROOT, "web/index.html")))
    if (p === "/api/health") return json({ ok: true, provider: llm.nombre, model: llm.modelo, protegido: !!ACCESS_KEY })
    if (!autorizado(req, url)) return json({ error: "Clave de acceso inválida" }, 401)
    if (p === "/api/chat" && req.method === "POST") return chat(req)
    const m = p.match(/^\/api\/sessions\/([\w-]{1,64})$/)
    if (m) return json(sesiones.get(m[1]!)?.historial ?? [])
    if (p.startsWith("/out/")) return archivoOut(p)
    return json({ error: "No encontrado" }, 404)
  },
})
console.log(`Agente listo en http://localhost:${PORT} · ${llm.nombre}/${llm.modelo}`)
