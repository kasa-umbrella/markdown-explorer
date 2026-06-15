import { useEffect, useRef, useState } from 'react'
import { buildContentIndex, searchContent, type SearchMatch } from '../lib/searchContent'

type Status = 'idle' | 'indexing' | 'ready'

/** How long to wait after the last keystroke before searching. */
const DEBOUNCE_MS = 200

/**
 * Search viewable file contents for `query`. The content index is built lazily
 * on first use and cached until the file set or the viewable-extension set changes.
 *
 * @param enabled When false, the hook stays idle and returns no matches.
 */
export function useContentSearch(
  files: Map<string, FileSystemFileHandle>,
  viewable: ReadonlySet<string>,
  query: string,
  enabled: boolean,
) {
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const indexRef = useRef<Map<string, string> | null>(null)
  // Identity of the file map / viewable set the cached index was built from.
  const indexForRef = useRef<Map<string, FileSystemFileHandle> | null>(null)
  const indexForViewableRef = useRef<ReadonlySet<string> | null>(null)

  const active = enabled && query.trim().length > 0

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const timer = setTimeout(async () => {
      // Build (and cache) the index on first use, or after the file set / extension set changed.
      if (
        indexRef.current === null ||
        indexForRef.current !== files ||
        indexForViewableRef.current !== viewable
      ) {
        setStatus('indexing')
        const index = await buildContentIndex(files, viewable)
        if (cancelled) return
        indexRef.current = index
        indexForRef.current = files
        indexForViewableRef.current = viewable
      }
      if (cancelled) return
      setMatches(searchContent(indexRef.current, query))
      setStatus('ready')
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [files, viewable, query, active])

  // Gate the returned values rather than resetting state inside an effect, so a
  // disabled or empty search reports nothing without an extra render pass.
  return active ? { matches, status } : { matches: [] as SearchMatch[], status: 'idle' as Status }
}
