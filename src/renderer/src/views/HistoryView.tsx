import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore'
import { formatClock, formatDuration, relativeTime } from '../lib/format'
import type { JSX } from 'react'

const OUTCOME_LABEL: Record<string, string> = {
  success: 'SUCCESS',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED'
}

/** Everything JARVIS has been asked to do, and what came of it. */
export function HistoryView(): JSX.Element {
  const history = useStore((s) => s.history)
  const [filter, setFilter] = useState('')
  const [outcome, setOutcome] = useState<'all' | 'success' | 'failed' | 'blocked' | 'cancelled'>('all')

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return history.filter((entry) => {
      if (outcome !== 'all' && entry.outcome !== outcome) return false
      if (!needle) return true
      return entry.command.toLowerCase().includes(needle) || entry.actions.join(' ').toLowerCase().includes(needle)
    })
  }, [history, filter, outcome])

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1 className="view-title">Command history</h1>
          <p className="view-sub">{history.length} recorded request{history.length === 1 ? '' : 's'}.</p>
        </div>
        <div className="view-actions">
          <input
            className="field"
            placeholder="Filter…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter history"
          />
          <select className="field" value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)} aria-label="Filter by outcome">
            <option value="all">All outcomes</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="blocked">Blocked</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button
            className="btn danger"
            disabled={!history.length}
            onClick={() => {
              if (confirm('Clear the entire command history?')) void window.jarvis.clearHistory().then(() => location.reload())
            }}
          >
            Clear
          </button>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="empty">{history.length ? 'Nothing matches that filter.' : 'No commands yet.'}</div>
      ) : (
        <div className="table panel scroll">
          <div className="table-head">
            <span>Time</span>
            <span>Command</span>
            <span>Actions</span>
            <span>Result</span>
            <span>Duration</span>
          </div>
          {rows.map((entry) => (
            <div className={`table-row outcome-${entry.outcome}`} key={entry.id}>
              <span className="mono" title={new Date(entry.ts).toLocaleString()}>
                {formatClock(entry.ts)}
                <span className="table-sub">{relativeTime(entry.ts)}</span>
              </span>
              <span className="table-command">
                {entry.command}
                {entry.detail && <span className="table-sub">{entry.detail}</span>}
              </span>
              <span className="table-actions mono">
                {entry.actions.length ? entry.actions.map((action) => action.replace(/_/g, ' ')).join(', ') : '—'}
              </span>
              <span className={`outcome-badge outcome-${entry.outcome}`}>{OUTCOME_LABEL[entry.outcome]}</span>
              <span className="mono">
                {formatDuration(entry.durationMs)}
                <span className="table-sub">{entry.source}{entry.provider ? ` · ${entry.provider}` : ''}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
