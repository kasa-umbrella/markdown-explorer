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

/**
 * Resolve a relative reference against an absolute filesystem path and return
 * a normalized absolute path. Used for externally-opened files whose relative
 * image / link refs need to be read from disk via IPC.
 *
 * - POSIX-absolute inputs (leading `/`) collapse `.` / `..` cleanly.
 * - Absolute references in `relative` (`/foo`) replace the base entirely.
 * - The query / anchor portion is dropped.
 * - Windows-style `\` separators in `absoluteFile` are tolerated by normalising
 *   them to `/` before splitting; the result uses `/`.
 */
export function resolveAbsoluteRelative(absoluteFile: string, relative: string): string {
  const clean = relative.split('#')[0].split('?')[0]
  const norm = absoluteFile.replace(/\\/g, '/')
  const isPosix = norm.startsWith('/')
  // Drive letter on Windows (e.g. "C:") — preserve it as the first segment.
  const drive = /^[A-Za-z]:/.test(norm) ? norm.slice(0, 2) : ''
  const tail = drive ? norm.slice(2) : norm
  const dir = tail.includes('/') ? tail.slice(0, tail.lastIndexOf('/')) : ''
  const segments = clean.startsWith('/') ? [] : dir.split('/').filter(Boolean)
  for (const part of clean.replace(/^\//, '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return (drive || (isPosix ? '/' : '')) + segments.join('/')
}

/**
 * Best-effort MIME guess from a file extension. Covers the image / video / audio
 * formats markdown commonly references — anything else falls back to
 * application/octet-stream so the browser sniffs it from headers if possible.
 */
export function guessMimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'avif': return 'image/avif'
    case 'bmp': return 'image/bmp'
    case 'ico': return 'image/x-icon'
    case 'mp4': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    default: return 'application/octet-stream'
  }
}
