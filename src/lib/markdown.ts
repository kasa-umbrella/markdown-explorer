import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import anchor from 'markdown-it-anchor'
import hljs from 'highlight.js'

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
  .use(taskLists, { label: true })
  .use(anchor, { permalink: false })

/** Convert a Markdown string to HTML. */
export function renderMarkdown(src: string): string {
  return md.render(src)
}
