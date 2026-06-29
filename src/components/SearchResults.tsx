import type { ReactNode } from 'react'
import type { SearchMatch } from '../lib/searchContent'

interface Props {
  matches: SearchMatch[]
  /** The active query, used to highlight matches inside snippets. */
  query: string
  selectedPath: string | null
  /** Single-click: open in preview tab. */
  onSelect: (path: string) => void
  /** Double-click: pin / open as a non-preview tab. */
  onActivate?: (path: string) => void
}

export function SearchResults({ matches, query, selectedPath, onSelect, onActivate }: Props) {
  if (matches.length === 0) {
    return <p className="hint">「{query.trim()}」を含むファイルはありません</p>
  }

  return (
    <ul className="results">
      {matches.map((m) => (
        <li key={m.path}>
          <button
            className={`result${m.path === selectedPath ? ' selected' : ''}`}
            onClick={() => onSelect(m.path)}
            onDoubleClick={() => onActivate?.(m.path)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onActivate?.(m.path)
              }
            }}
            onMouseDown={(e) => {
              // Suppress middle-click autoscroll so onAuxClick can open a new tab cleanly.
              if (e.button === 1) e.preventDefault()
            }}
            title={m.path}
          >
            <div className="result-head">
              <span className="icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z" />
                </svg>
              </span>
              <span className="label">{m.name}</span>
              <span className="badge" title={`${m.total} 行ヒット`}>
                {m.total}
              </span>
            </div>
            <div className="result-path">{m.path}</div>
            <ul className="snippets">
              {m.snippets.map((s) => (
                <li key={s.line}>
                  <span className="ln">{s.line}</span>
                  <span className="snippet-text">{highlight(s.text, query)}</span>
                </li>
              ))}
            </ul>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Wrap every case-insensitive occurrence of `query` in `text` with <mark>. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text

  const ql = q.toLowerCase()
  const lower = text.toLowerCase()
  const out: ReactNode[] = []
  let cursor = 0
  let key = 0
  let idx = lower.indexOf(ql)

  while (idx !== -1) {
    if (idx > cursor) out.push(text.slice(cursor, idx))
    out.push(<mark key={key++}>{text.slice(idx, idx + q.length)}</mark>)
    cursor = idx + q.length
    idx = lower.indexOf(ql, cursor)
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}
