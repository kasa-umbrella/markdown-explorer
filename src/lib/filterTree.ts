import type { TreeNode } from '../types'

/**
 * ファイル名でツリーを絞り込む。マッチするファイルと、それを含む祖先ディレクトリだけを残す。
 * query が空なら元のツリーをそのまま返す。
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
