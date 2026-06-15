/** Markdown extensions are always supported; they have special rendering. */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd'] as const

export const MARKDOWN_EXT_RE = /\.(md|markdown|mdown|mkd)$/i

/** Lowercased extension (without the leading dot), or null when the name has no extension. */
export function getExtension(name: string): string | null {
  const base = name.split('/').pop() ?? ''
  const idx = base.lastIndexOf('.')
  if (idx <= 0 || idx === base.length - 1) return null
  return base.slice(idx + 1).toLowerCase()
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT_RE.test(path)
}

/** True when the file's extension is in the viewable set. */
export function matchesViewable(path: string, viewable: ReadonlySet<string>): boolean {
  const ext = getExtension(path)
  return ext !== null && viewable.has(ext)
}

/** Build the active viewable-extension set (markdown + extras), lowercased. */
export function buildViewableExtensions(extra: readonly string[]): Set<string> {
  const set = new Set<string>(MARKDOWN_EXTENSIONS)
  for (const e of extra) {
    const cleaned = e.toLowerCase().replace(/^\./, '').trim()
    if (cleaned) set.add(cleaned)
  }
  return set
}

/**
 * Parse a free-form list from the settings UI. Accepts comma, space, or newline as separators,
 * strips a leading dot if present, lowercases, and dedupes. Drops markdown extensions (always
 * included implicitly) and anything that isn't a plain alphanumeric token.
 */
export function parseExtensionList(input: string): string[] {
  const seen = new Set<string>()
  const md = new Set<string>(MARKDOWN_EXTENSIONS)
  const out: string[] = []
  for (const raw of input.split(/[\s,]+/)) {
    const cleaned = raw.replace(/^\./, '').toLowerCase().trim()
    if (!cleaned) continue
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleaned)) continue
    if (md.has(cleaned)) continue
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out
}
