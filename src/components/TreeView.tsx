import { useEffect, useState } from 'react'
import type { TreeNode } from '../types'

interface Props {
  node: TreeNode
  selectedPath: string | null
  onSelect: (path: string) => void
  /** 検索中は全ディレクトリを開いて見せる */
  forceExpand: boolean
  /** ルート自身は描画せず子だけ描画する（最上段のフォルダ名はヘッダに出すため） */
  depth?: number
}

export function TreeView({ node, selectedPath, onSelect, forceExpand, depth = 0 }: Props) {
  return (
    <ul className="tree" role="tree">
      {(node.children ?? []).map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          onSelect={onSelect}
          forceExpand={forceExpand}
          depth={depth}
        />
      ))}
    </ul>
  )
}

function TreeItem({ node, selectedPath, onSelect, forceExpand, depth = 0 }: Props) {
  const [open, setOpen] = useState(depth < 1)

  // 検索が始まったら強制展開。
  useEffect(() => {
    if (forceExpand) setOpen(true)
  }, [forceExpand])

  const pad = { paddingLeft: `${depth * 14 + 8}px` }

  if (node.kind === 'file') {
    const selected = node.path === selectedPath
    return (
      <li role="treeitem" aria-selected={selected}>
        <button
          className={`row file${selected ? ' selected' : ''}`}
          style={pad}
          onClick={() => onSelect(node.path)}
          title={node.path}
        >
          <span className="icon">📄</span>
          <span className="label">{node.name}</span>
        </button>
      </li>
    )
  }

  return (
    <li role="treeitem" aria-expanded={open}>
      <button
        className={`row dir${node.hasMarkdown ? ' has-md' : ''}`}
        style={pad}
        onClick={() => setOpen((o) => !o)}
        title={node.path}
      >
        <span className="icon">{open ? '📂' : '📁'}</span>
        <span className="label">{node.name}</span>
      </button>
      {open && (
        <ul className="tree" role="group">
          {(node.children ?? []).map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              forceExpand={forceExpand}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
