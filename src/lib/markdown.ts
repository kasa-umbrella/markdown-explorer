import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import anchor from 'markdown-it-anchor'
import hljs from 'highlight.js'
import { extractFrontmatter, renderFrontmatterTable } from './frontmatter'

/**
 * A markdown-it instance roughly equivalent to GFM.
 * - Tables, strikethrough, etc. are enabled out of the box in markdown-it
 * - Task lists are added via a plugin
 * - Headings get id anchors
 * - Code blocks use highlight.js
 */
export const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(code, lang): string {
    // Mermaid blocks are rendered to SVG by a post-processing step in the
    // Preview. Emit the escaped source so the wrapping <code class="language-mermaid">
    // survives the render and can be found later.
    if (lang === 'mermaid') return md.utils.escapeHtml(code)
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        /* on failure, fall through */
      }
    }
    return md.utils.escapeHtml(code)
  },
})
  .use(taskLists, { label: true, enabled: true })
  .use(anchor, { permalink: false })

// Tag every block-level element with the source line range it came from
// (`data-src-line` = first line, `data-src-end` = one past the last, both 0-based
// and relative to the string passed to `md.render`). Purely informational for normal
// display; the git-diff marker decorator in Preview reads it to map changed source
// lines back onto rendered blocks. Covers open tokens (paragraph/heading/list/…)
// plus standalone `hr`; nested list items are tagged too, so a single changed item
// can be marked without lighting up its whole list.
md.core.ruler.push('source_line_attr', (state) => {
  for (const token of state.tokens) {
    if (!token.map) continue
    if (!token.type.endsWith('_open') && token.type !== 'hr') continue
    token.attrSet('data-src-line', String(token.map[0]))
    token.attrSet('data-src-end', String(token.map[1]))
  }
})

/**
 * Convert a Markdown string to HTML. If the source begins with a YAML frontmatter
 * block, that block is parsed and rendered as a GH-style key/value table above
 * the rest of the document. Malformed frontmatter falls back to plain rendering
 * (the `---` fences pass through as a thematic break).
 */
export function renderMarkdown(src: string): string {
  const { data, body } = extractFrontmatter(src)
  const fm = data !== null ? renderFrontmatterTable(data) : ''
  return fm + md.render(body)
}

/**
 * Render an arbitrary text blob as a single highlighted code block.
 * Used for non-Markdown viewable files (YAML, JSON, ...). The output is wrapped in
 * <pre><code class="hljs language-X"> so the existing .markdown-body CSS styles it.
 */
export function renderAsCodeBlock(content: string, lang: string): string {
  const safeLang = lang.replace(/[^a-z0-9_-]/gi, '').toLowerCase()
  let body: string
  if (safeLang && hljs.getLanguage(safeLang)) {
    try {
      body = hljs.highlight(content, { language: safeLang, ignoreIllegals: true }).value
    } catch {
      body = md.utils.escapeHtml(content)
    }
  } else {
    body = md.utils.escapeHtml(content)
  }
  const cls = safeLang ? `hljs language-${safeLang}` : 'hljs'
  return `<pre><code class="${cls}">${body}</code></pre>`
}
