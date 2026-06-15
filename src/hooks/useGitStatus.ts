import { useCallback, useEffect, useRef, useState } from 'react'

export type GitStatusCode = MdexpGitStatusCode
export type GitStatusMap = Record<string, GitStatusCode>

/**
 * Track `git status` for the currently active root and refresh it on the events
 * most likely to leave it stale — root changes, an explicit rescan (via `refreshKey`),
 * and window focus (returning from an editor / terminal where the user just edited
 * files).
 *
 * Returns `null` when the root isn't a git repo or the absolute path isn't known yet
 * (web-mode, or pre-link). The renderer can safely ignore the result and skip painting.
 *
 * The previous map is intentionally kept while a new fetch is in flight so the sidebar
 * doesn't flash between "no badges" and "badges" on every focus event.
 */
export function useGitStatus(
  absoluteRootPath: string | null | undefined,
  refreshKey: number,
): GitStatusMap | null {
  const [status, setStatus] = useState<GitStatusMap | null>(null)

  // Guard against out-of-order responses: a slow fetch issued for an old root
  // mustn't overwrite the result of a faster fetch for the current root.
  const requestId = useRef(0)

  const fetchStatus = useCallback(async (rootPath: string) => {
    const api = window.mdexp
    if (!api?.gitStatus) return
    const myId = ++requestId.current
    try {
      const result = await api.gitStatus(rootPath)
      if (myId !== requestId.current) return
      setStatus(result)
    } catch (err) {
      if (myId !== requestId.current) return
      console.error('[git-status] fetch failed:', err)
      setStatus(null)
    }
  }, [])

  // Reset to null immediately on root change so stale paths from the previous root
  // don't get painted onto the new tree during the brief gap before the fetch lands.
  useEffect(() => {
    requestId.current++
    if (!absoluteRootPath) {
      setStatus(null)
      return
    }
    setStatus(null)
    void fetchStatus(absoluteRootPath)
  }, [absoluteRootPath, refreshKey, fetchStatus])

  // Refetch when the user returns to the window — they may have edited files in
  // another editor while we were blurred.
  useEffect(() => {
    if (!absoluteRootPath) return
    const onFocus = () => {
      void fetchStatus(absoluteRootPath)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [absoluteRootPath, fetchStatus])

  return status
}
