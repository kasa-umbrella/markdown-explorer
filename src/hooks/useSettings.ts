import { useCallback, useState } from 'react'

export interface Settings {
  /** BrowserWindow opacity. macOS supports this natively. */
  windowOpacity: number
  /** Pin the window above other apps' windows. */
  alwaysOnTop: boolean
  /** Base font size of the rendered Markdown body (the main panel only). */
  mainFontSize: number
  /** Line-height multiplier for the rendered Markdown body. */
  mainLineHeight: number
  /** Reading column width (max-width of .markdown-body). */
  mainMaxWidth: number
  /** Soft-wrap long lines inside fenced code blocks instead of horizontal scrolling. */
  wrapCode: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  windowOpacity: 1,
  alwaysOnTop: false,
  mainFontSize: 17,
  mainLineHeight: 1.7,
  mainMaxWidth: 820,
  wrapCode: false,
}

export const SETTINGS_RANGES = {
  windowOpacity: { min: 0.4, max: 1, step: 0.05 },
  mainFontSize: { min: 12, max: 28, step: 1 },
  mainLineHeight: { min: 1.3, max: 2.2, step: 0.1 },
  mainMaxWidth: { min: 520, max: 1400, step: 20 },
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
      num(r.mainMaxWidth, DEFAULT_SETTINGS.mainMaxWidth),
      SETTINGS_RANGES.mainMaxWidth.min,
      SETTINGS_RANGES.mainMaxWidth.max,
    ),
    wrapCode: Boolean(r.wrapCode),
  }
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
