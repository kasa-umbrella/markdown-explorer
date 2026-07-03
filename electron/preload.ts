// Preload runs in an isolated world. The only safe way to expose APIs to the
// renderer is via contextBridge — never expose `ipcRenderer` directly.
import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * Read a text file from an absolute OS path via the main process. The main process
 * auto-detects UTF-8 vs Shift_JIS. Used to handle drops from sources like VSCode
 * that only provide the path, not a File object.
 */
async function readTextFileByPath(path: string): Promise<string> {
  return ipcRenderer.invoke('mdexp:read-text-file', path)
}

/**
 * Read a binary file from an absolute OS path. Returned as a raw ArrayBuffer so
 * the renderer can wrap it in a Blob for image rendering inside externally-opened
 * markdown (the file lives outside the FSA root, so the handle map can't help).
 */
async function readBinaryFileByPath(path: string): Promise<ArrayBuffer> {
  return ipcRenderer.invoke('mdexp:read-binary-file', path)
}

// Open-file delivery. Main can flush queued paths before React has had a chance
// to subscribe, so we buffer here and replay to the first handler that registers.
let pendingOpens: string[] = []
const openFileHandlers = new Set<(path: string) => void>()

ipcRenderer.on('mdexp:open-file', (_event, filePath: string) => {
  if (openFileHandlers.size === 0) {
    pendingOpens.push(filePath)
    return
  }
  for (const handler of openFileHandlers) handler(filePath)
})

function onOpenFile(handler: (path: string) => void): () => void {
  openFileHandlers.add(handler)
  if (pendingOpens.length > 0) {
    const drained = pendingOpens
    pendingOpens = []
    for (const p of drained) handler(p)
  }
  return () => {
    openFileHandlers.delete(handler)
  }
}

// Open-directory delivery (CLI alias / folder drop). Same buffer-and-replay pattern
// as onOpenFile, but on a separate channel so the renderer can route folders into
// the directory-load flow instead of the per-file open flow.
let pendingOpenDirs: string[] = []
const openDirHandlers = new Set<(path: string) => void>()

ipcRenderer.on('mdexp:open-dir', (_event, dirPath: string) => {
  if (openDirHandlers.size === 0) {
    pendingOpenDirs.push(dirPath)
    return
  }
  for (const handler of openDirHandlers) handler(dirPath)
})

function onOpenDir(handler: (path: string) => void): () => void {
  openDirHandlers.add(handler)
  if (pendingOpenDirs.length > 0) {
    const drained = pendingOpenDirs
    pendingOpenDirs = []
    for (const p of drained) handler(p)
  }
  return () => {
    openDirHandlers.delete(handler)
  }
}

/**
 * Native-mode directory walk: ask main to enumerate every file under `absPath`
 * and return a flat list of `{ relPath, absPath }`. Honors the same `showHidden`
 * semantics as the FSA walker (dotfiles excluded by default; `.git` always
 * excluded). The renderer turns this into the sidebar tree.
 */
async function scanDirByPath(
  absPath: string,
  options: { showHidden?: boolean },
): Promise<{ relPath: string; absPath: string }[]> {
  return ipcRenderer.invoke('mdexp:scan-dir-by-path', absPath, options)
}

function setWindowOpacity(opacity: number): void {
  ipcRenderer.send('mdexp:set-opacity', opacity)
}

function setAlwaysOnTop(flag: boolean): void {
  ipcRenderer.send('mdexp:set-always-on-top', flag)
}

// Cmd/Ctrl+W is intercepted in the main process and forwarded here so the
// renderer can decide whether to close a tab or the whole window.
const closeActiveTabHandlers = new Set<() => void>()
ipcRenderer.on('mdexp:close-active-tab', () => {
  for (const handler of closeActiveTabHandlers) handler()
})

function onCloseActiveTab(handler: () => void): () => void {
  closeActiveTabHandlers.add(handler)
  return () => {
    closeActiveTabHandlers.delete(handler)
  }
}

// Cmd/Ctrl+R is intercepted in the main process and forwarded here so the
// renderer can re-read the active tab from disk instead of reloading the page.
const reloadActiveTabHandlers = new Set<() => void>()
ipcRenderer.on('mdexp:reload-active-tab', () => {
  for (const handler of reloadActiveTabHandlers) handler()
})

function onReloadActiveTab(handler: () => void): () => void {
  reloadActiveTabHandlers.add(handler)
  return () => {
    reloadActiveTabHandlers.delete(handler)
  }
}

function closeWindow(): void {
  ipcRenderer.send('mdexp:close-window')
}

/** Open another full explorer window (also available on Cmd/Ctrl+N). */
function newWindow(): void {
  ipcRenderer.send('mdexp:new-window')
}

/**
 * Resolve the absolute OS path of a File object. Works for File instances obtained
 * from `<input type=file>`, drag-drop, and — crucially for us — `FileSystemFileHandle.getFile()`.
 * Returns the empty string when Electron can't resolve a path (e.g. a synthesized File
 * with no on-disk backing).
 */
function getPathForFile(file: File): string {
  return webUtils.getPathForFile(file)
}

type GitStatusCode = 'M' | 'A' | 'D' | 'R' | 'U'

/**
 * Snapshot of the git working tree under the given root. Maps each changed file's
 * path (relative to the root) to a single status letter. Resolves to null when the
 * root isn't inside a git repository or git isn't available.
 */
async function gitStatus(
  absoluteRootPath: string,
): Promise<Record<string, GitStatusCode> | null> {
  return ipcRenderer.invoke('mdexp:git-status', absoluteRootPath)
}

/**
 * The committed (HEAD) contents of a single file, used by the preview to mark which
 * blocks changed since the last commit. Resolves to null when the file isn't inside
 * a git repo; `{ head: null }` when it's a new / untracked file with no HEAD revision.
 */
async function gitFileDiff(
  absoluteFilePath: string,
): Promise<{ head: string | null } | null> {
  return ipcRenderer.invoke('mdexp:git-file-diff', absoluteFilePath)
}

// ── Detached presenter window (dual-screen) ──
// The main window opens/closes a second window and pushes the deck + current slide
// into it; the presenter window sends navigation commands back. Main relays both
// directions, so neither renderer needs a direct handle on the other.

/** Main window → ask main to open (or focus) the presenter window. */
function presenterOpen(): void {
  ipcRenderer.send('mdexp:presenter-open')
}

/** Main window → ask main to close the presenter window. */
function presenterClose(): void {
  ipcRenderer.send('mdexp:presenter-close')
}

/** Main window → presenter window: push a deck-init or index-update message. */
function sendToPresenter(msg: unknown): void {
  ipcRenderer.send('mdexp:to-presenter', msg)
}

const toPresenterHandlers = new Set<(msg: unknown) => void>()
ipcRenderer.on('mdexp:presenter-msg', (_e, msg: unknown) => {
  for (const handler of toPresenterHandlers) handler(msg)
})

/** Presenter window: subscribe to deck / index pushes from the main window. */
function onToPresenter(handler: (msg: unknown) => void): () => void {
  toPresenterHandlers.add(handler)
  return () => {
    toPresenterHandlers.delete(handler)
  }
}

/** Presenter window → main window: send a navigation / exit / ready command. */
function sendToMain(msg: unknown): void {
  ipcRenderer.send('mdexp:to-main', msg)
}

const toMainHandlers = new Set<(msg: unknown) => void>()
ipcRenderer.on('mdexp:main-msg', (_e, msg: unknown) => {
  for (const handler of toMainHandlers) handler(msg)
})

/** Main window: subscribe to commands coming back from the presenter window. */
function onToMain(handler: (msg: unknown) => void): () => void {
  toMainHandlers.add(handler)
  return () => {
    toMainHandlers.delete(handler)
  }
}

const presenterClosedHandlers = new Set<() => void>()
ipcRenderer.on('mdexp:presenter-closed', () => {
  for (const handler of presenterClosedHandlers) handler()
})

/** Main window: subscribe to the presenter window being closed (by the user). */
function onPresenterClosed(handler: () => void): () => void {
  presenterClosedHandlers.add(handler)
  return () => {
    presenterClosedHandlers.delete(handler)
  }
}

contextBridge.exposeInMainWorld('mdexp', {
  readTextFileByPath,
  readBinaryFileByPath,
  onOpenFile,
  onOpenDir,
  scanDirByPath,
  setWindowOpacity,
  setAlwaysOnTop,
  onCloseActiveTab,
  onReloadActiveTab,
  closeWindow,
  newWindow,
  getPathForFile,
  gitStatus,
  gitFileDiff,
  presenterOpen,
  presenterClose,
  sendToPresenter,
  onToPresenter,
  sendToMain,
  onToMain,
  onPresenterClosed,
})
