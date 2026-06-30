/**
 * Selectable fonts for the Markdown preview body (and the graph node labels).
 *
 * Every face here ships via an `@fontsource/*` package — all Google Fonts under the
 * SIL Open Font License, so bundling them into the app is fine. The weight CSS is
 * pulled in lazily through {@link FontDef.load} so only the picked font's `.woff2`
 * subsets are fetched: the initial bundle stays light even with the display fonts listed.
 *
 * Scoped to the reading surface on purpose — display faces (e.g. Dela Gothic One) only
 * have a single weight and would wreck the sidebar / button chrome if applied app-wide.
 */

export type FontCategory = 'sans' | 'serif' | 'rounded' | 'display'

export interface FontDef {
  /** Stable id persisted in settings. */
  id: string
  /** Human-facing name shown in the picker. */
  label: string
  /** Short JP category tag shown beside the name. */
  tag: string
  category: FontCategory
  /** Full `font-family` value, including system fallbacks while the face loads. */
  stack: string
  /**
   * Register the face's weight CSS. Resolves once the `@font-face` rules are injected.
   * Noto Sans JP is bundled eagerly in `main.tsx`, so its loader is a no-op.
   */
  load: () => Promise<unknown>
}

const SANS_FALLBACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Sans', sans-serif"
const SERIF_FALLBACK = "'Hiragino Mincho ProN', 'YuMincho', 'Yu Mincho', serif"

/**
 * The picker lineup. Body-friendly faces ship 400/500/700 so headings and bold text
 * render with real weights; single-weight display faces load just 400.
 */
export const FONTS: FontDef[] = [
  {
    id: 'noto-sans-jp',
    label: 'Noto Sans JP',
    tag: 'ゴシック',
    category: 'sans',
    stack: `'Noto Sans JP', ${SANS_FALLBACK}`,
    // Bundled eagerly in main.tsx (the app's default body font).
    load: () => Promise.resolve(),
  },
  {
    id: 'biz-udpgothic',
    label: 'BIZ UDPGothic',
    tag: 'ゴシック',
    category: 'sans',
    stack: `'BIZ UDPGothic', ${SANS_FALLBACK}`,
    load: () =>
      Promise.all([
        import('@fontsource/biz-udpgothic/400.css'),
        import('@fontsource/biz-udpgothic/700.css'),
      ]),
  },
  {
    id: 'noto-serif-jp',
    label: 'Noto Serif JP',
    tag: '明朝',
    category: 'serif',
    stack: `'Noto Serif JP', ${SERIF_FALLBACK}`,
    load: () =>
      Promise.all([
        import('@fontsource/noto-serif-jp/400.css'),
        import('@fontsource/noto-serif-jp/500.css'),
        import('@fontsource/noto-serif-jp/700.css'),
      ]),
  },
  {
    id: 'm-plus-rounded-1c',
    label: 'M PLUS Rounded 1c',
    tag: 'まる',
    category: 'rounded',
    stack: `'M PLUS Rounded 1c', ${SANS_FALLBACK}`,
    load: () =>
      Promise.all([
        import('@fontsource/m-plus-rounded-1c/400.css'),
        import('@fontsource/m-plus-rounded-1c/500.css'),
        import('@fontsource/m-plus-rounded-1c/700.css'),
      ]),
  },
  {
    id: 'zen-maru-gothic',
    label: 'Zen Maru Gothic',
    tag: 'まる',
    category: 'rounded',
    stack: `'Zen Maru Gothic', ${SANS_FALLBACK}`,
    load: () =>
      Promise.all([
        import('@fontsource/zen-maru-gothic/400.css'),
        import('@fontsource/zen-maru-gothic/500.css'),
        import('@fontsource/zen-maru-gothic/700.css'),
      ]),
  },
  {
    id: 'kaisei-decol',
    label: 'Kaisei Decol',
    tag: 'デコ',
    category: 'rounded',
    stack: `'Kaisei Decol', ${SERIF_FALLBACK}`,
    load: () =>
      Promise.all([
        import('@fontsource/kaisei-decol/400.css'),
        import('@fontsource/kaisei-decol/500.css'),
        import('@fontsource/kaisei-decol/700.css'),
      ]),
  },
  {
    id: 'dela-gothic-one',
    label: 'Dela Gothic One',
    tag: '見出し',
    category: 'display',
    stack: `'Dela Gothic One', ${SANS_FALLBACK}`,
    // Display face — a single 400 weight is all that exists.
    load: () => import('@fontsource/dela-gothic-one/400.css'),
  },
]

export const DEFAULT_FONT_ID = 'noto-sans-jp'

const FONT_BY_ID = new Map(FONTS.map((f) => [f.id, f]))

/** Look up a font by id, falling back to the default when the id is unknown. */
export function getFont(id: string): FontDef {
  return FONT_BY_ID.get(id) ?? FONTS[0]
}

export function isFontId(id: unknown): id is string {
  return typeof id === 'string' && FONT_BY_ID.has(id)
}
