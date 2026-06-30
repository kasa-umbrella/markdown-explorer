import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildDeck, type SplitStrategy } from '../lib/slides'
import { isExternalUrl } from '../lib/paths'
import { enrichSlide, fmtClock, type PresentCtx } from '../lib/slideDom'
import { portableizeDeck, type PortableDeck } from '../lib/portableDeck'

// Re-exported so existing importers (App) keep getting the type from here.
export type { PresentCtx } from '../lib/slideDom'

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
 * Full-window presentation overlay built live from the active markdown. Headings
 * (or `---`) become slides; arrow keys / space / click advance; `Esc` exits.
 *
 * The presenter view (🎤 / `F`) is dual-mode:
 *   - In Electron it opens a **detached** second window — the main window becomes the
 *     clean audience deck while the other window shows notes, the next slide, and a
 *     timer. Navigation round-trips through the main window, which stays the single
 *     source of truth for the current slide.
 *   - In a plain browser (no second-window IPC) it falls back to an in-window split.
 */
export function PresentationView({ markdown, ctx, strategy = 'auto', onExit }: Props) {
  const deck = useMemo(() => buildDeck(markdown, strategy), [markdown, strategy])
  const total = deck.slides.length

  const api = typeof window !== 'undefined' ? window.mdexp : undefined
  const canDetach = Boolean(api?.presenterOpen)

  const [index, setIndex] = useState(0)
  // In-window presenter split (browser fallback only).
  const [presenter, setPresenter] = useState(false)
  // Detached presenter window is open (Electron).
  const [detached, setDetached] = useState(false)
  const [portable, setPortable] = useState<PortableDeck | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  const safeIndex = Math.min(index, total - 1)
  const current = deck.slides[safeIndex]
  const next = safeIndex + 1 < total ? deck.slides[safeIndex + 1] : null

  const stageRef = useRef<HTMLElement>(null)
  const nextRef = useRef<HTMLElement>(null)
  const selfExitRef = useRef(false)
  const detachedRef = useRef(false)
  const presenterReadyRef = useRef(false)
  const deckSentRef = useRef(false)

  useEffect(() => {
    detachedRef.current = detached
  }, [detached])

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.max(0, Math.min(total - 1, i + delta))),
    [total],
  )
  const goTo = useCallback(
    (i: number) => setIndex(Math.max(0, Math.min(total - 1, i))),
    [total],
  )

  // ── Detached presenter window (Electron dual-screen) ──
  // Send the deck once the presenter window is both mounted (ready) and the deck has
  // been made portable (images inlined). Either may finish first, so both paths call
  // this and a ref guards against a double send.
  const trySendDeck = useCallback(() => {
    if (!api || !presenterReadyRef.current || !portable || deckSentRef.current) return
    deckSentRef.current = true
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    const fontStack = getComputedStyle(document.documentElement)
      .getPropertyValue('--md-font')
      .trim()
    api.sendToPresenter({ type: 'deck', slides: portable.slides, index: safeIndex, theme, fontStack })
  }, [api, portable, safeIndex])

  const enterDetached = useCallback(async () => {
    if (!api?.presenterOpen) return
    deckSentRef.current = false
    presenterReadyRef.current = false
    setDetached(true)
    api.presenterOpen()
    try {
      setPortable(await portableizeDeck(deck, ctx))
    } catch (err) {
      console.error('[present] portableize failed', err)
      // Fall back to the un-inlined deck — mermaid still renders; some images may not.
      setPortable({ slides: deck.slides })
    }
  }, [api, deck, ctx])

  const leaveDetached = useCallback(() => {
    setDetached(false)
    deckSentRef.current = false
    presenterReadyRef.current = false
    api?.presenterClose?.()
  }, [api])

  const togglePresenter = useCallback(() => {
    if (canDetach) {
      if (detached) leaveDetached()
      else void enterDetached()
    } else {
      setPresenter((p) => !p)
    }
  }, [canDetach, detached, enterDetached, leaveDetached])

  // Relay channel with the presenter window: receive ready / nav / exit commands,
  // and react to the user closing that window.
  useEffect(() => {
    if (!detached || !api?.onToMain) return
    const offMain = api.onToMain((raw) => {
      const msg = raw as { type?: string; index?: number } | null
      switch (msg?.type) {
        case 'ready':
          presenterReadyRef.current = true
          trySendDeck()
          break
        case 'next':
          go(1)
          break
        case 'prev':
          go(-1)
          break
        case 'goto':
          if (typeof msg.index === 'number') goTo(msg.index)
          break
        case 'exit':
          onExit()
          break
        default:
          break
      }
    })
    const offClosed = api.onPresenterClosed?.(() => {
      presenterReadyRef.current = false
      deckSentRef.current = false
      setDetached(false)
    })
    return () => {
      offMain()
      offClosed?.()
    }
  }, [detached, api, trySendDeck, go, goTo, onExit])

  // Retry the deck send when the portable deck arrives after the window was ready.
  useEffect(() => {
    if (detached) trySendDeck()
  }, [detached, portable, trySendDeck])

  // Push every navigation to the presenter window once the deck handshake is done.
  useEffect(() => {
    if (!detached || !api || !deckSentRef.current) return
    api.sendToPresenter({ type: 'index', index: safeIndex })
  }, [detached, api, safeIndex])

  // Close the presenter window if this overlay unmounts while it's still open.
  useEffect(
    () => () => {
      if (detachedRef.current) api?.presenterClose?.()
    },
    [api],
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
          togglePresenter()
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
  }, [go, goTo, total, onExit, togglePresenter])

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
      // Leaving full screen exits the show — except when a detached presenter window
      // is driving things (the audience window may be un-fullscreened deliberately to
      // reposition it across displays; only the presenter window or Esc ends it then).
      if (!inFs() && !selfExitRef.current && !detachedRef.current) onExit()
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

  // Tick the in-window presenter timer only while that split is visible.
  useEffect(() => {
    if (!presenter) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [presenter])

  // Auto-hide the control bar (and the cursor) after a spell of mouse stillness;
  // any movement brings them back. Skipped while the in-window split is open.
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

  // Enrich the next-slide thumbnail in the in-window presenter split.
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
  const presenterActive = presenter || detached

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
          className={`present-ctl${presenterActive ? ' active' : ''}`}
          onClick={togglePresenter}
          aria-pressed={presenterActive}
          title={canDetach ? '発表者ビューを別ウィンドウで開く (F)' : '発表者ビュー (F)'}
        >
          🎤 発表者
        </button>
        <button className="present-ctl" onClick={onExit} title="終了 (Esc)">
          ✕ 終了
        </button>
      </div>
    </div>
  )
}
