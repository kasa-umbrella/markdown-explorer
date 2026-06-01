import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import anchor from 'markdown-it-anchor'
import hljs from 'highlight.js'

/**
 * GFM 相当の markdown-it インスタンス。
 * - 表・打ち消し線などは markdown-it 標準で有効
 * - タスクリストはプラグインで追加
 * - 見出しに id（アンカー）付与
 * - コードブロックは highlight.js
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
        /* 失敗時は素通し */
      }
    }
    return md.utils.escapeHtml(code)
  },
})
  .use(taskLists, { label: true })
  .use(anchor, { permalink: false })

/** Markdown 文字列を HTML へ。 */
export function renderMarkdown(src: string): string {
  return md.render(src)
}
