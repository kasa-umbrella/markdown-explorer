import { useEffect, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { readBlobUrl, readTextFile } from '../lib/fsAccess'
import { isExternalUrl, isMarkdownLink, resolveRelative } from '../lib/paths'
import { renderMermaid } from '../lib/mermaid'

export type PreviewSource =
  | { kind: 'in-root'; path: string; files: Map<string, FileSystemFileHandle> }
  | { kind: 'external'; name: string; content: string }

interface Props {
  source: PreviewSource | null
  /** On clicking a md link in an in-root tab: navigate to another .md within the same tab. */
  onNavigate: (path: string) => void
  onBack: () => void
  onForward: () => void
  canBack: boolean
  canForward: boolean
}

interface Gesture {
  dir: 'back' | 'forward'
  /** 0 → just starting, 1 → about to fire (or just fired) */
  progress: number
}

export function Preview({
  source,
  onNavigate,
  onBack,
  onForward,
  canBack,
  canForward,
}: Props) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const swipeRef = useRef<HTMLDivElement>(null)

  // Split the source into primitive deps so effects only re-fire when content actually changes.
  const kind = source?.kind ?? null
  const path = source?.kind === 'in-root' ? source.path : null
  const files = source?.kind === 'in-root' ? source.files : null
  const externalName = source?.kind === 'external' ? source.name : null
  const externalContent = source?.kind === 'external' ? source.content : null

  // When the selected source changes, load and render it.
  useEffect(() => {
    if (!kind) {
      setHtml('')
      setError(null)
      return
    }
    if (kind === 'external') {
      setError(null)
      setHtml(renderMarkdown(externalContent ?? ''))
      return
    }
    if (!path || !files) return
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
  }, [kind, path, files, externalContent])

  // After rendering: swap image relative paths for Blob URLs (in-root only).
  useEffect(() => {
    const el = containerRef.current
    if (!el || kind !== 'in-root' || !path || !files) return
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
          img.setAttribute('alt', `（画像が見つかりません：${raw}）`)
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
  }, [html, kind, path, files])

  // For external tabs: still wrap tables and mark external anchors.
  useEffect(() => {
    const el = containerRef.current
    if (!el || kind !== 'external') return
    for (const img of Array.from(el.querySelectorAll('img'))) {
      const raw = img.getAttribute('src') ?? ''
      if (!raw || isExternalUrl(raw)) continue
      img.setAttribute('alt', `（外部ファイルでは相対パスを解決できません：${raw}）`)
    }
    for (const table of Array.from(el.querySelectorAll('table'))) {
      if (table.parentElement?.classList.contains('table-wrap')) continue
      const wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      table.replaceWith(wrap)
      wrap.appendChild(table)
    }
    for (const a of Array.from(el.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? ''
      if (isExternalUrl(href)) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
      }
    }
  }, [html, kind])

  // Render fenced ```mermaid blocks to SVG.
  // Markdown.ts deliberately skips highlight.js for `lang === 'mermaid'`, so the source
  // survives inside <code class="language-mermaid">…</code> with HTML entities intact.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let cancelled = false
    const blocks = el.querySelectorAll<HTMLElement>('code.language-mermaid')
    for (const code of Array.from(blocks)) {
      const pre = code.parentElement
      if (!pre || pre.tagName !== 'PRE') continue
      if (pre.dataset.mermaid === 'done') continue
      pre.dataset.mermaid = 'done'
      const source = code.textContent ?? ''
      ;(async () => {
        try {
          const svg = await renderMermaid(source)
          if (cancelled) return
          const wrap = document.createElement('div')
          wrap.className = 'mermaid'
          wrap.innerHTML = svg
          pre.replaceWith(wrap)
        } catch (err) {
          if (cancelled) return
          const box = document.createElement('div')
          box.className = 'mermaid-error'
          box.textContent = `Mermaid: ${err instanceof Error ? err.message : String(err)}`
          pre.replaceWith(box)
        }
      })()
    }
    return () => {
      cancelled = true
    }
  }, [html])

  // Intercept clicks on links inside the md and turn them into in-viewer navigation.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!href || isExternalUrl(href)) return
      if (href.startsWith('#')) {
        e.preventDefault()
        const id = decodeURIComponent(href.slice(1))
        el.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth' })
        return
      }
      if (kind === 'in-root' && path && isMarkdownLink(href)) {
        e.preventDefault()
        onNavigate(resolveRelative(path, href))
      } else {
        // External tab links or non-.md local references — block but don't navigate.
        e.preventDefault()
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [html, kind, path, onNavigate])

  // Scroll back to the top whenever the file changes — and also after the new
  // content has been rendered, in case the layout grew the scrollTop on re-render.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [kind, path, externalName, html])

  // Horizontal trackpad swipe → back / forward. macOS convention: swiping with two
  // fingers to the right (deltaX accumulates negative) goes back; left goes forward.
  // Updates `gesture` so the on-screen indicator follows the swipe in real time.
  useEffect(() => {
    const el = swipeRef.current
    if (!el) return
    const THRESHOLD = 140
    const COOLDOWN_MS = 600
    const GAP_RESET_MS = 160
    let accumX = 0
    let lastEventTime = 0
    let triggeredAt = 0
    let resetTimer: number | null = null

    const onWheel = (e: WheelEvent) => {
      const now = Date.now()
      if (now - triggeredAt < COOLDOWN_MS) return
      if (now - lastEventTime > GAP_RESET_MS) accumX = 0
      lastEventTime = now
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      accumX += e.deltaX

      if (accumX <= -THRESHOLD && canBack) {
        setGesture({ dir: 'back', progress: 1 })
        onBack()
        triggeredAt = now
        accumX = 0
        window.setTimeout(() => setGesture(null), 180)
        return
      }
      if (accumX >= THRESHOLD && canForward) {
        setGesture({ dir: 'forward', progress: 1 })
        onForward()
        triggeredAt = now
        accumX = 0
        window.setTimeout(() => setGesture(null), 180)
        return
      }

      const abs = Math.abs(accumX)
      if (abs < 4) {
        setGesture(null)
      } else {
        const dir: 'back' | 'forward' = accumX < 0 ? 'back' : 'forward'
        const allowed = dir === 'back' ? canBack : canForward
        setGesture(allowed ? { dir, progress: Math.min(1, abs / THRESHOLD) } : null)
      }

      if (resetTimer) window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => {
        accumX = 0
        setGesture(null)
      }, GAP_RESET_MS)
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (resetTimer) window.clearTimeout(resetTimer)
    }
  }, [canBack, canForward, onBack, onForward])

  // Touch swipe (touchscreens): right → back, left → forward, with live progress.
  useEffect(() => {
    const el = swipeRef.current
    if (!el) return
    const THRESHOLD = 90
    let startX = 0
    let startY = 0
    let tracking = false
    let lockedDir: 'h' | 'v' | null = null

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false
        setGesture(null)
        return
      }
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      tracking = true
      lockedDir = null
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      if (lockedDir === null) {
        const ax = Math.abs(dx)
        const ay = Math.abs(dy)
        if (ax > 10 || ay > 10) lockedDir = ax > ay ? 'h' : 'v'
        else return
      }
      if (lockedDir === 'v') return
      const dir: 'back' | 'forward' = dx > 0 ? 'back' : 'forward'
      const allowed = dir === 'back' ? canBack : canForward
      if (!allowed) {
        setGesture(null)
        return
      }
      setGesture({ dir, progress: Math.min(1, Math.abs(dx) / THRESHOLD) })
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return
      const horizontal = lockedDir === 'h'
      tracking = false
      if (!horizontal) {
        setGesture(null)
        return
      }
      const dx = e.changedTouches[0].clientX - startX
      if (Math.abs(dx) >= THRESHOLD) {
        if (dx > 0 && canBack) onBack()
        else if (dx < 0 && canForward) onForward()
      }
      setGesture(null)
    }
    const onTouchCancel = () => {
      tracking = false
      setGesture(null)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [canBack, canForward, onBack, onForward])

  // Clear any leftover indicator when the doc changes (e.g. after navigation fires).
  useEffect(() => {
    setGesture(null)
  }, [kind, path, externalName])

  if (!source) {
    return (
      <div className="preview empty">
        <p>左から .md を選択してください。ここに表示されます。</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="preview error">
        <p>このファイルを読み込めませんでした</p>
        <pre>{error}</pre>
      </div>
    )
  }
  const indicatorStyle = gesture
    ? (() => {
        const slide = gesture.dir === 'back' ? (gesture.progress - 1) * 30 : (1 - gesture.progress) * 30
        const scale = 0.6 + gesture.progress * 0.4
        return {
          opacity: 0.25 + gesture.progress * 0.75,
          transform: `translate(${slide}px, -50%) scale(${scale})`,
        }
      })()
    : undefined
  const headerText =
    source.kind === 'in-root' ? source.path : `📥 ${source.name}（外部ファイル）`
  return (
    <div className="preview-wrap" ref={swipeRef}>
      <div className="preview" ref={scrollRef}>
        <div className="doc-path">
          <div className="nav-buttons" role="group" aria-label="ナビゲーション">
            <button
              className="nav-btn"
              onClick={onBack}
              disabled={!canBack}
              title="戻る (⌘+[)"
              aria-label="戻る"
            >
              ‹
            </button>
            <button
              className="nav-btn"
              onClick={onForward}
              disabled={!canForward}
              title="進む (⌘+])"
              aria-label="進む"
            >
              ›
            </button>
          </div>
          <span className="path-text">{headerText}</span>
        </div>
        <article
          ref={containerRef}
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {gesture && (
        <div
          className={`swipe-indicator swipe-${gesture.dir}${gesture.progress >= 1 ? ' triggered' : ''}`}
          style={indicatorStyle}
          aria-hidden
        >
          {gesture.dir === 'back' ? '‹' : '›'}
        </div>
      )}
    </div>
  )
}
