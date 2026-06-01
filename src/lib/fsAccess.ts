import { get, set, del } from 'idb-keyval'
import type { ScanResult, TreeNode } from '../types'

const HANDLE_KEY = 'rootDirHandle'

/** Whether the File System Access API is available in this browser. */
export function isFsAccessSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

/** Open the folder picker, save the chosen handle to IndexedDB, and return it. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ mode: 'read' })
  await set(HANDLE_KEY, handle)
  return handle
}

/** Restore the previously saved folder handle. Returns null if none. */
export async function restoreDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await get<FileSystemDirectoryHandle>(HANDLE_KEY)
  return handle ?? null
}

/** Discard the saved handle. */
export async function forgetDirectory(): Promise<void> {
  await del(HANDLE_KEY)
}

/**
 * Check and, if needed, request read permission for a handle.
 * @param prompt If true, the permission dialog may be shown to the user (call this from a user action such as a click).
 */
export async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
  prompt: boolean,
): Promise<boolean> {
  // These are browser-extension methods missing from the type defs, so we call them via an as cast.
  const h = handle as unknown as {
    queryPermission(d: { mode: 'read' }): Promise<PermissionState>
    requestPermission(d: { mode: 'read' }): Promise<PermissionState>
  }
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true
  if (!prompt) return false
  return (await h.requestPermission({ mode: 'read' })) === 'granted'
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i

/** Recursively scan a directory, building the tree and a handle map of all files. */
export async function scanDirectory(root: FileSystemDirectoryHandle): Promise<ScanResult> {
  const files = new Map<string, FileSystemFileHandle>()
  let markdownCount = 0

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<TreeNode[]> {
    const dirs: TreeNode[] = []
    const mdFiles: TreeNode[] = []

    // Enumerate the AsyncIterable's entries with for await...of.
    for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (name.startsWith('.')) continue // skip dotfiles/dot-folders
      const path = prefix ? `${prefix}/${name}` : name

      if (entry.kind === 'directory') {
        const children = await walk(entry as FileSystemDirectoryHandle, path)
        // Omit directories that contain no .md at all from the tree
        if (children.length > 0) {
          // Folders with .md files directly inside (as child nodes) are highlighted
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
    // Order directories first, then files
    return [...dirs, ...mdFiles]
  }

  const children = await walk(root, '')
  const tree: TreeNode = { path: '', name: root.name, kind: 'dir', children }
  return { tree, files, markdownCount }
}

/** Read one file from the map and return it as text. */
export async function readTextFile(
  files: Map<string, FileSystemFileHandle>,
  path: string,
): Promise<string> {
  const handle = files.get(path)
  if (!handle) throw new Error(`File not found: ${path}`)
  const file = await handle.getFile()
  return file.text()
}

/** Read one file from the map and return a Blob URL (for images, etc.). */
export async function readBlobUrl(
  files: Map<string, FileSystemFileHandle>,
  path: string,
): Promise<string | null> {
  const handle = files.get(path)
  if (!handle) return null
  const file = await handle.getFile()
  return URL.createObjectURL(file)
}
