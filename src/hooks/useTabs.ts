import { useCallback, useMemo, useState } from 'react'

/**
 * A tab always holds a self-contained, externally-opened file: its content is read
 * once (via drag-drop or Finder open-with) and kept in state. There's no folder root,
 * so there's no in-root/relative-path tab kind anymore.
 */
export interface TabSource {
  name: string
  content: string
  /**
   * Absolute OS path the content was read from, when known (Finder open-with,
   * VSCode drag-drop, etc.). Enables resolving relative image / link references
   * inside the markdown — without it we can only show alt-text placeholders.
   */
  absolutePath?: string
}

export interface Tab {
  id: string
  source: TabSource
  /** VSCode-style preview state. A single preview tab gets replaced when another file is single-clicked. */
  preview: boolean
}

interface State {
  tabs: Tab[]
  activeIndex: number
}

const INITIAL: State = { tabs: [], activeIndex: -1 }

let _id = 0
const makeId = () => `t${++_id}-${Date.now().toString(36)}`

/**
 * Tab list for the viewer. Every tab is an opened file; there's no per-tab
 * navigation history (that only made sense for in-root relative links).
 */
export function useTabs() {
  const [state, setState] = useState<State>(INITIAL)

  const active = state.activeIndex >= 0 ? state.tabs[state.activeIndex] : null

  const openExternal = useCallback(
    (name: string, content: string, absolutePath?: string): string => {
      const id = makeId()
      setState((prev) => {
        // Re-focus an already-open tab for the same on-disk file instead of duplicating it.
        if (absolutePath) {
          const existing = prev.tabs.findIndex((t) => t.source.absolutePath === absolutePath)
          if (existing >= 0) return { ...prev, activeIndex: existing }
        }
        const newTab: Tab = {
          id,
          source: { name, content, ...(absolutePath ? { absolutePath } : {}) },
          preview: false,
        }
        return { tabs: [...prev.tabs, newTab], activeIndex: prev.tabs.length }
      })
      return id
    },
    [],
  )

  const close = useCallback((index: number) => {
    setState((prev) => {
      if (index < 0 || index >= prev.tabs.length) return prev
      const tabs = prev.tabs.filter((_, i) => i !== index)
      let activeIndex = prev.activeIndex
      if (tabs.length === 0) activeIndex = -1
      else if (activeIndex > index) activeIndex -= 1
      else if (activeIndex === index) activeIndex = Math.min(activeIndex, tabs.length - 1)
      return { tabs, activeIndex }
    })
  }, [])

  const closeById = useCallback((id: string) => {
    setState((prev) => {
      const index = prev.tabs.findIndex((t) => t.id === id)
      if (index < 0) return prev
      const tabs = prev.tabs.filter((_, i) => i !== index)
      let activeIndex = prev.activeIndex
      if (tabs.length === 0) activeIndex = -1
      else if (activeIndex > index) activeIndex -= 1
      else if (activeIndex === index) activeIndex = Math.min(activeIndex, tabs.length - 1)
      return { tabs, activeIndex }
    })
  }, [])

  /**
   * Replace a tab's content in place, preserving its id, preview state, and position.
   * Used by the reload flow when the file on disk changed outside the app — the
   * content is held in state, not re-read on demand, so without this a tab would stay
   * pinned to its open-time snapshot. Silently no-ops if the tab isn't found.
   */
  const updateExternalContent = useCallback((id: string, content: string) => {
    setState((prev) => {
      const idx = prev.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return prev
      const t = prev.tabs[idx]
      if (t.source.content === content) return prev
      return {
        ...prev,
        tabs: prev.tabs.map((tab, i) =>
          i === idx ? { ...tab, source: { ...t.source, content } } : tab,
        ),
      }
    })
  }, [])

  const closeActive = useCallback(() => {
    setState((prev) => {
      const i = prev.activeIndex
      if (i < 0) return prev
      const tabs = prev.tabs.filter((_, idx) => idx !== i)
      const activeIndex = tabs.length === 0 ? -1 : Math.min(i, tabs.length - 1)
      return { tabs, activeIndex }
    })
  }, [])

  const pin = useCallback((index: number) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t, i) => (i === index ? { ...t, preview: false } : t)),
    }))
  }, [])

  const activate = useCallback((index: number) => {
    setState((prev) =>
      index >= 0 && index < prev.tabs.length ? { ...prev, activeIndex: index } : prev,
    )
  }, [])

  const nextTab = useCallback(() => {
    setState((prev) => {
      if (prev.tabs.length === 0) return prev
      return { ...prev, activeIndex: (prev.activeIndex + 1) % prev.tabs.length }
    })
  }, [])

  const prevTab = useCallback(() => {
    setState((prev) => {
      if (prev.tabs.length === 0) return prev
      return {
        ...prev,
        activeIndex: (prev.activeIndex - 1 + prev.tabs.length) % prev.tabs.length,
      }
    })
  }, [])

  const reset = useCallback(() => setState(INITIAL), [])

  return useMemo(
    () => ({
      tabs: state.tabs,
      activeIndex: state.activeIndex,
      active,
      openExternal,
      updateExternalContent,
      close,
      closeById,
      closeActive,
      pin,
      activate,
      nextTab,
      prevTab,
      reset,
    }),
    [
      state.tabs,
      state.activeIndex,
      active,
      openExternal,
      updateExternalContent,
      close,
      closeById,
      closeActive,
      pin,
      activate,
      nextTab,
      prevTab,
      reset,
    ],
  )
}
