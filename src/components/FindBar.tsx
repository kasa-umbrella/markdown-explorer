import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { buildDocTextIndex, findMatches } from '../lib/findInDoc'

interface Props {
  /**
   * The scrollable preview pane — both the search root and the scroll target.
   * Passed as a ref (stable identity) so the effects below don't re-fire on
   * every host render.
   */
  scrollerRef: RefObject<HTMLElement | null>
  /**
   * Content signals: the bar re-runs its search whenever the rendered document is
   * replaced (file switch, reload). Passed as raw values purely as effect deps.
   */
  html: string
  csvText: string | null
  /** Measured height of the doc-path bar, so the bar and scroll margins clear it. */
  topOffset: number
  /** Bumped by the host on every ⌘F so an already-open bar re-focuses its input. */
  focusSignal: number
  onClose: () => void
}

/** Subtrees inside the scroll pane that are chrome, not document content. */
const skipNonContent = (parent: Element) => parent.closest('.doc-path') !== null

/**
 * In-preview find bar (⌘F). Searches the rendered document only — deliberately
 * not Electron's findInPage, which would also hit the sidebar tree and can't be
 * scoped. Matches are painted with the CSS Custom Highlight API (no DOM
 * mutation), so it coexists with Preview's mermaid / blob-URL post-processing.
 */
export function FindBar({ scrollerRef, html, csvText, topOffset, focusSignal, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // ⌘F while already open: re-focus and select so the user can retype immediately.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  // Re-search whenever the query or the rendered content changes. The initial
  // current match is the first one at/after the viewport top (Chrome behavior),
  // so opening find doesn't yank the reader back to the top of the document.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !query) {
      setRanges([])
      setCurrent(0)
      return
    }
    const index = buildDocTextIndex(scroller, skipNonContent)
    const found = findMatches(index, query)
    let initial = 0
    if (found.length > 0) {
      const top = scroller.getBoundingClientRect().top + topOffset
      const below = found.findIndex((r) => r.getBoundingClientRect().bottom >= top)
      if (below !== -1) initial = below
    }
    setRanges(found)
    setCurrent(initial)
    // topOffset is read for the initial pick but shouldn't retrigger a search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, html, csvText, scrollerRef])

  // Paint the matches. The current match gets its own named highlight with a
  // higher priority so its style wins over the all-matches one. Cleanup removes
  // both registrations, which also covers closing the bar (unmount).
  useEffect(() => {
    if (typeof Highlight === 'undefined' || !CSS.highlights) return
    const all = new Highlight()
    for (const r of ranges) all.add(r)
    CSS.highlights.set('find-match', all)
    const cur = new Highlight()
    const range = ranges[current]
    if (range) cur.add(range)
    cur.priority = 1
    CSS.highlights.set('find-current', cur)
    return () => {
      CSS.highlights.delete('find-match')
      CSS.highlights.delete('find-current')
    }
  }, [ranges, current])

  // Keep the current match in view, clear of the sticky doc-path bar. Skips
  // collapsed ranges (their node got replaced under us, e.g. by a mermaid render).
  useEffect(() => {
    const scroller = scrollerRef.current
    const range = ranges[current]
    if (!scroller || !range) return
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const sr = scroller.getBoundingClientRect()
    const topBound = sr.top + topOffset + 8
    const bottomBound = sr.bottom - 8
    if (rect.top < topBound || rect.bottom > bottomBound) {
      scroller.scrollTo({
        top: scroller.scrollTop + (rect.top - sr.top) - scroller.clientHeight * 0.3,
      })
    }
  }, [ranges, current, scrollerRef, topOffset])

  const step = useCallback(
    (dir: 1 | -1) => {
      setCurrent((i) => (ranges.length === 0 ? 0 : (i + dir + ranges.length) % ranges.length))
    },
    [ranges.length],
  )

  // Esc anywhere closes the bar; ⌘G / ⌘⇧G step through matches even when the
  // input isn't focused (matching the browser's native find keybindings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        step(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step])

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
  }

  const noMatch = query.length > 0 && ranges.length === 0
  return (
    <div
      className={`find-bar${noMatch ? ' no-match' : ''}`}
      style={{ top: topOffset + 8 }}
      role="search"
      aria-label="ページ内検索"
    >
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        placeholder="ページ内を検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
        autoFocus
        spellCheck={false}
      />
      <span className="find-count" aria-live="polite">
        {query.length === 0 ? '' : ranges.length === 0 ? '0 件' : `${current + 1} / ${ranges.length}`}
      </span>
      <button
        className="nav-btn"
        onClick={() => step(-1)}
        disabled={ranges.length === 0}
        title="前の一致へ (Shift+Enter)"
        aria-label="前の一致へ"
      >
        <svg className="nav-btn-svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
          <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z" />
        </svg>
      </button>
      <button
        className="nav-btn"
        onClick={() => step(1)}
        disabled={ranges.length === 0}
        title="次の一致へ (Enter)"
        aria-label="次の一致へ"
      >
        <svg className="nav-btn-svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
        </svg>
      </button>
      <button className="nav-btn" onClick={onClose} title="閉じる (Esc)" aria-label="検索を閉じる">
        <svg className="nav-btn-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
    </div>
  )
}
