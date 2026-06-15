// Preload runs in an isolated world. The only safe way to expose APIs to the
// renderer is via contextBridge — never expose `ipcRenderer` directly.
import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * Read a text file from an absolute OS path via the main process.
 * Used to handle drops from sources like VSCode that only provide the path,
 * not a File object.
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

/**
 * Open a native directory picker and return the chosen absolute path (or null on cancel).
 * The renderer uses this to learn the OS path of the active root — the File System Access
 * picker only yields a handle / basename, which isn't enough for git operations.
 */
async function chooseDirectory(): Promise<string | null> {
  return ipcRenderer.invoke('mdexp:choose-directory')
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

interface GitCommit {
  sha: string
  shortSha: string
  dateISO: string
  authorName: string
  subject: string
}

async function gitHistory(absoluteFilePath: string): Promise<GitCommit[]> {
  return ipcRenderer.invoke('mdexp:git-history', absoluteFilePath)
}

async function gitShow(absoluteFilePath: string, sha: string): Promise<string> {
  return ipcRenderer.invoke('mdexp:git-show', absoluteFilePath, sha)
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

contextBridge.exposeInMainWorld('mdexp', {
  readTextFileByPath,
  readBinaryFileByPath,
  onOpenFile,
  setWindowOpacity,
  setAlwaysOnTop,
  onCloseActiveTab,
  onReloadActiveTab,
  closeWindow,
  chooseDirectory,
  getPathForFile,
  gitHistory,
  gitShow,
  gitStatus,
})
