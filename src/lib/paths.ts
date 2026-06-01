/**
 * 相対パスを解決して、ルートからの正規化パスを返す。
 * @param fromFile 基準となるファイルのパス（例 "docs/guide.md"）
 * @param relative 相対参照（例 "../img/a.png", "./b.md", "sub/c.md"）
 */
export function resolveRelative(fromFile: string, relative: string): string {
  // アンカー(#...)やクエリ(?...)を落とす
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

/** http(s):, data:, mailto: など外部スキームか。 */
export function isExternalUrl(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

const MD_EXT = /\.(md|markdown|mdown|mkd)(#|\?|$)/i

/** リンク先がローカルの .md か。 */
export function isMarkdownLink(href: string): boolean {
  return !isExternalUrl(href) && MD_EXT.test(href)
}
