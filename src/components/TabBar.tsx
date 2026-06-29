import type { MouseEvent } from 'react'
import type { Tab } from '../hooks/useTabs'

interface Props {
  tabs: Tab[]
  activeIndex: number
  onActivate: (index: number) => void
  onClose: (index: number) => void
  onPin: (index: number) => void
}

export function TabBar({ tabs, activeIndex, onActivate, onClose, onPin }: Props) {
  if (tabs.length === 0) return null
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab, i) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={i === activeIndex}
          onActivate={() => onActivate(i)}
          onClose={() => onClose(i)}
          onPin={() => onPin(i)}
        />
      ))}
    </div>
  )
}

interface ItemProps {
  tab: Tab
  active: boolean
  onActivate: () => void
  onClose: () => void
  onPin: () => void
}

function TabItem({ tab, active, onActivate, onClose, onPin }: ItemProps) {
  const label =
    tab.source.kind === 'in-root'
      ? tab.source.path.split('/').pop() ?? tab.source.path
      : tab.source.name
  const inRoot = tab.source.kind === 'in-root'
  const title =
    tab.source.kind === 'in-root'
      ? tab.source.path
      : `外部ファイル: ${tab.source.name}`

  // Middle-click also closes — matches browser tab convention.
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      onClose()
    }
  }
  const onCloseClick = (e: MouseEvent) => {
    e.stopPropagation()
    onClose()
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab${active ? ' active' : ''}${tab.preview ? ' preview' : ''}`}
      onClick={onActivate}
      onDoubleClick={onPin}
      onMouseDown={onMouseDown}
      title={title}
    >
      <span className="tab-icon" aria-hidden>
        {inRoot ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M19 3H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.11-.89-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H5V5h14v10zm-3-5h-2V7h-4v3H8l4 4 4-4z" />
          </svg>
        )}
      </span>
      <span className="tab-label">{label}</span>
      <button
        type="button"
        className="tab-close"
        onClick={onCloseClick}
        title="閉じる"
        aria-label="閉じる"
      >
        ×
      </button>
    </div>
  )
}
