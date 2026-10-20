# Reto 01 · Agente "Registro como Proveedor"

Agente conversacional que lee una solicitud de registro como proveedor, llena el formulario del cliente (Excel o PDF) desde el repositorio maestro, arma el paquete para firma y **pide confirmación** antes de cualquier envío (simulado).

- **Link de prueba:** `<pendiente: URL del despliegue>`
- **Clave de acceso:** si el despliegue define `ACCESS_KEY`, el chat la pide al entrar: `<pendiente>`
- Planteamiento y decisiones: [SOLUCION.md](SOLUCION.md)

## Levantar en local (un comando)

Requiere [Bun](https://bun.sh) ≥ 1.1.

```bash
cp .env.example .env    # y pon tu ANTHROPIC_API_KEY
bun install && bun run dev
# → http://localhost:3000
```

Con Docker: `docker build -t reto01 . && docker run -p 3000:3000 --env-file .env reto01`.

## Verificación sin modelo

```bash
bun run demo.ts   # ejecuta las herramientas sobre todos los casos e imprime un resumen (sin clave)
bun test          # ciclo del agente con un LLM simulado: confirmación, errores, sincronía de modulo/
bun run typecheck
```

`demo.ts` limpia `out/` al inicio y produce el mismo resultado en cada ejecución (salvo timestamps). Para fijar la fecha con la que se evalúan vigencias: `FECHA_EJECUCION=2026-09-03 bun run demo.ts`.

## Variables de entorno

| Variable | Requerida | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | sí (chat) | Clave del modelo. Solo en el backend; nunca llega al front, a los logs ni a las respuestas. |
| `LLM_MODEL` | no | Modelo (por defecto `claude-opus-5-5`). |
| `MAX_ITERACIONES` | no | Tope de llamadas modelo→herramientas por turno (25). |
| `MAX_TOKENS_SESION` | no | Tope de tokens por sesión (400 000). |
| `LLM_TIMEOUT_MS` | no | Timeout por llamada al modelo (90 000). |
| `ACCESS_KEY` | no | Si se define, protege el chat y las descargas. |
| `FECHA_EJECUCION` | no | Fecha fija `YYYY-MM-DD` para evaluar vigencias. |
| `PORT` | no | Puerto HTTP (3000). |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[{ nombre, args, ok, resumen }], needsConfirmation, error? }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model, protegido }` (sin claves) |
| `GET` | `/out/<caso>/...` | Descarga de artefactos generados (formulario, paquete, logs) |

Con `ACCESS_KEY`, enviar el header `x-access-key` (o `?k=` en descargas).

## Estructura

```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/                      conocimiento: registro-proveedor.md (para el modelo) + reglas.json (para las herramientas)
src/tools/proveedor.ts              herramientas proveedor_* (zod, { ok, data } | { ok:false, error }, nunca lanzan)
src/tools/{mapeo,formatos,lib}.ts   mapeo al maestro, escritura xlsx/pdf, utilidades y log
src/llm/adapter.ts, anthropic.ts    interfaz de proveedor LLM + implementación Anthropic
src/agent.ts                        ciclo del agente (tope de iteraciones, confirmación, sesiones)
src/server.ts                       API HTTP + front estático
web/index.html                      chat (HTML + JS plano)
modulo/                             bonus: agente empaquetado, generado con `bun run modulo`
fixtures/reto-01/                   insumos entregados (solo lectura)
out/                                salidas (se crea en ejecución)
```

## Despliegue

`render.yaml` despliega el Dockerfile en Render (plan free): crear un Blueprint desde el repositorio y cargar `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`) como secretos. Cualquier plataforma que corra un Dockerfile sirve (Fly.io, Railway, Azure Container Apps).
