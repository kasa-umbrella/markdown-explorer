// メインは ESM(.js) で出力される。Electron の ESM ローダーは electron 組み込みの
// 名前付き export を解決できないため、createRequire で CJS require して API を取る。
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type ElectronModule from 'electron'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, protocol, net, session } =
  require('electron') as typeof ElectronModule

// dist-electron/main.js から見た各ルート
const dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.join(dirname, '..')
const RENDERER_DIST = path.join(APP_ROOT, 'dist')

// vite-plugin-electron が dev 時に注入する開発サーバ URL。本番では undefined。
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// 本番は file:// ではなく app:// で配信する。
// standard + secure にすることで:
//   - secure context が成立し showDirectoryPicker が使える
//   - origin が安定し idb-keyval に保存したフォルダハンドルが復元できる
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
    console.error(`[main] ロード失敗: ${code} ${desc} (${url})`)
  })

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadURL('app://local/index.html')
  }
}

app.whenReady().then(() => {
  // 前回フォルダの「無クリック復元」を成立させる肝。
  // ブラウザは File System Access の許可をセッション間で保持しないため、
  // 起動毎に handle.queryPermission が 'prompt' を返してしまう。
  // レンダラは app:// から読む自前の信頼済みコンテンツなので、
  // 'fileSystem' 権限だけ自動許可して再プロンプトを消す。
  const ses = session.defaultSession
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fileSystem')
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fileSystem')
  })

  // app://local/<path> を dist/<path> のファイルに対応づける
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
  // macOS は明示的に Cmd+Q するまで残すのが慣習
  if (process.platform !== 'darwin') app.quit()
})
