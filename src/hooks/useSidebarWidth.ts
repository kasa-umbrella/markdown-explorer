import { useCallback, useState } from 'react'

const STORAGE_KEY = 'sidebar-width'
const DEFAULT_WIDTH = 300
const MIN_WIDTH = 180
const MAX_WIDTH = 640

/**
 * Sidebar width persisted in localStorage. Width is clamped to [MIN, MAX].
 */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const n = parseInt(raw, 10)
        if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n
      }
    } catch {
      // localStorage may be unavailable (private mode, etc.) — fall through to default.
    }
    return DEFAULT_WIDTH
  })

  const set = useCallback((next: number) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(next)))
    setWidth(clamped)
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped))
    } catch {
      // Ignore quota / availability errors — width still works in-memory.
    }
  }, [])

  return { width, set, min: MIN_WIDTH, max: MAX_WIDTH }
}
