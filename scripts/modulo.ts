/**
 * Genera modulo/ desde las fuentes de la app (una sola verdad):
 *   agent/prompt.md                     → modulo/agent.md
 *   src/knowledge/registro-proveedor.md → modulo/skill/registro-proveedor/SKILL.md
 *   src/tools/proveedor.ts              → modulo/tools/proveedor.ts (re-export)
 * `bun run modulo --check` falla si modulo/ quedó desactualizado.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const leer = (p: string) => readFile(join(ROOT, p), "utf8")

export async function generar(): Promise<Record<string, string>> {
  const [prompt, conocimiento, reglas] = await Promise.all([
    leer("agent/prompt.md"),
    leer("src/knowledge/registro-proveedor.md"),
    leer("src/knowledge/reglas.json"),
  ])
  return {
    "modulo/agent.md": `---
description: Agente que llena formularios de registro como proveedor desde el repositorio maestro y arma el paquete para firma, sin enviar nada sin confirmación.
mode: primary
permission:
  edit: deny
  bash: deny
---
${prompt}`,
    "modulo/skill/registro-proveedor/SKILL.md": `---
name: registro-proveedor
description: Conocimiento del proceso de registro como proveedor de Periferia (estados de campo, reglas por país, soportes, bloqueos de firma). Úsalo al procesar solicitudes de registro de clientes.
---
${conocimiento}
## Reglas parametrizadas (src/knowledge/reglas.json)

\`\`\`json
${reglas.trim()}
\`\`\`
`,
    "modulo/tools/proveedor.ts": `// Generado por scripts/modulo.ts: las mismas herramientas que usa la app (no es una copia).
export * from "../../src/tools/proveedor.ts"
`,
  }
}

if (import.meta.main) {
  const archivos = await generar()
  const check = process.argv.includes("--check")
  let desactualizado = false
  for (const [ruta, contenido] of Object.entries(archivos)) {
    const actual = await leer(ruta).catch(() => "")
    if (actual === contenido) continue
    desactualizado = true
    if (check) console.error(`desactualizado: ${ruta}`)
    else {
      await mkdir(dirname(join(ROOT, ruta)), { recursive: true })
      await writeFile(join(ROOT, ruta), contenido)
      console.log(`escrito: ${ruta}`)
    }
  }
  if (check && desactualizado) process.exit(1)
}
