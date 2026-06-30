import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildDeck, type SplitStrategy } from '../lib/slides'
import { readBlobUrl } from '../lib/fsAccess'
import {
  guessMimeFromPath,
  isExternalUrl,
  resolveAbsoluteRelative,
  resolveRelative,
} from '../lib/paths'
import { renderMermaid } from '../lib/mermaid'
import type { FileEntry } from '../types'

/**
 * What the presenter needs to resolve a slide's relative images. Mirrors the two
 * source kinds the Preview understands: an in-root file (resolve via the scan's
 * handle map) or an externally-opened file (resolve via its on-disk path + IPC).
 */
export type PresentCtx =
  | { kind: 'in-root'; path: string; files: Map<string, FileEntry> }
  | { kind: 'external'; absolutePath: string | null }

interface Props {
  /** Raw markdown of the slide deck source. */
  markdown: string
  /** Context for resolving relative image references inside slides. */
  ctx: PresentCtx
  /** How to slice the document into slides. Defaults to `auto`. */
  strategy?: SplitStrategy
  /** Leave presentation mode. */
  onExit: () => void
}

/**
 * Post-render enrichment for a freshly-injected slide DOM: wrap tables, mark
 * external links, resolve relative images to Blob URLs, and render mermaid blocks
 * to static SVG.
 *
 * This deliberately parallels (a simpler, static-only subset of) the post-render
 * effects in Preview.tsx. The reading view needs interactive React-Flow charts and
 * StrictMode-safe retry bookkeeping; a slide only needs a one-shot static render,
 * so keeping a separate, smaller routine here avoids dragging that machinery — and
 * Preview's in-flight mermaid debugging — into the deck. Returns a cleanup that
 * revokes any Blob URLs it created.
 */
function enrichSlide(el: HTMLElement, ctx: PresentCtx, isCancelled: () => boolean): () => void {
  const created: string[] = []
  const api = window.mdexp

  // Tables scroll on their own so a wide one never pushes the slide sideways.
  for (const table of Array.from(el.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('table-wrap')) continue
    if (table.classList.contains('frontmatter-table')) continue
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    table.replaceWith(wrap)
    wrap.appendChild(table)
  }

  // External links open in the browser; in-root links are inert during a deck
  // (handled by the stage click handler, which swallows their default nav).
  for (const a of Array.from(el.querySelectorAll('a'))) {
    if (isExternalUrl(a.getAttribute('href') ?? '')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }

  // Relative images → Blob URLs.
  for (const img of Array.from(el.querySelectorAll('img'))) {
    const raw = img.getAttribute('src') ?? ''
    if (!raw || isExternalUrl(raw)) continue
    if (ctx.kind === 'in-root') {
      const target = resolveRelative(ctx.path, raw)
      void (async () => {
        const url = await readBlobUrl(ctx.files, target)
        if (isCancelled()) {
          if (url) URL.revokeObjectURL(url)
          return
        }
        if (url) {
          created.push(url)
          img.setAttribute('src', url)
        } else {
          img.setAttribute('alt', `（画像が見つかりません：${raw}）`)
        }
      })()
    } else if (ctx.absolutePath && api?.readBinaryFileByPath) {
      const targetAbs = resolveAbsoluteRelative(ctx.absolutePath, raw)
      void (async () => {
        try {
          const buf = await api.readBinaryFileByPath(targetAbs)
          if (isCancelled()) return
          const blob = new Blob([buf], { type: guessMimeFromPath(targetAbs) })
          const url = URL.createObjectURL(blob)
          created.push(url)
          img.setAttribute('src', url)
        } catch {
          if (!isCancelled()) img.setAttribute('alt', `（画像が見つかりません：${raw}）`)
        }
      })()
    } else {
      img.setAttribute('alt', `（相対パスを解決できません：${raw}）`)
    }
  }

  // Mermaid fences → static SVG. markdown.ts emits the escaped source inside
  // <code class="language-mermaid">, so textContent recovers the original.
  for (const code of Array.from(el.querySelectorAll<HTMLElement>('code.language-mermaid'))) {
    const pre = code.parentElement
    if (!pre || pre.tagName !== 'PRE') continue
    const source = code.textContent ?? ''
    const host = document.createElement('div')
    host.className = 'mermaid'
    pre.replaceWith(host)
    void (async () => {
      try {
        const svg = await renderMermaid(source)
        if (isCancelled()) return
        host.innerHTML = svg
      } catch (err) {
        if (isCancelled()) return
        host.className = 'mermaid-error'
        host.textContent = `Mermaid: ${err instanceof Error ? err.message : String(err)}`
      }
    })()
  }

  return () => created.forEach((u) => URL.revokeObjectURL(u))
}

/** Seconds → `m:ss`. */
function fmtClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Full-window presentation / teleprompter overlay built live from the active
 * markdown. Headings (or `---`) become slides; arrow keys / space / click advance;
 * `F` opens a presenter view with speaker notes, the next slide, and an elapsed
 * timer; `Esc` exits.
 */
export function PresentationView({ markdown, ctx, strategy = 'auto', onExit }: Props) {
  const deck = useMemo(() => buildDeck(markdown, strategy), [markdown, strategy])
  const total = deck.slides.length

  const [index, setIndex] = useState(0)
  const [presenter, setPresenter] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  const safeIndex = Math.min(index, total - 1)
  const current = deck.slides[safeIndex]
  const next = safeIndex + 1 < total ? deck.slides[safeIndex + 1] : null

  const stageRef = useRef<HTMLElement>(null)
  const nextRef = useRef<HTMLElement>(null)
  const selfExitRef = useRef(false)

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.max(0, Math.min(total - 1, i + delta))),
    [total],
  )
  const goTo = useCallback(
    (i: number) => setIndex(Math.max(0, Math.min(total - 1, i))),
    [total],
  )

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'j':
        case 'l':
          e.preventDefault()
          go(1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'k':
        case 'h':
          e.preventDefault()
          go(-1)
          break
        case 'Home':
          e.preventDefault()
          goTo(0)
          break
        case 'End':
          e.preventDefault()
          goTo(total - 1)
          break
        case 'f':
        case 'F':
          e.preventDefault()
          setPresenter((p) => !p)
          break
        case 'Escape':
          e.preventDefault()
          onExit()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, goTo, total, onExit])

  // Drive the deck full-screen (best-effort), and treat the user leaving full
  // screen (Esc / native control) as an exit — but not our own teardown.
  useEffect(() => {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>
    }
    const d = document as Document & {
      webkitExitFullscreen?: () => Promise<void>
      webkitFullscreenElement?: Element | null
    }
    const inFs = () => Boolean(d.fullscreenElement || d.webkitFullscreenElement)
    const onFsChange = () => {
      if (!inFs() && !selfExitRef.current) onExit()
    }
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    if (!inFs()) {
      const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el)
      req?.().catch(() => {})
    }
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
      selfExitRef.current = true
      if (inFs()) {
        const exit = d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d)
        exit?.().catch(() => {})
      }
    }
  }, [onExit])

  // Tick the presenter-view timer only while it's visible.
  useEffect(() => {
    if (!presenter) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [presenter])

  // Auto-hide the control bar (and the cursor) after a spell of mouse stillness;
  // any movement brings them back. Skipped while the presenter view is open —
  // `showControls` (below) forces the bar visible there regardless of this state.
  useEffect(() => {
    if (presenter) return
    let timer: number | null = null
    const wake = () => {
      setControlsVisible(true)
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => setControlsVisible(false), 2600)
    }
    wake()
    window.addEventListener('mousemove', wake)
    return () => {
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
    }
  }, [presenter])

  // Enrich the on-screen slide whenever it (or the layout) changes.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let cancelled = false
    const cleanup = enrichSlide(el, ctx, () => cancelled)
    return () => {
      cancelled = true
      cleanup()
    }
  }, [safeIndex, presenter, ctx])

  // Enrich the next-slide thumbnail in the presenter view.
  useEffect(() => {
    const el = nextRef.current
    if (!el || !presenter || !next) return
    let cancelled = false
    const cleanup = enrichSlide(el, ctx, () => cancelled)
    return () => {
      cancelled = true
      cleanup()
    }
  }, [safeIndex, presenter, next, ctx])

  /** Click the slide: links are inert, otherwise left third = back, rest = forward. */
  const onStageClick = (e: React.MouseEvent<HTMLElement>) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (anchor) {
      if (!isExternalUrl(anchor.getAttribute('href') ?? '')) e.preventDefault()
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    if (e.clientX - rect.left < rect.width * 0.32) go(-1)
    else go(1)
  }

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const progress = total > 0 ? ((safeIndex + 1) / total) * 100 : 0
  const showControls = presenter || controlsVisible

  return (
    <div
      className={`presentation${presenter ? ' presenter' : ''}${showControls ? '' : ' idle'}`}
      role="region"
      aria-label="プレゼンテーション"
    >
      <div className="present-progress" style={{ width: `${progress}%` }} aria-hidden />

      {presenter ? (
        <div className="presenter-grid">
          <div className="presenter-current">
            <div className="presenter-label">現在 ({safeIndex + 1}/{total})</div>
            <div className="present-stage">
              <article
                ref={stageRef}
                className="markdown-body slide-body"
                dangerouslySetInnerHTML={{ __html: current.bodyHtml }}
              />
            </div>
          </div>
          <div className="presenter-side">
            <div className="presenter-timer">
              <span className="timer-clock">{fmtClock(elapsed)}</span>
              <button className="present-btn-sm" onClick={() => setStartedAt(Date.now())}>
                リセット
              </button>
            </div>
            <div className="presenter-notes">
              <div className="presenter-label">発表者ノート</div>
              {current.hasNotes ? (
                <div
                  className="notes-body markdown-body"
                  dangerouslySetInnerHTML={{ __html: current.notesHtml }}
                />
              ) : (
                <p className="notes-empty">
                  このスライドにノートはまだないよ。
                  <br />
                  本文に <code>&lt;!-- note: … --&gt;</code> と書くか、 <code>???</code>{' '}
                  の行より下に書くと、ここに台本として出るよ。
                </p>
              )}
            </div>
            <div className="presenter-next">
              <div className="presenter-label">
                {next ? `次 (${safeIndex + 2}/${total})` : '最後のスライド'}
              </div>
              {next ? (
                <div className="next-scale">
                  <article
                    ref={nextRef}
                    className="markdown-body slide-body"
                    dangerouslySetInnerHTML={{ __html: next.bodyHtml }}
                  />
                </div>
              ) : (
                <div className="next-end">おわり 🎉</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="present-stage" onClick={onStageClick}>
          <article
            ref={stageRef}
            className="markdown-body slide-body"
            dangerouslySetInnerHTML={{ __html: current.bodyHtml }}
          />
        </div>
      )}

      <div className="present-bar">
        <button
          className="present-ctl"
          onClick={() => go(-1)}
          disabled={safeIndex === 0}
          aria-label="前のスライド"
          title="前へ (←)"
        >
          ‹
        </button>
        <span className="present-counter">
          {safeIndex + 1} / {total}
        </span>
        <button
          className="present-ctl"
          onClick={() => go(1)}
          disabled={safeIndex >= total - 1}
          aria-label="次のスライド"
          title="次へ (→)"
        >
          ›
        </button>
        <span className="present-sep" />
        <button
          className={`present-ctl${presenter ? ' active' : ''}`}
          onClick={() => setPresenter((p) => !p)}
          aria-pressed={presenter}
          title="発表者ビュー (F)"
        >
          🎤 発表者
        </button>
        <button className="present-ctl" onClick={onExit} title="終了 (Esc)">
          ✕ 終了
        </button>
      </div>

      <div className="present-hint">← → 移動 ・ F 発表者ビュー ・ Esc 終了</div>
    </div>
  )
}
