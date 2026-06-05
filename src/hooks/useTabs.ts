import { useCallback, useMemo, useState } from 'react'

export type TabSource =
  | { kind: 'in-root'; path: string }
  | { kind: 'external'; name: string; content: string }

export interface Tab {
  id: string
  source: TabSource
  /** VSCode-style preview state. A single preview tab gets replaced when another file is single-clicked. */
  preview: boolean
  /** Per-tab back/forward history. Only in-root tabs use it; external tabs keep an empty stack. */
  history: { stack: string[]; index: number }
}

interface State {
  tabs: Tab[]
  activeIndex: number
}

const INITIAL: State = { tabs: [], activeIndex: -1 }
const EMPTY_HISTORY = { stack: [] as string[], index: -1 }

let _id = 0
const makeId = () => `t${++_id}-${Date.now().toString(36)}`

/**
 * Tab list with VSCode-style preview semantics:
 *  - single-click ⇒ open as preview (replaces the existing preview tab, if any)
 *  - double-click ⇒ pin (or open pinned directly)
 *  - link click inside a tab ⇒ navigate within that tab, preserving preview state
 */
export function useTabs() {
  const [state, setState] = useState<State>(INITIAL)

  const active = state.activeIndex >= 0 ? state.tabs[state.activeIndex] : null

  const openInRoot = useCallback(
    (path: string, opts: { pinned?: boolean } = {}) => {
      setState((prev) => {
        const existing = prev.tabs.findIndex(
          (t) => t.source.kind === 'in-root' && t.source.path === path,
        )
        if (existing >= 0) {
          const tabs =
            opts.pinned && prev.tabs[existing].preview
              ? prev.tabs.map((t, i) => (i === existing ? { ...t, preview: false } : t))
              : prev.tabs
          return { tabs, activeIndex: existing }
        }

        const newTab: Tab = {
          id: makeId(),
          source: { kind: 'in-root', path },
          preview: !opts.pinned,
          history: { stack: [path], index: 0 },
        }

        if (!opts.pinned) {
          const previewIdx = prev.tabs.findIndex((t) => t.preview)
          if (previewIdx >= 0) {
            return {
              tabs: prev.tabs.map((t, i) => (i === previewIdx ? newTab : t)),
              activeIndex: previewIdx,
            }
          }
        }

        return { tabs: [...prev.tabs, newTab], activeIndex: prev.tabs.length }
      })
    },
    [],
  )

  const openExternal = useCallback((name: string, content: string): string => {
    const id = makeId()
    setState((prev) => {
      const newTab: Tab = {
        id,
        source: { kind: 'external', name, content },
        preview: false,
        history: EMPTY_HISTORY,
      }
      return { tabs: [...prev.tabs, newTab], activeIndex: prev.tabs.length }
    })
    return id
  }, [])

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

  const closeActive = useCallback(() => {
    setState((prev) => {
      const i = prev.activeIndex
      if (i < 0) return prev
      const tabs = prev.tabs.filter((_, idx) => idx !== i)
      const activeIndex =
        tabs.length === 0 ? -1 : Math.min(i, tabs.length - 1)
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

  const navigate = useCallback((path: string) => {
    setState((prev) => {
      if (prev.activeIndex < 0) return prev
      return {
        ...prev,
        tabs: prev.tabs.map((t, i) => {
          if (i !== prev.activeIndex || t.source.kind !== 'in-root') return t
          if (t.history.stack[t.history.index] === path) return t
          const nextStack = t.history.stack.slice(0, t.history.index + 1)
          nextStack.push(path)
          return {
            ...t,
            source: { kind: 'in-root', path },
            history: { stack: nextStack, index: nextStack.length - 1 },
          }
        }),
      }
    })
  }, [])

  const back = useCallback(() => {
    setState((prev) => {
      if (prev.activeIndex < 0) return prev
      return {
        ...prev,
        tabs: prev.tabs.map((t, i) => {
          if (i !== prev.activeIndex || t.source.kind !== 'in-root') return t
          if (t.history.index <= 0) return t
          const idx = t.history.index - 1
          return {
            ...t,
            source: { kind: 'in-root', path: t.history.stack[idx] },
            history: { ...t.history, index: idx },
          }
        }),
      }
    })
  }, [])

  const forward = useCallback(() => {
    setState((prev) => {
      if (prev.activeIndex < 0) return prev
      return {
        ...prev,
        tabs: prev.tabs.map((t, i) => {
          if (i !== prev.activeIndex || t.source.kind !== 'in-root') return t
          if (t.history.index >= t.history.stack.length - 1) return t
          const idx = t.history.index + 1
          return {
            ...t,
            source: { kind: 'in-root', path: t.history.stack[idx] },
            history: { ...t.history, index: idx },
          }
        }),
      }
    })
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

  // Drop in-root tabs only (their paths are tied to the previous root), keeping
  // external tabs intact — those carry self-contained content and survive a switch.
  const clearInRoot = useCallback(() => {
    setState((prev) => {
      let nextActive = -1
      const tabs: Tab[] = []
      prev.tabs.forEach((t, i) => {
        if (t.source.kind !== 'in-root') {
          if (i === prev.activeIndex) nextActive = tabs.length
          tabs.push(t)
        }
      })
      if (nextActive === -1 && tabs.length > 0) nextActive = 0
      return { tabs, activeIndex: nextActive }
    })
  }, [])

  const canBack =
    !!active && active.source.kind === 'in-root' && active.history.index > 0
  const canForward =
    !!active &&
    active.source.kind === 'in-root' &&
    active.history.index < active.history.stack.length - 1

  return useMemo(
    () => ({
      tabs: state.tabs,
      activeIndex: state.activeIndex,
      active,
      canBack,
      canForward,
      openInRoot,
      openExternal,
      close,
      closeById,
      closeActive,
      pin,
      activate,
      navigate,
      back,
      forward,
      nextTab,
      prevTab,
      reset,
      clearInRoot,
    }),
    [
      state.tabs,
      state.activeIndex,
      active,
      canBack,
      canForward,
      openInRoot,
      openExternal,
      close,
      closeById,
      closeActive,
      pin,
      activate,
      navigate,
      back,
      forward,
      nextTab,
      prevTab,
      reset,
      clearInRoot,
    ],
  )
}
