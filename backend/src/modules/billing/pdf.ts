/**
 * Writes a one-page A4 PDF of plain lines.
 *
 * A receipt is a title and a dozen labelled amounts, which is the one shape a PDF can be written
 * by hand: a page, a built-in font and a text stream. That is a few lines of byte counting here
 * against a rendering dependency and a headless browser in every deployment.
 */

const ESCAPE = /([\\()])/g

/** PDF strings are parenthesised, and WinAnsi has no rupee sign, so amounts read as "Rs." */
const text = (line: string) => line.replace(ESCAPE, '\\$1').replace(/₹/g, 'Rs.')

export interface PdfLine {
  text: string
  /** 16 for a heading, 11 for a body line */
  size?: number
  bold?: boolean
}

export function onePagePdf(lines: PdfLine[]): Buffer {
  const content: string[] = ['BT', '1 0 0 1 56 786 Tm', '15 TL']
  let lastSize = 0
  for (const line of lines) {
    const size = line.size ?? 11
    const font = line.bold ? '/F2' : '/F1'
    if (size !== lastSize) {
      content.push(`${Math.round(size * 1.4)} TL`)
      lastSize = size
    }
    content.push(`${font} ${size} Tf`, `(${text(line.text)}) Tj`, 'T*')
  }
  content.push('ET')
  const stream = content.join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const startxref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
