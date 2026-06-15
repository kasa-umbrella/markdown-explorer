import { useEffect, useState } from 'react'
import { SETTINGS_RANGES, type Settings, type ThemePref } from '../hooks/useSettings'
import { parseExtensionList } from '../lib/extensions'

interface Props {
  settings: Settings
  onUpdate: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
}

export function SettingsModal({ settings, onUpdate, onReset, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <h2 id="settings-title">設定</h2>
          <button className="modal-close" aria-label="閉じる" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3>ウィンドウ</h3>
          <Slider
            label="透明度"
            value={settings.windowOpacity}
            range={SETTINGS_RANGES.windowOpacity}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onUpdate({ windowOpacity: v })}
          />
          <Toggle
            label="常に手前に表示"
            checked={settings.alwaysOnTop}
            onChange={(checked) => onUpdate({ alwaysOnTop: checked })}
          />
        </section>

        <section className="settings-section">
          <h3>テーマ</h3>
          <ThemePicker
            value={settings.theme}
            onChange={(t) => onUpdate({ theme: t })}
          />
        </section>

        <section className="settings-section">
          <h3>メイン画面</h3>
          <Slider
            label="文字サイズ"
            value={settings.mainFontSize}
            range={SETTINGS_RANGES.mainFontSize}
            format={(v) => `${v}px`}
            onChange={(v) => onUpdate({ mainFontSize: v })}
          />
          <Slider
            label="行の高さ"
            value={settings.mainLineHeight}
            range={SETTINGS_RANGES.mainLineHeight}
            format={(v) => v.toFixed(1)}
            onChange={(v) => onUpdate({ mainLineHeight: v })}
          />
          <Slider
            label="読み幅"
            value={settings.mainMaxWidth}
            range={SETTINGS_RANGES.mainMaxWidth}
            format={(v) => `${v}%`}
            onChange={(v) => onUpdate({ mainMaxWidth: v })}
          />
          <Toggle
            label="コードを折り返す"
            checked={settings.wrapCode}
            onChange={(checked) => onUpdate({ wrapCode: checked })}
          />
        </section>

        <section className="settings-section">
          <h3>対応する拡張子</h3>
          <ExtensionsField
            value={settings.extraExtensions}
            onChange={(next) => onUpdate({ extraExtensions: next })}
          />
          <p className="settings-help">
            .md などの Markdown は常に表示されます。ここで追加した拡張子のファイルは
            シンタックスハイライト付きでプレビューされます。
          </p>
        </section>

        <div className="settings-footer">
          <button className="ghost" onClick={onReset}>
            デフォルトに戻す
          </button>
          <button className="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

interface SliderProps {
  label: string
  value: number
  range: { min: number; max: number; step: number }
  format: (v: number) => string
  onChange: (v: number) => void
}

function Slider({ label, value, range, format, onChange }: SliderProps) {
  return (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="settings-value">{format(value)}</span>
    </label>
  )
}

interface ToggleProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="settings-row settings-row-toggle">
      <span className="settings-label">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

interface ThemePickerProps {
  value: ThemePref
  onChange: (v: ThemePref) => void
}

/** Segmented control for choosing color scheme: System / Light / Dark. */
function ThemePicker({ value, onChange }: ThemePickerProps) {
  const options: { id: ThemePref; label: string }[] = [
    { id: 'system', label: '自動' },
    { id: 'light', label: 'ライト' },
    { id: 'dark', label: 'ダーク' },
  ]
  return (
    <div className="settings-row settings-row-theme">
      <span className="settings-label">配色</span>
      <div className="theme-picker" role="radiogroup" aria-label="配色">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            className={`theme-pick${value === o.id ? ' active' : ''}`}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

interface ExtensionsFieldProps {
  value: string[]
  onChange: (next: string[]) => void
}

/**
 * Free-form text field for editing the additional viewable extensions. The field is uncontrolled
 * during editing (so the user can type intermediate states like "ya"), and commits a normalized
 * list back on blur or Enter.
 */
function ExtensionsField({ value, onChange }: ExtensionsFieldProps) {
  const display = value.join(', ')
  const [draft, setDraft] = useState(display)

  // Reset the draft when the canonical value changes from outside (e.g. "Reset to defaults").
  useEffect(() => {
    setDraft(display)
  }, [display])

  const commit = () => {
    const next = parseExtensionList(draft)
    onChange(next)
    setDraft(next.join(', '))
  }

  return (
    <div className="settings-row settings-row-text">
      <span className="settings-label">拡張子</span>
      <input
        type="text"
        className="settings-text"
        value={draft}
        placeholder="yaml, yml, json"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </div>
  )
}
