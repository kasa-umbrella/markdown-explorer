/**
 * Resolve a relative path and return a normalized path from the root.
 * @param fromFile Path of the base file (e.g. "docs/guide.md")
 * @param relative Relative reference (e.g. "../img/a.png", "./b.md", "sub/c.md")
 */
export function resolveRelative(fromFile: string, relative: string): string {
  // Drop the anchor (#...) and query (?...)
  const clean = relative.split('#')[0].split('?')[0]
  const baseDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const segments = clean.startsWith('/') ? [] : baseDir ? baseDir.split('/') : []

  for (const part of clean.replace(/^\//, '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}

/** Whether it's an external scheme such as http(s):, data:, or mailto:. */
export function isExternalUrl(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

const MD_EXT = /\.(md|markdown|mdown|mkd)(#|\?|$)/i

/** Whether the link target is a local .md. */
export function isMarkdownLink(href: string): boolean {
  return !isExternalUrl(href) && MD_EXT.test(href)
}
