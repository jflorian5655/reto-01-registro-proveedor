import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib"
import { writeFile } from "node:fs/promises"

export type Celda = { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }
export type CampoPdf = { etiqueta: string; obligatorio: boolean }

/** P0: escribe etiqueta y valor exactamente en la hoja/celda indicada. Faltantes quedan vacíos. */
export async function escribirXlsx(ruta: string, celdas: Celda[], valores: Map<string, string>) {
  const libro = new ExcelJS.Workbook()
  for (const c of celdas) {
    const hoja = libro.getWorksheet(c.hoja) ?? libro.addWorksheet(c.hoja)
    hoja.getCell(c.celda_etiqueta).value = c.etiqueta
    hoja.getCell(c.celda_etiqueta).font = { bold: true }
    hoja.getCell(c.celda_valor).value = valores.get(c.etiqueta) ?? ""
  }
  libro.eachSheet((h) => h.columns.forEach((col) => (col.width = 42)))
  await libro.xlsx.writeFile(ruta)
}

function partir(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tam) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else actual = prueba
  }
  return [...lineas, actual]
}

/** P1: PDF generado con todos los campos (etiqueta y valor) en el orden de la plantilla. */
export async function escribirPdf(ruta: string, titulo: string, campos: CampoPdf[], valores: Map<string, string>) {
  const doc = await PDFDocument.create()
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  let pagina = doc.addPage([595, 842])
  let y = 790
  const linea = (texto: string, fuente: PDFFont, tam: number, x = 50, color = rgb(0, 0, 0)) => {
    for (const l of partir(texto, fuente, tam, 495 - (x - 50))) {
      if (y < 60) {
        pagina = doc.addPage([595, 842])
        y = 790
      }
      pagina.drawText(l, { x, y, size: tam, font: fuente, color })
      y -= tam + 5
    }
  }
  linea(titulo, negrita, 15)
  y -= 10
  for (const c of campos) {
    linea(`${c.etiqueta}${c.obligatorio ? " *" : ""}`, negrita, 10)
    linea(valores.get(c.etiqueta) || "______________________________", normal, 11, 62, rgb(0.1, 0.1, 0.35))
    y -= 6
  }
  y -= 20
  linea("* Campo obligatorio", normal, 8)
  y -= 30
  linea("_________________________________", normal, 10)
  linea("Firma del representante legal", normal, 9)
  await writeFile(ruta, await doc.save())
}
