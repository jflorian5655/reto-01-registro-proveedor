/** Contrato neutral entre el ciclo del agente y cualquier proveedor LLM. */
export type HerramientaLLM = { nombre: string; descripcion: string; parametros: Record<string, unknown> }
export type Llamada = { id: string; nombre: string; args: unknown }
export type Mensaje =
  | { rol: "user"; texto: string }
  /** `crudo` = contenido nativo del proveedor (p. ej. bloques de razonamiento) para reenviarlo intacto. */
  | { rol: "assistant"; texto: string; llamadas: Llamada[]; crudo?: unknown }
  | { rol: "tool"; resultados: { id: string; contenido: string; error: boolean }[] }
export type Respuesta = {
  texto: string
  llamadas: Llamada[]
  crudo: unknown
  uso: { entrada: number; salida: number }
  fin: "fin" | "herramientas" | "limite_tokens" | "rechazo"
}
export interface ProveedorLLM {
  nombre: string
  modelo: string
  enviar(sistema: string, mensajes: Mensaje[], herramientas: HerramientaLLM[]): Promise<Respuesta>
}
