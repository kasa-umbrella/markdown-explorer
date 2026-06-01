import { useEffect, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { readBlobUrl, readTextFile } from '../lib/fsAccess'
import { isExternalUrl, isMarkdownLink, resolveRelative } from '../lib/paths'

interface Props {
  /** Path of the .md currently shown (relative to root). null means nothing selected. */
  path: string | null
  files: Map<string, FileSystemFileHandle>
  /** On clicking a md link: navigate to another .md */
  onNavigate: (path: string) => void
}

export function Preview({ path, files, onNavigate }: Props) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // When the selected file changes, load and render it.
  useEffect(() => {
    if (!path) {
      setHtml('')
      setError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const src = await readTextFile(files, path)
        if (cancelled) return
        setError(null)
        setHtml(renderMarkdown(src))
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, files])

  // After rendering: swap image relative paths for Blob URLs.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !path) return
    const created: string[] = []
    let cancelled = false

    const imgs = Array.from(el.querySelectorAll('img'))
    for (const img of imgs) {
      const raw = img.getAttribute('src') ?? ''
      if (!raw || isExternalUrl(raw)) continue
      const target = resolveRelative(path, raw)
      ;(async () => {
        const url = await readBlobUrl(files, target)
        if (cancelled) return
        if (url) {
          created.push(url)
          img.setAttribute('src', url)
        } else {
          img.setAttribute('alt', `（画像が迷子にゃ：${raw}）`)
        }
      })()
    }

    // Wrap wide tables in a frame so each can scroll horizontally on its own.
    for (const table of Array.from(el.querySelectorAll('table'))) {
      if (table.parentElement?.classList.contains('table-wrap')) continue // avoid double-wrapping
      const wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      table.replaceWith(wrap)
      wrap.appendChild(table)
    }

    // Mark external links to open in a new tab.
    for (const a of Array.from(el.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? ''
      if (isExternalUrl(href)) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
      }
    }

    return () => {
      cancelled = true
      created.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [html, path, files])

  // Intercept clicks on links inside the md and turn them into in-viewer navigation.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !path) return
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!href || isExternalUrl(href)) return
      if (isMarkdownLink(href)) {
        e.preventDefault()
        onNavigate(resolveRelative(path, href))
      } else if (href.startsWith('#')) {
        // Same-page anchor: just scroll to it
        e.preventDefault()
        const id = decodeURIComponent(href.slice(1))
        el.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth' })
      } else {
        // Non-.md local references (PDFs, etc.) are ignored for now
        e.preventDefault()
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [html, path, onNavigate])

  // Scroll back to the top whenever the view changes.
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 })
  }, [path])

  if (!path) {
    return (
      <div className="preview empty">
        <p>左で .md を選んでみてにゃん。ここに出てくるにゃん。</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="preview error">
        <p>このファイル、読めなかったにゃ</p>
        <pre>{error}</pre>
      </div>
    )
  }
  return (
    <div className="preview">
      <div className="doc-path">{path}</div>
      <article
        ref={containerRef}
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
