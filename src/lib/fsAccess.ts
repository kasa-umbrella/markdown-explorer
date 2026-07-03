import { get, set, del } from 'idb-keyval'
import type { FileEntry, NativeFileRef, ScanResult, TreeNode } from '../types'
import { matchesViewable } from './extensions'
import { decodeText } from './encoding'

/** idb key for the FSA-picker handle of the last-opened root. */
const HANDLE_KEY = 'rootDirHandle'
/**
 * idb key for the absolute OS path of the last "native mode" root (folder opened
 * via the CLI alias / open-file folder drop). Restored on launch when the user
 * didn't pass a fresh path through the CLI.
 */
const NATIVE_PATH_KEY = 'rootDirNativePath'

/** Whether the File System Access API is available in this browser. */
export function isFsAccessSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

/** Type guard: this entry was produced by the native (Node fs) scan path. */
export function isNativeEntry(entry: FileEntry): entry is NativeFileRef {
  return (entry as NativeFileRef).kind === 'native'
}

/** Open the folder picker, save the chosen handle to IndexedDB, and return it. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ mode: 'read' })
  await set(HANDLE_KEY, handle)
  // Picking a fresh FSA folder is treated as the user's explicit intent to leave
  // any prior native-mode root behind.
  await del(NATIVE_PATH_KEY)
  return handle
}

/** Restore the previously saved FSA folder handle. Returns null if none. */
export async function restoreDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await get<FileSystemDirectoryHandle>(HANDLE_KEY)
  return handle ?? null
}

/** Restore the previously saved native-mode absolute root path. Null if none. */
export async function restoreNativePath(): Promise<string | null> {
  const p = await get<string>(NATIVE_PATH_KEY)
  return p ?? null
}

/** Persist `absPath` as the native-mode root for restore on the next launch. */
export async function rememberNativePath(absPath: string): Promise<void> {
  await set(NATIVE_PATH_KEY, absPath)
  // Native and FSA are mutually exclusive at the "last root" level — the renderer
  // restore chain prefers native when both exist, so the leftover FSA handle would
  // never be reached anyway, but clearing keeps the saved state truthful.
  await del(HANDLE_KEY)
}

/** Discard both saved roots. */
export async function forgetDirectory(): Promise<void> {
  await del(HANDLE_KEY)
  await del(NATIVE_PATH_KEY)
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
 * in the sidebar tree and be counted as viewable. When `showHidden` is false (default),
 * entries whose name begins with `.` are skipped — that's where `.git/`, `.claude/`, etc.
 * normally hide. `.git` is *always* skipped regardless of the flag: even with viewable files
 * filtered out, recursing into it is needlessly slow and never useful for reading docs.
 */
export async function scanDirectory(
  root: FileSystemDirectoryHandle,
  viewable: ReadonlySet<string>,
  options: { showHidden?: boolean } = {},
): Promise<ScanResult> {
  const showHidden = options.showHidden ?? false
  const files = new Map<string, FileEntry>()
  let viewableCount = 0

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<TreeNode[]> {
    const dirs: TreeNode[] = []
    const viewableFiles: TreeNode[] = []

    // Enumerate the AsyncIterable's entries with for await...of.
    for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (name === '.git') continue // never recurse into git's object store
      if (!showHidden && name.startsWith('.')) continue
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
 * Native-mode counterpart to `scanDirectory`: ask the main process to walk
 * `absoluteRoot` via Node fs and convert the returned flat tree into the
 * sidebar shape. `files` is populated with `{ kind:'native', absPath }`
 * records so read helpers can fetch via IPC.
 *
 * Returns null when the bridge is unavailable (i.e. running in a plain browser).
 */
export async function scanDirectoryByPath(
  absoluteRoot: string,
  viewable: ReadonlySet<string>,
  options: { showHidden?: boolean } = {},
): Promise<ScanResult | null> {
  const api = window.mdexp
  if (!api?.scanDirByPath) return null
  const showHidden = options.showHidden ?? false
  const flat = await api.scanDirByPath(absoluteRoot, { showHidden })

  const files = new Map<string, FileEntry>()
  let viewableCount = 0

  /** path → directory TreeNode, populated lazily so child links resolve in O(1). */
  const dirIndex = new Map<string, TreeNode>()
  // We strip a trailing slash so the root's basename calculation matches what FSA
  // would give us (folder name only, no separator).
  const trimmedRoot = absoluteRoot.replace(/[/\\]+$/, '')
  const rootName = trimmedRoot.split(/[/\\]/).pop() ?? trimmedRoot
  const rootNode: TreeNode = { path: '', name: rootName, kind: 'dir', children: [] }
  dirIndex.set('', rootNode)

  /**
   * Walk an entry's relative path and materialize any missing ancestor folder
   * nodes along the way. Returns the immediate parent node so the caller can
   * attach the leaf without worrying about intermediate creation order.
   */
  function ensureParent(relPath: string): TreeNode {
    const segments = relPath.split('/')
    let current = rootNode
    let cursor = ''
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      cursor = cursor ? `${cursor}/${seg}` : seg
      let next = dirIndex.get(cursor)
      if (!next) {
        next = { path: cursor, name: seg, kind: 'dir', children: [] }
        dirIndex.set(cursor, next)
        current.children!.push(next)
      }
      current = next
    }
    return current
  }

  // Pass 1: register every file in the map and attach viewable ones to the tree.
  for (const entry of flat) {
    const relPath = entry.relPath
    const absPath = entry.absPath
    const name = relPath.split('/').pop() ?? relPath
    files.set(relPath, { kind: 'native', absPath })
    if (!matchesViewable(name, viewable)) continue
    viewableCount++
    const parent = ensureParent(relPath)
    parent.children!.push({ path: relPath, name, kind: 'file' })
  }

  // Pass 2: strip empty directories, mark folders that directly hold viewable files,
  // and sort each level (directories first, then files, both by natural name order).
  const byName = (a: TreeNode, b: TreeNode) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  function finalize(node: TreeNode): boolean {
    if (node.kind === 'file') return true
    const kept: TreeNode[] = []
    let directViewable = false
    for (const child of node.children ?? []) {
      const keep = finalize(child)
      if (!keep) continue
      kept.push(child)
      if (child.kind === 'file') directViewable = true
    }
    kept.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return byName(a, b)
    })
    node.children = kept
    if (node.path === '') return true // never prune the synthetic root
    node.hasViewable = directViewable
    // Drop any directory that ended up with no viewable descendants — same UX as the
    // FSA path, which also omits empty branches from the sidebar.
    return kept.length > 0
  }
  finalize(rootNode)

  return { tree: rootNode, files, viewableCount }
}

/**
 * Resolve the absolute OS path of the scanned root.
 *
 * Two code paths converge here:
 *   - Native-mode scans already know the absolute root, so we just sniff it from any
 *     entry in the map (every native entry carries `absPath` directly).
 *   - FSA scans only hand us a basename; we ask Electron for the on-disk path of one
 *     scanned file via `webUtils.getPathForFile()` and peel the relative segment off.
 *
 * Returns null when:
 *   - the Electron bridge isn't present (web mode),
 *   - the root has no files to sample,
 *   - or the resolved absolute path doesn't end with the expected relative segment
 *     (defensive — would indicate a path-separator mismatch we can't reason about).
 */
export async function resolveRootAbsPath(
  files: Map<string, FileEntry>,
): Promise<string | null> {
  const first = files.entries().next()
  if (first.done) return null
  const [relPath, entry] = first.value
  if (isNativeEntry(entry)) {
    const suffix = '/' + relPath
    const normAbs = entry.absPath.replace(/\\/g, '/')
    if (!normAbs.endsWith(suffix)) return null
    return entry.absPath.slice(0, entry.absPath.length - suffix.length)
  }
  const api = window.mdexp
  if (!api?.getPathForFile) return null
  let file: File
  try {
    file = await entry.getFile()
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
  files: Map<string, FileEntry>,
  path: string,
): Promise<string> {
  const entry = files.get(path)
  if (!entry) throw new Error(`File not found: ${path}`)
  if (isNativeEntry(entry)) {
    const api = window.mdexp
    if (!api?.readTextFileByPath) {
      throw new Error('Native bridge unavailable; cannot read by absolute path')
    }
    // Encoding auto-detection happens in the main process (see the IPC handler).
    return api.readTextFileByPath(entry.absPath)
  }
  // Read bytes, not file.text(): the latter is locked to UTF-8 and mangles
  // Shift_JIS. decodeText() sniffs the encoding instead.
  const file = await entry.getFile()
  return decodeText(await file.arrayBuffer())
}

/** Read one file from the map and return a Blob URL (for images, etc.). */
export async function readBlobUrl(
  files: Map<string, FileEntry>,
  path: string,
): Promise<string | null> {
  const entry = files.get(path)
  if (!entry) return null
  if (isNativeEntry(entry)) {
    const api = window.mdexp
    if (!api?.readBinaryFileByPath) return null
    try {
      const buf = await api.readBinaryFileByPath(entry.absPath)
      const blob = new Blob([buf])
      return URL.createObjectURL(blob)
    } catch {
      return null
    }
  }
  const file = await entry.getFile()
  return URL.createObjectURL(file)
}
