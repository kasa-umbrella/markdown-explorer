import { md } from './markdown'
import { extractFrontmatter } from './frontmatter'

/**
 * How a markdown document is sliced into slides.
 *
 *  - `auto`  (default): if the document contains standalone `---` separators they
 *    win; otherwise we split before every heading at the *shallowest* level present
 *    (so a note with one `#` title and several `##` sections splits on the `##`s).
 *    This lets any existing note become a deck with zero edits.
 *  - `hr`    : split only on `---` / `***` / `___` thematic breaks.
 *  - `h1`/`h2`: split before every heading of that level (plus any thematic breaks).
 */
export type SplitStrategy = 'auto' | 'hr' | 'h1' | 'h2'

export interface SlideData {
  /** Rendered HTML of the slide body (no frontmatter table, notes stripped). */
  bodyHtml: string
  /** Rendered HTML of the speaker notes — shown only in the presenter view. */
  notesHtml: string
  /** Whether this slide carries any speaker notes. */
  hasNotes: boolean
}

export interface Deck {
  slides: SlideData[]
  /** Deck title taken from frontmatter `title`, when present. */
  title: string | null
}

interface LineKind {
  /** A thematic break being used as a hard slide separator. */
  hr: boolean
  /** ATX heading level (1–6), or null. */
  heading: number | null
}

/** A line that opens or closes a fenced code block (``` or ~~~, 3+). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING_RE = /^ {0,3}(#{1,6})(\s|$)/
/** Markdown thematic break: 3+ of -, *, or _, optionally space-separated. */
const HR_RE = /^ {0,3}([-*_]) *(\1 *){2,}$/

/**
 * Classify every line as heading / thematic-break / plain, while tracking fenced
 * code blocks so a `---` or `#` *inside* a code fence is never read as structure.
 * Thematic breaks only count when the previous line is blank, so a setext H2
 * underline (`Title` then `---`) isn't mistaken for a slide separator.
 */
function classifyLines(lines: string[]): LineKind[] {
  const out: LineKind[] = []
  let inFence = false
  let fenceChar = ''
  let prevBlank = true
  for (const line of lines) {
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const ch = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar && fence[2].trim() === '') {
        inFence = false
      }
      out.push({ hr: false, heading: null })
      prevBlank = false
      continue
    }
    if (inFence) {
      out.push({ hr: false, heading: null })
      prevBlank = line.trim() === ''
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      out.push({ hr: false, heading: heading[1].length })
      prevBlank = false
      continue
    }
    if (HR_RE.test(line) && prevBlank) {
      out.push({ hr: true, heading: null })
      prevBlank = false
      continue
    }
    out.push({ hr: false, heading: null })
    prevBlank = line.trim() === ''
  }
  return out
}

/** Split the body lines into raw per-slide markdown chunks following `strategy`. */
function buildChunks(lines: string[], kinds: LineKind[], strategy: SplitStrategy): string[] {
  const headingLevels = kinds
    .map((k) => k.heading)
    .filter((lvl): lvl is number => lvl != null)

  // Marp-style "heading divider": start a new slide before any heading whose level
  // is at or above `splitMaxLevel` (i.e. level <= splitMaxLevel). 0 disables it.
  let splitMaxLevel = 0
  if (strategy === 'h1') splitMaxLevel = 1
  else if (strategy === 'h2') splitMaxLevel = 2
  else if (strategy === 'auto') {
    const hasHr = kinds.some((k) => k.hr)
    if (hasHr || headingLevels.length === 0) {
      // Hand-authored decks (explicit `---`) keep their own breaks; a doc with no
      // headings stays a single slide.
      splitMaxLevel = 0
    } else if (headingLevels.some((lvl) => lvl <= 2)) {
      // The common note shape — one `#` title plus several `##` sections — breaks on
      // both, so the title leads and each section becomes its own slide. Deeper
      // (### …) headings stay inside their section.
      splitMaxLevel = 2
    } else {
      // Only deeper headings exist (### …): break on the shallowest level present.
      splitMaxLevel = Math.min(...headingLevels)
    }
  }
  // strategy === 'hr' leaves splitMaxLevel 0: separate on thematic breaks only.

  const chunks: string[] = []
  let cur: string[] = []
  const flush = () => {
    if (cur.length) {
      chunks.push(cur.join('\n'))
      cur = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const k = kinds[i]
    if (k.hr) {
      // Separator line itself is dropped; the next line starts a fresh slide.
      flush()
      continue
    }
    if (
      splitMaxLevel > 0 &&
      k.heading != null &&
      k.heading <= splitMaxLevel &&
      (cur.length || chunks.length)
    ) {
      // Start a new slide at this heading (kept in the new chunk). The guard avoids
      // emitting an empty leading slide when the doc opens straight with a heading.
      flush()
    }
    cur.push(lines[i])
  }
  flush()
  return chunks
}

/** Recognises `<!-- note: … -->` / `<!-- notes: … -->` / `<!-- speaker: … -->`. */
const NOTE_COMMENT_RE = /<!--\s*(?:notes?|speaker)\s*:?\s*([\s\S]*?)-->/gi

/**
 * Pull speaker notes out of one slide chunk. Two conventions, combined:
 *   - a `???` line (reveal.js style): everything after it on the slide is notes;
 *   - `<!-- note: … -->` comments anywhere in the body (invisible in normal preview).
 * Returns the cleaned slide body and the collected notes (both raw markdown).
 */
function extractNotes(chunk: string): { body: string; notes: string } {
  const noteParts: string[] = []
  const lines = chunk.split('\n')

  // 1) First non-fenced `???` line marks the start of notes.
  let inFence = false
  let fenceChar = ''
  let sep = -1
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_RE.exec(lines[i])
    if (fence) {
      const ch = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar && fence[2].trim() === '') {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    if (lines[i].trim() === '???') {
      sep = i
      break
    }
  }
  let body = chunk
  if (sep >= 0) {
    body = lines.slice(0, sep).join('\n')
    noteParts.push(lines.slice(sep + 1).join('\n').trim())
  }

  // 2) Comment-style notes anywhere in the remaining body.
  body = body.replace(NOTE_COMMENT_RE, (_full, inner: string) => {
    const t = String(inner).trim()
    if (t) noteParts.push(t)
    return ''
  })

  return {
    body: body.trim(),
    notes: noteParts.filter(Boolean).join('\n\n').trim(),
  }
}

function extractTitle(data: unknown): string | null {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const t = (data as Record<string, unknown>).title
    if (typeof t === 'string' && t.trim()) return t.trim()
  }
  return null
}

/**
 * Turn a markdown document into a deck. Frontmatter is stripped (its `title`
 * surfaces as the deck title); the body is split per `strategy`, speaker notes
 * are separated out, and each slide is rendered through the shared markdown-it
 * pipeline so code/tables/mermaid look identical to the reading view.
 */
export function buildDeck(src: string, strategy: SplitStrategy = 'auto'): Deck {
  const { data, body } = extractFrontmatter(src)
  const title = extractTitle(data)
  const lines = body.split(/\r?\n/)
  const kinds = classifyLines(lines)
  let chunks = buildChunks(lines, kinds, strategy)
  if (chunks.length === 0 && body.trim()) chunks = [body]

  const slides: SlideData[] = []
  for (const chunk of chunks) {
    const { body: slideBody, notes } = extractNotes(chunk)
    if (!slideBody && !notes) continue
    slides.push({
      bodyHtml: md.render(slideBody),
      notesHtml: notes ? md.render(notes) : '',
      hasNotes: notes.length > 0,
    })
  }
  // Always show at least one slide so an empty / notes-only doc still presents.
  if (slides.length === 0) {
    slides.push({ bodyHtml: md.render(body), notesHtml: '', hasNotes: false })
  }
  return { slides, title }
}
