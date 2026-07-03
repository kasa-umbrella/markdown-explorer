/**
 * In-document text search for the preview pane (⌘F).
 *
 * Works on the *rendered* DOM, not the markdown source: text nodes under a root
 * element are concatenated into one case-folded haystack (with per-node offsets
 * remembered), the query is matched against it, and each hit is mapped back to a
 * DOM `Range`. Matching over the concatenation means a query can span inline
 * element boundaries (e.g. "bold text" across a <strong>), just like the
 * browser's native find. The resulting Ranges are painted via the CSS Custom
 * Highlight API by the caller, so the document DOM is never mutated — important
 * because Preview's mermaid/blob-URL effects assume they own the article HTML.
 */

export interface DocTextIndex {
  /** Case-folded concatenation of every searchable text node under the root. */
  text: string
  /** The live text nodes, in document order. */
  nodes: Text[]
  /** starts[i] = offset of nodes[i]'s first character within `text`. */
  starts: number[]
}

/**
 * Lower-case `s` while preserving its length, so folded offsets map 1:1 onto the
 * original node data. The rare characters whose lowercase form changes length
 * (e.g. 'İ' → 'i̇') are kept as-is rather than corrupting the offset mapping.
 */
function fold(s: string): string {
  const lc = s.toLowerCase()
  if (lc.length === s.length) return lc
  let out = ''
  for (const ch of s) {
    const l = ch.toLowerCase()
    out += l.length === ch.length ? l : ch
  }
  return out
}

/**
 * Walk the text nodes under `root` (document order) and build the search index.
 * `shouldSkip` prunes subtrees that are visible in the pane but aren't document
 * content — e.g. the doc-path header that scrolls with the preview.
 */
export function buildDocTextIndex(
  root: HTMLElement,
  shouldSkip?: (parent: Element) => boolean,
): DocTextIndex {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      if (shouldSkip?.(parent)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    if (!t.data) continue
    nodes.push(t)
    starts.push(text.length)
    text += fold(t.data)
  }
  return { text, nodes, starts }
}

/** Index of the last node whose start offset is <= `offset` (binary search). */
function nodeIndexAt(index: DocTextIndex, offset: number): number {
  let lo = 0
  let hi = index.starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (index.starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Build a DOM Range for the haystack span [start, end). */
function rangeFor(index: DocTextIndex, start: number, end: number): Range {
  const range = document.createRange()
  const si = nodeIndexAt(index, start)
  // `end` is exclusive, so locate the node containing the match's last character.
  const ei = nodeIndexAt(index, end - 1)
  range.setStart(index.nodes[si], start - index.starts[si])
  range.setEnd(index.nodes[ei], end - index.starts[ei])
  return range
}

/**
 * Case-insensitive, non-overlapping matches of `rawQuery` in the index, as DOM
 * Ranges in document order. `limit` caps pathological cases (single-character
 * queries in huge documents) so highlight registration stays snappy.
 */
export function findMatches(index: DocTextIndex, rawQuery: string, limit = 5000): Range[] {
  const query = fold(rawQuery)
  if (!query) return []
  const ranges: Range[] = []
  let from = 0
  while (ranges.length < limit) {
    const at = index.text.indexOf(query, from)
    if (at === -1) break
    ranges.push(rangeFor(index, at, at + query.length))
    from = at + query.length
  }
  return ranges
}
