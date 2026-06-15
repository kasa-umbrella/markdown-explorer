// The main process is emitted as ESM (.js). Electron's ESM loader can't resolve the
// named exports of the built-in electron module, so we use createRequire to CJS-require the API.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type ElectronModule from 'electron'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, dialog, ipcMain, protocol, net, session } =
  require('electron') as typeof ElectronModule

const execFileP = promisify(execFile)

/**
 * Collapse a porcelain v1 two-letter status code into the single tag the sidebar
 * cares about. We surface untracked (`??`) as `U` so the UI can distinguish "new
 * file the user hasn't added yet" from "newly added to the index", but everything
 * else is reduced to its dominant axis. Returns null for codes we don't paint
 * (`!!` ignored, etc.).
 */
function simplifyStatus(xy: string): 'M' | 'A' | 'D' | 'R' | 'U' | null {
  if (xy === '??') return 'U'
  if (xy[0] === 'D' || xy[1] === 'D') return 'D'
  if (xy[0] === 'A' || xy[1] === 'A') return 'A'
  if (xy[0] === 'R' || xy[1] === 'R') return 'R'
  if (xy[0] === 'M' || xy[1] === 'M') return 'M'
  return null
}

/**
 * Resolve the git toplevel directory for a file by running `git rev-parse` in its parent dir.
 * Returns null when the file isn't tracked under any repository (or git isn't installed).
 */
async function gitToplevelOf(absoluteFilePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', path.dirname(absoluteFilePath), 'rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

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

  // Cmd/Ctrl+W normally closes the window via the default app menu accelerator.
  // Intercept it so the renderer can close the active tab first; if no tabs are
  // open, the renderer asks us back to actually close the window.
  // Cmd/Ctrl+R is similarly intercepted so it reloads the active tab's content
  // from disk instead of the whole BrowserWindow. Shift+R is left alone so the
  // default "force reload" still works for dev.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.alt || input.shift) return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod) return
    const key = input.key.toLowerCase()
    if (key === 'w') {
      event.preventDefault()
      win?.webContents.send('mdexp:close-active-tab')
      return
    }
    if (key === 'r') {
      event.preventDefault()
      win?.webContents.send('mdexp:reload-active-tab')
    }
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

  // Read an absolute file path on disk and return its raw bytes.
  // Used by the renderer to resolve relative image references inside externally-opened
  // markdown — those files live outside the FSA root, so we can't use the handle map.
  // The returned ArrayBuffer is wrapped into a Blob URL on the renderer side.
  ipcMain.handle('mdexp:read-binary-file', async (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('expected an absolute file path')
    }
    const buf = await readFile(filePath)
    // Slice to a fresh ArrayBuffer so we don't leak Node's pooled Buffer backing store
    // across the IPC boundary.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
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

  // Fallback close used when the renderer has no tabs left to close on Cmd+W.
  ipcMain.on('mdexp:close-window', () => {
    win?.close()
  })

  // Native directory picker — used by the renderer to learn the absolute OS path
  // of the active root (the File System Access picker only exposes a handle / basename,
  // which isn't enough to run git against). Returns the chosen path or null on cancel.
  ipcMain.handle('mdexp:choose-directory', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'フォルダの場所を選んでください',
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })

  // List the commit history that touched a specific file, newest first.
  // `--follow` keeps the chain across renames. Records are delimited with the ASCII
  // record-separator so subjects can safely contain newlines, tabs, etc.
  ipcMain.handle('mdexp:git-history', async (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('expected an absolute file path')
    }
    const top = await gitToplevelOf(filePath)
    if (!top) return []
    const rel = path.relative(top, filePath)
    const FMT = '%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1e'
    const { stdout } = await execFileP(
      'git',
      ['-C', top, 'log', '--follow', `--format=${FMT}`, '--', rel],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    const rows = stdout.split('\x1e').map((r) => r.replace(/^\n+/, '')).filter(Boolean)
    return rows.map((r) => {
      const [sha, shortSha, dateISO, authorName, subject] = r.split('\x1f')
      return { sha, shortSha, dateISO, authorName, subject }
    })
  })

  // Porcelain git status for the active root, returned as `{ path → status }`.
  //
  // We run `git -C <root> status --porcelain=v1 -z -uall -- .` so:
  //   - paths are relative to <root> (not the repo's toplevel — important when the
  //     active root is a sub-directory of a larger repo);
  //   - `-z` + NUL terminators keep filenames with newlines / quotes intact;
  //   - `-uall` expands untracked directories into individual file entries
  //     (without it, untracked sub-trees show as `dir/` and never match a tree path);
  //   - `-- .` limits scope to files under <root> so sibling changes elsewhere in
  //     the repo don't pollute the sidebar;
  //   - `core.quotepath=false` makes non-ASCII paths roundtrip as raw UTF-8.
  //
  // The two-letter XY code is collapsed into a single character: M / A / D / R / U
  // (untracked). Returns `null` when <root> isn't inside a git repository or git
  // isn't available, so the renderer can degrade gracefully.
  ipcMain.handle('mdexp:git-status', async (_e, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new Error('expected an absolute directory path')
    }
    try {
      await execFileP('git', ['-C', rootPath, 'rev-parse', '--is-inside-work-tree'])
    } catch {
      return null
    }
    try {
      const { stdout } = await execFileP(
        'git',
        [
          '-c',
          'core.quotepath=false',
          '-C',
          rootPath,
          'status',
          '--porcelain=v1',
          '-z',
          '-uall',
          '--',
          '.',
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      )
      const result: Record<string, 'M' | 'A' | 'D' | 'R' | 'U'> = {}
      // -z output is a stream of NUL-terminated fields. Most records are one field
      // ("XY <path>"), but R/C records are followed by a second NUL-terminated field
      // holding the original path — we want to advance past it so it isn't parsed
      // as a fresh status entry.
      const fields = stdout.split('\0')
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        if (!field) continue
        if (field.length < 3) continue
        const xy = field.slice(0, 2)
        const relPath = field.slice(3)
        const isRenameOrCopy = xy[0] === 'R' || xy[0] === 'C'
        if (isRenameOrCopy) i++ // skip the "from" path that follows
        if (relPath.startsWith('..')) continue // outside <root>; shouldn't happen with `-- .`, but be defensive
        const code = simplifyStatus(xy)
        if (code) result[relPath] = code
      }
      return result
    } catch (err) {
      console.error('[git-status] failed:', err)
      return null
    }
  })

  // Read a file's content at a specific revision (`git show <sha>:<rel>`).
  // SHA is validated to a hex string so it can be safely interpolated into the ref.
  ipcMain.handle('mdexp:git-show', async (_e, filePath: unknown, sha: unknown) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('expected an absolute file path')
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{4,40}$/i.test(sha)) {
      throw new Error('invalid sha')
    }
    const top = await gitToplevelOf(filePath)
    if (!top) throw new Error('not a git repository')
    const rel = path.relative(top, filePath)
    const { stdout } = await execFileP(
      'git',
      ['-C', top, 'show', `${sha}:${rel}`],
      { maxBuffer: 64 * 1024 * 1024 },
    )
    return stdout
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
