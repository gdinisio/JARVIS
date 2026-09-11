import { useState } from 'react'
import { useStore } from '../store/useStore'
import { relativeTime } from '../lib/format'
import type { JSX } from 'react'

/**
 * Memory.
 *
 * Everything JARVIS remembers is listed here in plain language, and anything
 * can be removed. Nothing is stored that is not visible on this screen.
 */
export function MemoryView(): JSX.Element {
  const memory = useStore((s) => s.memory)
  const settings = useStore((s) => s.settings)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')

  const preferences = Object.entries(memory.preferences).filter(([, v]) => v)

  const add = async () => {
    if (!key.trim() || !value.trim()) return
    await window.jarvis.saveMemory(key.trim(), value.trim())
    setKey('')
    setValue('')
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1 className="view-title">Memory</h1>
          <p className="view-sub">
            {settings?.memory.enabled
              ? 'Preferences and facts JARVIS keeps between sessions. Stored on this computer only.'
              : 'Memory is currently switched off in Settings → Memory.'}
          </p>
        </div>
        <div className="view-actions">
          <button
            className="btn danger"
            disabled={!memory.entries.length}
            onClick={() => {
              if (confirm('Forget everything JARVIS has stored?')) void window.jarvis.clearMemory()
            }}
          >
            Forget everything
          </button>
        </div>
      </header>

      {preferences.length > 0 && (
        <section className="memory-section">
          <div className="label">Derived preferences</div>
          <div className="pref-grid">
            {preferences.map(([field, preferenceValue]) => (
              <div className="pref panel" key={field}>
                <span className="label">{field.replace(/([A-Z])/g, ' $1')}</span>
                <span className="pref-value">{String(preferenceValue)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="memory-section">
        <div className="label">Stored items</div>
        {memory.entries.length === 0 ? (
          <div className="empty">
            <div>Nothing stored yet.</div>
            <div className="empty-hint">Try: “Remember that my preferred browser is Firefox.”</div>
          </div>
        ) : (
          <div className="memory-list panel scroll">
            {memory.entries.map((entry) => (
              <div className="memory-row" key={entry.id}>
                <div className="memory-key">{entry.key}</div>
                <div className="memory-value">{entry.value}</div>
                <div className="memory-meta label">
                  {entry.origin} · {relativeTime(entry.updatedAt)}
                </div>
                <button className="btn ghost tiny danger" onClick={() => void window.jarvis.deleteMemory(entry.id)} aria-label={`Forget ${entry.key}`}>
                  Forget
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="memory-section">
        <div className="label">Add manually</div>
        <div className="memory-add">
          <input
            className="field"
            placeholder="Label, e.g. preferred browser"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-label="Memory label"
          />
          <input
            className="field"
            placeholder="Value, e.g. Firefox"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void add()}
            aria-label="Memory value"
          />
          <button className="btn primary" onClick={() => void add()} disabled={!key.trim() || !value.trim()}>
            Remember
          </button>
        </div>
      </section>
    </div>
  )
}
