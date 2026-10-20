---
name: registro-proveedor
description: Conocimiento del proceso de registro como proveedor de Periferia (estados de campo, reglas por país, soportes, bloqueos de firma). Úsalo al procesar solicitudes de registro de clientes.
---
## Proceso de registro como proveedor

1. Un cliente envía por correo una solicitud con una plantilla (Excel, PDF o portal web) y una lista de soportes.
2. Se llenan los campos desde el **repositorio maestro** de Periferia (`fixtures/reto-01/repositorio/maestro.json`), resolviendo sinónimos con el glosario (`glosario-campos.json`).
3. Se arma un paquete para firma: formulario + soportes vigentes + checklist + borrador de correo.
4. La **firma** del representante legal y el **envío** al cliente son decisiones humanas.

## Estados de un campo

- `lleno`: tiene ruta en el maestro y valor.
- `requiere_confirmacion`: mapeo con confianza < 0.8, etiqueta ambigua o regla de país. Se escribe en el formulario, pero la analista debe revisarlo.
- `faltante`: no existe en el maestro. Se deja vacío y se reporta. **No bloquea** la firma.

## Reglas de negocio

- **RN1 · Identificador tributario por país**: CO → NIT; EC, PE, PA → RUC; HN → RTN. Periferia solo tiene NIT colombiano: para clientes de otros países se llena con el NIT y queda `requiere_confirmacion` ("identificador extranjero"). Etiquetas como "Identificación tributaria" son ambiguas y se confirman con el equivalente del país.
- **RN2 · Datos bancarios** solo si la plantilla los pide explícitamente. Nunca en el borrador de correo.
- **RN3 · Bloqueos de firma**: un soporte exigido **vencido** (`vigencia_hasta` anterior a la fecha de ejecución) o **ausente** bloquea `listo_para_firma`. Los campos faltantes no bloquean, pero aparecen en el checklist.
- **RN4 · Acciones externas** (envío, firma, carga a portal) solo con confirmación explícita en el mensaje inmediatamente anterior. En este sistema "enviar" solo escribe `out/<caso>/ENVIO-SIMULADO.md`.
- **RN5 · Trazabilidad**: cada herramienta deja registro en `out/<caso>/log.jsonl`.

## Formatos de salida

- **xlsx** → `out/<caso>/formulario.xlsx` (etiqueta y valor en la hoja/celda de la plantilla).
- **pdf** → `out/<caso>/formulario.pdf` (todos los campos en el orden de la plantilla).
- **portal** → no se automatiza; se entrega `out/<caso>/valores-portal.md` para copiar. Credenciales y clic en "Enviar" los hace una persona.

## Soportes habituales

Cámara de Comercio (existencia legal), RUT (registro tributario), certificación bancaria, parafiscales (obligaciones laborales), estados financieros, certificado de cumplimiento tributario. Cuando el cliente es extranjero y pide "registro tributario de su país", el soporte equivalente de Periferia es el RUT colombiano.

## Reglas parametrizadas (src/knowledge/reglas.json)

```json
{
  "pais_maestro": "CO",
  "identificador_por_pais": { "CO": "NIT", "EC": "RUC", "PE": "RUC", "PA": "RUC", "HN": "RTN" },
  "claves_identificador": ["nit", "digito_verificacion"],
  "etiquetas_ambiguas": ["Identificación tributaria", "Número de identificación fiscal"],
  "umbral_confianza": 0.8,
  "umbral_candidato": 0.5,
  "prefijos_solo_explicitos": ["banco."],
  "palabras_vacias": ["de", "del", "la", "el", "los", "las", "y", "o", "/", "e"],
  "nombres_soporte": {
    "camara_comercio": "Certificado de Cámara de Comercio / existencia legal",
    "rut": "RUT / registro tributario",
    "certificacion_bancaria": "Certificación bancaria",
    "parafiscales": "Certificado de pago de parafiscales / obligaciones laborales",
    "estados_financieros": "Estados financieros del último año",
    "certificado_cumplimiento_tributario": "Certificado de cumplimiento tributario"
  }
}
```
