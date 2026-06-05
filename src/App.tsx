import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useDirectory } from './hooks/useDirectory'
import { useContentSearch } from './hooks/useContentSearch'
import { useTabs, type Tab } from './hooks/useTabs'
import { useSidebarWidth } from './hooks/useSidebarWidth'
import { useSettings } from './hooks/useSettings'
import { filterTree } from './lib/filterTree'
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

const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i

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
 * For drops that lack `File` objects (e.g. VSCode), pull OS paths out of the
 * `text/uri-list` (preferred) or `text/plain` payload. file:// URIs are decoded
 * to absolute filesystem paths.
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

  const uriList = dt.getData('text/uri-list')
  if (uriList) {
    for (const raw of uriList.split(/\r?\n/)) {
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
  if (paths.length === 0) {
    const plain = dt.getData('text/plain').trim()
    if (plain.startsWith('/')) push(plain)
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
  return { kind: 'external', name: tab.source.name, content: tab.source.content }
}

export default function App() {
  const dir = useDirectory()
  const tabs = useTabs()
  const sidebar = useSidebarWidth()
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('name')
  const [dragHover, setDragHover] = useState(false)
  const [pendingPromote, setPendingPromote] = useState<PendingPromote | null>(null)
  const [pendingInRootOpen, setPendingInRootOpen] = useState<PendingInRootOpen | null>(null)
  const [graphMode, setGraphMode] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const { settings, update: updateSettings, reset: resetSettings } = useSettings()

  // Push opacity / always-on-top through to the BrowserWindow. Runs on mount too,
  // so saved values are applied right after the renderer attaches.
  useEffect(() => {
    window.mdexp?.setWindowOpacity?.(settings.windowOpacity)
  }, [settings.windowOpacity])
  useEffect(() => {
    window.mdexp?.setAlwaysOnTop?.(settings.alwaysOnTop)
  }, [settings.alwaysOnTop])

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
  useEffect(() => {
    dirRef.current = dir
  }, [dir])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  // Finder "Open With" → main process → onOpenFile. If the file lives inside the currently
  // loaded root, jump straight to its in-root tab. Otherwise open it as an external tab and
  // offer to promote the parent folder to root via a modal.
  useEffect(() => {
    const api = window.mdexp
    if (!api) return
    const off = api.onOpenFile(async (absolutePath) => {
      const baseName = absolutePath.split('/').pop() || absolutePath
      if (!MD_EXT_RE.test(baseName)) return

      const d = dirRef.current
      const t = tabsRef.current

      // Fast path: the file is inside the active root — open it in-root without the modal.
      if (d.status === 'ready' && d.scan && d.rootName) {
        const rel = relativeUnderRoot(absolutePath, d.rootName)
        if (rel && d.scan.files.has(rel)) {
          t.openInRoot(rel, { pinned: true })
          return
        }
      }

      let content: string
      try {
        content = await api.readTextFileByPath(absolutePath)
      } catch (err) {
        console.error('[open-file] failed to read', absolutePath, err)
        return
      }
      const externalTabId = t.openExternal(baseName, content)

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
  const { openExternal } = tabs
  useEffect(() => {
    /** Without preventDefault on dragover, the browser navigates the window to the dropped file. */
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      const types = Array.from(e.dataTransfer.types)
      if (types.includes('Files') || types.includes('text/uri-list')) {
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
        for (const file of files) {
          if (!MD_EXT_RE.test(file.name)) continue
          try {
            const content = await file.text()
            openExternal(file.name, content)
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
        if (!MD_EXT_RE.test(fullPath)) continue
        try {
          const content = await api.readTextFileByPath(fullPath)
          const name = fullPath.split('/').pop() || fullPath
          openExternal(name, content)
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
          '--md-max-width': `${settings.mainMaxWidth}px`,
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
                <span className="count">{dir.scan.markdownCount} 個</span>
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
              />
            ) : (
              <p className="hint">該当する .md が見つかりません</p>
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
              />
            ) : dir.status === 'ready' ? (
              <Preview
                source={null}
                onNavigate={tabs.navigate}
                onBack={tabs.back}
                onForward={tabs.forward}
                canBack={false}
                canForward={false}
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
              <div>.md をここに、ドロップ</div>
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
        ⚙
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
          ツリーから他の .md にもアクセスできるようになります。
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
      <p>フォルダを選んでください。中の .md をすべて表示します。</p>
      <button className="primary" onClick={() => dir.choose()}>
        フォルダを選ぶ
      </button>
      <p className="fine">選んだフォルダは記憶されるので、次回はワンタッチで開けます。</p>
    </div>
  )
}
