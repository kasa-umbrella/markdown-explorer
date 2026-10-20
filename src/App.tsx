import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTabs } from './hooks/useTabs'
import { useSettings } from './hooks/useSettings'
import { buildViewableExtensions, isMarkdownPath, matchesViewable } from './lib/extensions'
import { decodeText } from './lib/encoding'
import { isXlsxPath, parseWorkbook, serializeWorkbook } from './lib/xlsx'
import { getFont } from './lib/fonts'
import { TabBar } from './components/TabBar'
import { Preview } from './components/Preview'
import { PresentationView, type PresentCtx } from './components/PresentationView'
import { SettingsModal } from './components/SettingsModal'
import iconUrl from '../build/icon.png'
import './App.css'

/**
 * MIME types we treat as newline-separated URI lists. VSCode dispatches its own
 * `application/vnd.code.uri-list` for drags out of the editor and (recent versions of)
 * the file explorer, while Finder / most editors stick to the standard `text/uri-list`.
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

/**
 * Read a file's tab content from an absolute path. Excel workbooks are read as
 * raw bytes and parsed into a serialized workbook; all other files are decoded text.
 */
async function readContentByPath(api: MdexpApi, absolutePath: string, name: string): Promise<string> {
  if (isXlsxPath(name)) {
    const buf = await api.readBinaryFileByPath(absolutePath)
    return serializeWorkbook(parseWorkbook(buf))
  }
  return api.readTextFileByPath(absolutePath)
}

/** Turn already-read file bytes into tab content, parsing Excel workbooks and decoding the rest. */
function contentFromBuffer(buffer: ArrayBuffer, name: string): string {
  return isXlsxPath(name) ? serializeWorkbook(parseWorkbook(buffer)) : decodeText(buffer)
}

export default function App() {
  const tabs = useTabs()
  const { openExternal } = tabs
  const [dragHover, setDragHover] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // Active presentation deck (raw markdown + image-resolution context), or null when
  // not presenting. Built on demand from the active tab.
  const [present, setPresent] = useState<{ markdown: string; ctx: PresentCtx } | null>(null)
  // When true, the tab bar / settings FAB collapse so only the preview is visible.
  const [focusMode, setFocusMode] = useState(false)
  const { settings, update: updateSettings, reset: resetSettings } = useSettings()
  // Recompute the viewable extension set only when the configured extras change.
  const viewable = buildViewableExtensions(settings.extraExtensions)

  // Push opacity / always-on-top through to the BrowserWindow. Runs on mount too.
  useEffect(() => {
    window.mdexp?.setWindowOpacity?.(settings.windowOpacity)
  }, [settings.windowOpacity])
  useEffect(() => {
    window.mdexp?.setAlwaysOnTop?.(settings.alwaysOnTop)
  }, [settings.alwaysOnTop])

  // Reflect the theme preference onto <html data-theme="…">. For 'system', track the OS.
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

  // Apply the chosen font app-wide by setting --app-font on <html>.
  useEffect(() => {
    const font = getFont(settings.mainFont)
    document.documentElement.style.setProperty('--app-font', font.stack)
    void font.load()
  }, [settings.mainFont])

  // Keyboard shortcuts:
  //   ⌘+Shift+[ / ⌘+]   previous / next tab
  //   ⌘+1..9            jump to tab N (no-op if N is out of range)
  const { prevTab, nextTab, activate } = tabs
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
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        activate(parseInt(e.key, 10) - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prevTab, nextTab, activate])

  // Esc exits focus mode. Only attached while focus is active so the key stays
  // available for other modals when we're not focused.
  useEffect(() => {
    if (!focusMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocusMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode])

  // Tie focus mode to the browser's Fullscreen API so the OS chrome goes away too.
  useEffect(() => {
    const d = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => Promise<void>
    }
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>
    }
    const inFs = () => Boolean(d.fullscreenElement || d.webkitFullscreenElement)
    if (focusMode) {
      if (!inFs()) {
        const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el)
        req?.().catch(() => {})
      }
    } else if (inFs()) {
      const exit = d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d)
      exit?.().catch(() => {})
    }
  }, [focusMode])

  // If the user leaves fullscreen via the browser, drop focus mode so state stays in sync.
  useEffect(() => {
    const d = document as Document & { webkitFullscreenElement?: Element | null }
    const onChange = () => {
      if (!d.fullscreenElement && !d.webkitFullscreenElement) setFocusMode(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])

  // Latest values referenced inside the mount-time subscriptions, kept in refs so the
  // subscriptions stay stable while still seeing fresh state.
  const tabsRef = useRef(tabs)
  const viewableRef = useRef(viewable)
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    viewableRef.current = viewable
  }, [viewable])

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
   * Re-read the active tab from disk so external edits show up. Content is held in tab
   * state (read once at open), so we re-read via IPC and patch the tab in place. Tabs
   * without a known `absolutePath` (clipboard / synthesized drops) can't be refreshed.
   */
  const reloadActiveTab = useCallback(async () => {
    const t = tabsRef.current
    const active = t.active
    if (!active) return
    const abs = active.source.absolutePath
    const api = window.mdexp
    if (!abs || !api?.readTextFileByPath) return
    try {
      const content = await readContentByPath(api, abs, active.source.name)
      t.updateExternalContent(active.id, content)
    } catch (err) {
      console.error('[reload] failed to re-read:', abs, err)
    }
  }, [])

  // ⌘+R from the main process: reload the active tab's content.
  useEffect(() => {
    const api = window.mdexp
    if (!api?.onReloadActiveTab) return
    return api.onReloadActiveTab(() => {
      void reloadActiveTab()
    })
  }, [reloadActiveTab])

  // Window focus → auto-reload the active tab (edited elsewhere and switched back).
  useEffect(() => {
    const onFocus = () => {
      void reloadActiveTab()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reloadActiveTab])

  // Finder "Open With" → main process → onOpenFile. Open the file as a new tab.
  useEffect(() => {
    const api = window.mdexp
    if (!api) return
    return api.onOpenFile(async (absolutePath) => {
      const baseName = absolutePath.split('/').pop() || absolutePath
      if (!matchesViewable(baseName, viewableRef.current)) return
      let content: string
      try {
        content = await readContentByPath(api, absolutePath, baseName)
      } catch (err) {
        console.error('[open-file] failed to read', absolutePath, err)
        return
      }
      tabsRef.current.openExternal(baseName, content, absolutePath)
    })
  }, [])

  // Open an absolute filesystem path as a new tab. Used by Preview when the user
  // clicks a relative .md link inside a file.
  const openExternalByPath = useCallback(
    async (absolutePath: string) => {
      const api = window.mdexp
      if (!api?.readTextFileByPath) return
      const name = absolutePath.split('/').pop() || absolutePath
      if (!matchesViewable(name, viewableRef.current)) return
      try {
        const content = await readContentByPath(api, absolutePath, name)
        openExternal(name, content, absolutePath)
      } catch (err) {
        console.error('[nav] failed to read:', absolutePath, err)
      }
    },
    [openExternal],
  )

  // Open the native file picker (multi-select) and open each chosen file as a tab.
  const openViaDialog = useCallback(async () => {
    const api = window.mdexp
    if (!api?.openFileDialog) return
    const paths = await api.openFileDialog(Array.from(viewableRef.current))
    for (const p of paths) {
      await openExternalByPath(p)
    }
  }, [openExternalByPath])

  // Enter presentation mode for the active markdown tab. No-ops for non-markdown.
  const activeTab = tabs.active
  const startPresentation = useCallback(() => {
    if (!activeTab) return
    if (!isMarkdownPath(activeTab.source.name)) return
    setPresent({
      markdown: activeTab.source.content,
      ctx: { absolutePath: activeTab.source.absolutePath ?? null },
    })
  }, [activeTab])

  const exitPresentation = useCallback(() => setPresent(null), [])

  // ⌘/Ctrl+P starts presenting the active markdown. Esc inside the deck exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        if (!present) startPresentation()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [present, startPresentation])

  // Document-level drag-and-drop: accept files dropped from outside (Finder, VSCode, …).
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      const types = Array.from(e.dataTransfer.types)
      if (
        types.includes('Files') ||
        types.includes('text/uri-list') ||
        types.includes('application/vnd.code.uri-list')
      ) {
        setDragHover(true)
      }
    }
    const onDragLeave = (e: DragEvent) => {
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
            const absolutePath = api?.getPathForFile?.(file) || undefined
            const content = contentFromBuffer(await file.arrayBuffer(), file.name)
            openExternal(file.name, content, absolutePath)
          } catch (err) {
            console.error('[D&D] failed to read dropped file:', file.name, err)
          }
        }
        return
      }

      // VSCode and some other sources attach only a path (no File object). Read by path via IPC.
      const paths = collectDroppedPaths(e.dataTransfer)
      if (paths.length === 0) return
      const api = window.mdexp
      if (!api) {
        console.warn('[D&D] received a path-only drop but the preload API is unavailable.')
        return
      }
      for (const fullPath of paths) {
        if (!matchesViewable(fullPath, viewableRef.current)) continue
        try {
          const name = fullPath.split('/').pop() || fullPath
          const content = await readContentByPath(api, fullPath, name)
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

  const activeSource = tabs.active ? tabs.active.source : null

  return (
    <div
      className={`app viewer${dragHover ? ' drag-hover' : ''}${settings.wrapCode ? ' wrap-code' : ''}${focusMode ? ' focus' : ''}`}
      style={
        {
          '--md-font-size': `${settings.mainFontSize}px`,
          '--md-line-height': settings.mainLineHeight,
          '--md-max-width': `${settings.mainMaxWidth}%`,
        } as CSSProperties
      }
    >
      <main className="main">
        {tabs.tabs.length > 0 && (
          <TabBar
            tabs={tabs.tabs}
            activeIndex={tabs.activeIndex}
            onActivate={tabs.activate}
            onClose={tabs.close}
            onPin={tabs.pin}
          />
        )}
        {activeSource ? (
          <Preview
            source={activeSource}
            onOpenExternalPath={openExternalByPath}
            onOpenFiles={openViaDialog}
            onReload={reloadActiveTab}
            focusMode={focusMode}
            onToggleFocus={() => setFocusMode((f) => !f)}
            onPresent={startPresentation}
            stickyHeadings={settings.stickyHeadings}
            gitDiff={settings.gitDiffMarkers}
            onToggleGitDiff={() => updateSettings({ gitDiffMarkers: !settings.gitDiffMarkers })}
          />
        ) : (
          <DropGate onOpenFiles={openViaDialog} />
        )}
        {dragHover && (
          <div className="drop-overlay" aria-hidden>
            <div className="drop-overlay-inner">
              <div className="drop-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                  <path d="M19 3H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.11-.89-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H5V5h14v10zm-3-5h-2V7h-4v3H8l4 4 4-4z" />
                </svg>
              </div>
              <div>ファイルをここに、ドロップ</div>
            </div>
          </div>
        )}
      </main>

      {!focusMode && (
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
            <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.13 7.13 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.24-1.17.57-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98L2.46 14.63a.5.5 0 0 0-.12.64l2 3.46c.14.24.42.34.61.22l2.49-1c.52.41 1.08.74 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4c.25 0 .45-.18.49-.42l.38-2.65c.61-.24 1.17-.57 1.69-.98l2.49 1c.19.12.47.02.61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
          </svg>
        </button>
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onUpdate={updateSettings}
          onReset={resetSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {present && (
        <PresentationView markdown={present.markdown} ctx={present.ctx} onExit={exitPresentation} />
      )}
    </div>
  )
}

/** Empty state shown when no tab is open: an invitation to drop or pick files. */
function DropGate({ onOpenFiles }: { onOpenFiles: () => void }) {
  return (
    <div className="gate">
      <h1>
        <img className="gate-icon" src={iconUrl} alt="" />
        Markdown Explorer
      </h1>
      <p>Markdown・CSV などのファイルをウィンドウにドロップすると表示します。</p>
      <button className="primary" onClick={onOpenFiles}>
        ファイルを選んで開く
      </button>
      <p className="fine">Finder の「このアプリで開く」からも開けます。</p>
    </div>
  )
}
