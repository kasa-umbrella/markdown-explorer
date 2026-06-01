import type { TreeNode } from '../types'

/**
 * Filter the tree by file name. Keeps only matching files and the ancestor directories that contain them.
 * If query is empty, returns the original tree unchanged.
 */
export function filterTree(node: TreeNode, query: string): TreeNode | null {
  const q = query.trim().toLowerCase()
  if (!q) return node

  if (node.kind === 'file') {
    return node.name.toLowerCase().includes(q) ? node : null
  }
  const children = (node.children ?? [])
    .map((c) => filterTree(c, q))
    .filter((c): c is TreeNode => c !== null)

  if (children.length === 0) return null
  return { ...node, children }
}
