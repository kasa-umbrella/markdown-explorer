import { useCallback, useState } from 'react'

/**
 * Maps an FSA root's basename (the only identity the File System Access picker
 * exposes) to an absolute OS path, so features that need a real filesystem path
 * — Git Time Machine in particular — can locate files on disk.
 *
 * The map is persisted in localStorage and keyed by basename. That's lossy when
 * two distinct folders share a name across the user's machine, but in practice
 * one Markdown vault per name is the common case, and `link()` re-prompts on
 * demand to override.
 */
const STORAGE_KEY = 'mdexp.rootAbsPath.v1'

type Map = Record<string, string>

function load(): Map {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const result: Map = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') result[k] = v
    }
    return result
  } catch {
    return {}
  }
}

function save(m: Map): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m))
  } catch {
    // Quota / private-mode → silently ignore; the feature degrades to "ask again next time".
  }
}

export function useRootAbsPath(rootName: string | null) {
  // Load the whole map up-front; cheap, and lets `absPath` be derived in render
  // (no effect-driven cascading renders when rootName changes).
  const [overrides, setOverrides] = useState<Map>(() => load())
  const absPath = rootName ? overrides[rootName] ?? null : null

  /**
   * Pop the native directory picker so the user can point us at the actual OS
   * folder behind `rootName`. The picked path is saved against `rootName` and
   * returned to the caller. Resolves to null on cancel.
   */
  const link = useCallback(async (): Promise<string | null> => {
    const api = window.mdexp
    if (!api?.chooseDirectory || !rootName) return null
    const picked = await api.chooseDirectory()
    if (!picked) return null
    setOverrides((prev) => {
      const next = { ...prev, [rootName]: picked }
      save(next)
      return next
    })
    return picked
  }, [rootName])

  /** Forget the saved path for the current root (mostly here for tests / debug paths). */
  const unlink = useCallback(() => {
    if (!rootName) return
    setOverrides((prev) => {
      if (!(rootName in prev)) return prev
      const next = { ...prev }
      delete next[rootName]
      save(next)
      return next
    })
  }, [rootName])

  return { absPath, link, unlink }
}
