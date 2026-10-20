import { expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { nuevaSesion, turno } from "./agent.ts"
import type { Llamada, ProveedorLLM, Respuesta } from "./llm/adapter.ts"

const ROOT = join(import.meta.dir, "..")
const CASO = "hn-agroexport-sula"

/** Proveedor guionado: devuelve las respuestas en orden, sin red ni clave. */
function guion(pasos: (Llamada[] | string)[]): ProveedorLLM {
  let i = 0
  return {
    nombre: "falso",
    modelo: "guion",
    async enviar(): Promise<Respuesta> {
      const p = pasos[i++] ?? "fin"
      const llamadas = typeof p === "string" ? [] : p
      return { texto: typeof p === "string" ? p : "", llamadas, crudo: undefined, uso: { entrada: 10, salida: 10 }, fin: llamadas.length ? "herramientas" : "fin" }
    },
  }
}
const llamada = (nombre: string, args: object): Llamada => ({ id: crypto.randomUUID(), nombre, args })

test("procesa, pide confirmación y solo envía tras un 'sí' explícito", async () => {
  rmSync(join(ROOT, "out", CASO), { recursive: true, force: true })
  const s = nuevaSesion("test")
  const llm = guion([
    [llamada("proveedor_leer_solicitud", { caso: CASO })],
    [llamada("proveedor_mapear_campos", { caso: CASO, campos: ["Razón social", "RTN"] }), llamada("proveedor_generar_formulario", { caso: CASO, mapeo: [] })],
    [llamada("proveedor_armar_paquete", { caso: CASO }), llamada("proveedor_simular_envio", { caso: CASO, confirmado: true })],
    "Resumen listo.",
    [llamada("proveedor_simular_envio", { caso: CASO, confirmado: true })],
    "Envío simulado.",
  ])
  const t1 = await turno(s, `Procesa el caso ${CASO}. No envíes nada todavía.`, llm, ROOT)
  expect(t1.toolCalls.map((t) => t.ok)).toEqual([true, true, true, true, false]) // el envío sin confirmar se bloquea
  expect(t1.needsConfirmation).toBe(true)
  expect(t1.reply.endsWith("?")).toBe(true)
  expect(existsSync(join(ROOT, "out", CASO, "ENVIO-SIMULADO.md"))).toBe(false)

  const t2 = await turno(s, "envía", llm, ROOT)
  expect(t2.toolCalls[0]?.ok).toBe(true)
  expect(existsSync(join(ROOT, "out", CASO, "ENVIO-SIMULADO.md"))).toBe(true)
})

test("argumentos inválidos y fallas del proveedor no matan la sesión", async () => {
  const s = nuevaSesion("test2")
  const t1 = await turno(s, "x", guion([[llamada("proveedor_leer_solicitud", { caso: "../etc" })], "ok"]), ROOT)
  expect(t1.toolCalls[0]?.ok).toBe(false)
  const roto: ProveedorLLM = { nombre: "x", modelo: "x", enviar: () => Promise.reject(new Error("Request timed out")) }
  const t2 = await turno(s, "hola", roto, ROOT)
  expect(t2.error).toBe(true)
  expect(t2.reply).toContain("tiempo de espera")
})

test("modulo/ está sincronizado con prompt, conocimiento y herramientas de la app", async () => {
  const { generar } = await import("../scripts/modulo.ts")
  for (const [ruta, contenido] of Object.entries(await generar())) expect(await Bun.file(join(ROOT, ruta)).text()).toBe(contenido)
})
