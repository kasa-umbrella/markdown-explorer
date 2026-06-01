import { get, set, del } from 'idb-keyval'
import type { ScanResult, TreeNode } from '../types'

const HANDLE_KEY = 'rootDirHandle'

/** File System Access API がこのブラウザで使えるか。 */
export function isFsAccessSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

/** フォルダ選択ダイアログを開き、選ばれたハンドルを IndexedDB に保存して返す。 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ mode: 'read' })
  await set(HANDLE_KEY, handle)
  return handle
}

/** 前回保存したフォルダのハンドルを復元する。無ければ null。 */
export async function restoreDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await get<FileSystemDirectoryHandle>(HANDLE_KEY)
  return handle ?? null
}

/** 保存済みハンドルを破棄する。 */
export async function forgetDirectory(): Promise<void> {
  await del(HANDLE_KEY)
}

/**
 * ハンドルの読み取り権限を確認・要求する。
 * @param prompt true ならユーザーへの許可ダイアログを出してよい（クリック等のユーザー操作起点で呼ぶこと）。
 */
export async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
  prompt: boolean,
): Promise<boolean> {
  // 型定義に無いブラウザ拡張メソッドのため as 経由で叩く。
  const h = handle as unknown as {
    queryPermission(d: { mode: 'read' }): Promise<PermissionState>
    requestPermission(d: { mode: 'read' }): Promise<PermissionState>
  }
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true
  if (!prompt) return false
  return (await h.requestPermission({ mode: 'read' })) === 'granted'
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i

/** ディレクトリを再帰走査し、ツリーと全ファイルのハンドルマップを作る。 */
export async function scanDirectory(root: FileSystemDirectoryHandle): Promise<ScanResult> {
  const files = new Map<string, FileSystemFileHandle>()
  let markdownCount = 0

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<TreeNode[]> {
    const dirs: TreeNode[] = []
    const mdFiles: TreeNode[] = []

    // for await...of で AsyncIterable のエントリを列挙する。
    for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (name.startsWith('.')) continue // ドットファイル/フォルダはスキップ
      const path = prefix ? `${prefix}/${name}` : name

      if (entry.kind === 'directory') {
        const children = await walk(entry as FileSystemDirectoryHandle, path)
        // .md を1つも含まないディレクトリはツリーから省く
        if (children.length > 0) {
          // 直下（子ノード）に .md ファイルがあるフォルダはハイライト対象
          const hasMarkdown = children.some((c) => c.kind === 'file')
          dirs.push({ path, name, kind: 'dir', children, hasMarkdown })
        }
      } else {
        const fileHandle = entry as FileSystemFileHandle
        files.set(path, fileHandle)
        if (MD_EXT.test(name)) {
          markdownCount++
          mdFiles.push({ path, name, kind: 'file' })
        }
      }
    }

    const byName = (a: TreeNode, b: TreeNode) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    dirs.sort(byName)
    mdFiles.sort(byName)
    // ディレクトリを先、ファイルを後に並べる
    return [...dirs, ...mdFiles]
  }

  const children = await walk(root, '')
  const tree: TreeNode = { path: '', name: root.name, kind: 'dir', children }
  return { tree, files, markdownCount }
}

/** マップから1ファイルを読み、テキストとして返す。 */
export async function readTextFile(
  files: Map<string, FileSystemFileHandle>,
  path: string,
): Promise<string> {
  const handle = files.get(path)
  if (!handle) throw new Error(`ファイルが見つからない: ${path}`)
  const file = await handle.getFile()
  return file.text()
}

/** マップから1ファイルを読み、Blob URL を返す（画像など）。 */
export async function readBlobUrl(
  files: Map<string, FileSystemFileHandle>,
  path: string,
): Promise<string | null> {
  const handle = files.get(path)
  if (!handle) return null
  const file = await handle.getFile()
  return URL.createObjectURL(file)
}
