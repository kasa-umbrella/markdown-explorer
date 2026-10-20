import { guessMimeFromPath, isExternalUrl, resolveAbsoluteRelative } from './paths'
import { renderMermaid } from './mermaid'

/**
 * What a slide needs to resolve its relative images: the source file's on-disk path
 * (images are read via IPC relative to it). Null when the path is unknown. The
 * detached presenter window passes images pre-baked as data URLs, so it can pass a
 * null path and rely on those.
 */
export type PresentCtx = { absolutePath: string | null }

/**
 * Post-render enrichment for a freshly-injected slide DOM: wrap tables, mark
 * external links, resolve relative images to Blob URLs, and render mermaid blocks
 * to static SVG.
 *
 * This deliberately parallels (a simpler, static-only subset of) the post-render
 * effects in Preview.tsx. The reading view needs interactive React-Flow charts and
 * StrictMode-safe retry bookkeeping; a slide only needs a one-shot static render, so
 * keeping a separate, smaller routine here avoids dragging that machinery — and
 * Preview's in-flight mermaid debugging — into the deck. Returns a cleanup that
 * revokes any Blob URLs it created.
 *
 * Images whose src is already an external scheme (http(s):, data:, …) are left as-is;
 * that's how the presenter window's pre-baked data URLs pass through untouched.
 */
export function enrichSlide(
  el: HTMLElement,
  ctx: PresentCtx,
  isCancelled: () => boolean,
): () => void {
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

  // External links open in the browser; local links are inert during a deck.
  for (const a of Array.from(el.querySelectorAll('a'))) {
    if (isExternalUrl(a.getAttribute('href') ?? '')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }

  // Relative images → Blob URLs, resolved against the source file's on-disk path.
  for (const img of Array.from(el.querySelectorAll('img'))) {
    const raw = img.getAttribute('src') ?? ''
    if (!raw || isExternalUrl(raw)) continue
    if (ctx.absolutePath && api?.readBinaryFileByPath) {
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
export function fmtClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
