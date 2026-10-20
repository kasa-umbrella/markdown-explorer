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
  const label = tab.source.name
  const title = tab.source.absolutePath ?? tab.source.name

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
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z" />
        </svg>
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
