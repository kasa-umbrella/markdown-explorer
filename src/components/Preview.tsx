import { useEffect, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { readBlobUrl, readTextFile } from '../lib/fsAccess'
import { isExternalUrl, isMarkdownLink, resolveRelative } from '../lib/paths'

interface Props {
  /** 現在表示中の .md のパス（ルート相対）。null なら未選択。 */
  path: string | null
  files: Map<string, FileSystemFileHandle>
  /** md リンククリック時：別の .md へ遷移する */
  onNavigate: (path: string) => void
}

export function Preview({ path, files, onNavigate }: Props) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 選択ファイルが変わったら読み込んでレンダリング。
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

  // レンダリング後：画像の相対パスを Blob URL に差し替える。
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
          img.setAttribute('alt', `(画像が見つからない: ${raw})`)
        }
      })()
    }

    // 横に大きいテーブルは、それ単体で横スクロールできるよう枠で包む。
    for (const table of Array.from(el.querySelectorAll('table'))) {
      if (table.parentElement?.classList.contains('table-wrap')) continue // 二重ラップ防止
      const wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      table.replaceWith(wrap)
      wrap.appendChild(table)
    }

    // 外部リンクは新規タブで開くよう印を付ける。
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

  // md 内リンクのクリックを横取りして、ビューア内遷移へ。
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
        // 同一ページ内アンカー：そのままスクロール
        e.preventDefault()
        const id = decodeURIComponent(href.slice(1))
        el.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth' })
      } else {
        // .md でないローカル参照（PDF等）は今は無視
        e.preventDefault()
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [html, path, onNavigate])

  // 表示が変わったら一番上へスクロール。
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 })
  }, [path])

  if (!path) {
    return (
      <div className="preview empty">
        <p>左から .md を選ぶ、と。……ここに、出る、よ。</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="preview error">
        <p>読み込めなかった。</p>
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
