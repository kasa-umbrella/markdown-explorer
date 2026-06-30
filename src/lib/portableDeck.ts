import type { Deck } from './slides'
import type { PresentCtx } from './slideDom'
import { readBlobUrl } from './fsAccess'
import {
  guessMimeFromPath,
  isExternalUrl,
  resolveAbsoluteRelative,
  resolveRelative,
} from './paths'

/**
 * A deck whose slide HTML is fully self-contained: every relative image has been
 * inlined as a `data:` URL. The detached presenter window lives in a separate
 * renderer that can't reach the FSA handle map (handles aren't transferable across
 * windows), so we bake images in before pushing the deck across the IPC bridge.
 */
export interface PortableSlide {
  bodyHtml: string
  notesHtml: string
  hasNotes: boolean
}
export interface PortableDeck {
  slides: PortableSlide[]
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

async function resolveImageToDataUrl(raw: string, ctx: PresentCtx): Promise<string | null> {
  if (ctx.kind === 'in-root') {
    const blobUrl = await readBlobUrl(ctx.files, resolveRelative(ctx.path, raw))
    if (!blobUrl) return null
    try {
      const blob = await (await fetch(blobUrl)).blob()
      return await blobToDataUrl(blob)
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }
  const api = window.mdexp
  if (!ctx.absolutePath || !api?.readBinaryFileByPath) return null
  try {
    const buf = await api.readBinaryFileByPath(resolveAbsoluteRelative(ctx.absolutePath, raw))
    return await blobToDataUrl(new Blob([buf], { type: guessMimeFromPath(raw) }))
  } catch {
    return null
  }
}

/** Inline every relative <img> in an HTML fragment as a data URL. */
async function portableizeHtml(html: string, ctx: PresentCtx): Promise<string> {
  if (!html.includes('<img')) return html
  // A <template>'s content is inert: images don't load while we rewrite their src.
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const imgs = Array.from(tpl.content.querySelectorAll('img'))
  await Promise.all(
    imgs.map(async (img) => {
      const raw = img.getAttribute('src') ?? ''
      if (!raw || isExternalUrl(raw)) return // http(s):/data: are already portable
      const dataUrl = await resolveImageToDataUrl(raw, ctx)
      if (dataUrl) img.setAttribute('src', dataUrl)
      else img.setAttribute('alt', `（画像が見つかりません：${raw}）`)
    }),
  )
  return tpl.innerHTML
}

/**
 * Build a self-contained copy of `deck` for the detached presenter window: image
 * refs become inline data URLs. Mermaid blocks are left as source — the presenter
 * window renders them locally (no filesystem access needed).
 */
export async function portableizeDeck(deck: Deck, ctx: PresentCtx): Promise<PortableDeck> {
  const slides = await Promise.all(
    deck.slides.map(async (s) => ({
      bodyHtml: await portableizeHtml(s.bodyHtml, ctx),
      notesHtml: s.notesHtml ? await portableizeHtml(s.notesHtml, ctx) : '',
      hasNotes: s.hasNotes,
    })),
  )
  return { slides }
}
