import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useDirectory } from './hooks/useDirectory'
import { useContentSearch } from './hooks/useContentSearch'
import { useTabs, type Tab } from './hooks/useTabs'
import { useSidebarWidth } from './hooks/useSidebarWidth'
import { useSettings } from './hooks/useSettings'
import { useRootAbsPath } from './hooks/useRootAbsPath'
import { useGitStatus } from './hooks/useGitStatus'
import { filterTree } from './lib/filterTree'
import { buildViewableExtensions, matchesViewable } from './lib/extensions'
import { TreeView } from './components/TreeView'
import { SearchResults } from './components/SearchResults'
import { TabBar } from './components/TabBar'
import { Preview, type PreviewSource } from './components/Preview'
import { GraphView } from './components/GraphView'
import { SettingsModal } from './components/SettingsModal'
import iconUrl from '../build/icon.png'
import './App.css'

/** Search either by file name or by file contents. */
type SearchMode = 'name' | 'content'

/** Stable empty map so the content-search hook has consistent deps before a scan. */
const NO_FILES = new Map<string, FileSystemFileHandle>()

/**
 * Find the relative path of `absoluteFilePath` inside a root whose basename is `rootName`.
 * Walks up the absolute path from the leaf looking for a segment that matches the picked
 * directory's name, then returns everything below it joined with `/`.
 * Returns null when no segment in the absolute path matches the given root name.
 */
function relativeUnderRoot(absoluteFilePath: string, rootName: string): string | null {
  const parts = absoluteFilePath.split('/').filter(Boolean)
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === rootName) return parts.slice(i + 1).join('/')
  }
  return null
}

/**
 * Decide whether `absolutePath` is a file inside the currently loaded root, returning its
 * path relative to the root (the key used in `scan.files`) — or null if it isn't.
 *
 * Prefers absolute-prefix matching when we know the root's real OS path (Electron), which
 * is robust against ancestor directories that happen to share the root's basename. Falls
 * back to scanning the absolute path for the root's basename in plain-browser web mode,
 * where the FSA picker only exposes a basename.
 */
function resolveInRoot(
  absolutePath: string,
  dir: ReturnType<typeof useDirectory>,
  rootAbsPath: string | null,
): string | null {
  if (dir.status !== 'ready' || !dir.scan || !dir.rootName) return null
  if (rootAbsPath) {
    const normalized = rootAbsPath.endsWith('/') ? rootAbsPath : rootAbsPath + '/'
    if (!absolutePath.startsWith(normalized)) return null
    const rel = absolutePath.slice(normalized.length)
    return dir.scan.files.has(rel) ? rel : null
  }
  const rel = relativeUnderRoot(absolutePath, dir.rootName)
  return rel && dir.scan.files.has(rel) ? rel : null
}

interface PendingPromote {
  absolutePath: string
  fileName: string
  parentName: string
  externalTabId: string
}

interface PendingInRootOpen {
  relative: string
  externalTabId: string
}

/**
 * MIME types we treat as newline-separated URI lists. VSCode dispatches its own
 * `application/vnd.code.uri-list` for drags out of the editor and (recent versions of)
 * the file explorer, while Finder / most editors stick to the standard `text/uri-list`.
 * We read both so a drop from either source surfaces the same way.
 */
const URI_LIST_MIMES = ['text/uri-list', 'application/vnd.code.uri-list'] as const

/**
 * For drops that lack `File` objects (e.g. VSCode), pull OS paths out of the
 * URI-list payloads (standard + VSCode-specific) or, as a last resort, `text/plain`.
 * file:// URIs are decoded to absolute filesystem paths.
 */
function collectDroppedPaths(dt: DataTransfer): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    if (p && !seen.has(p)) {
      seen.add(p)
      paths.push(p)
    }
  }

  for (const mime of URI_LIST_MIMES) {
    const list = dt.getData(mime)
    if (!list) continue
    for (const raw of list.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('file://')) {
        try {
          push(decodeURI(new URL(line).pathname))
        } catch {
          // Malformed URI — fall through.
        }
      } else if (line.startsWith('/')) {
        push(line)
      }
    }
  }
  // Last-ditch: VSCode (and some other editors) sometimes leave only a plain-text
  // path or a newline-separated batch of paths. Split on newlines so multi-file
  // drags don't silently lose all but the first entry.
  if (paths.length === 0) {
    const plain = dt.getData('text/plain')
    if (plain) {
      for (const raw of plain.split(/\r?\n/)) {
        const line = raw.trim()
        if (line.startsWith('file://')) {
          try {
            push(decodeURI(new URL(line).pathname))
          } catch {
            // Malformed — skip.
          }
        } else if (line.startsWith('/')) {
          push(line)
        }
      }
    }
  }
  return paths
}

function tabToSource(
  tab: Tab,
  files: Map<string, FileSystemFileHandle> | undefined,
): PreviewSource | null {
  if (tab.source.kind === 'in-root') {
    if (!files) return null
    return { kind: 'in-root', path: tab.source.path, files }
  }
  return {
    kind: 'external',
    name: tab.source.name,
    content: tab.source.content,
    ...(tab.source.absolutePath ? { absolutePath: tab.source.absolutePath } : {}),
  }
}

export default function App() {
  const tabs = useTabs()
  // Pulled out early so callbacks defined below (e.g. openExternalByPath) can capture
  // a stable reference without depending on the whole `tabs` object.
  const { openExternal } = tabs
  const sidebar = useSidebarWidth()
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('name')
  const [dragHover, setDragHover] = useState(false)
  const [pendingPromote, setPendingPromote] = useState<PendingPromote | null>(null)
  const [pendingInRootOpen, setPendingInRootOpen] = useState<PendingInRootOpen | null>(null)
  const [graphMode, setGraphMode] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // Bumped whenever the user asks to reload the active in-root tab. Threaded into
  // Preview as a load-effect dep so the same path triggers a fresh `getFile()` read.
  // External tabs sidestep this — their content lives in tab state and is mutated
  // in place via `tabs.updateExternalContent`.
  const [reloadCounter, setReloadCounter] = useState(0)
  const { settings, update: updateSettings, reset: resetSettings } = useSettings()
  // Recompute the viewable extension set only when the configured extras actually change,
  // so dependent hooks see a stable identity across unrelated re-renders.
  const viewable = useMemo(
    () => buildViewableExtensions(settings.extraExtensions),
    [settings.extraExtensions],
  )
  const dir = useDirectory(viewable)
  // Auto-resolved path from the scanned files wins; the override map only kicks in
  // when resolution failed (empty root, or running in plain-browser web mode).
  const rootAbsPath = useRootAbsPath(dir.rootName)
  const effectiveRootAbsPath = dir.rootAbsPath ?? rootAbsPath.absPath

  // Bumped on each fresh scan so the git-status hook re-fetches after the user hits
  // the rescan button. Root-change refreshes are already triggered by the hook's
  // own `absoluteRootPath` dependency, so we just need to capture rescan-driven
  // updates here.
  const [gitRefreshKey, setGitRefreshKey] = useState(0)
  useEffect(() => {
    if (dir.scan) setGitRefreshKey((n) => n + 1)
  }, [dir.scan])
  const gitStatus = useGitStatus(effectiveRootAbsPath, gitRefreshKey)

  // Push opacity / always-on-top through to the BrowserWindow. Runs on mount too,
  // so saved values are applied right after the renderer attaches.
  useEffect(() => {
    window.mdexp?.setWindowOpacity?.(settings.windowOpacity)
  }, [settings.windowOpacity])
  useEffect(() => {
    window.mdexp?.setAlwaysOnTop?.(settings.alwaysOnTop)
  }, [settings.alwaysOnTop])

  // Reflect the theme preference onto <html data-theme="…">. For 'system', we track
  // the OS scheme and update whenever it flips (toggling appearance in macOS, etc.).
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const apply = () => {
        root.dataset.theme = mq.matches ? 'dark' : 'light'
      }
      apply()
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    root.dataset.theme = settings.theme
  }, [settings.theme])

  // When the root folder changes, drop in-root tabs (their paths are tied to the previous
  // root) — but keep external tabs so files opened via Finder/drop survive a root switch.
  const rootName = dir.rootName
  useEffect(() => {
    tabs.clearInRoot()
    // We deliberately depend only on rootName — re-running on tabs.clearInRoot's identity is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootName])

  // Drag the divider between the sidebar and the main pane.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebar.width
    document.body.classList.add('resizing')
    const onMove = (ev: PointerEvent) => sidebar.set(startWidth + (ev.clientX - startX))
    const onUp = () => {
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Keyboard shortcuts:
  //   ⌘+[ / ⌘+]          back / forward within the active tab
  //   ⌘+Shift+[ / ⌘+]   previous / next tab
  //   ⌘+1..9            jump to tab N (no-op if N is out of range)
  const { prevTab, nextTab, back, forward, activate } = tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.shiftKey) {
        if (e.key === '{' || e.code === 'BracketLeft') {
          e.preventDefault()
          prevTab()
          return
        }
        if (e.key === '}' || e.code === 'BracketRight') {
          e.preventDefault()
          nextTab()
          return
        }
        return
      }
      if (e.key === '[') {
        e.preventDefault()
        back()
        return
      }
      if (e.key === ']') {
        e.preventDefault()
        forward()
        return
      }
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        activate(parseInt(e.key, 10) - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prevTab, nextTab, back, forward, activate])

  // Latest values referenced inside the open-file subscription (which is set up once on mount).
  // Using refs keeps the subscription stable while still letting the handler see fresh state.
  const dirRef = useRef(dir)
  const tabsRef = useRef(tabs)
  const viewableRef = useRef(viewable)
  const rootAbsPathRef = useRef(effectiveRootAbsPath)
  useEffect(() => {
    dirRef.current = dir
  }, [dir])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    viewableRef.current = viewable
  }, [viewable])
  useEffect(() => {
    rootAbsPathRef.current = effectiveRootAbsPath
  }, [effectiveRootAbsPath])

  // Cmd/Ctrl+W: close the active tab; fall back to closing the window when none remain.
  useEffect(() => {
    const api = window.mdexp
    if (!api?.onCloseActiveTab) return
    return api.onCloseActiveTab(() => {
      const t = tabsRef.current
      if (t.tabs.length > 0) {
        t.closeActive()
      } else {
        api.closeWindow?.()
      }
    })
  }, [])

  /**
   * Re-read the active tab from disk so external edits show up.
   *
   *  - in-root: the FSA handle is still valid, so bumping `reloadCounter` simply
   *    re-fires Preview's load effect, which goes back through `handle.getFile()`
   *    and picks up the latest bytes.
   *  - external: content is held inside tab state (the tab was created from a
   *    one-shot read), so we re-read via IPC and patch the tab in place. Tabs
   *    that came from clipboard / drag without a known `absolutePath` can't be
   *    refreshed — they no-op silently.
   */
  const reloadActiveTab = useCallback(async () => {
    const t = tabsRef.current
    const active = t.active
    if (!active) return
    if (active.source.kind === 'external') {
      const abs = active.source.absolutePath
      const api = window.mdexp
      if (!abs || !api?.readTextFileByPath) return
      try {
        const content = await api.readTextFileByPath(abs)
        t.updateExternalContent(active.id, content)
      } catch (err) {
        console.error('[reload] failed to re-read external:', abs, err)
      }
      return
    }
    setReloadCounter((n) => n + 1)
  }, [])

  // ⌘+R from the main process: reload the active tab's content.
  useEffect(() => {
    const api = window.mdexp
    if (!api?.onReloadActiveTab) return
    return api.onReloadActiveTab(() => {
      void reloadActiveTab()
    })
  }, [reloadActiveTab])

  // Window focus → auto-reload. The common case is "I edited the file in another
  // app and switched back" — re-read silently so the preview matches what's on disk.
  useEffect(() => {
    const onFocus = () => {
      void reloadActiveTab()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reloadActiveTab])

  // Finder "Open With" → main process → onOpenFile. If the file lives inside the currently
  // loaded root, jump straight to its in-root tab. Otherwise open it as an external tab and
  // offer to promote the parent folder to root via a modal.
  useEffect(() => {
    const api = window.mdexp
    if (!api) return
    const off = api.onOpenFile(async (absolutePath) => {
      const baseName = absolutePath.split('/').pop() || absolutePath
      if (!matchesViewable(baseName, viewableRef.current)) return

      const t = tabsRef.current

      // Fast path: the file is inside the active root — open it in-root without the modal.
      const inRootRel = resolveInRoot(absolutePath, dirRef.current, rootAbsPathRef.current)
      if (inRootRel) {
        t.openInRoot(inRootRel, { pinned: true })
        return
      }

      let content: string
      try {
        content = await api.readTextFileByPath(absolutePath)
      } catch (err) {
        console.error('[open-file] failed to read', absolutePath, err)
        return
      }
      const externalTabId = t.openExternal(baseName, content, absolutePath)

      const parts = absolutePath.split('/').filter(Boolean)
      const parentName = parts.length >= 2 ? parts[parts.length - 2] : ''
      setPendingPromote({
        absolutePath,
        fileName: baseName,
        parentName,
        externalTabId,
      })
    })
    return off
  }, [])

  // After the user picks a folder to promote, wait for the scan to finish, then open the
  // file as an in-root tab and close the external one. The clearInRoot from the rootName
  // effect leaves the external tab intact, so closing it here is safe.
  useEffect(() => {
    if (!pendingInRootOpen) return
    if (dir.status !== 'ready' || !dir.scan) return
    if (dir.scan.files.has(pendingInRootOpen.relative)) {
      tabs.openInRoot(pendingInRootOpen.relative, { pinned: true })
      tabs.closeById(pendingInRootOpen.externalTabId)
    }
    setPendingInRootOpen(null)
  }, [pendingInRootOpen, dir.status, dir.scan, tabs])

  // Open an absolute filesystem path as a new external tab. Used by Preview when
  // the user clicks a relative .md link inside an externally-opened file.
  const openExternalByPath = useCallback(
    async (absolutePath: string) => {
      const api = window.mdexp
      if (!api?.readTextFileByPath) return
      const name = absolutePath.split('/').pop() || absolutePath
      if (!matchesViewable(name, viewableRef.current)) return
      try {
        const content = await api.readTextFileByPath(absolutePath)
        openExternal(name, content, absolutePath)
      } catch (err) {
        console.error('[ext-nav] failed to read:', absolutePath, err)
      }
    },
    [openExternal],
  )

  const handlePromote = useCallback(async () => {
    const target = pendingPromote
    if (!target) return
    setPendingPromote(null)
    const result = await dir.chooseAndScan()
    if (!result) return
    const rel = relativeUnderRoot(target.absolutePath, result.handle.name)
    if (rel && result.scan.files.has(rel)) {
      setPendingInRootOpen({ relative: rel, externalTabId: target.externalTabId })
    }
  }, [pendingPromote, dir])

  // Document-level drag-and-drop: accept .md files dropped from outside (e.g. VSCode, Finder).
  // Dropped files become external tabs since we don't know their parent directory.
  useEffect(() => {
    /** Without preventDefault on dragover, the browser navigates the window to the dropped file. */
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      const types = Array.from(e.dataTransfer.types)
      // Show the drop overlay for: native file drags (Finder), standard URI-list
      // drags (most editors), and VSCode's custom URI-list (its explorer / editor tabs).
      if (
        types.includes('Files') ||
        types.includes('text/uri-list') ||
        types.includes('application/vnd.code.uri-list')
      ) {
        setDragHover(true)
      }
    }
    const onDragLeave = (e: DragEvent) => {
      // Only clear when leaving the window, not when crossing inner elements.
      if (e.relatedTarget === null) setDragHover(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      setDragHover(false)
      if (!e.dataTransfer) return

      const files = Array.from(e.dataTransfer.files)

      if (files.length > 0) {
        const api = window.mdexp
        for (const file of files) {
          if (!matchesViewable(file.name, viewableRef.current)) continue
          try {
            // Recover the on-disk path so relative images / links inside the file resolve.
            // Falls back to undefined for File objects without a real backing path
            // (rare for Finder; happens with synthesized File objects).
            const absolutePath = api?.getPathForFile?.(file) || undefined
            // If the file lives inside the active root, route it to an in-root tab so
            // it joins the tree / graph / history — instead of becoming a stranded external.
            if (absolutePath) {
              const rel = resolveInRoot(absolutePath, dirRef.current, rootAbsPathRef.current)
              if (rel) {
                tabsRef.current.openInRoot(rel, { pinned: true })
                continue
              }
            }
            const content = await file.text()
            openExternal(file.name, content, absolutePath)
          } catch (err) {
            console.error('[D&D] failed to read dropped file:', file.name, err)
          }
        }
        return
      }

      // VSCode and some other sources don't attach File objects — only a
      // text/uri-list or a plain path. Use the preload IPC to read the file
      // by absolute path on disk.
      const paths = collectDroppedPaths(e.dataTransfer)
      if (paths.length === 0) return
      const api = window.mdexp
      if (!api) {
        console.warn('[D&D] received a path-only drop but the preload API is unavailable.')
        return
      }
      for (const fullPath of paths) {
        if (!matchesViewable(fullPath, viewableRef.current)) continue
        // Same in-root short-circuit as the File-object branch: avoid reading the file
        // again from disk when the scan already has it indexed.
        const rel = resolveInRoot(fullPath, dirRef.current, rootAbsPathRef.current)
        if (rel) {
          tabsRef.current.openInRoot(rel, { pinned: true })
          continue
        }
        try {
          const content = await api.readTextFileByPath(fullPath)
          const name = fullPath.split('/').pop() || fullPath
          openExternal(name, content, fullPath)
        } catch (err) {
          console.error('[D&D] failed to read by path:', fullPath, err)
        }
      }
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [openExternal])

  const filtered = useMemo(() => {
    if (!dir.scan) return null
    return filterTree(dir.scan.tree, query)
  }, [dir.scan, query])

  const trimmed = query.trim()
  const search = useContentSearch(
    dir.scan?.files ?? NO_FILES,
    viewable,
    query,
    mode === 'content' && dir.status === 'ready',
  )
  const showResults = mode === 'content' && trimmed.length > 0

  const activeSource = tabs.active ? tabToSource(tabs.active, dir.scan?.files) : null
  // Path of the active in-root tab, used to highlight the row in the tree / results.
  const activeInRootPath =
    tabs.active?.source.kind === 'in-root' ? tabs.active.source.path : null

  const openPreview = (path: string) => {
    setGraphMode(false)
    tabs.openInRoot(path)
  }
  const openPinned = (path: string) => {
    setGraphMode(false)
    tabs.openInRoot(path, { pinned: true })
  }
  const openFromGraph = (path: string) => {
    setGraphMode(false)
    tabs.openInRoot(path, { pinned: true })
  }
  const showGraph = graphMode && dir.status === 'ready' && !!dir.scan

  return (
    <div
      className={`app${dragHover ? ' drag-hover' : ''}${settings.wrapCode ? ' wrap-code' : ''}`}
      style={
        {
          '--sidebar-width': `${sidebar.width}px`,
          '--md-font-size': `${settings.mainFontSize}px`,
          '--md-line-height': settings.mainLineHeight,
          '--md-max-width': `${settings.mainMaxWidth}%`,
        } as CSSProperties
      }
    >
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="title-row">
            <strong className="app-name">
              <img className="app-icon" src={iconUrl} alt="" />
              Markdown Explorer
            </strong>
          </div>
          {dir.status === 'ready' && dir.scan && (
            <>
              <div className="root-row" title={dir.rootName ?? ''}>
                <span className="root-name">{dir.rootName}</span>
                <span className="count">{dir.scan.viewableCount} 個</span>
              </div>
              <div className="toolbar">
                <input
                  className="search"
                  type="search"
                  placeholder={mode === 'content' ? '中身を検索' : 'ファイル名で絞り込む'}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button className="icon-btn" title="読み直す" onClick={() => dir.rescan()}>
                  ⟳
                </button>
                <button className="icon-btn" title="別のフォルダを開く" onClick={() => dir.choose()}>
                  📂
                </button>
                <button
                  className={`icon-btn${graphMode ? ' active' : ''}`}
                  title="リンクのつながりを図で見る"
                  aria-pressed={graphMode}
                  onClick={() => setGraphMode((g) => !g)}
                >
                  🕸
                </button>
              </div>
              <div className="mode-toggle" role="group" aria-label="検索モード">
                <button
                  className={`mode-btn${mode === 'name' ? ' active' : ''}`}
                  onClick={() => setMode('name')}
                >
                  名前
                </button>
                <button
                  className={`mode-btn${mode === 'content' ? ' active' : ''}`}
                  onClick={() => setMode('content')}
                >
                  中身
                </button>
              </div>
            </>
          )}
        </header>

        <nav className="tree-scroll">
          {showResults ? (
            search.status === 'indexing' ? (
              <p className="hint">読み込み中…</p>
            ) : (
              <SearchResults
                matches={search.matches}
                query={query}
                selectedPath={activeInRootPath}
                onSelect={openPreview}
                onActivate={openPinned}
              />
            )
          ) : filtered ? (
            filtered.children && filtered.children.length > 0 ? (
              <TreeView
                node={filtered}
                selectedPath={activeInRootPath}
                onSelect={openPreview}
                onActivate={openPinned}
                forceExpand={mode === 'name' && trimmed.length > 0}
                revealPath={activeInRootPath}
                gitStatus={gitStatus}
              />
            ) : (
              <p className="hint">該当するファイルが見つかりません</p>
            )
          ) : null}
        </nav>
      </aside>

      <div
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="サイドバー幅を変更"
        onPointerDown={startResize}
      />

      <main className="main">
        {showGraph ? (
          <GraphView
            scan={dir.scan!}
            activePath={activeInRootPath}
            onSelectFile={openFromGraph}
          />
        ) : (
          <>
            {tabs.tabs.length > 0 && (
              <TabBar
                tabs={tabs.tabs}
                activeIndex={tabs.activeIndex}
                onActivate={tabs.activate}
                onClose={tabs.close}
                onPin={tabs.pin}
              />
            )}
            {tabs.active ? (
              <Preview
                source={activeSource}
                onNavigate={tabs.navigate}
                onBack={tabs.back}
                onForward={tabs.forward}
                canBack={tabs.canBack}
                canForward={tabs.canForward}
                rootAbsPath={effectiveRootAbsPath}
                rootName={dir.rootName}
                onLinkRoot={rootAbsPath.link}
                onOpenExternalPath={openExternalByPath}
                onReload={reloadActiveTab}
                reloadCounter={reloadCounter}
              />
            ) : dir.status === 'ready' ? (
              <Preview
                source={null}
                onNavigate={tabs.navigate}
                onBack={tabs.back}
                onForward={tabs.forward}
                canBack={false}
                canForward={false}
                rootAbsPath={effectiveRootAbsPath}
                rootName={dir.rootName}
                onLinkRoot={rootAbsPath.link}
                onOpenExternalPath={openExternalByPath}
                onReload={reloadActiveTab}
                reloadCounter={reloadCounter}
              />
            ) : (
              <Gate dir={dir} />
            )}
          </>
        )}
        {dragHover && (
          <div className="drop-overlay" aria-hidden>
            <div className="drop-overlay-inner">
              <div className="drop-icon">📥</div>
              <div>ファイルをここに、ドロップ</div>
            </div>
          </div>
        )}
      </main>

      <button
        className="settings-fab"
        title="設定"
        aria-label="設定を開く"
        onClick={() => setShowSettings(true)}
      >
        <svg
          className="settings-fab-icon"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="currentColor"
          aria-hidden
        >
          {/* Material "settings" (filled). Solid gear silhouette so the glyph reads
              cleanly even at small sizes against the translucent FAB background. */}
          <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.13 7.13 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.24-1.17.57-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98L2.46 14.63a.5.5 0 0 0-.12.64l2 3.46c.14.24.42.34.61.22l2.49-1c.52.41 1.08.74 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4c.25 0 .45-.18.49-.42l.38-2.65c.61-.24 1.17-.57 1.69-.98l2.49 1c.19.12.47.02.61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
        </svg>
      </button>

      {pendingPromote && (
        <PromoteModal
          fileName={pendingPromote.fileName}
          parentName={pendingPromote.parentName}
          onPromote={handlePromote}
          onDismiss={() => setPendingPromote(null)}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onUpdate={updateSettings}
          onReset={resetSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

interface PromoteModalProps {
  fileName: string
  parentName: string
  onPromote: () => void
  onDismiss: () => void
}

function PromoteModal({ fileName, parentName, onPromote, onDismiss }: PromoteModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="promote-title">Finder から開きました</h2>
        <p>
          <strong>{fileName}</strong> を表示しています。
        </p>
        <p>
          親フォルダ {parentName ? <strong>「{parentName}」</strong> : 'の中身'} をルートにすると、
          ツリーから他のファイルにもアクセスできるようになります。
        </p>
        <div className="modal-actions">
          <button className="primary" onClick={onPromote}>
            フォルダを選んでルートにする
          </button>
          <button className="ghost" onClick={onDismiss}>
            外部ファイルのまま見る
          </button>
        </div>
      </div>
    </div>
  )
}

function Gate({ dir }: { dir: ReturnType<typeof useDirectory> }) {
  if (!dir.supported) {
    return (
      <div className="gate">
        <h1>このブラウザには対応していません</h1>
        <p>File System Access API が必要です。Chrome 系のブラウザで開いてください。</p>
      </div>
    )
  }
  if (dir.status === 'restoring') {
    return (
      <div className="gate">
        <p>前回のフォルダを復元しています…</p>
      </div>
    )
  }
  if (dir.status === 'need-permission') {
    return (
      <div className="gate">
        <h1>アクセス許可が必要です</h1>
        <p>
          <strong>{dir.rootName}</strong> を覚えています。読み込みを許可してください。
        </p>
        <button className="primary" onClick={() => dir.grant()}>
          このフォルダを開く
        </button>
        <button className="ghost" onClick={() => dir.reset()}>
          忘れて選び直す
        </button>
      </div>
    )
  }
  if (dir.status === 'scanning') {
    return (
      <div className="gate">
        <p>「{dir.rootName}」を読み込み中…</p>
      </div>
    )
  }
  if (dir.status === 'error') {
    return (
      <div className="gate">
        <h1>エラーが発生しました</h1>
        <pre className="err">{dir.error}</pre>
        <button className="primary" onClick={() => dir.choose()}>
          フォルダを選ぶ
        </button>
      </div>
    )
  }
  // idle
  return (
    <div className="gate">
      <h1>
        <img className="gate-icon" src={iconUrl} alt="" />
        Markdown Explorer
      </h1>
      <p>フォルダを選んでください。中のファイルをすべて表示します。</p>
      <button className="primary" onClick={() => dir.choose()}>
        フォルダを選ぶ
      </button>
      <p className="fine">選んだフォルダは記憶されるので、次回はワンタッチで開けます。</p>
    </div>
  )
}
