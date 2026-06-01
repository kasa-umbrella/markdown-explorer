/** A single node in the tree: a directory or an .md file. */
export interface TreeNode {
  /** Path relative to the root. e.g. "docs/guide.md" */
  path: string
  /** Display name (the last segment of the path) */
  name: string
  kind: 'dir' | 'file'
  /** Only when kind === 'dir'. Child nodes sorted by name. */
  children?: TreeNode[]
  /** Only when kind === 'dir'. True if the folder directly contains .md files. */
  hasMarkdown?: boolean
}

/** Result of scanning a folder. */
export interface ScanResult {
  /** Tree for the sidebar (directories and .md only) */
  tree: TreeNode
  /** Handles for all files. Keyed by path relative to the root. Includes non-.md files such as images. */
  files: Map<string, FileSystemFileHandle>
  /** Total number of .md files found during the scan */
  markdownCount: number
}
