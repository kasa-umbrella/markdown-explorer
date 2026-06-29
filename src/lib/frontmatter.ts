import yaml from 'js-yaml'
import MarkdownIt from 'markdown-it'

const escapeHtml = new MarkdownIt().utils.escapeHtml

/**
 * Strip a leading YAML frontmatter block (`---\n…\n---`) from a markdown source.
 * Returns the parsed data plus the remaining body. When the file has no frontmatter,
 * or the block is malformed, returns `{ data: null, body: src }` so callers can fall
 * back to rendering the original source as plain markdown.
 *
 * The opening fence must sit on the first line and be exactly `---`. The closing
 * fence is the first `---` or `...` line that appears after it.
 */
export function extractFrontmatter(src: string): { data: unknown; body: string } {
  if (!src.startsWith('---')) return { data: null, body: src }
  const rest = src.slice(3)
  if (rest.length === 0 || (rest[0] !== '\n' && rest[0] !== '\r')) {
    return { data: null, body: src }
  }
  const afterOpen = rest.replace(/^\r?\n/, '')
  const closeRe = /\r?\n(---|\.\.\.)[ \t]*(?=\r?\n|$)/
  const m = closeRe.exec(afterOpen)
  if (!m) return { data: null, body: src }
  const yamlText = afterOpen.slice(0, m.index)
  let body = afterOpen.slice(m.index + m[0].length)
  body = body.replace(/^\r?\n/, '')
  let data: unknown
  try {
    data = yaml.load(yamlText)
  } catch {
    return { data: null, body: src }
  }
  if (data === null || data === undefined) {
    return { data: null, body }
  }
  return { data, body }
}

/**
 * Render parsed YAML data as a GitHub-style key/value table. Plain object → 2-column
 * table; arrays and nested objects nest inside the value cell. Returns an empty
 * string when there's nothing meaningful to display (null, scalar at top level, etc.).
 */
export function renderFrontmatterTable(data: unknown): string {
  if (!isPlainObject(data)) return ''
  const entries = Object.entries(data)
  if (entries.length === 0) return ''
  const rows = entries.map(([k, v]) => {
    return `<tr><th scope="row">${escapeHtml(k)}</th><td>${renderValue(v)}</td></tr>`
  })
  return `<table class="frontmatter-table"><tbody>${rows.join('')}</tbody></table>`
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) {
    return '<span class="frontmatter-null">∅</span>'
  }
  if (typeof v === 'string') {
    if (v.includes('\n')) {
      return `<span class="frontmatter-multiline">${escapeHtml(v)}</span>`
    }
    return escapeHtml(v)
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return `<span class="frontmatter-scalar">${escapeHtml(String(v))}</span>`
  }
  if (v instanceof Date) {
    return `<span class="frontmatter-scalar">${escapeHtml(v.toISOString())}</span>`
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '<span class="frontmatter-null">[]</span>'
    const items = v.map((it) => `<li>${renderValue(it)}</li>`).join('')
    return `<ul class="frontmatter-list">${items}</ul>`
  }
  if (isPlainObject(v)) {
    const entries = Object.entries(v)
    if (entries.length === 0) return '<span class="frontmatter-null">{}</span>'
    const rows = entries
      .map(
        ([k, vv]) =>
          `<tr><th scope="row">${escapeHtml(k)}</th><td>${renderValue(vv)}</td></tr>`,
      )
      .join('')
    return `<table class="frontmatter-table frontmatter-nested"><tbody>${rows}</tbody></table>`
  }
  return escapeHtml(String(v))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return false
  if (v instanceof Date) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
