const MD_EXT = /\.(md|markdown|mdown|mkd)$/i

/** Whether a path points to a Markdown file. */
export function isMarkdownPath(path: string): boolean {
  return MD_EXT.test(path)
}

/** One matching line within a file. */
export interface SearchSnippet {
  /** 1-based line number. */
  line: number
  /** The matching line, trimmed of surrounding whitespace. */
  text: string
}

/** A file whose contents match the query, with a few preview snippets. */
export interface SearchMatch {
  /** Path relative to root. */
  path: string
  /** Display name (last segment of the path). */
  name: string
  /** Total number of matching lines in the file. */
  total: number
  /** Up to MAX_SNIPPETS preview lines. */
  snippets: SearchSnippet[]
}

/** How many preview lines to keep per matching file. */
const MAX_SNIPPETS = 3

/**
 * Read every Markdown file in the handle map and cache its text, keyed by path.
 * Unreadable files are skipped silently. Reads run concurrently.
 */
export async function buildContentIndex(
  files: Map<string, FileSystemFileHandle>,
): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  const tasks: Promise<void>[] = []
  for (const [path, handle] of files) {
    if (!isMarkdownPath(path)) continue
    tasks.push(
      (async () => {
        try {
          const file = await handle.getFile()
          index.set(path, await file.text())
        } catch {
          // Skip files that can't be read; they just won't appear in results.
        }
      })(),
    )
  }
  await Promise.all(tasks)
  return index
}

/**
 * Case-insensitive substring search across a prebuilt content index.
 * Returns matches sorted by hit count (most first), then by path.
 */
export function searchContent(index: Map<string, string>, rawQuery: string): SearchMatch[] {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return []

  const matches: SearchMatch[] = []
  for (const [path, content] of index) {
    const lines = content.split(/\r?\n/)
    const snippets: SearchSnippet[] = []
    let total = 0
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        total++
        if (snippets.length < MAX_SNIPPETS) {
          snippets.push({ line: i + 1, text: lines[i].trim() })
        }
      }
    }
    if (total > 0) {
      matches.push({ path, name: path.slice(path.lastIndexOf('/') + 1), total, snippets })
    }
  }

  matches.sort((a, b) => b.total - a.total || a.path.localeCompare(b.path))
  return matches
}
