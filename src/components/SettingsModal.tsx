import { useEffect, useState } from 'react'
import { SETTINGS_RANGES, type Settings, type ThemePref } from '../hooks/useSettings'
import { parseExtensionList } from '../lib/extensions'
import { FONTS } from '../lib/fonts'

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
          {window.mdexp && (
            <>
              <button className="ghost" onClick={() => window.mdexp?.newWindow()}>
                新しいウィンドウを開く
              </button>
              <p className="settings-help">
                ⌘N（Ctrl+N）でも開けます。透明度・手前表示はウィンドウごとに独立です。
              </p>
            </>
          )}
        </section>

        <section className="settings-section">
          <h3>テーマ</h3>
          <ThemePicker
            value={settings.theme}
            onChange={(t) => onUpdate({ theme: t })}
          />
        </section>

        <section className="settings-section">
          <h3>フォント</h3>
          <FontPicker
            value={settings.mainFont}
            onChange={(id) => onUpdate({ mainFont: id })}
          />
          <p className="settings-help">
            アプリ全体（サイドバー・タブ・本文）の表示フォントを切り替えます。
            コードブロックなどの等幅フォントはそのままです。
          </p>
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
          <Toggle
            label="見出しを上部に固定"
            checked={settings.stickyHeadings}
            onChange={(checked) => onUpdate({ stickyHeadings: checked })}
          />
          <p className="settings-help">
            スクロール中、いま読んでいる位置の見出し（# / ## どれでも、直近の見出し）を
            上部に固定表示します。スクロールに合わせて中身が切り替わり、クリックでその見出しへ移動できます。
          </p>
          <Toggle
            label="git 差分を本文に表示"
            checked={settings.gitDiffMarkers}
            onChange={(checked) => onUpdate({ gitDiffMarkers: checked })}
          />
          <p className="settings-help">
            git 管理下のファイルで、直近のコミット以降に変わった箇所を本文の左に色帯で示します
            （緑＝追加 / 黄＝変更 / 赤＝削除あり）。ツールバーの差分ボタンでも切り替えられます。
          </p>
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
          <Toggle
            label="隠しファイル / フォルダを表示"
            checked={settings.showHidden}
            onChange={(checked) => onUpdate({ showHidden: checked })}
          />
          <p className="settings-help">
            「.」始まりの項目（.claude / .github など）をツリーに表示します。
            .git だけは大量のオブジェクトを抱えるため常に除外されます。
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

interface FontPickerProps {
  value: string
  onChange: (id: string) => void
}

/**
 * Vertical list of the selectable body fonts. Each row previews itself in its own face,
 * so on mount we eagerly load every face — otherwise the not-yet-picked rows would fall
 * back to the system font and the preview would be a lie.
 */
function FontPicker({ value, onChange }: FontPickerProps) {
  useEffect(() => {
    for (const font of FONTS) void font.load()
  }, [])

  return (
    <div className="settings-row settings-row-font">
      <span className="settings-label">フォント</span>
      <div className="font-picker" role="radiogroup" aria-label="フォント">
        {FONTS.map((font) => (
          <button
            key={font.id}
            type="button"
            role="radio"
            aria-checked={value === font.id}
            className={`font-pick${value === font.id ? ' active' : ''}`}
            style={{ fontFamily: font.stack }}
            onClick={() => onChange(font.id)}
          >
            <span className="font-pick-main">
              <span className="font-pick-name">{font.label}</span>
              <span className="font-pick-tag">{font.tag}</span>
            </span>
            <span className="font-pick-sample">あア亜 Markdown 123</span>
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
