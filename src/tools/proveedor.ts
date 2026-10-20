import { z } from "zod"
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import reglas from "../knowledge/reglas.json"
import { CASO, Falla, comoTexto, exigirCaso, herramienta, hoy, leerJson, rutas, valorEn, type Ctx, type Json } from "./lib.ts"
import { mapear, valoresPorEtiqueta, type Mapeo } from "./mapeo.ts"
import { escribirPdf, escribirXlsx, type CampoPdf, type Celda } from "./formatos.ts"

// ---------- esquemas de los fixtures ----------
const Solicitud = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.string(),
  adjuntos: z.array(z.string()).default([]),
})
const Celdas = z.array(z.object({ hoja: z.string(), celda_etiqueta: z.string(), etiqueta: z.string(), celda_valor: z.string() })).min(1)
const Campos = z.array(z.object({ etiqueta: z.string(), obligatorio: z.boolean().default(false) })).min(1)
const Exigidos = z.array(z.string())
const Soporte = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.string().nullable().optional(),
  pais_emisor: z.string().optional(),
})
const IndiceSoportes = z.union([z.array(Soporte), z.object({ soportes: z.array(Soporte) }).transform((o) => o.soportes)])
const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonSchema), z.record(z.string(), JsonSchema)]),
)
const MapeoSchema: z.ZodType<Mapeo> = z.object({
  llenos: z.array(z.object({ etiqueta: z.string(), ruta: z.string(), valor: z.string(), confianza: z.number() })),
  faltantes: z.array(z.object({ etiqueta: z.string(), motivo: z.string() })),
  requiere_confirmacion: z.array(
    z.object({ etiqueta: z.string(), ruta: z.string(), valor: z.string(), confianza: z.number(), nota: z.string() }),
  ),
})

type Plantilla = { tipo: "xlsx"; celdas: Celda[] } | { tipo: "pdf"; campos: CampoPdf[] }

// ---------- cargadores ----------
const solicitudDe = (ctx: Ctx, caso: string) => leerJson(join(rutas(ctx, caso).caso, "solicitud.json"), Solicitud, "solicitud.json")
const maestroDe = (ctx: Ctx) => leerJson(join(rutas(ctx).repo, "maestro.json"), JsonSchema, "maestro.json")
const glosarioDe = (ctx: Ctx) =>
  leerJson(join(rutas(ctx).fixtures, "glosario-campos.json"), z.record(z.string(), z.string()), "glosario-campos.json")
const existe = (ruta: string) => stat(ruta).then(() => true, () => false)
const rel = (ctx: Ctx, ruta: string) => relative(ctx.directory, ruta)

/** Lee la plantilla que exista (celdas → xlsx, campos → pdf/portal). Corrupta o ausente = null + advertencia. */
async function plantillaDe(ctx: Ctx, caso: string): Promise<{ plantilla: Plantilla | null; advertencia?: string }> {
  const dir = rutas(ctx, caso).caso
  try {
    if (await existe(join(dir, "plantilla-celdas.json")))
      return { plantilla: { tipo: "xlsx", celdas: await leerJson(join(dir, "plantilla-celdas.json"), Celdas, "plantilla-celdas.json") } }
    if (await existe(join(dir, "plantilla-campos.json")))
      return { plantilla: { tipo: "pdf", campos: await leerJson(join(dir, "plantilla-campos.json"), Campos, "plantilla-campos.json") } }
    return { plantilla: null, advertencia: "El caso no trae plantilla de campos" }
  } catch (e) {
    return { plantilla: null, advertencia: e instanceof Falla ? e.message : "Plantilla ilegible" }
  }
}

const etiquetas = (p: Plantilla) => (p.tipo === "xlsx" ? p.celdas.map((c) => c.etiqueta) : p.campos.map((c) => c.etiqueta))

async function mapeoDe(ctx: Ctx, caso: string): Promise<Mapeo> {
  const guardado = join(rutas(ctx, caso).out, "mapeo.json")
  if (await existe(guardado)) return leerJson(guardado, MapeoSchema, "mapeo.json")
  const { plantilla, advertencia } = await plantillaDe(ctx, caso)
  if (!plantilla) throw new Falla(`No se puede mapear: ${advertencia}`)
  const sol = await solicitudDe(ctx, caso)
  return guardarMapeo(ctx, caso, mapear(etiquetas(plantilla), sol.pais, await glosarioDe(ctx), await maestroDe(ctx)))
}

async function guardarMapeo(ctx: Ctx, caso: string, m: Mapeo) {
  await mkdir(rutas(ctx, caso).out, { recursive: true })
  await writeFile(join(rutas(ctx, caso).out, "mapeo.json"), JSON.stringify(m, null, 2))
  return m
}

const nombreSoporte = (tipo: string) => reglas.nombres_soporte[tipo as keyof typeof reglas.nombres_soporte] ?? tipo

// ---------- herramientas (el modelo las ve como proveedor_<export>) ----------

export const leer_solicitud = herramienta(
  "proveedor_leer_solicitud",
  "Lee la solicitud de un caso (correo + plantilla) y devuelve país, cliente, formato de salida, campos pedidos y soportes exigidos.",
  { caso: CASO },
  async ({ caso }, ctx) => {
    await exigirCaso(ctx, caso)
    const sol = await solicitudDe(ctx, caso)
    const { plantilla, advertencia } = await plantillaDe(ctx, caso)
    const exigidos = await leerJson(join(rutas(ctx, caso).caso, "soportes-exigidos.json"), Exigidos, "soportes-exigidos.json").catch(
      () => [] as string[],
    )
    const campos = plantilla ? etiquetas(plantilla) : []
    const ambiguos = campos.filter((c) => reglas.etiquetas_ambiguas.includes(c))
    const idLocal = reglas.identificador_por_pais[sol.pais as keyof typeof reglas.identificador_por_pais] ?? "desconocido"
    const formato = ["xlsx", "pdf", "portal"].includes(sol.formato) ? sol.formato : `${sol.formato} (no soportado)`
    return {
      ok: true,
      resumen: `${caso}: ${sol.pais}, ${formato}, ${campos.length} campos, ${exigidos.length} soportes`,
      data: {
        pais: sol.pais,
        cliente: sol.cliente,
        correo_cliente: sol.de,
        asunto: sol.asunto,
        fecha: sol.fecha,
        formato,
        identificador_tributario_local: idLocal,
        campos,
        obligatorios: plantilla?.tipo === "pdf" ? plantilla.campos.filter((c) => c.obligatorio).map((c) => c.etiqueta) : campos,
        requiere_confirmacion: ambiguos.map((c) => ({ etiqueta: c, propuesta: idLocal })),
        soportes: exigidos.map((tipo) => ({ tipo, nombre: nombreSoporte(tipo) })),
        advertencias: advertencia ? [advertencia] : [],
      },
    }
  },
)

export const mapear_campos = herramienta(
  "proveedor_mapear_campos",
  "Cruza los campos pedidos con el repositorio maestro y los clasifica en llenos (con ruta y valor), faltantes y requiere_confirmacion.",
  {
    caso: CASO,
    campos: z.array(z.string().min(1)).min(1).describe("Etiquetas tal como las devolvió proveedor_leer_solicitud"),
  },
  async ({ caso, campos }, ctx) => {
    await exigirCaso(ctx, caso)
    const sol = await solicitudDe(ctx, caso)
    const m = await guardarMapeo(ctx, caso, mapear(campos, sol.pais, await glosarioDe(ctx), await maestroDe(ctx)))
    return {
      ok: true,
      resumen: `${m.llenos.length} llenos, ${m.faltantes.length} faltantes, ${m.requiere_confirmacion.length} por confirmar`,
      data: m,
    }
  },
)

const Ajuste = z.object({
  etiqueta: z.string().describe("Etiqueta del campo, exactamente como en la plantilla"),
  ruta: z.string().describe("Ruta del dato en el maestro que la analista confirmó, ej. contacto_financiero.email"),
})

export const generar_formulario = herramienta(
  "proveedor_generar_formulario",
  "Genera el formulario lleno en el formato del cliente (xlsx o pdf; portal produce valores-portal.md) usando el último mapeo del caso.",
  {
    caso: CASO,
    mapeo: z
      .array(Ajuste)
      .default([])
      .describe("Solo ajustes confirmados por la analista (etiqueta → ruta del maestro). Vacío = usar el mapeo calculado. Los valores siempre salen del maestro."),
  },
  async ({ caso, mapeo: ajustes }, ctx) => {
    await exigirCaso(ctx, caso)
    const sol = await solicitudDe(ctx, caso)
    const m = await aplicarAjustes(ctx, caso, await mapeoDe(ctx, caso), ajustes)
    const valores = valoresPorEtiqueta(m)
    const { plantilla, advertencia } = await plantillaDe(ctx, caso)
    const out = rutas(ctx, caso).out
    await mkdir(out, { recursive: true })

    if (sol.formato === "portal") {
      const ruta = join(out, "valores-portal.md")
      const filas = (plantilla ? etiquetas(plantilla) : [...valores.keys()]).map((e) => `| ${e} | ${valores.get(e) ?? "**FALTANTE**"} |`)
      await writeFile(ruta, `# Valores para el portal de ${sol.cliente}\n\nCopiar en el portal (el ingreso de credenciales y el clic en "Enviar" son humanos).\n\n| Campo | Valor |\n|---|---|\n${filas.join("\n")}\n`)
      return { ok: false, error: `Formato no soportado (portal web). Se generó ${rel(ctx, ruta)} con los valores listos para copiar.` }
    }
    if (!plantilla) throw new Falla(`No se puede generar el formulario: ${advertencia}. El reporte de faltantes sigue disponible.`)
    if (sol.formato === "xlsx" && plantilla.tipo === "xlsx") {
      const ruta = join(out, "formulario.xlsx")
      await escribirXlsx(ruta, plantilla.celdas, valores)
      return { ok: true, resumen: rel(ctx, ruta), data: { ruta: rel(ctx, ruta), formato: "xlsx", campos_escritos: valores.size, faltantes: m.faltantes.length } }
    }
    if (sol.formato === "pdf") {
      const campos = plantilla.tipo === "pdf" ? plantilla.campos : plantilla.celdas.map((c) => ({ etiqueta: c.etiqueta, obligatorio: false }))
      const ruta = join(out, "formulario.pdf")
      await escribirPdf(ruta, `Registro de proveedor — ${sol.cliente}`, campos, valores)
      return { ok: true, resumen: rel(ctx, ruta), data: { ruta: rel(ctx, ruta), formato: "pdf", campos_escritos: valores.size, faltantes: m.faltantes.length } }
    }
    return { ok: false, error: `Formato no soportado: "${sol.formato}". Use el reporte de faltantes y llene el formulario manualmente.` }
  },
)

/** Ajustes confirmados por la analista: la ruta la elige la persona, el valor sigue saliendo del maestro. */
async function aplicarAjustes(ctx: Ctx, caso: string, m: Mapeo, ajustes: z.infer<typeof Ajuste>[]): Promise<Mapeo> {
  if (!ajustes.length) return m
  const maestro = await maestroDe(ctx)
  for (const a of ajustes) {
    const v = valorEn(maestro, a.ruta)
    if (v === undefined || v === null || v === "" || typeof v === "object") throw new Falla(`La ruta "${a.ruta}" no tiene un valor simple en el maestro`)
    m = {
      llenos: [...m.llenos.filter((c) => c.etiqueta !== a.etiqueta), { etiqueta: a.etiqueta, ruta: a.ruta, valor: comoTexto(v), confianza: 1 }],
      faltantes: m.faltantes.filter((c) => c.etiqueta !== a.etiqueta),
      requiere_confirmacion: m.requiere_confirmacion.filter((c) => c.etiqueta !== a.etiqueta),
    }
  }
  return guardarMapeo(ctx, caso, m)
}

type EstadoSoporte = { tipo: string; nombre: string; estado: "presente" | "vencido" | "ausente"; archivo?: string; vigencia_hasta?: string | null }

async function revisarSoportes(ctx: Ctx, exigidos: string[], fecha: string): Promise<EstadoSoporte[]> {
  const dir = join(rutas(ctx).repo, "soportes")
  const indice = await leerJson(join(dir, "index.json"), IndiceSoportes, "soportes/index.json")
  return Promise.all(
    exigidos.map(async (tipo): Promise<EstadoSoporte> => {
      const candidatos = indice
        .filter((s) => s.tipo === tipo)
        .sort((a, b) => (b.vigencia_hasta ?? "9999").localeCompare(a.vigencia_hasta ?? "9999"))
      const s = candidatos[0]
      if (!s || !(await existe(join(dir, s.archivo)))) return { tipo, nombre: nombreSoporte(tipo), estado: "ausente" }
      const vencido = !!s.vigencia_hasta && s.vigencia_hasta < fecha
      return { tipo, nombre: nombreSoporte(tipo), estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta ?? null }
    }),
  )
}

export const armar_paquete = herramienta(
  "proveedor_armar_paquete",
  "Arma out/<caso>/paquete/ con formulario, soportes vigentes, checklist.md y borrador-correo.md, e indica si queda listo_para_firma.",
  { caso: CASO },
  async ({ caso }, ctx) => {
    await exigirCaso(ctx, caso)
    const sol = await solicitudDe(ctx, caso)
    const fecha = hoy()
    const out = rutas(ctx, caso).out
    const paquete = join(out, "paquete")
    await rm(paquete, { recursive: true, force: true })
    await mkdir(paquete, { recursive: true })

    const exigidos = await leerJson(join(rutas(ctx, caso).caso, "soportes-exigidos.json"), Exigidos, "soportes-exigidos.json")
    const soportes = await revisarSoportes(ctx, exigidos, fecha)
    for (const s of soportes) if (s.estado === "presente" && s.archivo) await copyFile(join(rutas(ctx).repo, "soportes", s.archivo), join(paquete, s.archivo))

    const formularios = (await readdir(out)).filter((f) => /^(formulario\.(xlsx|pdf)|valores-portal\.md)$/.test(f))
    for (const f of formularios) await copyFile(join(out, f), join(paquete, f))
    const m = await mapeoDe(ctx, caso).catch(() => null)

    const bloqueos = soportes.filter((s) => s.estado !== "presente").map((s) => `${s.nombre}: ${s.estado}`)
    const listo = bloqueos.length === 0
    await writeFile(join(paquete, "checklist.md"), checklist(sol.cliente, fecha, listo, soportes, formularios, m))
    await writeFile(join(paquete, "borrador-correo.md"), borrador(sol, soportes, formularios))
    const estado = { listo_para_firma: listo, bloqueos, fecha }
    await writeFile(join(out, "estado-paquete.json"), JSON.stringify(estado, null, 2))

    return {
      ok: true,
      resumen: `listo_para_firma=${listo}${bloqueos.length ? ` (${bloqueos.join("; ")})` : ""}`,
      data: {
        ruta: rel(ctx, paquete),
        listo_para_firma: listo,
        bloqueos,
        checklist: {
          fecha_ejecucion: fecha,
          formulario: formularios,
          soportes,
          campos_faltantes: m?.faltantes.map((f) => f.etiqueta) ?? ["(sin mapeo)"],
          campos_por_confirmar: m?.requiere_confirmacion.map((c) => `${c.etiqueta}: ${c.nota}`) ?? [],
        },
      },
    }
  },
)

const ICONO = { presente: "✅ presente", vencido: "⛔ vencido", ausente: "❌ ausente" } as const

function checklist(cliente: string, fecha: string, listo: boolean, soportes: EstadoSoporte[], formularios: string[], m: Mapeo | null) {
  const lista = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- Ninguno")
  return `# Checklist — registro como proveedor ante ${cliente}

Fecha de ejecución: ${fecha}
**Estado: ${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**

## Formulario
${lista(formularios.length ? formularios : ["⚠️ No se generó formulario"])}

## Soportes exigidos
| Soporte | Estado | Archivo | Vigente hasta |
|---|---|---|---|
${soportes.map((s) => `| ${s.nombre} | ${ICONO[s.estado]} | ${s.archivo ?? "—"} | ${s.vigencia_hasta ?? "—"} |`).join("\n")}

## Campos faltantes (no bloquean la firma; completar a mano)
${lista(m?.faltantes.map((f) => `${f.etiqueta} — ${f.motivo}`) ?? ["Sin mapeo disponible"])}

## Campos por confirmar
${lista(m?.requiere_confirmacion.map((c) => `${c.etiqueta} = ${c.valor} — ${c.nota}`) ?? [])}

## Pendientes humanos
- [ ] Revisar campos por confirmar y faltantes
- [ ] Firma del representante legal
- [ ] Envío al cliente
`
}

/** RN2: el borrador nunca incluye datos bancarios (ni ningún valor del formulario). */
function borrador(sol: z.infer<typeof Solicitud>, soportes: EstadoSoporte[], formularios: string[]) {
  const adjuntos = [...formularios, ...soportes.filter((s) => s.estado === "presente").map((s) => `${s.nombre} (${s.archivo})`)]
  return `Para: ${sol.de}
Asunto: RE: ${sol.asunto}

Buen día,

En atención a su solicitud, adjuntamos el formulario de registro como proveedor de Periferia IT Group, firmado por nuestro representante legal, junto con los siguientes soportes:

${adjuntos.map((a) => `- ${a}`).join("\n")}

Quedamos atentos a cualquier información adicional.

Cordialmente,
Área Administrativa — Periferia IT Group

<!-- BORRADOR: revisar y firmar antes de enviar. -->
`
}

export const simular_envio = herramienta(
  "proveedor_simular_envio",
  "Simula el envío del paquete escribiendo out/<caso>/ENVIO-SIMULADO.md; solo con confirmación explícita de la analista en su último mensaje.",
  {
    caso: CASO,
    confirmado: z.boolean().describe("true solo si la analista confirmó explícitamente el envío en su último mensaje"),
  },
  async ({ caso, confirmado }, ctx) => {
    if (!confirmado) return { ok: false, error: "requiere confirmación explícita" }
    await exigirCaso(ctx, caso)
    const out = rutas(ctx, caso).out
    if (!(await existe(join(out, "paquete")))) throw new Falla("No hay paquete armado para este caso; primero arme el paquete")
    const estado = await leerJson(
      join(out, "estado-paquete.json"),
      z.object({ listo_para_firma: z.boolean(), bloqueos: z.array(z.string()) }),
      "estado-paquete.json",
    )
    const sol = await solicitudDe(ctx, caso)
    const archivos = await readdir(join(out, "paquete"))
    const ruta = join(out, "ENVIO-SIMULADO.md")
    await writeFile(
      ruta,
      `# ENVÍO SIMULADO

- Fecha: ${new Date().toISOString()}
- Para: ${sol.de}
- Asunto: RE: ${sol.asunto}
- Confirmado por la analista: sí
- Listo para firma: ${estado.listo_para_firma ? "sí" : `NO — ${estado.bloqueos.join("; ")}`}

## Adjuntos
${archivos.map((a) => `- paquete/${a}`).join("\n")}

> Simulación: no se envió ningún correo real.
`,
    )
    return { ok: true, resumen: rel(ctx, ruta), data: { ruta: rel(ctx, ruta), listo_para_firma: estado.listo_para_firma } }
  },
)
