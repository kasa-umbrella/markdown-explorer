import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Highlight,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid'
import { maxColumnCount, parseCsv } from '../lib/csv'

interface Props {
  /** Raw CSV text to render. */
  source: string
  /**
   * Stable key used to persist the per-row checkbox state. Typically the file's
   * absolute OS path or basename. When null/empty, the table still works but check
   * state is in-memory only.
   */
  storageKey: string | null
  /**
   * Treat the first row as a header. The header cells become the grid's column
   * titles; every data row below is selectable via its row-marker checkbox.
   */
  hasHeader?: boolean
}

/**
 * Imperative search API exposed to the FindBar. Since the grid renders to a
 * <canvas> (no DOM text to walk), ⌘F drives it through these methods instead of
 * the CSS Custom Highlight API used for markdown.
 */
export interface CsvSearchHandle {
  /** Run a case-insensitive search over every cell; returns the match count. */
  search: (query: string) => number
  /** Focus match `index` (0-based): emphasise it and scroll it into view. */
  goto: (index: number) => void
  /** Drop all search highlights. */
  clear: () => void
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
      localStorage.setItem(
        STORAGE_PREFIX + storageKey,
        JSON.stringify([...checked].sort((a, b) => a - b)),
      )
    }
  } catch {
    // quota / private mode — fall through, state stays in-memory.
  }
}

/** Build a CompactSelection (Glide's row-selection type) from a set of indices. */
function rowsFromSet(set: Set<number>): CompactSelection {
  let sel = CompactSelection.empty()
  for (const i of set) sel = sel.add(i)
  return sel
}

/**
 * Convert `#rrggbb` (or `#rgb`) to an `rgba()` string with the given alpha.
 * Canvas fill styles parse rgba() everywhere, whereas `color-mix()` support is
 * engine-dependent — so we pre-mix here to keep selection tints reliable.
 */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (full.length !== 6) return hex
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Read the app's live CSS custom properties into a Glide theme override. */
function readTheme(): Partial<Theme> {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback
  const bg = v('--bg', '#ffffff')
  const panel = v('--panel', '#f7f8fa')
  const panel2 = v('--panel-2', '#eef0f4')
  const border = v('--border', '#e2e5ea')
  const text = v('--text', '#1f2328')
  const muted = v('--muted', '#6b7280')
  const accent = v('--accent', '#2f6feb')
  return {
    accentColor: accent,
    accentFg: '#ffffff',
    accentLight: withAlpha(accent, 0.18),
    textDark: text,
    textMedium: muted,
    textLight: muted,
    textBubble: text,
    textHeader: text,
    textHeaderSelected: accent,
    bgIconHeader: muted,
    fgIconHeader: bg,
    bgCell: bg,
    bgCellMedium: panel,
    bgHeader: panel2,
    bgHeaderHasFocus: panel2,
    bgHeaderHovered: panel,
    bgBubble: panel2,
    bgBubbleSelected: accent,
    bgSearchResult: withAlpha(accent, 0.2),
    borderColor: border,
    horizontalBorderColor: border,
    drilldownBorder: border,
    linkColor: accent,
  }
}

/** Keep the grid theme in sync with the app's light/dark palette. */
function useGridTheme(): Partial<Theme> {
  const [theme, setTheme] = useState<Partial<Theme>>(readTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

/** Cap on search matches, mirroring the DOM find path in findInDoc.ts. */
const SEARCH_LIMIT = 5000

export const CsvTable = forwardRef<CsvSearchHandle, Props>(function CsvTable(
  { source, storageKey, hasHeader = true },
  ref,
) {
  const rows = useMemo(() => parseCsv(source), [source])
  const colCount = useMemo(() => maxColumnCount(rows), [rows])

  // Row 0 supplies the column titles when hasHeader; the remaining rows are the
  // selectable data body. Row indices below are relative to `bodyRows`, matching
  // the persisted checkbox semantics of the previous HTML-table renderer.
  const headerRow = hasHeader && rows.length > 0 ? rows[0] : null
  const bodyRows = useMemo(() => (headerRow ? rows.slice(1) : rows), [rows, headerRow])

  const theme = useGridTheme()
  const gridRef = useRef<DataEditorRef>(null)

  // Estimate a comfortable starting width per column from its content, capped so
  // one long cell can't blow the column out. Users can still drag to resize.
  const estimatedWidths = useMemo(() => {
    const sample = Math.min(bodyRows.length, 100)
    return Array.from({ length: colCount }, (_, c) => {
      let maxLen = (headerRow?.[c] ?? '').length
      for (let r = 0; r < sample; r++) {
        const len = (bodyRows[r]?.[c] ?? '').length
        if (len > maxLen) maxLen = len
      }
      return Math.max(80, Math.min(360, maxLen * 8 + 36))
    })
  }, [bodyRows, colCount, headerRow])

  // User-overridden widths from drag-resizing, keyed by column index.
  const [colWidths, setColWidths] = useState<Record<number, number>>({})

  const columns = useMemo<GridColumn[]>(
    () =>
      Array.from({ length: colCount }, (_, ci) => ({
        title: headerRow?.[ci]?.trim() || `列${ci + 1}`,
        id: String(ci),
        width: colWidths[ci] ?? estimatedWidths[ci] ?? 120,
      })),
    [colCount, headerRow, colWidths, estimatedWidths],
  )

  const getCellContent = useCallback(
    (cell: Item): GridCell => {
      const [col, row] = cell
      const value = bodyRows[row]?.[col] ?? ''
      return {
        kind: GridCellKind.Text,
        data: value,
        displayData: value,
        allowOverlay: true,
        readonly: true,
        allowWrapping: false,
      }
    },
    [bodyRows],
  )

  const onColumnResize = useCallback((_col: GridColumn, newSize: number, colIndex: number) => {
    setColWidths((prev) => ({ ...prev, [colIndex]: newSize }))
  }, [])

  // Selection state. `rows` holds the persisted row-marker checkboxes; `current`
  // holds the transient cell range the user drag-selects for copying.
  const [selection, setSelection] = useState<GridSelection>(() => ({
    columns: CompactSelection.empty(),
    rows: rowsFromSet(loadChecked(storageKey)),
  }))

  // Re-hydrate checkbox state when the active file changes so one CSV's checks
  // don't bleed into the next.
  useEffect(() => {
    setSelection({ columns: CompactSelection.empty(), rows: rowsFromSet(loadChecked(storageKey)) })
  }, [storageKey])

  const onGridSelectionChange = useCallback(
    (next: GridSelection) => {
      setSelection(next)
      persistChecked(storageKey, new Set(next.rows.toArray()))
    },
    [storageKey],
  )

  // ── Search (driven by FindBar) ──
  // `matches` feeds the highlight overlay; `matchesRef` lets goto() read the
  // latest list without a stale closure. Both reset when the file changes.
  const [matches, setMatches] = useState<Item[]>([])
  const [currentMatch, setCurrentMatch] = useState(0)
  const matchesRef = useRef<Item[]>([])

  useEffect(() => {
    setColWidths({})
    setMatches([])
    matchesRef.current = []
    setCurrentMatch(0)
  }, [source])

  useImperativeHandle(
    ref,
    (): CsvSearchHandle => ({
      search(query) {
        const q = query.trim().toLowerCase()
        if (!q) {
          matchesRef.current = []
          setMatches([])
          setCurrentMatch(0)
          return 0
        }
        const found: Item[] = []
        outer: for (let r = 0; r < bodyRows.length; r++) {
          const row = bodyRows[r]
          for (let c = 0; c < colCount; c++) {
            const cell = row[c]
            if (cell && cell.toLowerCase().includes(q)) {
              found.push([c, r] as Item)
              if (found.length >= SEARCH_LIMIT) break outer
            }
          }
        }
        matchesRef.current = found
        setMatches(found)
        setCurrentMatch(0)
        return found.length
      },
      goto(index) {
        const m = matchesRef.current
        if (index < 0 || index >= m.length) return
        setCurrentMatch(index)
        const [col, row] = m[index]
        gridRef.current?.scrollTo(col, row, 'both', 0, 0, { hAlign: 'center', vAlign: 'center' })
      },
      clear() {
        matchesRef.current = []
        setMatches([])
        setCurrentMatch(0)
      },
    }),
    [bodyRows, colCount],
  )

  const accent = theme.accentColor ?? '#2f6feb'
  const highlightRegions = useMemo<readonly Highlight[] | undefined>(() => {
    if (matches.length === 0) return undefined
    const regions: Highlight[] = matches.map((m) => ({
      color: withAlpha(accent, 0.16),
      range: { x: m[0], y: m[1], width: 1, height: 1 },
      style: 'no-outline',
    }))
    const cur = matches[currentMatch]
    if (cur) {
      // Drawn last so the active match's outline sits on top of the plain fills.
      regions.push({
        color: withAlpha(accent, 0.32),
        range: { x: cur[0], y: cur[1], width: 1, height: 1 },
        style: 'solid-outline',
      })
    }
    return regions
  }, [matches, currentMatch, accent])

  if (rows.length === 0) {
    return <div className="csv-empty">空のCSVです。</div>
  }

  return (
    <div className="csv-grid-wrap">
      <DataEditor
        ref={gridRef}
        columns={columns}
        rows={bodyRows.length}
        getCellContent={getCellContent}
        getCellsForSelection={true}
        rowMarkers="checkbox"
        gridSelection={selection}
        onGridSelectionChange={onGridSelectionChange}
        onColumnResize={onColumnResize}
        highlightRegions={highlightRegions}
        rangeSelect="rect"
        columnSelect="multi"
        rowSelect="multi"
        smoothScrollX
        smoothScrollY
        theme={theme}
      />
    </div>
  )
})
