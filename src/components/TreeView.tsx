import { useEffect, useState } from 'react'
import type { TreeNode } from '../types'
import type { GitStatusMap } from '../hooks/useGitStatus'

interface Props {
  node: TreeNode
  selectedPath: string | null
  /** Single-click: open in preview tab (VSCode style). */
  onSelect: (path: string) => void
  /** Double-click: pin / open as a non-preview tab. */
  onActivate?: (path: string) => void
  /** While searching, expand every directory so all matches are visible */
  forceExpand: boolean
  /**
   * Path of the file to reveal — directories on the path from root to this file
   * auto-expand once. Lets external files dropped into the root (or any in-root
   * tab activation) surface their parent folder without the user hunting for it.
   */
  revealPath?: string | null
  /**
   * Per-path git status (relative to the active root). When provided, file rows
   * pick up a `git-X` modifier class so CSS can tint the label by status.
   */
  gitStatus?: GitStatusMap | null
  /** Don't render the root itself, only its children (the top-level folder name is shown in the header) */
  depth?: number
}

export function TreeView({ node, selectedPath, onSelect, onActivate, forceExpand, revealPath, gitStatus, depth = 0 }: Props) {
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
          revealPath={revealPath}
          gitStatus={gitStatus}
          depth={depth}
        />
      ))}
    </ul>
  )
}

function TreeItem({ node, selectedPath, onSelect, onActivate, forceExpand, revealPath, gitStatus, depth = 0 }: Props) {
  const [open, setOpen] = useState(depth < 1)

  // Force-expand once a search begins.
  useEffect(() => {
    if (forceExpand) setOpen(true)
  }, [forceExpand])

  // Auto-expand this directory when the active file lives somewhere underneath it.
  // Runs whenever revealPath changes, so a later manual collapse stays collapsed
  // until the next reveal request (e.g. switching to a tab in a different folder).
  useEffect(() => {
    if (node.kind !== 'dir' || !revealPath) return
    if (revealPath.startsWith(node.path + '/')) setOpen(true)
  }, [revealPath, node.kind, node.path])

  const pad = { paddingLeft: `${depth * 14 + 8}px` }

  if (node.kind === 'file') {
    const selected = node.path === selectedPath
    const statusCode = gitStatus ? gitStatus[node.path] : undefined
    const statusClass = statusCode ? ` git-${statusCode}` : ''
    return (
      <li role="treeitem" aria-selected={selected}>
        <button
          className={`row file${selected ? ' selected' : ''}${statusClass}`}
          style={pad}
          onClick={() => onSelect(node.path)}
          onDoubleClick={() => onActivate?.(node.path)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onActivate?.(node.path)
            }
          }}
          onMouseDown={(e) => {
            // Suppress middle-click autoscroll so onAuxClick can open a new tab cleanly.
            if (e.button === 1) e.preventDefault()
          }}
          title={node.path}
        >
          <span className="icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z" />
            </svg>
          </span>
          <span className="label">{node.name}</span>
        </button>
      </li>
    )
  }

  return (
    <li role="treeitem" aria-expanded={open}>
      <button
        className={`row dir${node.hasViewable ? ' has-md' : ''}`}
        style={pad}
        onClick={() => setOpen((o) => !o)}
        title={node.path}
      >
        <span className="icon" aria-hidden>
          {open ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
          )}
        </span>
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
              revealPath={revealPath}
              gitStatus={gitStatus}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
