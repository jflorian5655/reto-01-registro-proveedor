import { z } from "zod"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import * as proveedor from "./tools/proveedor.ts"
import type { Ctx } from "./tools/lib.ts"
import type { HerramientaLLM, Mensaje, ProveedorLLM } from "./llm/adapter.ts"

const MAX_ITERACIONES = Number(process.env.MAX_ITERACIONES) || 25
const MAX_TOKENS_SESION = Number(process.env.MAX_TOKENS_SESION) || 400_000
const MARCA = "[CONFIRMAR]"
const ACCION_EXTERNA = new Set(["proveedor_simular_envio"])
// Afirmación explícita y sin negación ("sí", "confirmo", "envía", "adelante"...).
const AFIRMA = /^\s*(s[ií]\b|s[ií],|confirm|env[ií]a|adelante|procede|dale\b|ok\b|de acuerdo|hazlo|apruebo|aprobado)/i
const NIEGA = /\b(no|todav[ií]a|espera|aún|aun)\b/i

// Nombre que ve el modelo: <archivo>_<export>
const HERRAMIENTAS = Object.fromEntries(Object.entries(proveedor).map(([k, t]) => [`proveedor_${k}`, t]))

export const definiciones: HerramientaLLM[] = Object.entries(HERRAMIENTAS).map(([nombre, t]) => {
  const { $schema: _, ...parametros } = z.toJSONSchema(z.object(t.args), { io: "input" })
  return { nombre, descripcion: t.description, parametros }
})

export async function sistema(directory: string) {
  const [prompt, conocimiento] = await Promise.all([
    readFile(join(directory, "agent/prompt.md"), "utf8"),
    readFile(join(directory, "src/knowledge/registro-proveedor.md"), "utf8"),
  ])
  return `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`
}

export type ToolCallVisible = { nombre: string; args: unknown; ok: boolean; resumen: string }
export type Turno = { reply: string; toolCalls: ToolCallVisible[]; needsConfirmation: boolean; error?: boolean }
export type Sesion = {
  id: string
  mensajes: Mensaje[]
  historial: ({ rol: "user"; texto: string } | ({ rol: "assistant" } & Turno))[]
  tokens: number
  esperaConfirmacion: boolean
}

export const nuevaSesion = (id: string): Sesion => ({ id, mensajes: [], historial: [], tokens: 0, esperaConfirmacion: false })

/** RN4/CA3: confirma solo si el turno anterior pidió confirmación y este mensaje la da explícitamente. */
const confirma = (s: Sesion, texto: string) => s.esperaConfirmacion && AFIRMA.test(texto) && !NIEGA.test(texto)

function resumir(resultado: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(resultado) as { ok: boolean; error?: string; data?: unknown }
    if (!r.ok) return { ok: false, resumen: r.error ?? "error" }
    const d = JSON.stringify(r.data)
    return { ok: true, resumen: d.length > 300 ? `${d.slice(0, 300)}…` : d }
  } catch {
    return { ok: false, resumen: "respuesta ilegible" }
  }
}

async function ejecutar(nombre: string, args: unknown, ctx: Ctx, confirmado: boolean): Promise<string> {
  const t = HERRAMIENTAS[nombre]
  if (!t) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  if (ACCION_EXTERNA.has(nombre) && !confirmado)
    return JSON.stringify({ ok: false, error: "requiere confirmación explícita: la analista debe confirmar en su mensaje inmediatamente anterior" })
  return t.execute(args, ctx)
}

/** Un turno del agente: modelo → herramientas → modelo… hasta responder o llegar al tope (CA1). */
export async function turno(s: Sesion, texto: string, llm: ProveedorLLM, directory: string): Promise<Turno> {
  const fin = (t: Turno) => (s.historial.push({ rol: "assistant", ...t }), (s.esperaConfirmacion = t.needsConfirmation), t)
  s.historial.push({ rol: "user", texto })
  if (s.tokens >= MAX_TOKENS_SESION)
    return fin({ reply: "Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar.", toolCalls: [], needsConfirmation: false, error: true })

  const confirmado = confirma(s, texto)
  s.mensajes.push({ rol: "user", texto })
  const ctx: Ctx = { directory, sessionId: s.id }
  const prompt = await sistema(directory)
  const toolCalls: ToolCallVisible[] = []
  let respuesta = ""

  for (let i = 0; i < MAX_ITERACIONES; i++) {
    let r
    try {
      r = await llm.enviar(prompt, s.mensajes, definiciones)
    } catch (e) {
      console.error("[llm]", e instanceof Error ? e.message : e)
      const reply = `No pude comunicarme con el modelo de lenguaje (${e instanceof Error && /timeout|timed out/i.test(e.message) ? "tiempo de espera agotado" : "error del proveedor"}). Tu sesión sigue activa: intenta de nuevo en un momento.`
      s.mensajes.push({ rol: "assistant", texto: reply, llamadas: [] })
      return fin({ reply, toolCalls, needsConfirmation: false, error: true })
    }
    s.tokens += r.uso.entrada + r.uso.salida
    s.mensajes.push({ rol: "assistant", texto: r.texto, llamadas: r.llamadas, crudo: r.crudo })
    respuesta = r.texto
    if (r.fin === "rechazo") respuesta ||= "El modelo declinó responder a esta solicitud."
    if (!r.llamadas.length) break

    const resultados = []
    for (const l of r.llamadas) {
      const contenido = await ejecutar(l.nombre, l.args, ctx, confirmado)
      const v = resumir(contenido)
      toolCalls.push({ nombre: l.nombre, args: l.args, ...v })
      resultados.push({ id: l.id, contenido, error: !v.ok })
    }
    s.mensajes.push({ rol: "tool", resultados })
    if (i === MAX_ITERACIONES - 1) {
      respuesta = `Alcancé el tope de ${MAX_ITERACIONES} pasos en este turno. Hecho: ${toolCalls.map((t) => `${t.nombre} (${t.ok ? "ok" : "error"})`).join(", ")}. Pídeme que continúe para completar lo que falta.`
      s.mensajes.push({ rol: "assistant", texto: respuesta, llamadas: [] })
    }
  }

  // CA3: el turno pide confirmación si el modelo lo marca, o si se armó un paquete y aún no se envió.
  const armo = toolCalls.some((t) => t.nombre === "proveedor_armar_paquete" && t.ok)
  const envio = toolCalls.some((t) => t.nombre === "proveedor_simular_envio" && t.ok)
  const needsConfirmation = respuesta.includes(MARCA) || (armo && !envio)
  let reply = respuesta.replaceAll(MARCA, "").trim()
  if (needsConfirmation && !reply.trim().endsWith("?")) reply += "\n\n¿Confirmas que simule el envío del paquete al cliente?"
  return fin({ reply, toolCalls, needsConfirmation })
}
