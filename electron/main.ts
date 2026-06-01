// The main process is emitted as ESM (.js). Electron's ESM loader can't resolve the
// named exports of the built-in electron module, so we use createRequire to CJS-require the API.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type ElectronModule from 'electron'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, protocol, net, session } =
  require('electron') as typeof ElectronModule

// Roots as seen from dist-electron/main.js
const dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.join(dirname, '..')
const RENDERER_DIST = path.join(APP_ROOT, 'dist')

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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'markdown-explorer',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] load failed: ${code} ${desc} (${url})`)
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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS, the convention is to keep the app alive until the user explicitly hits Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})
