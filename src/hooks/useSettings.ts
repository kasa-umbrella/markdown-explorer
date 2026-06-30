import { useCallback, useState } from 'react'
import { parseExtensionList } from '../lib/extensions'
import { DEFAULT_FONT_ID, isFontId } from '../lib/fonts'

/** Color scheme: 'system' tracks the OS preference, 'light' / 'dark' force the choice. */
export type ThemePref = 'system' | 'light' | 'dark'

export interface Settings {
  /** BrowserWindow opacity. macOS supports this natively. */
  windowOpacity: number
  /** Pin the window above other apps' windows. */
  alwaysOnTop: boolean
  /** App-wide display font id (see `FONTS` in ../lib/fonts). Drives the :root font-family. */
  mainFont: string
  /** Base font size of the rendered Markdown body (the main panel only). */
  mainFontSize: number
  /** Line-height multiplier for the rendered Markdown body. */
  mainLineHeight: number
  /** Reading column width as a percentage of the main panel (max-width of .markdown-body). */
  mainMaxWidth: number
  /** Soft-wrap long lines inside fenced code blocks instead of horizontal scrolling. */
  wrapCode: boolean
  /** Color scheme preference. See {@link ThemePref}. */
  theme: ThemePref
  /**
   * Additional file extensions (without the leading dot, lowercase) to show in the tree and
   * render as syntax-highlighted code. Markdown extensions are always supported on top of this.
   */
  extraExtensions: string[]
  /**
   * Show entries whose name begins with a dot (e.g. `.claude/`, `.github/`).
   * Off by default — these are usually tool config / VCS state and only clutter the tree.
   */
  showHidden: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  windowOpacity: 1,
  alwaysOnTop: false,
  mainFont: DEFAULT_FONT_ID,
  mainFontSize: 17,
  mainLineHeight: 1.7,
  mainMaxWidth: 95,
  wrapCode: false,
  theme: 'system',
  extraExtensions: ['yaml', 'yml', 'json', 'csv'],
  showHidden: false,
}

export const SETTINGS_RANGES = {
  windowOpacity: { min: 0.4, max: 1, step: 0.05 },
  mainFontSize: { min: 12, max: 28, step: 1 },
  mainLineHeight: { min: 1.3, max: 2.2, step: 0.1 },
  mainMaxWidth: { min: 60, max: 100, step: 1 },
} as const

const STORAGE_KEY = 'app-settings'

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function sanitize(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS
  const r = raw as Partial<Record<keyof Settings, unknown>>
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    windowOpacity: clamp(
      num(r.windowOpacity, DEFAULT_SETTINGS.windowOpacity),
      SETTINGS_RANGES.windowOpacity.min,
      SETTINGS_RANGES.windowOpacity.max,
    ),
    alwaysOnTop: Boolean(r.alwaysOnTop),
    mainFont: isFontId(r.mainFont) ? r.mainFont : DEFAULT_SETTINGS.mainFont,
    mainFontSize: clamp(
      num(r.mainFontSize, DEFAULT_SETTINGS.mainFontSize),
      SETTINGS_RANGES.mainFontSize.min,
      SETTINGS_RANGES.mainFontSize.max,
    ),
    mainLineHeight: clamp(
      num(r.mainLineHeight, DEFAULT_SETTINGS.mainLineHeight),
      SETTINGS_RANGES.mainLineHeight.min,
      SETTINGS_RANGES.mainLineHeight.max,
    ),
    mainMaxWidth: clamp(
      // Legacy px values (pre-percent migration) are above the new range — reset to default.
      ((): number => {
        const v = num(r.mainMaxWidth, DEFAULT_SETTINGS.mainMaxWidth)
        return v > SETTINGS_RANGES.mainMaxWidth.max ? DEFAULT_SETTINGS.mainMaxWidth : v
      })(),
      SETTINGS_RANGES.mainMaxWidth.min,
      SETTINGS_RANGES.mainMaxWidth.max,
    ),
    wrapCode: Boolean(r.wrapCode),
    theme: sanitizeTheme(r.theme),
    extraExtensions: sanitizeExtensions(r.extraExtensions),
    showHidden: Boolean(r.showHidden),
  }
}

function sanitizeTheme(raw: unknown): ThemePref {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_SETTINGS.theme
}

function sanitizeExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_SETTINGS.extraExtensions
  return parseExtensionList(raw.filter((x): x is string => typeof x === 'string').join(','))
}

function loadInitial(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return sanitize(JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}

function persist(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // localStorage may be unavailable (private mode, quota). Settings still work in-memory.
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadInitial)

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = sanitize({ ...prev, ...patch })
      persist(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    persist(DEFAULT_SETTINGS)
    setSettings(DEFAULT_SETTINGS)
  }, [])

  return { settings, update, reset }
}
