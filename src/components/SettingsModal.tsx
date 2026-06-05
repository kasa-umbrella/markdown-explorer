import { useEffect } from 'react'
import { SETTINGS_RANGES, type Settings } from '../hooks/useSettings'

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
            format={(v) => `${v}px`}
            onChange={(v) => onUpdate({ mainMaxWidth: v })}
          />
          <Toggle
            label="コードを折り返す"
            checked={settings.wrapCode}
            onChange={(checked) => onUpdate({ wrapCode: checked })}
          />
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
