import { get, set, del } from 'idb-keyval'
import type { ScanResult, TreeNode } from '../types'
import { matchesViewable } from './extensions'

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

/**
 * Recursively scan a directory, building the tree and a handle map of all files.
 * `viewable` is the set of lowercased extensions (without the leading dot) that should appear
 * in the sidebar tree and be counted as viewable.
 */
export async function scanDirectory(
  root: FileSystemDirectoryHandle,
  viewable: ReadonlySet<string>,
): Promise<ScanResult> {
  const files = new Map<string, FileSystemFileHandle>()
  let viewableCount = 0

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<TreeNode[]> {
    const dirs: TreeNode[] = []
    const viewableFiles: TreeNode[] = []

    // Enumerate the AsyncIterable's entries with for await...of.
    for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (name.startsWith('.')) continue // skip dotfiles/dot-folders
      const path = prefix ? `${prefix}/${name}` : name

      if (entry.kind === 'directory') {
        const children = await walk(entry as FileSystemDirectoryHandle, path)
        // Omit directories that contain no viewable files at all from the tree
        if (children.length > 0) {
          // Folders with viewable files directly inside (as child nodes) are highlighted
          const hasViewable = children.some((c) => c.kind === 'file')
          dirs.push({ path, name, kind: 'dir', children, hasViewable })
        }
      } else {
        const fileHandle = entry as FileSystemFileHandle
        files.set(path, fileHandle)
        if (matchesViewable(name, viewable)) {
          viewableCount++
          viewableFiles.push({ path, name, kind: 'file' })
        }
      }
    }

    const byName = (a: TreeNode, b: TreeNode) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    dirs.sort(byName)
    viewableFiles.sort(byName)
    // Order directories first, then files
    return [...dirs, ...viewableFiles]
  }

  const children = await walk(root, '')
  const tree: TreeNode = { path: '', name: root.name, kind: 'dir', children }
  return { tree, files, viewableCount }
}

/**
 * Resolve the absolute OS path of the scanned root by asking Electron for one of
 * the scanned files' on-disk paths, then peeling off the known relative segment.
 *
 * Why this exists: the FSA picker only hands us a `FileSystemDirectoryHandle` with
 * a basename — not the absolute path — and used to force a second native dialog
 * just to learn the root's OS location. With `webUtils.getPathForFile()` we can
 * derive it silently from the very first scanned file, so the Git Time Machine
 * works the moment a folder is opened.
 *
 * Returns null when:
 *   - the Electron bridge isn't present (web mode),
 *   - the root has no files to sample,
 *   - or the resolved absolute path doesn't end with the expected relative segment
 *     (defensive — would indicate a path-separator mismatch we can't reason about).
 */
export async function resolveRootAbsPath(
  files: Map<string, FileSystemFileHandle>,
): Promise<string | null> {
  const api = window.mdexp
  if (!api?.getPathForFile) return null
  const first = files.entries().next()
  if (first.done) return null
  const [relPath, handle] = first.value
  let file: File
  try {
    file = await handle.getFile()
  } catch {
    return null
  }
  const abs = api.getPathForFile(file)
  if (!abs) return null
  // FSA always uses forward slashes; the OS path may use either depending on platform.
  // Normalize so the suffix check works on Windows too.
  const normAbs = abs.replace(/\\/g, '/')
  const suffix = '/' + relPath
  if (!normAbs.endsWith(suffix)) return null
  // Slice from the original (un-normalized) to preserve native separators in the result.
  return abs.slice(0, abs.length - suffix.length)
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
