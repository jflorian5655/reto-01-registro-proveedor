# SOLUCIÓN — Agente "Registro como Proveedor"

## 1. Problema en una frase

Cada solicitud de registro como proveedor obliga a transcribir a mano datos que ya existen (NIT, banco, representante legal…) y a buscar soportes. Eso cuesta días, introduce errores en datos sensibles y depende de una sola persona. **Le duele** a la analista administrativa, que hace el trabajo, y a Periferia, que no puede facturar hasta quedar registrada.

## 2. Arquitectura

```
┌──────────────────────┐  POST /api/chat   ┌────────────────────────────────────────────┐
│ web/index.html       │ ────────────────▶ │ src/server.ts   API HTTP, sesiones en       │
│ - historial          │ ◀──────────────── │                 memoria, clave de acceso    │
│ - tool calls visibles│  { reply,          │ src/agent.ts    ciclo del agente:           │
│ - estado "confirmar" │    toolCalls,      │                 prompt → LLM → tools → …    │
└──────────────────────┘    needsConfirm }  │ src/llm/adapter.ts   interfaz enviar()      │
                                            │ src/llm/anthropic.ts implementación          │
                                            └───────────┬───────────────────────┬────────┘
                                                        │ execute(args, ctx)    │
                                            ┌───────────▼───────────┐           │
                                            │ src/tools/proveedor.ts│ ◀── demo.ts (sin modelo)
                                            │  mapeo.ts formatos.ts │ ◀── modulo/tools (re-export)
                                            └───────┬───────────┬───┘
                                    fixtures/ (solo lectura)   out/ (escritura + log.jsonl)
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Orden de pasos, reglas inquebrantables (no inventar valores, no enviar sin confirmación), formato del resumen y marca `[CONFIRMAR]`. |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` (para el modelo) y `src/knowledge/reglas.json` (para las herramientas) | Proceso, estados de campo, RN1–RN5, identificador por país, umbral de confianza, prefijos bancarios "solo explícitos", nombres de soportes. Si cambia una regla de negocio (p. ej., un nuevo país), se edita `reglas.json`; el servidor no se toca. |
| **Ejecución** | `src/tools/` | Cinco herramientas tipadas con zod. Son la única fuente de valores. |

## 3. Ciclo del agente

`src/agent.ts → turno()`:

1. Se agrega el mensaje de la usuaria y se llama `llm.enviar(sistema, mensajes, herramientas)`.
2. Si el modelo pide herramientas, cada una se ejecuta con `execute(args, ctx)`. El envoltorio `herramienta()` (`src/tools/lib.ts`) **valida los argumentos con zod antes de ejecutar**, captura cualquier excepción, escribe `{ ts, herramienta, ok, resumen }` en `out/log.jsonl` y `out/<caso>/log.jsonl`, y devuelve siempre `{ ok, data }` o `{ ok:false, error }`. Los resultados vuelven al modelo y el ciclo continúa.
3. **Tope (CA1):** `MAX_ITERACIONES` (25) por turno. Al alcanzarlo, el turno cierra con lo hecho y lo pendiente. También hay tope de tokens por sesión (`MAX_TOKENS_SESION`), timeout por llamada (`LLM_TIMEOUT_MS`), límite de longitud del mensaje y una sola petición en curso por sesión.
4. **Confirmación humana (CA3/RN4), en dos capas:**
   - *Prompt:* el modelo termina con una pregunta y la marca `[CONFIRMAR]`. El servidor también marca el turno si se armó un paquete y no se envió. La respuesta lleva `needsConfirmation: true`, y el front la resalta en ámbar con botones "Sí / No".
   - *Código:* `proveedor_simular_envio` está en la lista de **acciones externas**. El ciclo solo la ejecuta si el turno anterior pidió confirmación **y** el mensaje actual es afirmativo y sin negación ("sí", "confirmo", "envía"…). Aunque el modelo la llame por su cuenta con `confirmado: true`, recibe `requiere confirmación explícita`. La herramienta, por su parte, rechaza `confirmado: false`.
5. **Errores (CA5):** un fallo del proveedor LLM (timeout, 5xx) se convierte en un mensaje claro, la sesión sigue viva y el error técnico solo va al log del servidor.

**Anti-alucinación (CA2) por diseño:** `proveedor_generar_formulario` **no recibe valores** del modelo. Usa el mapeo que guardó `mapear_campos` (`out/<caso>/mapeo.json`) y, como mucho, acepta ajustes `{ etiqueta → ruta del maestro }` confirmados por la analista. El valor siempre se lee del maestro. `demo.ts` verifica que cada valor escrito coincide literalmente con el maestro en su ruta.

**Mapeo (HU-2)**, en orden:
1. Sinónimo exacto del glosario (normalizado sin tildes ni mayúsculas): confianza 1.
2. Clave directa del maestro: 0.9.
3. Similitud de Dice por palabras contra los sinónimos (≥ 0.5 es candidato; < 0.8 queda `requiere_confirmacion`). Las rutas `banco.*` nunca se asignan por similitud (RN2).

Si no hay ruta o el maestro no tiene valor, el campo queda `faltante`. RN1 marca `requiere_confirmacion` cuando el identificador se pide para un país distinto de CO, o cuando la etiqueta es ambigua.

## 4. Elección del modelo

- **Proveedor / modelo:** Anthropic, `claude-opus-5-5` (configurable con `LLM_MODEL`), con esfuerzo `medium`, prompt caching del system prompt y *fallback* del lado del servidor (`fallbacks: "default"`) para que un rechazo por política no corte el turno.
- **Por qué:** el trabajo es *tool use* de varios pasos con reglas estrictas (no inventar, pedir confirmación). Importan la fiabilidad al llamar herramientas y seguir instrucciones más que el costo por token, porque el volumen es de 8–12 casos al mes.
- **Costo estimado por caso:** unas 5–6 llamadas al modelo, ~40–60 k tokens de entrada acumulados (system + herramientas + resultados; buena parte cacheada) y ~2–4 k de salida. Con Opus 5.5 ($4 / $20 por MTok) son **≈ USD 0,20–0,30 por caso**, unos USD 3 al mes. Con `LLM_MODEL=claude-sonnet-5-5` baja a ≈ USD 0,10–0,15, y con Haiku 5.5 a centavos, a costa de robustez en el seguimiento de reglas.
- **Cambiar de proveedor:** se implementa `ProveedorLLM` (`src/llm/adapter.ts`) para OpenAI, Gemini, etc. El ciclo no cambia (el test usa un proveedor simulado precisamente con esa interfaz).

## 5. Diseño: portal web con usuario y contraseña

**Hoy (implementado):** si `formato = portal`, el agente responde "formato no soportado" y genera `out/<caso>/valores-portal.md` con la tabla campo → valor lista para copiar.

**Propuesta para producción:**

- **Estrategia:** navegador controlado (Playwright) operado por el agente, con un *adaptador por portal* (selectores y pasos versionados) y modo "co-piloto". El humano abre una sesión de navegador visible, inicia sesión y el agente solo **rellena** campos. Descarté:
  - RPA clásico: frágil y caro de mantener.
  - Extensión de navegador: obliga a instalar software y a distribuirla. Queda como alternativa si TI lo prefiere, porque ve la sesión del usuario sin manejar credenciales.
- **Límites:**
  - CAPTCHA y MFA: no se evaden; los resuelve la persona.
  - Cambios de layout: el adaptador valida que cada selector exista antes de escribir. Si falla, cae a `valores-portal.md` y avisa.
  - Sesiones que expiran y cargas de archivos con validaciones propias del portal.
- **Credenciales:** nunca en el repo, el prompt, el contexto del modelo ni los logs. Viven en el gestor de secretos corporativo (p. ej., Azure Key Vault o el gestor de contraseñas del equipo). **Las ingresa la persona** en el navegador; el agente nunca las ve. Si en el futuro se automatiza el login, la herramienta las inyectaría directamente desde el vault al campo, sin pasar por el modelo, con logs que enmascaren valores.
- **Reparto de responsabilidades:**

  | Agente | Humano |
  |---|---|
  | Prepara valores, rellena campos, adjunta soportes vigentes, toma captura de la pantalla final y la deja en el paquete | Ingresa credenciales y MFA, revisa la pantalla, **hace clic en "Enviar"** y gestiona la firma |

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | `generar_formulario` toma el mapeo guardado y solo acepta ajustes *etiqueta → ruta*; el valor siempre sale del maestro. | Pasar el mapeo completo con valores como argumento del modelo (literal del contrato). | Si el modelo transporta los valores, puede alterarlos. Así es imposible por construcción (CA2), y se mantiene la firma `{ caso, mapeo }`. |
| 2 | Ciclo del agente propio sobre una interfaz `ProveedorLLM`. | Tool Runner del SDK de Anthropic o un framework (LangChain, Vercel AI SDK). | El reto exige cambiar de proveedor sin tocar el ciclo y controlar tope, confirmación y log. Son ~100 líneas legibles, sin dependencias extra. |
| 3 | Confirmación forzada en código (lista de acciones externas + regex de afirmación sobre el mensaje siguiente), además del prompt. | Confiar solo en el prompt. | RN4 es una regla de seguridad; un modelo no puede ser la única barrera. |
| 4 | Mapeo determinista (glosario + similitud de palabras + umbrales en `reglas.json`). | Pedir al LLM que haga el mapeo. | Determinismo para `demo.ts`, trazabilidad (ruta + confianza) y cero costo. El LLM se reserva para conversar y orquestar. |
| 5 | PDF generado con `pdf-lib` (etiqueta/valor en orden + línea de firma). | Rellenar el AcroForm original. | No se entregó el PDF original. El PRD acepta el PDF generado. |
| 6 | Front en HTML + JS plano servido por el mismo proceso Bun. | React o Svelte con un build aparte. | Un comando, cero build y un solo servicio que desplegar. La UI pedida es pequeña. |
| 7 | Sesiones en memoria (máx. 200, se expulsa la más antigua). | Archivo o base de datos. | El PRD lo permite. Si el servicio se reinicia se pierde el chat, pero no los artefactos de `out/`. |

**Dependencias:** `zod` (obligatorio, esquemas y JSON Schema para el modelo), `exceljs` (escribir celdas exactas en xlsx), `pdf-lib` (PDF sin binarios nativos), `@anthropic-ai/sdk` (cliente oficial: reintentos, timeout y tipos). Dev: `typescript`, `@types/bun`.

## 7. Supuestos

1. "Fecha de ejecución" = fecha del sistema (`FECHA_EJECUCION` la fija para pruebas). Un soporte con `vigencia_hasta` nula no vence. Ejemplo: con la fecha del PRD (2026-09-03) `co-industrias-delta` queda **listo para firma**; con una fecha posterior a 2026-09-30 la Cámara de Comercio vence y bloquea los tres casos, lo cual es el comportamiento esperado de RN3.
2. Si hay varios soportes del mismo tipo, se usa el de vigencia más lejana. Si el archivo listado no existe en disco, el soporte cuenta como **ausente**.
3. Los campos `requiere_confirmacion` **se escriben** en el formulario (RN1 dice "se llena con el NIT") y se listan en el checklist para revisión. Los `faltante` quedan vacíos.
4. `listo_para_firma` depende solo de los soportes (RN3). Un paquete no listo **puede** enviarse en simulación si la analista lo confirma; `ENVIO-SIMULADO.md` deja constancia del estado y de los bloqueos.
5. "Correo electrónico" se llena con el correo comercial, según el glosario.
6. Para un cliente extranjero que pide "registro tributario de su país", el soporte equivalente es el RUT colombiano (`rut`). Se informa, no se bloquea.
7. Un formato distinto de xlsx, pdf o portal se reporta como no soportado. El mapeo y el paquete se generan igual.

## 8. Cobertura

| HU | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Detecta ambiguos y propone el identificador del país. Falta: leer correos y adjuntos reales (hoy, fixtures normalizados). |
| HU-2 Mapear al maestro | Hecho | Tres estados con ruta y confianza; sinónimos del glosario; nunca inventa. Falta: aprendizaje de nuevos sinónimos confirmados por la analista. |
| HU-3 Generar formulario | xlsx hecho · pdf hecho · portal = `valores-portal.md` | Falta: escribir sobre el `.xlsx`/AcroForm original del cliente para conservar su formato. |
| HU-4 Paquete para firma | Hecho | Checklist (presentes/ausentes/vencidos, faltantes, por confirmar), borrador sin datos bancarios, confirmación y `ENVIO-SIMULADO.md`. Falta: integración con correo y firma electrónica. |
| HU-5 Errores | Hecho | Caso inexistente, plantilla corrupta, formato no soportado, argumentos inválidos, *path traversal*, timeout del LLM: mensajes claros, sin trazas. |
| Bonus módulo | Hecho | `modulo/` se genera desde las mismas fuentes (`bun run modulo`); un test falla si diverge. |

## 9. Uso de IA

| Asistente | Para qué |
|---|---|
| Claude Code | Leer el PRD y los fixtures, proponer la arquitectura, escribir el código, `demo.ts`, los tests y la primera versión de esta documentación. |

**Lo que descarté de las propuestas y por qué:**
- Usar el *Tool Runner* del SDK: amarra el ciclo a un proveedor. Escribí el ciclo propio.
- Dejar que el modelo pase los valores al generar el formulario: riesgo de alucinación (ver decisión 1).
- Cargar una librería de Markdown desde CDN en el front: dependencia externa por ~20 líneas de render propio.
- Cualquier llamada a shell desde herramientas: prohibido por el PRD; todo es `fs` con rutas confinadas.

> *Candidato: ajusta esta sección con tu uso real de asistentes.*

## 10. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| Maestro desactualizado → formularios con datos viejos | Dueño del dato, fecha de actualización por campo y alerta en el checklist si un dato tiene más de N meses. |
| Plantillas reales más sucias (celdas combinadas, etiquetas libres) | Extraer etiquetas del xlsx/pdf real, cola de "por confirmar" y glosario que crece con cada confirmación. |
| El modelo ignora una instrucción | Las barreras críticas están en código (valores solo del maestro, confirmación forzada, validación zod). |
| Fuga de datos sensibles (cuenta bancaria) | No se muestran en el chat ni en el borrador; logs solo con resúmenes. En producción: cifrado en reposo de `out/` y retención limitada. |
| Abuso del link público / costo | `ACCESS_KEY`, topes de iteraciones y tokens por sesión, límite de mensaje. En producción: SSO y cuota por usuario. |
| Pérdida de sesiones al reiniciar; un solo proceso | Persistir sesiones en archivo o Redis; los artefactos ya quedan en disco. |
| Prompt injection desde correos de clientes | El contenido del correo solo llega como dato de herramienta; las acciones externas exigen confirmación humana en código. |
