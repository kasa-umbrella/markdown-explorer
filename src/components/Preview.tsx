import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderAsCodeBlock, renderMarkdown } from '../lib/markdown'
import { extractFrontmatter } from '../lib/frontmatter'
import { diffLines, type LineDiff } from '../lib/lineDiff'
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
import { useRawHtml } from '../lib/rawHtml'
import { MermaidFlow } from './MermaidFlow'
import { FindBar } from './FindBar'
import type { FileEntry } from '../types'

export type PreviewSource =
  | {
      kind: 'in-root'
      path: string
      files: Map<string, FileEntry>
      /** Absolute OS path of the active root, when known (Electron). Enables git-diff lookup. */
      rootAbsPath?: string | null
    }
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
  /**
   * Pin the current section's heading(s) to the top of the pane as a breadcrumb while
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
  const [error, setError] = useState<string | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
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
  const swipeRef = useRef<HTMLDivElement>(null)
  const docPathRef = useRef<HTMLDivElement>(null)
  /**
   * Bumped every time a fresh <article> element attaches. The article can be torn
   * down and re-created without `html` changing — error round-trips, the csv⇄md
   * flip — and a fresh element starts from the raw markdown-it HTML, with none of
   * the imperative decorations (mermaid hosts, git marks, table wraps, blob images,
   * click handler). Every effect that paints into or listens on the article keys on
   * this so a remount re-applies its work; `html` alone can't signal that.
   */
  const [articleGen, setArticleGen] = useState(0)
  const attachArticle = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el
    if (el) setArticleGen((g) => g + 1)
  }, [])
  // Stable {__html} identity — see useRawHtml. Without it, React 19 re-sets the
  // article's innerHTML on EVERY re-render (scroll crumb, git-diff arrival, sidebar
  // drag, window focus...), silently erasing everything the effects below painted.
  const htmlObj = useRawHtml(html)
  // React roots mounted into flowchart hosts, keyed by their host <div>. Persisted
  // across effect runs (NOT a per-run local) so StrictMode's mount→unmount→mount in
  // dev doesn't createRoot twice on the same host, then tear the survivor down. A
  // root lives exactly as long as its host stays in the document; see the mermaid
  // effect's cleanup.
  const flowRootsRef = useRef<Map<HTMLElement, Root>>(new Map())

  // Split the source into primitive deps so effects only re-fire when content actually changes.
  const kind = source?.kind ?? null
  const path = source?.kind === 'in-root' ? source.path : null
  const files = source?.kind === 'in-root' ? source.files : null
  const externalName = source?.kind === 'external' ? source.name : null
  const externalContent = source?.kind === 'external' ? source.content : null
  const externalAbsPath = source?.kind === 'external' ? source.absolutePath ?? null : null
  const rootAbsPath = source?.kind === 'in-root' ? source.rootAbsPath ?? null : null

  // Whether the active source is markdown (drives both the diff pipeline and the
  // present / diff toolbar buttons), and its absolute on-disk path when we know it —
  // the key the git-file-diff IPC needs to locate the file inside its repo.
  const markdownSource =
    kind === 'in-root'
      ? !!path && isMarkdownPath(path)
      : !!externalName && isMarkdownPath(externalName)
  const absFilePath =
    kind === 'in-root'
      ? rootAbsPath && path
        ? `${rootAbsPath}/${path}`
        : null
      : externalAbsPath

  // When the selected source changes, load and render it.
  // Markdown files go through the full markdown-it pipeline; everything else is rendered as a
  // single syntax-highlighted code block keyed off its extension (yaml/json/...).
  useEffect(() => {
    if (!kind) {
      setHtml('')
      setCsvText(null)
      setSrcText(null)
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
        setSrcText(null)
      } else if (isMarkdownPath(name)) {
        setCsvText(null)
        setSrcText(content)
        setHtml(renderMarkdown(content))
      } else {
        setCsvText(null)
        setSrcText(null)
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
          setSrcText(null)
        } else if (isMarkdownPath(path)) {
          setCsvText(null)
          setSrcText(src)
          setHtml(renderMarkdown(src))
        } else {
          setCsvText(null)
          setSrcText(null)
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

  // Pull the HEAD revision of the current markdown file and diff it against the
  // in-memory source, producing the per-line change map the decorator paints. Runs
  // only for markdown with a known on-disk path (Electron); clears otherwise. The
  // diff is computed on the frontmatter-stripped body so the resulting NEW-side line
  // numbers line up with markdown-it's `data-src-line` (which is body-relative).
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
          // Not inside a git repo → nothing to mark.
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
  // its range overlaps a changed line. When a change is nested (e.g. one list item), we
  // keep only the innermost marked block so the whole list doesn't light up. Deletions,
  // which have no surviving block, get a thin marker on the block the gap sits before.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const MARK_CLASSES = [
      'git-diff-added',
      'git-diff-changed',
      'git-diff-del-before',
      'git-diff-del-end',
    ]
    // Clear any markers from a previous run before (maybe) repainting.
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

    // Keep only innermost matches so nested blocks don't stack bars on their parents.
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
    // A deletion trailing the last line has no "before" anchor — flag the final block.
    if (diff.deletedAtEnd && blocks.length > 0) {
      const last = blocks.reduce((a, b) =>
        Number(b.getAttribute('data-src-end')) >= Number(a.getAttribute('data-src-end')) ? b : a,
      )
      last.classList.add('git-diff-del-end')
      last.setAttribute('data-git-mark', '')
    }
  }, [html, gitDiffResult, gitDiff, csvText, articleGen])

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
  }, [html, kind, path, files, articleGen])

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
  }, [html, kind, externalAbsPath, articleGen])

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
    const flowRoots = flowRootsRef.current

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
        // Reuse the host's existing root if it already has one. Under StrictMode the
        // effect re-runs against the same (still-mounted) host; calling createRoot a
        // second time on it both warns and leaves an orphaned root that the deferred
        // cleanup then unmounts, blanking the diagram. Keyed off the host so only a
        // genuine new host (fresh document / re-render) gets a fresh root.
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
      // Tear down only the roots whose host has actually left the document — i.e.
      // the html changed (or we switched to CSV) and React wiped the old article,
      // detaching those hosts. A host that's still connected belongs to the same
      // document we're about to re-render against (StrictMode's remount, or any
      // re-render that didn't change `html`), so its root must survive; unmounting
      // it here is exactly what used to blank the diagram. Defer via queueMicrotask:
      // React 19 forbids synchronously unmounting a root from inside a render/commit
      // phase, and useEffect cleanups can fire mid-commit when a parent updates.
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
    // `articleGen` is in the dep list so this re-runs whenever a fresh article
    // element mounts (csv⇄md flip, error round-trip). Without it, the new mount
    // inherits the same `html` string and the effect never fires, leaving the
    // fresh DOM's <pre><code class="language-mermaid"> blocks un-hoisted — and
    // `pre:has(...)` CSS hides them.
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
  }, [html, kind, path, externalAbsPath, onNavigate, onOpenExternalPath, articleGen])

  // Scroll back to the top whenever the *file* changes. Deliberately excludes
  // `html` so that a reload (same file, fresh bytes) keeps the user's scroll
  // position — the load effect will repaint markdown in-place without yanking
  // the viewport back to the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [kind, path, externalName])

  // Track the path bar's height so the sticky-heading breadcrumb pins flush beneath
  // it. The height shifts with the chosen font / window width, so observe it rather
  // than hardcoding a pixel value.
  useEffect(() => {
    const el = docPathRef.current
    if (!el) return
    const measure = () => setHeaderH(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // Primitive deps (not the `source` object, which is a fresh identity each render)
    // so this re-attaches only when the doc-path actually (re)appears for a new file.
  }, [kind, path, externalName])

  // Sticky heading: as the user scrolls, track which section the reader is in and pin
  // that single heading to the top bar — updating live as each heading scrolls past,
  // regardless of level (#, ##, …; the nearest heading above wins).
  //
  // Each heading's position is measured *within the scroll content* once (distance from
  // the article's top, which is scroll-invariant), cached, and then compared against
  // `scrollTop` on every scroll. Reading positions up front and only the scroll offset
  // live is cheaper and far steadier than re-measuring on-screen rects each frame, which
  // is fragile mid-scroll. Re-measured on resize / late image + diagram loads.
  useEffect(() => {
    const scroller = scrollRef.current
    const article = containerRef.current
    if (!stickyHeadings || !scroller || !article || csvText !== null) {
      setActive(null)
      return
    }
    const levelOf = (h: HTMLElement) => Number(h.tagName[1])

    // Re-queried fresh on every measure (NOT captured once): the article's innerHTML
    // gets replaced out from under us — reloads, and mermaid/React-Flow diagrams that
    // re-render the whole body — which detaches any heading nodes we'd cached. A
    // detached node reports a zero rect, pegging every position to the same value (the
    // "always shows the last heading / never comes back" bug). Re-querying keeps us on
    // live nodes. tops[i] = distance from the article's top to heading i, in scroll-
    // content px (scroll-invariant since both rects are read in the same frame), so
    // `tops[i] <= scrollTop` ⇒ heading i has reached the top of the pane.
    let headings: HTMLElement[] = []
    let tops: number[] = []
    const measure = () => {
      headings = Array.from(
        article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
      )
      const base = article.getBoundingClientRect().top
      tops = headings.map((h) => h.getBoundingClientRect().top - base)
    }

    let raf = 0
    let lastKey = ''
    const compute = () => {
      raf = 0
      const y = scroller.scrollTop
      // Flip to a heading while it's still in the upper portion of the pane, not only
      // once it reaches the very top — so the pinned topic changes as soon as the reader
      // is clearly into the new section. Scales with pane height so the feel is the same
      // on any screen (min 4px slack for very short panes).
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
    // Re-measure (then re-evaluate) when the article's box changes — window resize,
    // font swap, late-loading images, or mermaid/React-Flow diagrams finishing layout
    // all move the cached heading positions.
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

  // Jump to the pinned heading, landing it just below the sticky bar (rather than
  // flush against the very top, where the bar would hide it).
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

  // ⌘/Ctrl+F opens the in-document find bar (or re-focuses it when already open).
  // The default browser find is a no-op in Electron, so nothing else claims the key.
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
        <div className="doc-path" ref={docPathRef}>
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
                {/* Material "search". */}
                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
            </button>
            {onToggleGitDiff && isMarkdownSource && absFilePath && (
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
                  {/* Material "difference": two stacked docs with a + and – inside. */}
                  <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm12.5 8.5h-2v2h-1v-2h-2v-1h2v-2h1v2h2v1zm0-6h-5v-1h5v1z" />
                </svg>
              </button>
            )}
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
          csvText={csvText}
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
            {/* Keyed so it remounts (and re-runs the swap animation) on each section change. */}
            <span key={active.id || active.text} className="crumb-text">
              {active.text}
            </span>
          </button>
        </div>
      )}
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

