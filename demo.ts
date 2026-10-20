/**
 * Ejecuta todos los casos llamando directamente a las herramientas (sin modelo, sin clave).
 *   bun run demo.ts
 */
import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { strict as assert } from "node:assert"
import * as proveedor from "./src/tools/proveedor.ts"
import { valorEn, comoTexto, type Json } from "./src/tools/lib.ts"

const ctx = { directory: import.meta.dir, sessionId: "demo" }
type R<T> = { ok: true; data: T } | { ok: false; error: string }
const llamar = async <T,>(t: { execute(a: unknown, c: typeof ctx): Promise<string> }, args: object) =>
  JSON.parse(await t.execute(args, ctx)) as R<T>

type Solicitud = { pais: string; cliente: string; formato: string; campos: string[]; advertencias: string[] }
type Item = { etiqueta: string; ruta: string; valor: string; nota?: string; motivo?: string }
type Mapeo = { llenos: Item[]; faltantes: Item[]; requiere_confirmacion: Item[] }
type Paquete = { ruta: string; listo_para_firma: boolean; bloqueos: string[] }

await rm(join(ctx.directory, "out"), { recursive: true, force: true })
const maestro = JSON.parse(await readFile(join(ctx.directory, "fixtures/reto-01/repositorio/maestro.json"), "utf8")) as Json
const casos = (await readdir(join(ctx.directory, "fixtures/reto-01/casos"))).sort()

for (const caso of casos) {
  console.log(`\n━━━ ${caso} ━━━`)
  const sol = await llamar<Solicitud>(proveedor.leer_solicitud, { caso })
  if (!sol.ok) {
    console.log(`  ✗ leer_solicitud: ${sol.error}`)
    continue
  }
  const { pais, cliente, formato, campos, advertencias } = sol.data
  console.log(`  ${cliente} · ${pais} · ${formato} · ${campos.length} campos${advertencias.length ? ` · ⚠ ${advertencias.join("; ")}` : ""}`)

  const m = campos.length ? await llamar<Mapeo>(proveedor.mapear_campos, { caso, campos }) : null
  if (m?.ok) {
    const { llenos, faltantes, requiere_confirmacion } = m.data
    console.log(`  llenos ${llenos.length} · faltantes ${faltantes.length} · por confirmar ${requiere_confirmacion.length}`)
    for (const c of requiere_confirmacion) console.log(`    ? ${c.etiqueta} → ${c.ruta}: ${c.nota}`)
    for (const c of faltantes) console.log(`    ✗ ${c.etiqueta}: ${c.motivo}`)
    // HU-2: ningún valor inventado — todo valor sale literal del maestro en su ruta.
    for (const c of [...llenos, ...requiere_confirmacion]) assert.equal(c.valor, comoTexto(valorEn(maestro, c.ruta)!), `${caso}/${c.etiqueta}`)
  }

  const f = await llamar<{ ruta: string }>(proveedor.generar_formulario, { caso, mapeo: [] })
  console.log(`  formulario: ${f.ok ? f.data.ruta : `✗ ${f.error}`}`)

  const p = await llamar<Paquete>(proveedor.armar_paquete, { caso })
  console.log(p.ok ? `  paquete: ${p.data.ruta} · listo_para_firma=${p.data.listo_para_firma}${p.data.bloqueos.map((b) => `\n    ⛔ ${b}`).join("")}` : `  ✗ paquete: ${p.error}`)

  // RN4: sin confirmación no hay envío.
  const sinConfirmar = await llamar(proveedor.simular_envio, { caso, confirmado: false })
  assert.deepEqual(sinConfirmar, { ok: false, error: "requiere confirmación explícita" })

  // RN2: el borrador de correo nunca lleva datos bancarios.
  if (p.ok) {
    const correo = await readFile(join(ctx.directory, p.data.ruta, "borrador-correo.md"), "utf8")
    for (const r of ["banco.numero_cuenta", "banco.swift"]) {
      const v = valorEn(maestro, r)
      if (typeof v === "string" || typeof v === "number") assert.ok(!correo.includes(String(v)), `${caso}: ${r} en el borrador`)
    }
  }
}

// HU-5: errores claros, nunca excepciones.
const inexistente = await llamar(proveedor.leer_solicitud, { caso: "pe-no-existe" })
assert.equal(inexistente.ok, false)
const traversal = await llamar(proveedor.leer_solicitud, { caso: "../secretos" })
assert.equal(traversal.ok, false)
console.log(`\nErrores controlados: ${!inexistente.ok && inexistente.error}`)
console.log("\n✓ demo completa: todos los checks pasaron")
