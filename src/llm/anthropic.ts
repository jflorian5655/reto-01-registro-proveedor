import Anthropic from "@anthropic-ai/sdk"
import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type { Mensaje, ProveedorLLM, Respuesta } from "./adapter.ts"

function aMensajes(mensajes: Mensaje[]): BetaMessageParam[] {
  return mensajes.map((m): BetaMessageParam => {
    if (m.rol === "user") return { role: "user", content: m.texto }
    if (m.rol === "tool")
      return {
        role: "user",
        content: m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido, is_error: r.error })),
      }
    if (m.crudo) return { role: "assistant", content: m.crudo as BetaContentBlockParam[] }
    const bloques: BetaContentBlockParam[] = m.texto ? [{ type: "text", text: m.texto }] : []
    for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args })
    return { role: "assistant", content: bloques }
  })
}

export function crearAnthropic(): ProveedorLLM {
  const modelo = process.env.LLM_MODEL || "claude-opus-5-5"
  // La clave se lee de ANTHROPIC_API_KEY dentro del SDK; nunca pasa por nuestro código ni por logs.
  const cliente = new Anthropic({ timeout: Number(process.env.LLM_TIMEOUT_MS) || 90_000, maxRetries: 1 })
  return {
    nombre: "anthropic",
    modelo,
    async enviar(sistema, mensajes, herramientas): Promise<Respuesta> {
      const r = await cliente.beta.messages.create({
        model: modelo,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: [{ type: "text", text: sistema, cache_control: { type: "ephemeral" } }],
        tools: herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: h.parametros as { type: "object"; [k: string]: unknown },
        })),
        messages: aMensajes(mensajes),
      })
      const texto = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
      const llamadas = r.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, args: b.input }] : []))
      const fin = r.stop_reason === "tool_use" ? "herramientas" : r.stop_reason === "max_tokens" ? "limite_tokens" : r.stop_reason === "refusal" ? "rechazo" : "fin"
      return { texto, llamadas, crudo: r.content, uso: { entrada: r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0), salida: r.usage.output_tokens }, fin }
    },
  }
}
