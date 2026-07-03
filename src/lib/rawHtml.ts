import { useMemo } from 'react'

/**
 * A stable `{ __html }` object for `dangerouslySetInnerHTML`.
 *
 * React 19's commit-time prop diff compares the prop VALUE with `===` — and an
 * inline `{{ __html: html }}` is a fresh object every render, so React re-sets
 * `innerHTML` on every unrelated re-render even when the html string is unchanged
 * (React 18 compared the `__html` strings and skipped). Each reset silently wipes
 * everything imperative effects have painted into that subtree — mermaid hosts,
 * git-diff marks, table wraps, blob-URL image srcs — and the effects don't re-run
 * because their `[html]` deps didn't change.
 *
 * Memoizing the wrapper restores the React-18 contract: innerHTML is re-set only
 * when the html string actually changes.
 */
export function useRawHtml(html: string): { __html: string } {
  return useMemo(() => ({ __html: html }), [html])
}
