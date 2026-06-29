/**
 * Minimal RFC 4180-flavoured CSV parser.
 *
 * Handles:
 *  - quoted fields with embedded commas, newlines, and doubled-quote escapes
 *  - mixed CRLF / LF / CR line endings
 *  - trailing newline (does not emit a phantom empty row)
 *
 * Rows are returned ragged — the table renderer pads shorter rows to match the
 * widest row, so we don't need to enforce a uniform column count here.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length

  while (i < n) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote ("") collapses to a single " inside the field.
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      // Consume a CRLF pair as one line terminator.
      if (ch === '\r' && i + 1 < n && text[i + 1] === '\n') i += 2
      else i++
      continue
    }
    field += ch
    i++
  }

  // Flush the last field/row unless the input ended exactly on a newline (which
  // already pushed the trailing row above).
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Largest row length across `rows`, or 0 when there are no rows. */
export function maxColumnCount(rows: readonly (readonly string[])[]): number {
  let max = 0
  for (const r of rows) {
    if (r.length > max) max = r.length
  }
  return max
}
