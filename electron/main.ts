// The main process is emitted as ESM (.js). Electron's ESM loader can't resolve the
// named exports of the built-in electron module, so we use createRequire to CJS-require the API.
import { createRequire } from 'node:module'
import { readFile, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type ElectronModule from 'electron'
import { decodeText } from '../src/lib/encoding'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, Menu, ipcMain, protocol, net, session } =
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

// All open main windows, in creation order (Set iteration preserves insertion).
// The renderer is multi-window capable: each entry is a full, independent explorer.
const mainWindows = new Set<BrowserWindow>()
// webContents that have finished their first load and can receive open-file pushes.
const readyWebContents = new WeakSet<Electron.WebContents>()
// The detached presenter window (true dual-screen). It loads the same renderer
// bundle with `?role=presenter`; messages are relayed between it and the main
// window through the present:* / to-* IPC channels below.
let presenterWin: BrowserWindow | null = null
// The main window that opened the presenter. Relays are scoped to this pair so a
// second explorer window can't accidentally drive someone else's presentation.
let presenterOwner: BrowserWindow | null = null

/**
 * The main window that OS-level events (Finder opens, CLI paths) should land in:
 * the focused one if it's a main window, otherwise the most recently created one.
 * Returns null when no main window exists (macOS with all windows closed).
 */
function targetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && mainWindows.has(focused)) return focused
  let last: BrowserWindow | null = null
  for (const w of mainWindows) last = w
  return last
}

// "Open With" / double-click handoff from Finder. The event can fire before app.ready
// on a cold launch, so the handler must be registered at module top, and incoming paths
// must be queued until the renderer is loaded and ready to receive them.
const pendingOpenPaths: string[] = []
/**
 * Same queueing strategy as pendingOpenPaths, but for *folders* — passed via the CLI
 * alias (`mdexp /path/to/dir` → `open -a markdown-explorer --args /path/to/dir`) or
 * via macOS folder-drops once Info.plist declares `public.folder` support.
 */
const pendingOpenDirs: string[] = []

function flushPending(): void {
  const target = targetWindow()
  if (!target || !readyWebContents.has(target.webContents)) return
  while (pendingOpenPaths.length > 0) {
    const p = pendingOpenPaths.shift()!
    target.webContents.send('mdexp:open-file', p)
  }
  while (pendingOpenDirs.length > 0) {
    const p = pendingOpenDirs.shift()!
    target.webContents.send('mdexp:open-dir', p)
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  // macOS also fires `open-file` for folder drops onto the dock icon / app bundle,
  // so we route by stat'ing the path and queueing into the right bucket. We don't
  // await here because the event handler is sync — the routing finishes by the time
  // the renderer asks for a flush.
  void routeIncomingPath(filePath)
})

/**
 * stat the path and decide which queue it belongs to. Silently drops paths that
 * don't exist or can't be reached — there's nothing useful we can show for those.
 */
async function routeIncomingPath(p: string): Promise<void> {
  try {
    const s = await stat(p)
    if (s.isDirectory()) {
      pendingOpenDirs.push(p)
    } else {
      pendingOpenPaths.push(p)
    }
    flushPending()
  } catch {
    // ENOENT etc. — nothing to open.
  }
}

/**
 * Pick the first argv entry that looks like an absolute path to something on disk.
 * We can't rely on positional indices because Electron prepends its own switches
 * (`--remote-debugging-port=…`, etc.) and the dev launcher passes `.` as the app
 * directory. Iterating and filtering by existence keeps the heuristic robust.
 *
 * Skipped in dev mode entirely — vite-plugin-electron passes the project root as
 * argv[1], which would otherwise be misread as a CLI-supplied folder and load the
 * source tree as the active root every time `npm run dev` ran.
 */
async function findPathInArgv(argv: readonly string[]): Promise<string | null> {
  if (DEV_SERVER_URL) return null
  // argv[0] is always the executable; everything after that could be a path.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg || arg.startsWith('-')) continue
    if (!path.isAbsolute(arg)) continue
    // The app's own bundled root looks like a real folder to `stat`, but it's never
    // what the user meant to open — guard against the production case where the OS
    // re-passes the .app bundle path as argv[1].
    if (arg === APP_ROOT) continue
    try {
      await stat(arg)
      return arg
    } catch {
      // Not a real path — keep looking.
    }
  }
  return null
}

// Enforce single-instance so the CLI alias's second invocation activates the existing
// window with the new path instead of spawning a duplicate app. The lock has to be
// requested before any window is created (i.e. synchronously here at module top).
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', (_event, argv) => {
  // A second `mdexp /foo` arrived. Pull the path out of the new argv, route into the
  // pending queue, and focus the target window so the user sees the result. On macOS
  // the app can be alive with zero windows — spawn one so the path has somewhere to go.
  void (async () => {
    const incoming = await findPathInArgv(argv)
    if (incoming) await routeIncomingPath(incoming)
    const target = targetWindow()
    if (target) {
      if (target.isMinimized()) target.restore()
      target.focus()
    } else {
      createWindow()
    }
  })()
})

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Markdown Explorer',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
    },
  })
  mainWindows.add(win)

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] load failed: ${code} ${desc} (${url})`)
  })

  win.webContents.on('did-finish-load', () => {
    readyWebContents.add(win.webContents)
    flushPending()
  })

  // Cmd/Ctrl+W normally closes the window via the default app menu accelerator.
  // Intercept it so the renderer can close the active tab first; if no tabs are
  // open, the renderer asks us back to actually close the window.
  // Cmd/Ctrl+R is similarly intercepted so it reloads the active tab's content
  // from disk instead of the whole BrowserWindow. Shift+R is left alone so the
  // default "force reload" still works for dev.
  // Cmd/Ctrl+N opens another full explorer window.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.alt || input.shift) return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod) return
    const key = input.key.toLowerCase()
    if (key === 'w') {
      event.preventDefault()
      win.webContents.send('mdexp:close-active-tab')
      return
    }
    if (key === 'r') {
      event.preventDefault()
      win.webContents.send('mdexp:reload-active-tab')
      return
    }
    if (key === 'n') {
      event.preventDefault()
      createWindow()
    }
  })

  win.on('closed', () => {
    mainWindows.delete(win)
    // The presenter window is meaningless without the window it mirrors; other
    // explorer windows keep living independently.
    if (presenterOwner === win && presenterWin && !presenterWin.isDestroyed()) {
      presenterWin.close()
    }
  })

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadURL('app://local/index.html')
  }
  return win
}

/**
 * Open (or focus) the detached presenter window on behalf of `owner`. It loads the
 * same renderer with `?role=presenter`, which mounts the lightweight presenter
 * mirror. There is a single presenter at a time; if another explorer window starts
 * presenting, ownership moves to it (that window pushes its own deck-init next).
 * When the user closes the presenter, the owning window is told so its in-app
 * state can follow.
 */
function createPresenterWindow(owner: BrowserWindow): void {
  presenterOwner = owner
  if (presenterWin && !presenterWin.isDestroyed()) {
    presenterWin.focus()
    return
  }
  presenterWin = new BrowserWindow({
    width: 960,
    height: 720,
    title: '発表者ビュー',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
    },
  })
  const target = DEV_SERVER_URL
    ? `${DEV_SERVER_URL}?role=presenter`
    : 'app://local/index.html?role=presenter'
  presenterWin.loadURL(target)
  presenterWin.on('closed', () => {
    presenterWin = null
    const owner = presenterOwner
    presenterOwner = null
    if (owner && !owner.isDestroyed()) {
      owner.webContents.send('mdexp:presenter-closed')
    }
  })
}

/**
 * Recursively walk `absoluteRoot` for the native-mode scan IPC. Returns a flat
 * list of `{ relPath, absPath }` for every file under the root (directories are
 * inferred on the renderer side). Mirrors the FSA walker's exclusions: `.git` is
 * always skipped, and dot-prefixed entries are skipped unless `showHidden`.
 *
 * Errors on individual subtrees (permission denied, broken symlinks, etc.) are
 * swallowed — the same way the FSA path silently drops anything the browser
 * refuses to enumerate.
 */
async function walkDirectory(
  absoluteRoot: string,
  options: { showHidden: boolean },
): Promise<{ relPath: string; absPath: string }[]> {
  const entries: { relPath: string; absPath: string }[] = []
  const normalizedRoot = absoluteRoot.replace(/[/\\]+$/, '')

  async function walk(dirAbs: string, prefix: string): Promise<void> {
    let children
    try {
      children = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      const name = child.name
      if (name === '.git') continue
      if (!options.showHidden && name.startsWith('.')) continue
      const relPath = prefix ? `${prefix}/${name}` : name
      const absChild = path.join(dirAbs, name)
      if (child.isDirectory()) {
        await walk(absChild, relPath)
      } else if (child.isFile()) {
        entries.push({ relPath, absPath: absChild })
      }
      // Skip symlinks / sockets / etc. — same posture as the FSA walker, which
      // only sees `file` and `directory` from the AsyncIterable.
    }
  }

  await walk(normalizedRoot, '')
  return entries
}

app.whenReady().then(async () => {
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
    // Read raw bytes and auto-detect UTF-8 vs Shift_JIS rather than assuming UTF-8,
    // so legacy Japanese files (Excel CSVs, etc.) don't come back as mojibake.
    return decodeText(await readFile(filePath))
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

  // Recursive walk for native-mode scans (CLI alias / open-folder entry points).
  // The renderer turns the flat result into the tree shape the sidebar expects.
  ipcMain.handle(
    'mdexp:scan-dir-by-path',
    async (_e, rawPath: unknown, rawOptions: unknown) => {
      if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) {
        throw new Error('expected an absolute directory path')
      }
      const showHidden =
        typeof rawOptions === 'object' &&
        rawOptions !== null &&
        'showHidden' in rawOptions &&
        Boolean((rawOptions as { showHidden?: unknown }).showHidden)
      try {
        const s = await stat(rawPath)
        if (!s.isDirectory()) throw new Error('path is not a directory')
      } catch (err) {
        throw new Error(`cannot read directory: ${String(err)}`, { cause: err })
      }
      return walkDirectory(rawPath, { showHidden })
    },
  )

  // Window-level settings driven by the renderer's settings UI. Each handler acts
  // on the window that sent the message, so every explorer window is independent.
  ipcMain.on('mdexp:set-opacity', (e, opacity: unknown) => {
    const sender = BrowserWindow.fromWebContents(e.sender)
    if (!sender) return
    const n = typeof opacity === 'number' ? opacity : NaN
    // setOpacity ignores anything < 0 or > 1, but we clamp to a sane floor so the
    // window never becomes effectively invisible (and untouchable) by accident.
    if (Number.isFinite(n)) sender.setOpacity(Math.min(1, Math.max(0.2, n)))
  })

  ipcMain.on('mdexp:set-always-on-top', (e, flag: unknown) => {
    BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(Boolean(flag))
  })

  // Fallback close used when the renderer has no tabs left to close on Cmd+W.
  ipcMain.on('mdexp:close-window', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  // Open another full explorer window (settings UI / renderer shortcut fallback).
  ipcMain.on('mdexp:new-window', () => {
    createWindow()
  })

  // ── Detached presenter window (dual-screen) ──
  // Open/close requested by a main window's presentation overlay. The requesting
  // window becomes the presenter's owner; relays below are scoped to that pair.
  ipcMain.on('mdexp:presenter-open', (e) => {
    const sender = BrowserWindow.fromWebContents(e.sender)
    if (sender && mainWindows.has(sender)) createPresenterWindow(sender)
  })
  ipcMain.on('mdexp:presenter-close', (e) => {
    const sender = BrowserWindow.fromWebContents(e.sender)
    if (sender !== presenterOwner) return
    if (presenterWin && !presenterWin.isDestroyed()) presenterWin.close()
  })
  // Relay deck / index pushes from the owning window to the presenter window…
  ipcMain.on('mdexp:to-presenter', (e, msg: unknown) => {
    if (BrowserWindow.fromWebContents(e.sender) !== presenterOwner) return
    presenterWin?.webContents.send('mdexp:presenter-msg', msg)
  })
  // …and navigation / exit commands (plus the initial "ready") back the other way.
  ipcMain.on('mdexp:to-main', (_e, msg: unknown) => {
    if (presenterOwner && !presenterOwner.isDestroyed()) {
      presenterOwner.webContents.send('mdexp:main-msg', msg)
    }
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

  // Contents of a file at HEAD, for the preview's in-document git-diff markers.
  //
  // Given an absolute path to the file currently open in the preview, we run git
  // *in that file's directory* and ask for `HEAD:./<basename>` — the `./` makes the
  // pathspec resolve relative to the cwd, so it works whether the file sits at the
  // repo root or deep in a sub-directory. Bytes are read raw (encoding: 'buffer')
  // and decoded the same way working-tree files are, so Shift_JIS docs diff cleanly
  // against their already-decoded current text.
  //
  // Returns:
  //   - null                   → not inside a git repo (or git unavailable): no markers
  //   - { head: string }       → the committed text to diff against
  //   - { head: null }         → tracked path has no HEAD revision yet (new / untracked
  //                              file): the renderer treats the whole document as added
  ipcMain.handle('mdexp:git-file-diff', async (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('expected an absolute file path')
    }
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    try {
      await execFileP('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])
    } catch {
      return null
    }
    try {
      const { stdout } = await execFileP(
        'git',
        ['-c', 'core.quotepath=false', 'show', `HEAD:./${base}`],
        { cwd: dir, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      )
      return { head: decodeText(stdout as Buffer) }
    } catch {
      // No committed revision of this path — a newly added / untracked file.
      return { head: null }
    }
  })

  // macOS Dock icon context menu: mirror the Cmd+N / settings-modal entry point.
  // Unlike the in-window shortcut this also works when every window is closed
  // (the app stays alive on macOS), so it doubles as a "reopen" affordance.
  if (process.platform === 'darwin') {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: '新しいウィンドウを開く', click: () => createWindow() },
      ]),
    )
  }

  // Cold-launch CLI: if `mdexp /some/dir` started the app, capture that path now so
  // it's queued before the renderer asks for a flush. routeIncomingPath stats the
  // path itself, so the file-vs-folder distinction is already handled.
  const initialPath = await findPathInArgv(process.argv)
  if (initialPath) await routeIncomingPath(initialPath)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS, the convention is to keep the app alive until the user explicitly hits Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})
