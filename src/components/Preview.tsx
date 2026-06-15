import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderAsCodeBlock, renderMarkdown } from '../lib/markdown'
import { readBlobUrl, readTextFile } from '../lib/fsAccess'
import { getExtension, isMarkdownPath } from '../lib/extensions'
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

export type PreviewSource =
  | { kind: 'in-root'; path: string; files: Map<string, FileSystemFileHandle> }
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
   * Absolute OS path of the active root (in-root tabs only). Required for the
   * Git Time Machine; when null, the time bar still opens but prompts the user
   * to link the root via `onLinkRoot`.
   */
  rootAbsPath?: string | null
  /** Display name of the active root; shown in the time-bar's link prompt. */
  rootName?: string | null
  /** Opens the native directory picker and persists the chosen abs path. */
  onLinkRoot?: () => Promise<string | null>
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
  rootAbsPath = null,
  rootName = null,
  onLinkRoot,
  onOpenExternalPath,
  onReload,
  reloadCounter = 0,
}: Props) {
  const [html, setHtml] = useState('')
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

  // ─── Time Machine state ───
  // `timeOpen` toggles the history bar in the header. `cursorSha` selects which
  // revision drives the rendered content — null means "working tree" (current FS).
  // History is loaded lazily on first open of the bar for each file.
  const [timeOpen, setTimeOpen] = useState(false)
  const [commits, setCommits] = useState<MdexpGitCommit[] | null>(null)
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [cursorSha, setCursorSha] = useState<string | null>(null)

  /**
   * Absolute path of the active in-root file. Built by joining the saved root
   * abs path with the FSA-relative path. Null whenever either side is missing
   * (external tabs, or root not yet linked).
   */
  const absoluteFilePath =
    kind === 'in-root' && path && rootAbsPath
      ? `${rootAbsPath.replace(/\/+$/, '')}/${path}`
      : null

  /** Reset the time-machine cursor and cached history whenever the file changes. */
  useEffect(() => {
    setCursorSha(null)
    setCommits(null)
    setHistoryStatus('idle')
    setHistoryError(null)
  }, [kind, path, externalName])

  /** External tabs and absent paths can't be time-traveled — fold the bar shut. */
  useEffect(() => {
    if (kind !== 'in-root') setTimeOpen(false)
  }, [kind])

  /** Fetch `git log --follow` once the bar is opened against a linked root. */
  useEffect(() => {
    if (!timeOpen || !absoluteFilePath) return
    const api = window.mdexp
    if (!api?.gitHistory) return
    let cancelled = false
    setHistoryStatus('loading')
    setHistoryError(null)
    ;(async () => {
      try {
        const list = await api.gitHistory(absoluteFilePath)
        if (cancelled) return
        setCommits(list)
        setHistoryStatus('idle')
      } catch (e) {
        if (cancelled) return
        setHistoryError(e instanceof Error ? e.message : String(e))
        setHistoryStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [timeOpen, absoluteFilePath])

  // When the selected source changes, load and render it.
  // Markdown files go through the full markdown-it pipeline; everything else is rendered as a
  // single syntax-highlighted code block keyed off its extension (yaml/json/...).
  // When `cursorSha` is set, the in-root branch routes through `git show <sha>:<file>`
  // instead of the working-tree read so the user sees that revision's content.
  useEffect(() => {
    if (!kind) {
      setHtml('')
      setError(null)
      return
    }
    if (kind === 'external') {
      setError(null)
      const name = externalName ?? ''
      if (isMarkdownPath(name)) {
        setHtml(renderMarkdown(externalContent ?? ''))
      } else {
        const ext = getExtension(name) ?? ''
        setHtml(renderAsCodeBlock(externalContent ?? '', ext))
      }
      return
    }
    if (!path || !files) return
    let cancelled = false
    ;(async () => {
      try {
        let src: string
        if (cursorSha && absoluteFilePath && window.mdexp?.gitShow) {
          src = await window.mdexp.gitShow(absoluteFilePath, cursorSha)
        } else {
          src = await readTextFile(files, path)
        }
        if (cancelled) return
        setError(null)
        if (isMarkdownPath(path)) {
          setHtml(renderMarkdown(src))
        } else {
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
  }, [kind, path, files, externalName, externalContent, cursorSha, absoluteFilePath, reloadCounter])

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
    for (const table of Array.from(el.querySelectorAll('table'))) {
      if (table.parentElement?.classList.contains('table-wrap')) continue // avoid double-wrapping
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
    /** Roots mounted into the current `html` render so we can unmount on the next pass. */
    const mountedRoots: Root[] = []
    const blocks = el.querySelectorAll<HTMLElement>('code.language-mermaid')
    for (const code of Array.from(blocks)) {
      const pre = code.parentElement
      if (!pre || pre.tagName !== 'PRE') continue
      if (pre.dataset.mermaid === 'done') continue
      pre.dataset.mermaid = 'done'
      const source = code.textContent ?? ''

      if (isFlowchart(source)) {
        const host = document.createElement('div')
        host.className = 'mermaid-flow-host'
        pre.replaceWith(host)
        const root = createRoot(host)
        mountedRoots.push(root)
        root.render(<MermaidFlow source={source} />)
        continue
      }

      ;(async () => {
        try {
          const svg = await renderMermaid(source)
          if (cancelled) return
          const wrap = document.createElement('div')
          wrap.className = 'mermaid'
          wrap.innerHTML = svg
          pre.replaceWith(wrap)
        } catch (err) {
          if (cancelled) return
          const box = document.createElement('div')
          box.className = 'mermaid-error'
          box.textContent = `Mermaid: ${err instanceof Error ? err.message : String(err)}`
          pre.replaceWith(box)
        }
      })()
    }
    return () => {
      cancelled = true
      // Tear down React roots before the host nodes get clobbered by the next innerHTML
      // assignment; otherwise React warns about unmounted components on stale DOM.
      for (const root of mountedRoots) {
        try {
          root.unmount()
        } catch {
          /* root may already be detached if the document was replaced */
        }
      }
    }
  }, [html])

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
    source.kind === 'in-root' ? source.path : `📥 ${source.name}（外部ファイル）`
  const activeCommit =
    cursorSha && commits ? commits.find((c) => c.sha === cursorSha) ?? null : null
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
                ↻
              </button>
            )}
          </div>
          <span className="path-text">{headerText}</span>
          {kind === 'in-root' && (
            <button
              className={`nav-btn time-btn${timeOpen ? ' active' : ''}`}
              onClick={() => setTimeOpen((o) => !o)}
              title="タイムマシン: 過去のバージョンを覗く"
              aria-pressed={timeOpen}
              aria-label="タイムマシン"
            >
              🕰
            </button>
          )}
          {activeCommit && (
            <span className="time-badge" title={activeCommit.subject}>
              {formatDateShort(activeCommit.dateISO)} · {activeCommit.shortSha}
            </span>
          )}
        </div>
        {timeOpen && kind === 'in-root' && (
          <TimeMachineBar
            rootAbsPath={rootAbsPath}
            rootName={rootName}
            absoluteFilePath={absoluteFilePath}
            historyStatus={historyStatus}
            historyError={historyError}
            commits={commits}
            cursorSha={cursorSha}
            onCursor={setCursorSha}
            onLinkRoot={onLinkRoot}
          />
        )}
        <article
          ref={containerRef}
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
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
 * Compact date for inline badges (e.g. "2024/03/14"). Falls back to the raw
 * ISO string if parsing fails — better to show something than nothing.
 */
function formatDateShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}/${m}/${day}`
}

interface TimeMachineBarProps {
  rootAbsPath: string | null
  rootName: string | null
  absoluteFilePath: string | null
  historyStatus: 'idle' | 'loading' | 'error'
  historyError: string | null
  commits: MdexpGitCommit[] | null
  cursorSha: string | null
  onCursor: (sha: string | null) => void
  onLinkRoot?: () => Promise<string | null>
}

/**
 * Slider that walks the active file through its git history. The rightmost
 * stop is always "現在" (working tree); slots to the left are commits, newest
 * first. Selecting "現在" clears the cursor so the FSA-backed read path takes
 * over again.
 *
 * Three degenerate states get inline messages rather than a slider:
 *   • the root isn't linked yet           → prompt the user to link it
 *   • git history is being fetched        → status spinner
 *   • the file isn't tracked / git failed → friendly explanation
 */
function TimeMachineBar({
  rootAbsPath,
  rootName,
  absoluteFilePath,
  historyStatus,
  historyError,
  commits,
  cursorSha,
  onCursor,
  onLinkRoot,
}: TimeMachineBarProps) {
  // Unlinked root → prompt.
  if (!rootAbsPath || !absoluteFilePath) {
    return (
      <div className="time-bar time-bar-prompt">
        <span className="time-bar-msg">
          {rootName ? <>「{rootName}」</> : 'このフォルダ'}
          の場所を教えてくれたら、過去の自分を、呼び戻せる、よ。
        </span>
        <button className="primary time-link-btn" onClick={() => onLinkRoot?.()}>
          フォルダを指す
        </button>
      </div>
    )
  }
  if (historyStatus === 'error') {
    return (
      <div className="time-bar time-bar-prompt time-bar-error">
        <span className="time-bar-msg">
          履歴を、たどれません。{historyError ? <> — {historyError}</> : null}
        </span>
      </div>
    )
  }
  // `commits === null` covers both the initial render before the load effect runs
  // and the in-flight loading window — treat both as "spinner-ish".
  if (commits === null || historyStatus === 'loading') {
    return (
      <div className="time-bar time-bar-prompt">
        <span className="time-bar-msg">過去を、たぐっています…</span>
      </div>
    )
  }
  if (commits.length === 0) {
    return (
      <div className="time-bar time-bar-prompt">
        <span className="time-bar-msg">
          このファイルには、まだ……コミットの足跡が、ない、みたい。
        </span>
      </div>
    )
  }

  // Slot mapping: 0..commits.length-1 → oldest..newest commit, commits.length → working tree.
  // The slider runs left-to-right as time forward, so the highest value is "現在".
  const max = commits.length
  const currentSlot = cursorSha
    ? commits.findIndex((c) => c.sha === cursorSha)
    : max
  const slotValue = currentSlot < 0 ? max : currentSlot
  const isLatest = slotValue === max
  const activeCommit = isLatest ? null : commits[slotValue]

  const onSlide = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    if (!Number.isFinite(v)) return
    if (v >= max) {
      onCursor(null)
      return
    }
    const c = commits[v]
    if (c) onCursor(c.sha)
  }

  const oldest = commits[0]
  const newest = commits[commits.length - 1]
  return (
    <div className="time-bar">
      <button
        className="time-step-btn"
        onClick={() => {
          if (slotValue > 0) {
            const c = commits[slotValue - 1]
            if (c) onCursor(c.sha)
          }
        }}
        disabled={slotValue <= 0}
        title="一つ古い版へ"
        aria-label="一つ古い版"
      >
        ‹
      </button>
      <input
        className="time-slider"
        type="range"
        min={0}
        max={max}
        step={1}
        value={slotValue}
        onChange={onSlide}
        aria-label="バージョン"
      />
      <button
        className="time-step-btn"
        onClick={() => {
          if (slotValue < max) {
            const next = slotValue + 1
            if (next >= max) onCursor(null)
            else {
              const c = commits[next]
              if (c) onCursor(c.sha)
            }
          }
        }}
        disabled={slotValue >= max}
        title="一つ新しい版へ"
        aria-label="一つ新しい版"
      >
        ›
      </button>
      <div className="time-label">
        {isLatest ? (
          <span className="time-label-now">現在（作業ツリー）</span>
        ) : activeCommit ? (
          <span className="time-label-commit" title={activeCommit.subject}>
            <strong>{formatDateShort(activeCommit.dateISO)}</strong>
            <span className="time-sha">{activeCommit.shortSha}</span>
            <span className="time-subject">{activeCommit.subject}</span>
          </span>
        ) : null}
      </div>
      {!isLatest && (
        <button
          className="time-now-btn"
          onClick={() => onCursor(null)}
          title="現在に戻る"
        >
          ⤴ 現在
        </button>
      )}
      <div className="time-range" aria-hidden>
        <span>{formatDateShort(oldest.dateISO)}</span>
        <span>{formatDateShort(newest.dateISO)}</span>
      </div>
    </div>
  )
}
