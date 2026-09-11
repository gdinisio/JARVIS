import type { ReactNode } from 'react'
import type { JSX } from 'react'

/** Form primitives shared by Settings and the editors. */

export function Row({ label, hint, children, warn }: { label: string; hint?: ReactNode; children: ReactNode; warn?: boolean }): JSX.Element {
  return (
    <div className={`setting-row ${warn ? 'warn' : ''}`}>
      <div className="setting-label">
        <span>{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <span className="switch-track"><span className="switch-thumb" /></span>
    </label>
  )
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  label
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
  label: string
}): JSX.Element {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      />
      <span className="slider-value mono">{format ? format(value) : value.toFixed(2)}</span>
    </div>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
}): JSX.Element {
  return (
    <select className="field" value={value} onChange={(event) => onChange(event.target.value as T)} aria-label={label}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function TextField({
  value,
  onChange,
  placeholder,
  label,
  type = 'text',
  mono
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  type?: 'text' | 'password'
  mono?: boolean
}): JSX.Element {
  return (
    <input
      className={`field ${mono ? 'mono' : ''}`}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
    />
  )
}

/** Captures a keyboard shortcut by listening for the next chord pressed. */
export function HotkeyField({
  value,
  onChange,
  label
}: {
  value: string
  onChange: (value: string) => void
  label: string
}): JSX.Element {
  const capture = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const parts: string[] = []
    if (event.ctrlKey) parts.push('Control')
    if (event.metaKey) parts.push('Command')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')

    const key = event.key
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return
    if (key === 'Escape') {
      onChange('')
      event.currentTarget.blur()
      return
    }
    const named = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key
    parts.push(named)
    if (parts.length < 2) return
    onChange(parts.join('+'))
    event.currentTarget.blur()
  }

  return (
    <button className="hotkey-field" onKeyDown={capture} aria-label={label} title="Click, then press a shortcut. Escape clears it.">
      <span className="mono">{value || 'Not set'}</span>
      <span className="hotkey-hint label">click to change</span>
    </button>
  )
}
