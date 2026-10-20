import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderAsCodeBlock, renderMarkdown } from '../lib/markdown'
import { extractFrontmatter } from '../lib/frontmatter'
import { diffLines, type LineDiff } from '../lib/lineDiff'
import { getExtension, isCsvPath, isMarkdownPath } from '../lib/extensions'
import { isXlsxPath, parseSerializedWorkbook, type SheetData } from '../lib/xlsx'
import { CsvTable, type CsvSearchHandle } from './CsvTable'
import {
  guessMimeFromPath,
  isExternalUrl,
  isMarkdownLink,
  resolveAbsoluteRelative,
} from '../lib/paths'
import { renderMermaid } from '../lib/mermaid'
import { isFlowchart } from '../lib/mermaidFlow'
import { useRawHtml } from '../lib/rawHtml'
import { MermaidFlow } from './MermaidFlow'
import { FindBar } from './FindBar'

/** A single opened file. Content is read once and held by the tab. */
export interface PreviewSource {
  name: string
  content: string
  /** Absolute OS path of the source file, when known. Enables relative path resolution + git diff. */
  absolutePath?: string
}

interface Props {
  source: PreviewSource | null
  /**
   * Open an absolute filesystem path as a new tab. Called when the user clicks a
   * relative .md link inside a file — there's no per-tab history, so navigation
   * spawns a sibling tab.
   */
  onOpenExternalPath?: (absolutePath: string) => void
  /** Open the native file picker (multi-select) and open each chosen file as a tab. */
  onOpenFiles?: () => void
  /** Ask the host to re-read the active source from disk (↻ button / ⌘R / focus). */
  onReload?: () => void
  /** Whether the host is currently in focus (full-pane) mode. */
  focusMode?: boolean
  /** Toggle the host's focus mode. */
  onToggleFocus?: () => void
  /** Enter presentation mode for the active markdown source (shown for .md only). */
  onPresent?: () => void
  /**
   * Pin the current section's heading to the top of the pane as a breadcrumb while
   * scrolling. Defaults to on; the host wires it to the user setting of the same name.
   */
  stickyHeadings?: boolean
  /**
   * Mark blocks that changed since the last git commit (added / changed / deleted).
   * Only takes effect for markdown files whose on-disk path is inside a git repo.
   */
  gitDiff?: boolean
  /** Toggle the git-diff markers (wired to the settings flag of the same name). */
  onToggleGitDiff?: () => void
}

/** The heading currently pinned to the sticky top bar. */
interface Crumb {
  id: string
  text: string
  /** 1–6, from the heading's tag (h1 → 1). */
  level: number
}

export function Preview({
  source,
  onOpenExternalPath,
  onOpenFiles,
  onReload,
  focusMode = false,
  onToggleFocus,
  onPresent,
  stickyHeadings = true,
  gitDiff = false,
  onToggleGitDiff,
}: Props) {
  const [html, setHtml] = useState('')
  /**
   * Raw markdown of the active source, kept so the git-diff effect can compare it
   * against the HEAD revision. Null for non-markdown (CSV / code) sources.
   */
  const [srcText, setSrcText] = useState<string | null>(null)
  /**
   * Raw text of the active source when it's a CSV. The viewer renders <CsvTable>
   * instead of the markdown HTML pipeline; `html` is left empty in that branch.
   */
  const [csvText, setCsvText] = useState<string | null>(null)
  /**
   * Parsed Excel workbook sheets when the active source is a spreadsheet, else null.
   * Each sheet is rendered through the CSV grid; `activeSheet` picks the visible one.
   */
  const [xlsxSheets, setXlsxSheets] = useState<SheetData[] | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)
  const [error, setError] = useState<string | null>(null)
  /** The heading of the section the reader is currently scrolled into, pinned to the top bar. */
  const [active, setActive] = useState<Crumb | null>(null)
  /** Measured height of the path bar, so the breadcrumb pins flush beneath it. */
  const [headerH, setHeaderH] = useState(33)
  /** Whether the ⌘F in-document find bar is shown. Survives file switches (Chrome-like). */
  const [findOpen, setFindOpen] = useState(false)
  /** Bumped on every ⌘F so an already-open find bar re-focuses/selects its input. */
  const [findFocusSignal, setFindFocusSignal] = useState(0)
  /**
   * git-diff of the current markdown source against its HEAD revision. null means
   * "no markers" — feature off, non-markdown, or the file isn't inside a git repo.
   */
  const [gitDiffResult, setGitDiffResult] = useState<LineDiff | null>(null)
  /** Bumped on window focus so we re-pull HEAD — the user may have committed while away. */
  const [diffRefreshKey, setDiffRefreshKey] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const docPathRef = useRef<HTMLDivElement>(null)
  /** Search bridge to the CSV grid; used by the FindBar when a CSV is showing. */
  const csvSearchRef = useRef<CsvSearchHandle | null>(null)
  // Drop the grid's search highlights whenever the find bar closes.
  useEffect(() => {
    if (!findOpen) csvSearchRef.current?.clear()
  }, [findOpen])
  /**
   * Bumped every time a fresh <article> element attaches. The article can be torn
   * down and re-created without `html` changing — error round-trips, the csv⇄md flip
   * — and a fresh element starts from the raw markdown-it HTML, with none of the
   * imperative decorations. Every effect that paints into the article keys on this.
   */
  const [articleGen, setArticleGen] = useState(0)
  const attachArticle = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el
    if (el) setArticleGen((g) => g + 1)
  }, [])
  // Stable {__html} identity — see useRawHtml. Without it, React 19 re-sets the
  // article's innerHTML on EVERY re-render, silently erasing the effects' paint.
  const htmlObj = useRawHtml(html)
  const flowRootsRef = useRef<Map<HTMLElement, Root>>(new Map())

  // Split the source into primitive deps so effects only re-fire when content changes.
  const name = source?.name ?? null
  const content = source?.content ?? null
  const absFilePath = source?.absolutePath ?? null

  const markdownSource = !!name && isMarkdownPath(name)

  // When the selected source changes, render it. Markdown goes through the full
  // markdown-it pipeline; CSV renders as a grid; everything else as a code block.
  useEffect(() => {
    if (name === null || content === null) {
      setHtml('')
      setCsvText(null)
      setXlsxSheets(null)
      setSrcText(null)
      setError(null)
      return
    }
    setError(null)
    if (isCsvPath(name)) {
      setHtml('')
      setCsvText(content)
      setXlsxSheets(null)
      setSrcText(null)
    } else if (isXlsxPath(name)) {
      setHtml('')
      setCsvText(null)
      setSrcText(null)
      const wb = parseSerializedWorkbook(content)
      setXlsxSheets(wb?.sheets ?? [])
      setActiveSheet(0)
    } else if (isMarkdownPath(name)) {
      setCsvText(null)
      setXlsxSheets(null)
      setSrcText(content)
      setHtml(renderMarkdown(content))
    } else {
      setCsvText(null)
      setXlsxSheets(null)
      setSrcText(null)
      const ext = getExtension(name) ?? ''
      setHtml(renderAsCodeBlock(content, ext))
    }
  }, [name, content])

  // Pull the HEAD revision of the current markdown file and diff it against the
  // in-memory source. Runs only for markdown with a known on-disk path (Electron).
  useEffect(() => {
    if (!gitDiff || !markdownSource || !absFilePath || srcText === null) {
      setGitDiffResult(null)
      return
    }
    const api = window.mdexp
    if (!api?.gitFileDiff) {
      setGitDiffResult(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.gitFileDiff(absFilePath)
        if (cancelled) return
        if (!res) {
          setGitDiffResult(null)
          return
        }
        const oldBody = res.head === null ? '' : extractFrontmatter(res.head).body
        const newBody = extractFrontmatter(srcText).body
        setGitDiffResult(diffLines(oldBody, newBody))
      } catch (err) {
        if (!cancelled) {
          console.error('[git-diff] failed:', absFilePath, err)
          setGitDiffResult(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [gitDiff, markdownSource, absFilePath, srcText, diffRefreshKey])

  // Returning to the window may mean the user committed / staged in a terminal while
  // away, changing HEAD without touching the file. Re-pull the diff so markers follow.
  useEffect(() => {
    if (!gitDiff) return
    const onFocus = () => setDiffRefreshKey((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [gitDiff])

  // Paint the git-diff markers onto the rendered blocks. Each block carries the source
  // line range it came from (`data-src-line` / `data-src-end`); a block is marked when
  // its range overlaps a changed line.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const MARK_CLASSES = [
      'git-diff-added',
      'git-diff-changed',
      'git-diff-del-before',
      'git-diff-del-end',
    ]
    for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-git-mark]'))) {
      node.classList.remove(...MARK_CLASSES)
      node.removeAttribute('data-git-mark')
    }
    const diff = gitDiffResult
    if (!gitDiff || !diff || csvText !== null) return

    const blocks = Array.from(el.querySelectorAll<HTMLElement>('[data-src-line]'))
    const kinds = new Map<HTMLElement, 'added' | 'changed'>()
    const delBlocks = new Set<HTMLElement>()
    for (const block of blocks) {
      const start = Number(block.getAttribute('data-src-line'))
      const end = Number(block.getAttribute('data-src-end'))
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      let kind: 'added' | 'changed' | null = null
      let del = false
      for (let ln = start; ln < end; ln++) {
        if (diff.changed.has(ln)) kind = 'changed'
        else if (diff.added.has(ln) && kind === null) kind = 'added'
        if (diff.deletedBefore.has(ln)) del = true
      }
      if (kind) kinds.set(block, kind)
      if (del) delBlocks.add(block)
    }

    const innermost = (set: Iterable<HTMLElement>): HTMLElement[] => {
      const all = Array.from(set)
      return all.filter((b) => !all.some((o) => o !== b && b.contains(o)))
    }
    for (const block of innermost(kinds.keys())) {
      block.classList.add(kinds.get(block) === 'changed' ? 'git-diff-changed' : 'git-diff-added')
      block.setAttribute('data-git-mark', '')
    }
    for (const block of innermost(delBlocks)) {
      block.classList.add('git-diff-del-before')
      block.setAttribute('data-git-mark', '')
    }
    if (diff.deletedAtEnd && blocks.length > 0) {
      const last = blocks.reduce((a, b) =>
        Number(b.getAttribute('data-src-end')) >= Number(a.getAttribute('data-src-end')) ? b : a,
      )
      last.classList.add('git-diff-del-end')
      last.setAttribute('data-git-mark', '')
    }
  }, [html, gitDiffResult, gitDiff, csvText, articleGen])

  // After rendering: wrap wide tables, mark external anchors, and — when we know the
  // file's on-disk location — resolve relative image refs by reading them via IPC.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const created: string[] = []
    let cancelled = false
    const api = window.mdexp

    for (const img of Array.from(el.querySelectorAll('img'))) {
      const raw = img.getAttribute('src') ?? ''
      if (!raw || isExternalUrl(raw)) continue
      // Without the source's absolute path (or the IPC bridge) we can't locate the image.
      if (!absFilePath || !api?.readBinaryFileByPath) {
        img.setAttribute('alt', `（相対パスを解決できません：${raw}）`)
        continue
      }
      const targetAbs = resolveAbsoluteRelative(absFilePath, raw)
      ;(async () => {
        try {
          const buf = await api.readBinaryFileByPath(targetAbs)
          if (cancelled) return
          const blob = new Blob([buf], { type: guessMimeFromPath(targetAbs) })
          const url = URL.createObjectURL(blob)
          created.push(url)
          img.setAttribute('src', url)
        } catch {
          if (cancelled) return
          img.setAttribute('alt', `（画像が見つかりません：${raw}）`)
        }
      })()
    }

    for (const table of Array.from(el.querySelectorAll('table'))) {
      if (table.parentElement?.classList.contains('table-wrap')) continue
      if (table.classList.contains('frontmatter-table')) continue
      const wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      table.replaceWith(wrap)
      wrap.appendChild(table)
    }
    for (const a of Array.from(el.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? ''
      if (isExternalUrl(href)) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
      }
    }

    return () => {
      cancelled = true
      created.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [html, absFilePath, articleGen])

  // Render fenced ```mermaid blocks. flowchart/graph diagrams go to the interactive
  // React-Flow renderer; everything else falls back to mermaid's own SVG output.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let cancelled = false
    const flowRoots = flowRootsRef.current

    for (const code of Array.from(el.querySelectorAll<HTMLElement>('code.language-mermaid'))) {
      const pre = code.parentElement
      if (!pre || pre.tagName !== 'PRE') continue
      const host = document.createElement('div')
      host.dataset.mermaidSrc = code.textContent ?? ''
      host.dataset.mermaidStatus = 'pending'
      pre.replaceWith(host)
    }

    for (const host of Array.from(
      el.querySelectorAll<HTMLElement>(
        'div[data-mermaid-status="pending"], div[data-mermaid-status="rendering"]',
      ),
    )) {
      if (host.childElementCount > 0) continue
      const source = host.dataset.mermaidSrc ?? ''
      host.dataset.mermaidStatus = 'rendering'

      if (isFlowchart(source)) {
        host.className = 'mermaid-flow-host'
        if (!flowRoots.has(host)) {
          const root = createRoot(host)
          flowRoots.set(host, root)
          root.render(<MermaidFlow source={source} />)
        }
        continue
      }

      void (async (h: HTMLElement, src: string) => {
        try {
          const svg = await renderMermaid(src)
          if (cancelled) {
            if (h.dataset.mermaidStatus === 'rendering') h.dataset.mermaidStatus = 'pending'
            return
          }
          h.className = 'mermaid'
          h.innerHTML = svg
          h.dataset.mermaidStatus = 'done'
        } catch (err) {
          if (cancelled) {
            if (h.dataset.mermaidStatus === 'rendering') h.dataset.mermaidStatus = 'pending'
            return
          }
          h.className = 'mermaid-error'
          h.textContent = `Mermaid: ${err instanceof Error ? err.message : String(err)}`
          h.dataset.mermaidStatus = 'done'
        }
      })(host, source)
    }

    return () => {
      cancelled = true
      for (const [host, root] of flowRoots) {
        if (host.isConnected) continue
        flowRoots.delete(host)
        queueMicrotask(() => {
          try {
            root.unmount()
          } catch {
            /* root may already be detached if the document was replaced */
          }
        })
      }
      for (const host of Array.from(
        el.querySelectorAll<HTMLElement>('div[data-mermaid-status="rendering"]'),
      )) {
        host.dataset.mermaidStatus = 'pending'
      }
    }
  }, [html, articleGen])

  // Intercept clicks on links inside the md and turn them into in-viewer navigation.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!href || isExternalUrl(href)) return
      if (href.startsWith('#')) {
        e.preventDefault()
        const id = decodeURIComponent(href.slice(1))
        el.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth' })
        return
      }
      if (absFilePath && isMarkdownLink(href) && onOpenExternalPath) {
        // No per-tab history, so a relative .md link opens a sibling tab.
        e.preventDefault()
        onOpenExternalPath(resolveAbsoluteRelative(absFilePath, href))
        return
      }
      // Non-.md local references, or files without a known abs path — block.
      e.preventDefault()
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [html, absFilePath, onOpenExternalPath, articleGen])

  // Scroll back to the top whenever the *file* changes. Excludes `html` so a reload
  // (same file, fresh bytes) keeps the user's scroll position.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [name])

  // Track the path bar's height so the sticky-heading breadcrumb pins flush beneath it.
  useEffect(() => {
    const el = docPathRef.current
    if (!el) return
    const measure = () => setHeaderH(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [name])

  // Sticky heading: as the user scrolls, pin the section's heading to the top bar.
  useEffect(() => {
    const scroller = scrollRef.current
    const article = containerRef.current
    if (!stickyHeadings || !scroller || !article || csvText !== null) {
      setActive(null)
      return
    }
    const levelOf = (h: HTMLElement) => Number(h.tagName[1])

    let headings: HTMLElement[] = []
    let tops: number[] = []
    const measure = () => {
      headings = Array.from(article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
      const base = article.getBoundingClientRect().top
      tops = headings.map((h) => h.getBoundingClientRect().top - base)
    }

    let raf = 0
    let lastKey = ''
    const compute = () => {
      raf = 0
      const y = scroller.scrollTop
      const lead = Math.max(4, scroller.clientHeight * 0.12)
      let activeEl: HTMLElement | null = null
      for (let i = 0; i < headings.length; i++) {
        if (tops[i] <= y + lead) activeEl = headings[i]
        else break
      }
      const key = activeEl ? activeEl.id || activeEl.textContent || '' : ''
      if (key === lastKey) return
      lastKey = key
      setActive(
        activeEl
          ? { id: activeEl.id, text: activeEl.textContent ?? '', level: levelOf(activeEl) }
          : null,
      )
    }
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(compute)
    }
    const onResize = () => {
      measure()
      onScroll()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(article)
    measure()
    compute()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [html, csvText, stickyHeadings, headerH, articleGen])

  // Jump to the pinned heading, landing it just below the sticky bar.
  const scrollToHeading = (id: string) => {
    const scroller = scrollRef.current
    const article = containerRef.current
    if (!scroller || !article || !id) return
    const target = article.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
    if (!target) return
    const top =
      scroller.scrollTop +
      (target.getBoundingClientRect().top - scroller.getBoundingClientRect().top) -
      headerH
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }

  // ⌘/Ctrl+F opens the in-document find bar (or re-focuses it when already open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key !== 'f' && e.key !== 'F') return
      e.preventDefault()
      setFindOpen(true)
      setFindFocusSignal((n) => n + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!source) {
    return (
      <div className="preview empty">
        <p>ファイルをドロップすると、ここに表示されます。</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="preview error">
        <p>このファイルを読み込めませんでした</p>
        <pre>{error}</pre>
      </div>
    )
  }
  const isMarkdownSourceView = isMarkdownPath(source.name)
  // CSV of the sheet the grid is currently showing (null unless viewing a workbook).
  const activeSheetCsv = xlsxSheets ? (xlsxSheets[activeSheet]?.csv ?? '') : null
  // Any grid view (CSV or a workbook sheet) fills the pane and drives grid-mode find.
  const gridText = csvText ?? activeSheetCsv
  const baseKey = csvStorageKey(absFilePath, source.name)
  return (
    <div className="preview-wrap">
      <div className={`preview${gridText !== null ? ' preview--csv' : ''}`} ref={scrollRef}>
        <div className="doc-path" ref={docPathRef}>
          <div className="nav-buttons" role="group" aria-label="ナビゲーション">
            {onReload && (
              <button
                className="nav-btn reload-btn"
                onClick={() => onReload()}
                disabled={!absFilePath}
                title={
                  !absFilePath
                    ? 'このタブはパスが不明なので再読込できません'
                    : 'ディスクから読み直す (⌘+R)'
                }
                aria-label="再読込"
              >
                <svg
                  className="nav-btn-svg"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                </svg>
              </button>
            )}
          </div>
          <span className="path-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z" />
            </svg>
          </span>
          <span className="path-text">{source.name}</span>
          <div className="doc-actions">
            {onOpenFiles && (
              <button
                className="nav-btn open-files-btn"
                onClick={() => onOpenFiles()}
                title="ファイルを開く"
                aria-label="ファイルを開く"
              >
                <svg
                  className="nav-btn-svg"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
                </svg>
              </button>
            )}
            <button
              className={`nav-btn${findOpen ? ' active' : ''}`}
              onClick={() => {
                setFindOpen(true)
                setFindFocusSignal((n) => n + 1)
              }}
              title="ページ内を検索 (⌘F)"
              aria-label="ページ内を検索"
            >
              <svg
                className="nav-btn-svg"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="currentColor"
                aria-hidden
              >
                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
            </button>
            {onToggleGitDiff && isMarkdownSourceView && absFilePath && (
              <button
                className={`nav-btn git-diff-btn${gitDiff ? ' active' : ''}`}
                onClick={() => onToggleGitDiff()}
                title={
                  gitDiff
                    ? 'git 差分の表示をやめる'
                    : 'git 差分を本文に表示（緑=追加 / 黄=変更 / 赤=削除）'
                }
                aria-pressed={gitDiff}
                aria-label="git 差分の表示を切り替え"
              >
                <svg
                  className="nav-btn-svg"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm12.5 8.5h-2v2h-1v-2h-2v-1h2v-2h1v2h2v1zm0-6h-5v-1h5v1z" />
                </svg>
              </button>
            )}
            {onPresent && isMarkdownSourceView && (
              <button
                className="nav-btn present-btn"
                onClick={() => onPresent()}
                title="プレゼン: 見出しごとにスライド表示 (⌘P)"
                aria-label="プレゼンを開始"
              >
                <svg
                  className="nav-btn-svg"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M10 8v8l5-4-5-4zm9-5H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z" />
                </svg>
              </button>
            )}
            {onToggleFocus && (
              <button
                className={`nav-btn focus-btn${focusMode ? ' active' : ''}`}
                onClick={() => onToggleFocus()}
                title={focusMode ? '集中モードを解除 (Esc)' : '集中モード: このウィンドウだけ全画面'}
                aria-pressed={focusMode}
                aria-label={focusMode ? '集中モードを解除' : '集中モード'}
              >
                <svg
                  className="nav-btn-svg"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="currentColor"
                  aria-hidden
                >
                  {focusMode ? (
                    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                  ) : (
                    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                  )}
                </svg>
              </button>
            )}
          </div>
        </div>
        {csvText !== null ? (
          <CsvTable ref={csvSearchRef} source={csvText} storageKey={baseKey} />
        ) : xlsxSheets !== null ? (
          <div className="xlsx-view">
            {xlsxSheets.length > 1 && (
              <div className="sheet-tabs" role="tablist" aria-label="シート">
                {xlsxSheets.map((sheet, i) => (
                  <button
                    key={`${sheet.name}-${i}`}
                    role="tab"
                    aria-selected={i === activeSheet}
                    className={`sheet-tab${i === activeSheet ? ' active' : ''}`}
                    onClick={() => setActiveSheet(i)}
                    title={sheet.name}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            )}
            {xlsxSheets.length === 0 ? (
              <div className="csv-empty">シートがありません。</div>
            ) : (
              <CsvTable
                key={activeSheet}
                ref={csvSearchRef}
                source={activeSheetCsv ?? ''}
                storageKey={
                  baseKey ? `${baseKey}::${xlsxSheets[activeSheet]?.name ?? activeSheet}` : baseKey
                }
              />
            )}
          </div>
        ) : (
          <article
            ref={attachArticle}
            className="markdown-body"
            dangerouslySetInnerHTML={htmlObj}
          />
        )}
      </div>
      {findOpen && (
        <FindBar
          scrollerRef={scrollRef}
          html={html}
          csvText={gridText}
          csvSearchRef={csvSearchRef}
          topOffset={headerH}
          focusSignal={findFocusSignal}
          onClose={() => setFindOpen(false)}
        />
      )}
      {stickyHeadings && active && (
        <div className="sticky-heading" style={{ top: headerH }}>
          <button
            type="button"
            className="crumb"
            onClick={() => scrollToHeading(active.id)}
            title={`${active.text} へ移動`}
            aria-label={`現在地: ${active.text}`}
            disabled={!active.id}
          >
            <span key={active.id || active.text} className="crumb-text">
              {active.text}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Build the localStorage key for a CSV's per-row check state. Prefers the file's
 * absolute OS path, falling back to its basename. Returns null when neither exists —
 * the table then keeps state in memory only.
 */
function csvStorageKey(absolutePath: string | null, name: string): string | null {
  if (absolutePath) return `abs:${absolutePath}`
  if (name) return `name:${name}`
  return null
}
