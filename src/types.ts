/** A single node in the tree: a directory or a viewable file. */
export interface TreeNode {
  /** Path relative to the root. e.g. "docs/guide.md" */
  path: string
  /** Display name (the last segment of the path) */
  name: string
  kind: 'dir' | 'file'
  /** Only when kind === 'dir'. Child nodes sorted by name. */
  children?: TreeNode[]
  /** Only when kind === 'dir'. True if the folder directly contains viewable files. */
  hasViewable?: boolean
}

/**
 * Reference to a single file inside the scanned root.
 *
 * Two backends produce scans:
 *   - the FSA picker hands us `FileSystemFileHandle`s straight from the browser API
 *   - the Electron CLI / "open this folder" entry point walks the disk via Node and
 *     produces lightweight `{ kind:'native', absPath }` records instead
 *
 * `lib/fsAccess.ts`'s read helpers dispatch on which shape they got, so callers can
 * treat the `files` map opaquely.
 */
export type NativeFileRef = { kind: 'native'; absPath: string }
export type FileEntry = FileSystemFileHandle | NativeFileRef

/** Result of scanning a folder. */
export interface ScanResult {
  /** Tree for the sidebar (directories and viewable files only) */
  tree: TreeNode
  /** Refs for all files (FSA handle or native abs path). Keyed by path relative to the root. */
  files: Map<string, FileEntry>
  /** Total number of viewable files found during the scan */
  viewableCount: number
}
