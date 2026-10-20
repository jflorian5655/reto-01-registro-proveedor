import reglas from "../knowledge/reglas.json"
import { comoTexto, normalizar, valorEn, type Json } from "./lib.ts"

export type Lleno = { etiqueta: string; ruta: string; valor: string; confianza: number }
export type PorConfirmar = Lleno & { nota: string }
export type Faltante = { etiqueta: string; motivo: string }
export type Mapeo = { llenos: Lleno[]; faltantes: Faltante[]; requiere_confirmacion: PorConfirmar[] }

const VACIAS = new Set(reglas.palabras_vacias)
const tokens = (s: string) => new Set(normalizar(s).split(/[^a-z0-9]+/).filter((t) => t && !VACIAS.has(t)))

/** Coeficiente de Dice sobre tokens: 1 = mismas palabras, 0 = ninguna en común. */
export function similitud(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let comunes = 0
  for (const t of ta) if (tb.has(t)) comunes++
  return (2 * comunes) / (ta.size + tb.size)
}

const soloExplicito = (ruta: string) => reglas.prefijos_solo_explicitos.some((p) => ruta.startsWith(p))

/** Busca la ruta del maestro para una etiqueta: glosario exacto, clave del maestro, o sinónimo parecido. */
export function resolverRuta(etiqueta: string, glosario: Record<string, string>, maestro: Json) {
  const n = normalizar(etiqueta)
  for (const [sinonimo, ruta] of Object.entries(glosario)) if (normalizar(sinonimo) === n) return { ruta, confianza: 1 }
  const clave = n.replace(/ /g, "_")
  if (valorEn(maestro, clave) !== undefined) return { ruta: clave, confianza: 0.9 }
  let mejor = { ruta: "", confianza: 0 }
  for (const [sinonimo, ruta] of Object.entries(glosario)) {
    if (soloExplicito(ruta)) continue // RN2: datos bancarios solo si la plantilla los pide explícitamente
    const s = similitud(etiqueta, sinonimo)
    if (s > mejor.confianza) mejor = { ruta, confianza: Number(s.toFixed(2)) }
  }
  return mejor.confianza >= reglas.umbral_candidato ? mejor : null
}

function notaIdentificador(etiqueta: string, ruta: string, pais: string): string | null {
  if (!reglas.claves_identificador.includes(ruta)) return null
  const esperado = reglas.identificador_por_pais[pais as keyof typeof reglas.identificador_por_pais] ?? "identificador tributario local"
  if (reglas.etiquetas_ambiguas.some((a) => normalizar(a) === normalizar(etiqueta)))
    return `Etiqueta ambigua: en ${pais} equivale a ${esperado}.${pais === reglas.pais_maestro ? "" : " Se llenó con el NIT colombiano (identificador extranjero)."}`
  if (pais !== reglas.pais_maestro) return `Identificador extranjero: el cliente (${pais}) pide ${esperado}; Periferia solo tiene NIT colombiano.`
  return null
}

/** HU-2: cada etiqueta termina en lleno / faltante / requiere_confirmacion. Nunca inventa valores. */
export function mapear(campos: string[], pais: string, glosario: Record<string, string>, maestro: Json): Mapeo {
  const m: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const etiqueta of campos) {
    const r = resolverRuta(etiqueta, glosario, maestro)
    if (!r) {
      m.faltantes.push({ etiqueta, motivo: "Sin equivalente en el glosario ni en el maestro" })
      continue
    }
    const v = valorEn(maestro, r.ruta)
    if (v === undefined || v === null || v === "") {
      m.faltantes.push({ etiqueta, motivo: `El maestro no tiene valor en "${r.ruta}"` })
      continue
    }
    const base = { etiqueta, ruta: r.ruta, valor: comoTexto(v), confianza: r.confianza }
    const nota =
      notaIdentificador(etiqueta, r.ruta, pais) ??
      (r.confianza < reglas.umbral_confianza ? `Mapeo aproximado (confianza ${r.confianza}): verificar que "${etiqueta}" corresponde a ${r.ruta}` : null)
    if (nota) m.requiere_confirmacion.push({ ...base, nota })
    else m.llenos.push(base)
  }
  return m
}

/** Valor por etiqueta para escribir en el formulario (llenos + por confirmar). */
export const valoresPorEtiqueta = (m: Mapeo) =>
  new Map<string, string>([...m.llenos, ...m.requiere_confirmacion].map((c) => [c.etiqueta, c.valor]))
