/**
 * Line-level diff between an old and a new revision of a text document, tuned for
 * highlighting *where* a rendered Markdown block changed. The result is expressed
 * purely in terms of NEW-side line numbers (0-based) — that's the coordinate space
 * markdown-it's `token.map` reports, and the only side we actually render.
 *
 * We compute a longest-common-subsequence alignment of the two line arrays, group
 * the resulting edits into hunks, and classify each hunk:
 *   - added:   new lines with nothing removed alongside → the block is brand new.
 *   - changed: new lines in a hunk that also dropped old lines → the block replaced
 *              earlier content.
 *   - deleted: old lines removed with no new lines taking their place → there's no
 *              block to paint, so we record the new-side line the gap sits *before*
 *              (or flag a trailing deletion at EOF) and the UI draws a thin marker.
 */
export interface LineDiff {
  /** New-side line indices (0-based) that are pure additions. */
  added: Set<number>
  /** New-side line indices (0-based) that replaced removed content. */
  changed: Set<number>
  /** New-side line indices a removed-only gap sits immediately before. */
  deletedBefore: Set<number>
  /** True when content was removed after the final new-side line. */
  deletedAtEnd: boolean
}

/**
 * Above this many DP cells (oldLines × newLines) we skip the O(n·m) LCS and return
 * an empty diff (no highlighting) rather than stalling the UI / spiking memory.
 * Markdown notes are far below this; the guard only matters for pathological inputs.
 */
const MAX_CELLS = 9_000_000

type Edit =
  | { kind: 'eq'; newLine: number }
  | { kind: 'add'; newLine: number }
  | { kind: 'del' }

function splitLines(text: string): string[] {
  // A trailing newline yields a final '' element on both sides, which aligns as
  // context — harmless. Empty input → [''], treated as a single empty line.
  return text.split(/\r?\n/)
}

function emptyDiff(): LineDiff {
  return { added: new Set(), changed: new Set(), deletedBefore: new Set(), deletedAtEnd: false }
}

export function diffLines(oldText: string, newText: string): LineDiff {
  const result = emptyDiff()
  const oldLines = oldText.length === 0 ? [] : splitLines(oldText)
  const newLines = splitLines(newText)

  // No prior revision (a brand-new / untracked file) → the whole document is added.
  if (oldLines.length === 0) {
    for (let i = 0; i < newLines.length; i++) result.added.add(i)
    return result
  }
  // Everything was removed and nothing rendered survives.
  if (newLines.length === 0) {
    result.deletedAtEnd = true
    return result
  }
  if (oldLines.length * newLines.length > MAX_CELLS) return result

  const ops = lcsEdits(oldLines, newLines)

  let i = 0
  while (i < ops.length) {
    if (ops[i].kind === 'eq') {
      i++
      continue
    }
    // Consume a maximal run of non-context edits (a hunk).
    let dels = 0
    const adds: number[] = []
    while (i < ops.length && ops[i].kind !== 'eq') {
      const op = ops[i]
      if (op.kind === 'del') dels++
      else adds.push(op.newLine)
      i++
    }
    if (adds.length > 0) {
      const bucket = dels > 0 ? result.changed : result.added
      for (const n of adds) bucket.add(n)
    } else if (dels > 0) {
      // Pure deletion: anchor it to the surviving line that follows the gap,
      // or flag a trailing deletion when the gap runs to the end of the file.
      const next = ops[i]
      if (next && next.kind === 'eq') result.deletedBefore.add(next.newLine)
      else result.deletedAtEnd = true
    }
  }
  return result
}

/**
 * Standard LCS edit script over two line arrays. Returns the ops in new-file order:
 * `eq` (line present on both sides), `add` (new-only), `del` (old-only). Uses a flat
 * Int32Array DP table filled from the bottom-right so the forward walk is greedy.
 */
function lcsEdits(a: string[], b: string[]): Edit[] {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }
  const ops: Edit[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', newLine: j })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ kind: 'del' })
      i++
    } else {
      ops.push({ kind: 'add', newLine: j })
      j++
    }
  }
  while (i < n) {
    ops.push({ kind: 'del' })
    i++
  }
  while (j < m) {
    ops.push({ kind: 'add', newLine: j })
    j++
  }
  return ops
}
