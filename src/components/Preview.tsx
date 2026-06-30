import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderAsCodeBlock, renderMarkdown } from '../lib/markdown'
import { readBlobUrl, readTextFile } from '../lib/fsAccess'
import { getExtension, isCsvPath, isMarkdownPath } from '../lib/extensions'
import { CsvTable } from './CsvTable'
import {
  guessMimeFromPath,
  isExternalUrl,
  isMarkdownLink,
  resolveAbsoluteRelative,
  resolveRelative,
} from '../lib/paths'
import { renderMermaid } from '../lib/mermaid'
import { isFlowchart } from '../lib/mermaidFlow'
import { MermaidFlow } from './MermaidFlow'
import type { FileEntry } from '../types'

export type PreviewSource =
  | { kind: 'in-root'; path: string; files: Map<string, FileEntry> }
  | {
      kind: 'external'
      name: string
      content: string
      /** Absolute OS path of the source file, when known. Enables relative path resolution. */
      absolutePath?: string
    }

interface Props {
  source: PreviewSource | null
  /** On clicking a md link in an in-root tab: navigate to another .md within the same tab. */
  onNavigate: (path: string) => void
  onBack: () => void
  onForward: () => void
  canBack: boolean
  canForward: boolean
  /**
   * Open an absolute filesystem path as a new external tab. Called when the user
   * clicks a relative .md link inside an externally-opened file — we don't have a
   * tab-local history for external tabs, so navigation spawns a new tab instead.
   */
  onOpenExternalPath?: (absolutePath: string) => void
  /**
   * Ask the host to re-read the active source from disk. Wired to the ↻ button
   * and to the ⌘+R / window-focus reload paths upstream. The component itself
   * doesn't decide *how* the reload happens — for in-root sources, the host bumps
   * `reloadCounter`; for external sources, it patches the tab content in place.
   */
  onReload?: () => void
  /**
   * Monotonic counter the host bumps to force a fresh `getFile()` read of the
   * current in-root path. External sources don't use it (their content prop
   * already changes when the host re-reads on their behalf).
   */
  reloadCounter?: number
  /** Whether the host is currently in focus (full-pane) mode. */
  focusMode?: boolean
  /** Toggle the host's focus mode. */
  onToggleFocus?: () => void
  /** Enter presentation mode for the active markdown source (shown for .md only). */
  onPresent?: () => void
}

interface Gesture {
  dir: 'back' | 'forward'
  /** 0 → just starting, 1 → about to fire (or just fired) */
  progress: number
}

export function Preview({
  source,
  onNavigate,
  onBack,
  onForward,
  canBack,
  canForward,
  onOpenExternalPath,
  onReload,
  reloadCounter = 0,
  focusMode = false,
  onToggleFocus,
  onPresent,
}: Props) {
  const [html, setHtml] = useState('')
  /**
   * Raw text of the active source when it's a CSV. The viewer renders <CsvTable>
   * instead of the markdown HTML pipeline; `html` is left empty in that branch.
   */
  const [csvText, setCsvText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const swipeRef = useRef<HTMLDivElement>(null)

  // Split the source into primitive deps so effects only re-fire when content actually changes.
  const kind = source?.kind ?? null
  const path = source?.kind === 'in-root' ? source.path : null
  const files = source?.kind === 'in-root' ? source.files : null
  const externalName = source?.kind === 'external' ? source.name : null
  const externalContent = source?.kind === 'external' ? source.content : null
  const externalAbsPath = source?.kind === 'external' ? source.absolutePath ?? null : null

  // [debug] re-attach MutationObserver every render so we always watch the LIVE
  // article element (in case React replaces it). Also polls host count to detect
  // disappearance even if observer misses it.
  const lastArticleRef = useRef<HTMLElement | null>(null)
  const obsRef = useRef<MutationObserver | null>(null)
  useEffect(() => {
    const el = containerRef.current
    if (el !== lastArticleRef.current) {
      // eslint-disable-next-line no-console
      console.log('[mermaid-debug] ARTICLE IDENTITY CHANGED', {
        wasNull: lastArticleRef.current === null,
        now: el ? 'present' : 'null',
        time: new Date().toISOString(),
      })
      lastArticleRef.current = el
      obsRef.current?.disconnect()
      obsRef.current = null
    }
    if (!el || obsRef.current) return
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of Array.from(m.removedNodes)) {
          if (!(node instanceof HTMLElement)) continue
          const isHost =
            (node.dataset && node.dataset.mermaidStatus !== undefined) ||
            node.classList?.contains('mermaid') ||
            node.classList?.contains('mermaid-flow-host') ||
            node.classList?.contains('mermaid-error')
          if (isHost) {
            // eslint-disable-next-line no-console
            console.log('[mermaid-debug] HOST REMOVED', {
              className: node.className,
              status: node.dataset?.mermaidStatus,
              parent: m.target instanceof HTMLElement ? m.target.tagName + '.' + m.target.className : String(m.target),
              hadChildren: node.childElementCount,
              time: new Date().toISOString(),
            })
            // eslint-disable-next-line no-console
            console.trace('[mermaid-debug] removed by')
          }
        }
        // Also log when many nodes vanish at once (whole-innerHTML replacement)
        if (m.removedNodes.length > 3) {
          // eslint-disable-next-line no-console
          console.log('[mermaid-debug] BULK REMOVAL', {
            count: m.removedNodes.length,
            target: m.target instanceof HTMLElement ? m.target.tagName + '.' + m.target.className : String(m.target),
          })
        }
      }
    })
    obs.observe(el, { childList: true, subtree: true })
    obsRef.current = obs
  })

  // [debug] poll host count once per second. Catches disappearances the observer might miss.
  useEffect(() => {
    let prev = -1
    const id = window.setInterval(() => {
      const el = containerRef.current
      if (!el) return
      const hosts = el.querySelectorAll('[data-mermaid-status], .mermaid, .mermaid-flow-host, .mermaid-error').length
      const pres = el.querySelectorAll('code.language-mermaid').length
      if (hosts !== prev) {
        // eslint-disable-next-line no-console
        console.log('[mermaid-debug] poll', { hosts, pres, articleChildren: el.childElementCount, time: new Date().toISOString() })
        prev = hosts
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  // When the selected source changes, load and render it.
  // Markdown files go through the full markdown-it pipeline; everything else is rendered as a
  // single syntax-highlighted code block keyed off its extension (yaml/json/...).
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[mermaid-debug] load effect', { kind, path, externalName, reloadCounter })
    if (!kind) {
      setHtml('')
      setCsvText(null)
      setError(null)
      return
    }
    if (kind === 'external') {
      setError(null)
      const name = externalName ?? ''
      const content = externalContent ?? ''
      if (isCsvPath(name)) {
        setHtml('')
        setCsvText(content)
      } else if (isMarkdownPath(name)) {
        setCsvText(null)
        setHtml(renderMarkdown(content))
      } else {
        setCsvText(null)
        const ext = getExtension(name) ?? ''
        setHtml(renderAsCodeBlock(content, ext))
      }
      return
    }
    if (!path || !files) return
    let cancelled = false
    ;(async () => {
      try {
        const src = await readTextFile(files, path)
        if (cancelled) return
        setError(null)
        if (isCsvPath(path)) {
          setHtml('')
          setCsvText(src)
        } else if (isMarkdownPath(path)) {
          setCsvText(null)
          setHtml(renderMarkdown(src))
        } else {
          setCsvText(null)
          const ext = getExtension(path) ?? ''
          setHtml(renderAsCodeBlock(src, ext))
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [kind, path, files, externalName, externalContent, reloadCounter])

  // After rendering: swap image relative paths for Blob URLs (in-root only).
  useEffect(() => {
    const el = containerRef.current
    if (!el || kind !== 'in-root' || !path || !files) return
    const created: string[] = []
    let cancelled = false

    const imgs = Array.from(el.querySelectorAll('img'))
    for (const img of imgs) {
      const raw = img.getAttribute('src') ?? ''
      if (!raw || isExternalUrl(raw)) continue
      const target = resolveRelative(path, raw)
      ;(async () => {
        const url = await readBlobUrl(files, target)
        if (cancelled) return
        if (url) {
          created.push(url)
          img.setAttribute('src', url)
        } else {
          img.setAttribute('alt', `（画像が見つかりません：${raw}）`)
        }
      })()
    }

    // Wrap wide tables in a frame so each can scroll horizontally on its own.
    // Frontmatter tables (and their nested children) are exempt — they're
    // size-constrained by the value-cell layout, and wrapping them in a scroll
    // box adds awkward margins at the top of the document.
    for (const table of Array.from(el.querySelectorAll('table'))) {
      if (table.parentElement?.classList.contains('table-wrap')) continue // avoid double-wrapping
      if (table.classList.contains('frontmatter-table')) continue
      const wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      table.replaceWith(wrap)
      wrap.appendChild(table)
    }

    // Mark external links to open in a new tab.
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
  }, [html, kind, path, files])

  // For external tabs: wrap tables, mark external anchors, and — when we know the
  // file's on-disk location — resolve relative image refs by reading them via IPC.
  useEffect(() => {
    const el = containerRef.current
    if (!el || kind !== 'external') return
    const created: string[] = []
    let cancelled = false
    const api = window.mdexp

    for (const img of Array.from(el.querySelectorAll('img'))) {
      const raw = img.getAttribute('src') ?? ''
      if (!raw || isExternalUrl(raw)) continue
      // Without the source's absolute path, we can't locate the image at all.
      // Same when we're outside Electron (no IPC bridge).
      if (!externalAbsPath || !api?.readBinaryFileByPath) {
        img.setAttribute('alt', `（外部ファイルでは相対パスを解決できません：${raw}）`)
        continue
      }
      const targetAbs = resolveAbsoluteRelative(externalAbsPath, raw)
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
  }, [html, kind, externalAbsPath])

  // Render fenced ```mermaid blocks. flowchart/graph diagrams are handed to the
  // interactive React-Flow renderer (drag/zoom/pan); everything else falls back
  // to mermaid's own SVG output so we don't have to support the long tail of
  // sequenceDiagram/gantt/stateDiagram layouts ourselves.
  // Markdown.ts deliberately skips highlight.js for `lang === 'mermaid'`, so the source
  // survives inside <code class="language-mermaid">…</code> with HTML entities intact.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let cancelled = false
    // eslint-disable-next-line no-console
    console.log('[mermaid-debug] mermaid effect MOUNT', {
      htmlLen: html.length,
      csvText: csvText !== null,
      hosts: el.querySelectorAll('div[data-mermaid-status]').length,
      pres: el.querySelectorAll('code.language-mermaid').length,
    })
    /** React roots mounted during this run so cleanup can tear them down. */
    const mountedRoots: Root[] = []

    // First pass: synchronously hoist every raw <pre><code class="language-mermaid">
    // into a host <div> that carries the source as a data attribute. Replacing the
    // pre up-front frees the block from the `pre:has(...)` visibility CSS so that
    // a cancelled or failed render can't leave a permanently-invisible <pre>.
    for (const code of Array.from(
      el.querySelectorAll<HTMLElement>('code.language-mermaid'),
    )) {
      const pre = code.parentElement
      if (!pre || pre.tagName !== 'PRE') continue
      const host = document.createElement('div')
      host.dataset.mermaidSrc = code.textContent ?? ''
      host.dataset.mermaidStatus = 'pending'
      pre.replaceWith(host)
    }

    // Second pass: render every host that hasn't reached "done" yet. We pick up
    // both fresh "pending" hosts from the first pass and "rendering" leftovers
    // from a previous effect run whose async bailed mid-flight (StrictMode's
    // mount→unmount→mount, or any cancellation that didn't get a follow-up
    // commit). Done hosts are skipped so we don't redraw an already-painted SVG.
    for (const host of Array.from(
      el.querySelectorAll<HTMLElement>(
        'div[data-mermaid-status="pending"], div[data-mermaid-status="rendering"]',
      ),
    )) {
      // Skip hosts that already have something painted in them. Two cases:
      //   1. Flowchart hosts stay flagged "rendering" forever (React-Flow owns
      //      the canvas), so we'd loop-mount them every effect run otherwise.
      //   2. A static-SVG host whose async landed before the cleanup walked
      //      it back to "pending" — we'd re-render the same diagram on top of
      //      itself, which works but throws away the layout for a beat.
      if (host.childElementCount > 0) continue
      const source = host.dataset.mermaidSrc ?? ''
      host.dataset.mermaidStatus = 'rendering'

      if (isFlowchart(source)) {
        host.className = 'mermaid-flow-host'
        const root = createRoot(host)
        mountedRoots.push(root)
        root.render(<MermaidFlow source={source} />)
        continue
      }

      void (async (h: HTMLElement, src: string) => {
        try {
          const svg = await renderMermaid(src)
          if (cancelled) {
            // Don't clobber whatever's on screen, but flip back to "pending"
            // so the next effect run can retry against this same host.
            if (h.dataset.mermaidStatus === 'rendering') {
              h.dataset.mermaidStatus = 'pending'
            }
            return
          }
          h.className = 'mermaid'
          h.innerHTML = svg
          h.dataset.mermaidStatus = 'done'
        } catch (err) {
          if (cancelled) {
            if (h.dataset.mermaidStatus === 'rendering') {
              h.dataset.mermaidStatus = 'pending'
            }
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
      // eslint-disable-next-line no-console
      console.log('[mermaid-debug] mermaid effect CLEANUP', {
        roots: mountedRoots.length,
        hosts: el.querySelectorAll('div[data-mermaid-status]').length,
      })
      // eslint-disable-next-line no-console
      console.trace('[mermaid-debug] cleanup by')
      // Tear down React roots before the host nodes get clobbered by the next
      // innerHTML assignment; otherwise React warns about unmounted components
      // on stale DOM. Defer the unmount via queueMicrotask: React 19 forbids
      // synchronously unmounting a root from inside a render/commit phase, and
      // useEffect cleanups can fire mid-commit when a parent updates.
      for (const root of mountedRoots) {
        queueMicrotask(() => {
          try {
            root.unmount()
          } catch {
            /* root may already be detached if the document was replaced */
          }
        })
      }
      // Mark in-flight hosts as "pending" so the next effect run picks them up.
      // Deliberately don't clear className / innerHTML here: if the async
      // landed a frame before this cleanup, we'd erase a perfectly good SVG.
      // The retry path in the async (and the second pass above) handle the
      // case where we genuinely need to re-render.
      for (const host of Array.from(
        el.querySelectorAll<HTMLElement>('div[data-mermaid-status="rendering"]'),
      )) {
        host.dataset.mermaidStatus = 'pending'
      }
    }
    // `csvText` is in the dep list so this re-runs when the article element is
    // unmounted (csv view) and later re-mounted (back to markdown). Without it,
    // the second mount inherits the same `html` string and the effect never
    // fires, leaving the fresh DOM's <pre><code class="language-mermaid"> blocks
    // un-hoisted — and `pre:has(...)` CSS hides them.
  }, [html, csvText])

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
      if (kind === 'in-root' && path && isMarkdownLink(href)) {
        e.preventDefault()
        onNavigate(resolveRelative(path, href))
        return
      }
      if (
        kind === 'external' &&
        externalAbsPath &&
        isMarkdownLink(href) &&
        onOpenExternalPath
      ) {
        // External tabs have no per-tab history, so navigation spawns a sibling tab
        // pinned to the resolved absolute path.
        e.preventDefault()
        onOpenExternalPath(resolveAbsoluteRelative(externalAbsPath, href))
        return
      }
      // Non-.md local references, or external tabs without a known abs path — block.
      e.preventDefault()
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [html, kind, path, externalAbsPath, onNavigate, onOpenExternalPath])

  // Scroll back to the top whenever the *file* changes. Deliberately excludes
  // `html` so that a reload (same file, fresh bytes) keeps the user's scroll
  // position — the load effect will repaint markdown in-place without yanking
  // the viewport back to the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [kind, path, externalName])

  // Horizontal trackpad swipe → back / forward. macOS convention: swiping with two
  // fingers to the right (deltaX accumulates negative) goes back; left goes forward.
  // Updates `gesture` so the on-screen indicator follows the swipe in real time.
  useEffect(() => {
    const el = swipeRef.current
    if (!el) return
    const THRESHOLD = 140
    const COOLDOWN_MS = 600
    const GAP_RESET_MS = 160
    let accumX = 0
    let lastEventTime = 0
    let triggeredAt = 0
    let resetTimer: number | null = null

    const onWheel = (e: WheelEvent) => {
      const now = Date.now()
      if (now - triggeredAt < COOLDOWN_MS) return
      if (now - lastEventTime > GAP_RESET_MS) accumX = 0
      lastEventTime = now
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      accumX += e.deltaX

      if (accumX <= -THRESHOLD && canBack) {
        setGesture({ dir: 'back', progress: 1 })
        onBack()
        triggeredAt = now
        accumX = 0
        window.setTimeout(() => setGesture(null), 180)
        return
      }
      if (accumX >= THRESHOLD && canForward) {
        setGesture({ dir: 'forward', progress: 1 })
        onForward()
        triggeredAt = now
        accumX = 0
        window.setTimeout(() => setGesture(null), 180)
        return
      }

      const abs = Math.abs(accumX)
      if (abs < 4) {
        setGesture(null)
      } else {
        const dir: 'back' | 'forward' = accumX < 0 ? 'back' : 'forward'
        const allowed = dir === 'back' ? canBack : canForward
        setGesture(allowed ? { dir, progress: Math.min(1, abs / THRESHOLD) } : null)
      }

      if (resetTimer) window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => {
        accumX = 0
        setGesture(null)
      }, GAP_RESET_MS)
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (resetTimer) window.clearTimeout(resetTimer)
    }
  }, [canBack, canForward, onBack, onForward])

  // Touch swipe (touchscreens): right → back, left → forward, with live progress.
  useEffect(() => {
    const el = swipeRef.current
    if (!el) return
    const THRESHOLD = 90
    let startX = 0
    let startY = 0
    let tracking = false
    let lockedDir: 'h' | 'v' | null = null

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false
        setGesture(null)
        return
      }
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      tracking = true
      lockedDir = null
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      if (lockedDir === null) {
        const ax = Math.abs(dx)
        const ay = Math.abs(dy)
        if (ax > 10 || ay > 10) lockedDir = ax > ay ? 'h' : 'v'
        else return
      }
      if (lockedDir === 'v') return
      const dir: 'back' | 'forward' = dx > 0 ? 'back' : 'forward'
      const allowed = dir === 'back' ? canBack : canForward
      if (!allowed) {
        setGesture(null)
        return
      }
      setGesture({ dir, progress: Math.min(1, Math.abs(dx) / THRESHOLD) })
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return
      const horizontal = lockedDir === 'h'
      tracking = false
      if (!horizontal) {
        setGesture(null)
        return
      }
      const dx = e.changedTouches[0].clientX - startX
      if (Math.abs(dx) >= THRESHOLD) {
        if (dx > 0 && canBack) onBack()
        else if (dx < 0 && canForward) onForward()
      }
      setGesture(null)
    }
    const onTouchCancel = () => {
      tracking = false
      setGesture(null)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [canBack, canForward, onBack, onForward])

  // Clear any leftover indicator when the doc changes (e.g. after navigation fires).
  useEffect(() => {
    setGesture(null)
  }, [kind, path, externalName])

  if (!source) {
    return (
      <div className="preview empty">
        <p>左からファイルを選択してください。ここに表示されます。</p>
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
  const indicatorStyle = gesture
    ? (() => {
        const slide = gesture.dir === 'back' ? (gesture.progress - 1) * 30 : (1 - gesture.progress) * 30
        const scale = 0.6 + gesture.progress * 0.4
        return {
          opacity: 0.25 + gesture.progress * 0.75,
          transform: `translate(${slide}px, -50%) scale(${scale})`,
        }
      })()
    : undefined
  const headerText =
    source.kind === 'in-root' ? source.path : `${source.name}（外部ファイル）`
  // The present button only makes sense for markdown — code/CSV views aren't decks.
  const isMarkdownSource =
    source.kind === 'in-root' ? isMarkdownPath(source.path) : isMarkdownPath(source.name)
  return (
    <div className="preview-wrap" ref={swipeRef}>
      <div className="preview" ref={scrollRef}>
        <div className="doc-path">
          <div className="nav-buttons" role="group" aria-label="ナビゲーション">
            <button
              className="nav-btn"
              onClick={onBack}
              disabled={!canBack}
              title="戻る (⌘+[)"
              aria-label="戻る"
            >
              ‹
            </button>
            <button
              className="nav-btn"
              onClick={onForward}
              disabled={!canForward}
              title="進む (⌘+])"
              aria-label="進む"
            >
              ›
            </button>
            {onReload && (
              <button
                className="nav-btn reload-btn"
                onClick={() => onReload()}
                disabled={
                  kind === 'external' && !externalAbsPath
                }
                title={
                  kind === 'external' && !externalAbsPath
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
          {source.kind === 'external' && (
            <span className="path-icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M19 3H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.11-.89-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H5V5h14v10zm-3-5h-2V7h-4v3H8l4 4 4-4z" />
              </svg>
            </span>
          )}
          <span className="path-text">{headerText}</span>
          <div className="doc-actions">
            {onPresent && isMarkdownSource && (
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
                  {/* Material "slideshow": a play triangle inside a screen frame. */}
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
          <CsvTable
            source={csvText}
            storageKey={csvStorageKey(kind, path, externalAbsPath, externalName)}
          />
        ) : (
          <article
            ref={containerRef}
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
      {gesture && (
        <div
          className={`swipe-indicator swipe-${gesture.dir}${gesture.progress >= 1 ? ' triggered' : ''}`}
          style={indicatorStyle}
          aria-hidden
        >
          {gesture.dir === 'back' ? '‹' : '›'}
        </div>
      )}
    </div>
  )
}

/**
 * Build the localStorage key for a CSV's per-row check state. Prefers the
 * in-root relative path (stable across sessions and survives a root re-pick
 * to the same folder), then the external file's absolute OS path, and finally
 * the external file's basename as a last-ditch fallback. Returns null when
 * none of those identifiers exist — the table then keeps state in memory only.
 */
function csvStorageKey(
  kind: 'in-root' | 'external' | null,
  path: string | null,
  externalAbsPath: string | null,
  externalName: string | null,
): string | null {
  if (kind === 'in-root' && path) return `in-root:${path}`
  if (kind === 'external' && externalAbsPath) return `abs:${externalAbsPath}`
  if (kind === 'external' && externalName) return `name:${externalName}`
  return null
}

