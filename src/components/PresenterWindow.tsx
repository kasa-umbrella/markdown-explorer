import { useCallback, useEffect, useRef, useState } from 'react'
import { enrichSlide, fmtClock, type PresentCtx } from '../lib/slideDom'
import type { PortableSlide } from '../lib/portableDeck'
import '../App.css'

/**
 * The detached presenter window's renderer. It owns no document state of its own —
 * it mirrors the main window: the deck (with images pre-baked as data URLs) and the
 * current index arrive over the IPC bridge, and navigation is sent back as commands
 * so the main window stays the single source of truth.
 */

interface DeckMessage {
  type: 'deck'
  slides: PortableSlide[]
  index: number
  theme: 'light' | 'dark'
  fontStack: string
}
interface IndexMessage {
  type: 'index'
  index: number
}
type IncomingMessage = DeckMessage | IndexMessage

// Images are already inlined as data URLs, so enrichSlide only needs to wrap tables
// and render mermaid — no filesystem context required.
const INERT_CTX: PresentCtx = { kind: 'external', absolutePath: null }

export function PresenterWindow() {
  const [slides, setSlides] = useState<PortableSlide[]>([])
  const [index, setIndex] = useState(0)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  const stageRef = useRef<HTMLElement>(null)
  const nextRef = useRef<HTMLElement>(null)

  const api = window.mdexp

  // Subscribe to deck / index pushes, then announce readiness so the main window
  // sends the initial deck.
  useEffect(() => {
    if (!api?.onToPresenter) return
    const off = api.onToPresenter((raw) => {
      const msg = raw as IncomingMessage | null
      if (!msg) return
      if (msg.type === 'deck') {
        setSlides(msg.slides)
        setIndex(msg.index)
        document.documentElement.dataset.theme = msg.theme
        if (msg.fontStack) document.documentElement.style.setProperty('--md-font', msg.fontStack)
      } else if (msg.type === 'index') {
        setIndex(msg.index)
      }
    })
    api.sendToMain?.({ type: 'ready' })
    return off
  }, [api])

  const total = slides.length
  const safeIndex = total ? Math.min(index, total - 1) : 0
  const current = total ? slides[safeIndex] : null
  const next = safeIndex + 1 < total ? slides[safeIndex + 1] : null

  const command = useCallback(
    (type: 'next' | 'prev' | 'exit') => api?.sendToMain?.({ type }),
    [api],
  )

  // Navigation / exit are forwarded to the main window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          command('next')
          break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault()
          command('prev')
          break
        case 'Escape':
          e.preventDefault()
          command('exit')
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [command])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el || !current) return
    let cancelled = false
    const cleanup = enrichSlide(el, INERT_CTX, () => cancelled)
    return () => {
      cancelled = true
      cleanup()
    }
  }, [safeIndex, current])

  useEffect(() => {
    const el = nextRef.current
    if (!el || !next) return
    let cancelled = false
    const cleanup = enrichSlide(el, INERT_CTX, () => cancelled)
    return () => {
      cancelled = true
      cleanup()
    }
  }, [safeIndex, next])

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))

  if (!current) {
    return (
      <div className="presentation presenter-window">
        <div className="presenter-waiting" />
      </div>
    )
  }

  return (
    <div className="presentation presenter presenter-window">
      <div className="presenter-grid">
        <div className="presenter-current">
          <div className="presenter-label">
            現在 ({safeIndex + 1}/{total})
          </div>
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
            <div
              className="notes-body markdown-body"
              dangerouslySetInnerHTML={{ __html: current.hasNotes ? current.notesHtml : '' }}
            />
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
      <div className="present-bar">
        <button
          className="present-ctl"
          onClick={() => command('prev')}
          disabled={safeIndex === 0}
          aria-label="前のスライド"
        >
          ‹
        </button>
        <span className="present-counter">
          {safeIndex + 1} / {total}
        </span>
        <button
          className="present-ctl"
          onClick={() => command('next')}
          disabled={safeIndex >= total - 1}
          aria-label="次のスライド"
        >
          ›
        </button>
        <span className="present-sep" />
        <button className="present-ctl" onClick={() => command('exit')} aria-label="終了">
          ✕ 終了
        </button>
      </div>
    </div>
  )
}
