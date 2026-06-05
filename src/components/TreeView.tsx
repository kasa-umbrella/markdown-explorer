import { useEffect, useState } from 'react'
import type { TreeNode } from '../types'

interface Props {
  node: TreeNode
  selectedPath: string | null
  /** Single-click: open in preview tab (VSCode style). */
  onSelect: (path: string) => void
  /** Double-click: pin / open as a non-preview tab. */
  onActivate?: (path: string) => void
  /** While searching, expand every directory so all matches are visible */
  forceExpand: boolean
  /** Don't render the root itself, only its children (the top-level folder name is shown in the header) */
  depth?: number
}

export function TreeView({ node, selectedPath, onSelect, onActivate, forceExpand, depth = 0 }: Props) {
  return (
    <ul className="tree" role="tree">
      {(node.children ?? []).map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onActivate={onActivate}
          forceExpand={forceExpand}
          depth={depth}
        />
      ))}
    </ul>
  )
}

function TreeItem({ node, selectedPath, onSelect, onActivate, forceExpand, depth = 0 }: Props) {
  const [open, setOpen] = useState(depth < 1)

  // Force-expand once a search begins.
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
          onDoubleClick={() => onActivate?.(node.path)}
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
              onActivate={onActivate}
              forceExpand={forceExpand}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
