// Preload runs in an isolated world. The only safe way to expose APIs to the
// renderer is via contextBridge — never expose `ipcRenderer` directly.
import { contextBridge, ipcRenderer } from 'electron'

/**
 * Read a text file from an absolute OS path via the main process.
 * Used to handle drops from sources like VSCode that only provide the path,
 * not a File object.
 */
async function readTextFileByPath(path: string): Promise<string> {
  return ipcRenderer.invoke('mdexp:read-text-file', path)
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

contextBridge.exposeInMainWorld('mdexp', {
  readTextFileByPath,
  onOpenFile,
  setWindowOpacity,
  setAlwaysOnTop,
})
