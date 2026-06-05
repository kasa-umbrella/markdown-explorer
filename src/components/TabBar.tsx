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
  const icon = tab.source.kind === 'in-root' ? '📄' : '📥'
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
        {icon}
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
