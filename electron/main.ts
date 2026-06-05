// The main process is emitted as ESM (.js). Electron's ESM loader can't resolve the
// named exports of the built-in electron module, so we use createRequire to CJS-require the API.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type ElectronModule from 'electron'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, ipcMain, protocol, net, session } =
  require('electron') as typeof ElectronModule

// Roots as seen from dist-electron/main.js
const dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.join(dirname, '..')
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
const PRELOAD = path.join(dirname, 'preload.mjs')

// Dev server URL injected by vite-plugin-electron during dev. undefined in production.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// In production we serve over app:// instead of file://.
// Marking it standard + secure means:
//   - a secure context is established, so showDirectoryPicker is available
//   - the origin is stable, so folder handles saved in idb-keyval can be restored
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])

let win: BrowserWindow | null = null

// "Open With" / double-click handoff from Finder. The event can fire before app.ready
// on a cold launch, so the handler must be registered at module top, and incoming paths
// must be queued until the renderer is loaded and ready to receive them.
const pendingOpenPaths: string[] = []
let rendererReady = false

function flushPendingOpens(): void {
  if (!rendererReady || !win) return
  while (pendingOpenPaths.length > 0) {
    const p = pendingOpenPaths.shift()!
    win.webContents.send('mdexp:open-file', p)
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  pendingOpenPaths.push(filePath)
  flushPendingOpens()
})

function createWindow(): void {
  rendererReady = false
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Markdown Explorer',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
    },
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] load failed: ${code} ${desc} (${url})`)
  })

  win.webContents.on('did-finish-load', () => {
    rendererReady = true
    flushPendingOpens()
  })

  win.on('closed', () => {
    rendererReady = false
    win = null
  })

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadURL('app://local/index.html')
  }
}

app.whenReady().then(() => {
  // The key to making "no-click restore" of the last folder work.
  // Browsers don't persist File System Access permissions across sessions,
  // so handle.queryPermission returns 'prompt' on every launch.
  // Since the renderer is our own trusted content loaded from app://,
  // we auto-grant only the 'fileSystem' permission to suppress the re-prompt.
  const ses = session.defaultSession
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fileSystem')
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fileSystem')
  })

  // Map app://local/<path> to the file at dist/<path>
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url)
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
    const filePath = path.join(RENDERER_DIST, relative)
    return net.fetch(pathToFileURL(filePath).toString())
  })

  // Read an absolute file path on disk and return its text content.
  // Used by the renderer to handle drops from sources (e.g. VSCode) that only
  // supply a file path string, not a File object.
  ipcMain.handle('mdexp:read-text-file', async (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('expected an absolute file path')
    }
    return readFile(filePath, 'utf8')
  })

  // Window-level settings driven by the renderer's settings UI.
  ipcMain.on('mdexp:set-opacity', (_e, opacity: unknown) => {
    if (!win) return
    const n = typeof opacity === 'number' ? opacity : NaN
    // setOpacity ignores anything < 0 or > 1, but we clamp to a sane floor so the
    // window never becomes effectively invisible (and untouchable) by accident.
    if (Number.isFinite(n)) win.setOpacity(Math.min(1, Math.max(0.2, n)))
  })

  ipcMain.on('mdexp:set-always-on-top', (_e, flag: unknown) => {
    if (!win) return
    win.setAlwaysOnTop(Boolean(flag))
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS, the convention is to keep the app alive until the user explicitly hits Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})
