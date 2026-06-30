import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { maxColumnCount, parseCsv } from '../lib/csv'

interface Props {
  /** Raw CSV text to render. */
  source: string
  /**
   * Stable key used to persist the per-row checkbox state. Typically the file's
   * in-root path or its absolute OS path. When null/empty, the table still works
   * but check state is in-memory only.
   */
  storageKey: string | null
  /**
   * Treat the first row as a header. Header cells get a sticky-top style and the
   * "select all" master checkbox sits in its row instead of an extra one.
   */
  hasHeader?: boolean
}

const STORAGE_PREFIX = 'csv-checks:'

/**
 * Load the persisted set of checked row indices for a given storage key.
 * Returns an empty Set on miss, malformed JSON, or when localStorage is unavailable.
 */
function loadChecked(storageKey: string | null): Set<number> {
  if (!storageKey) return new Set()
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + storageKey)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    const out = new Set<number>()
    for (const v of parsed) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out.add(v)
    }
    return out
  } catch {
    return new Set()
  }
}

function persistChecked(storageKey: string | null, checked: Set<number>): void {
  if (!storageKey) return
  try {
    if (checked.size === 0) {
      localStorage.removeItem(STORAGE_PREFIX + storageKey)
    } else {
      localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify([...checked].sort((a, b) => a - b)))
    }
  } catch {
    // quota / private mode — fall through, state stays in-memory.
  }
}

export function CsvTable({ source, storageKey, hasHeader = true }: Props) {
  const rows = useMemo(() => parseCsv(source), [source])
  const colCount = useMemo(() => maxColumnCount(rows), [rows])

  // Header row (row 0) is not selectable; data rows start at offset 0 in the body.
  const headerRow = hasHeader && rows.length > 0 ? rows[0] : null
  const bodyRows = headerRow ? rows.slice(1) : rows

  // Persisted checkbox state, keyed by the row's index within `bodyRows`.
  const [checked, setChecked] = useState<Set<number>>(() => loadChecked(storageKey))

  // Re-hydrate when the storageKey (i.e. the active file) changes. Without this,
  // switching tabs to a different CSV would carry over the previous file's checks
  // until the user toggled something.
  const lastKey = useRef(storageKey)
  useEffect(() => {
    if (lastKey.current === storageKey) return
    lastKey.current = storageKey
    setChecked(loadChecked(storageKey))
  }, [storageKey])

  const toggleRow = useCallback(
    (idx: number) => {
      setChecked((prev) => {
        const next = new Set(prev)
        if (next.has(idx)) next.delete(idx)
        else next.add(idx)
        persistChecked(storageKey, next)
        return next
      })
    },
    [storageKey],
  )

  const allChecked = bodyRows.length > 0 && checked.size === bodyRows.length
  const someChecked = checked.size > 0 && !allChecked

  const toggleAll = useCallback(() => {
    setChecked((prev) => {
      const next: Set<number> =
        prev.size === bodyRows.length ? new Set() : new Set(bodyRows.map((_, i) => i))
      persistChecked(storageKey, next)
      return next
    })
  }, [bodyRows.length, storageKey])

  if (rows.length === 0) {
    return <div className="csv-empty">空のCSVです。</div>
  }

  return (
    <div className="csv-table-wrap">
      <table className="csv-table">
        {headerRow && (
          <thead>
            <tr>
              <th className="csv-check-col">
                <CheckCell
                  checked={allChecked}
                  indeterminate={someChecked}
                  onChange={toggleAll}
                  ariaLabel="すべて選択"
                />
              </th>
              {Array.from({ length: colCount }, (_, ci) => (
                <th key={ci}>{headerRow[ci] ?? ''}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {bodyRows.map((row, ri) => (
            <BodyRow
              key={ri}
              rowIndex={ri}
              row={row}
              colCount={colCount}
              isChecked={checked.has(ri)}
              onToggle={toggleRow}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface BodyRowProps {
  rowIndex: number
  row: readonly string[]
  colCount: number
  isChecked: boolean
  onToggle: (idx: number) => void
}

/**
 * Memoised row. Only re-renders when its own checkbox flips or the underlying
 * row content changes — important for keeping 1000-row tables responsive when
 * a single check toggles.
 */
const BodyRow = memo(function BodyRow({ rowIndex, row, colCount, isChecked, onToggle }: BodyRowProps) {
  return (
    <tr className={isChecked ? 'csv-row-checked' : undefined}>
      <td className="csv-check-col">
        <CheckCell
          checked={isChecked}
          onChange={() => onToggle(rowIndex)}
          ariaLabel={`行 ${rowIndex + 1} を選択`}
        />
      </td>
      {Array.from({ length: colCount }, (_, ci) => (
        <td key={ci}>{row[ci] ?? ''}</td>
      ))}
    </tr>
  )
})

interface CheckCellProps {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  ariaLabel: string
}

function CheckCell({ checked, indeterminate = false, onChange, ariaLabel }: CheckCellProps) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="csv-check"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
    />
  )
}
