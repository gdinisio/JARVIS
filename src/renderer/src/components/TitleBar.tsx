import { useEffect, useState } from 'react'
import { useStore, type ViewName } from '../store/useStore'
import { formatClock, formatDate } from '../lib/format'
import type { JSX } from 'react'

const VIEWS: Array<{ id: ViewName; label: string; key: string }> = [
  { id: 'command', label: 'Command', key: '1' },
  { id: 'routines', label: 'Routines', key: '2' },
  { id: 'memory', label: 'Memory', key: '3' },
  { id: 'history', label: 'History', key: '4' },
  { id: 'settings', label: 'Settings', key: '5' }
]

const STATUS_LABEL: Record<string, string> = {
  idle: 'STANDBY',
  listening: 'LISTENING',
  thinking: 'THINKING',
  executing: 'EXECUTING',
  speaking: 'SPEAKING',
  complete: 'COMPLETE',
  error: 'ATTENTION'
}

export function TitleBar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const status = useStore((s) => s.status)
  const provider = useStore((s) => s.provider)
  const platform = useStore((s) => s.platform)
  const screenAccess = useStore((s) => s.screenAccess)
  const listening = useStore((s) => s.listening)
  const wakeArmed = useStore((s) => s.wakeArmed)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // The DEMO MODE chip carries that state; this one always names the engine.
  const configuredCount = Object.values(provider?.providers ?? {}).filter((entry) => entry.configured).length
  const activeProvider = provider?.active
    ? (provider.providers[provider.active]?.name ?? provider.active).toUpperCase()
    : configuredCount > 0
      ? provider!.mode.toUpperCase()
      : 'NO KEY'

  return (
    <header className="titlebar">
      <div className="titlebar-drag" />

      <div className="titlebar-left">
        <div className="wordmark" title="Just A Really Very Intelligent System">
          <span className="wordmark-mark" aria-hidden="true" />
          <span className="wordmark-text">JARVIS</span>
        </div>
        <div className={`status-chip status-${status}`}>
          <span className="dot live" />
          {STATUS_LABEL[status] ?? status.toUpperCase()}
        </div>
        {provider?.demo && <div className="chip demo-chip">DEMO MODE</div>}
      </div>

      <nav className="titlebar-nav" aria-label="Sections">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            className={`nav-tab ${view === entry.id ? 'active' : ''}`}
            onClick={() => setView(entry.id)}
            title={`${entry.label}  (Ctrl+${entry.key})`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="titlebar-right">
        {screenAccess && (
          <div className="chip screen-chip" title="JARVIS is looking at your screen">
            <span className="dot live" /> SCREEN
          </div>
        )}
        {(listening || wakeArmed) && (
          <div className={`chip mic-chip ${listening ? 'hot' : ''}`} title={listening ? 'Microphone is open' : 'Wake word is armed'}>
            <span className={`dot ${listening ? 'live' : 'warn'}`} /> {listening ? 'MIC OPEN' : 'WAKE'}
          </div>
        )}
        <div className={`chip provider-chip ${provider?.online === false ? 'offline' : ''}`}>
          <span className={`dot ${provider?.online === false ? 'warn' : 'ok'}`} />
          {provider?.online === false ? 'OFFLINE' : activeProvider}
        </div>
        <div className="clock mono">
          <span className="clock-time">{formatClock(now)}</span>
          <span className="clock-date">{formatDate(now)}</span>
        </div>
        <div className="window-controls">
          <button className="win-btn" onClick={() => window.jarvis.window('minimise')} aria-label="Minimise" title="Minimise">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button className="win-btn" onClick={() => window.jarvis.window('maximise')} aria-label="Maximise" title="Maximise">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1" /></svg>
          </button>
          <button className="win-btn close" onClick={() => window.jarvis.window('close')} aria-label="Close to tray" title={platform === 'darwin' ? 'Close to menu bar' : 'Close to tray'}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
        </div>
      </div>
    </header>
  )
}
