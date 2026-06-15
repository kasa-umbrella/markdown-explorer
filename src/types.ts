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

/** Result of scanning a folder. */
export interface ScanResult {
  /** Tree for the sidebar (directories and viewable files only) */
  tree: TreeNode
  /** Handles for all files. Keyed by path relative to the root. Includes non-viewable files such as images. */
  files: Map<string, FileSystemFileHandle>
  /** Total number of viewable files found during the scan */
  viewableCount: number
}
