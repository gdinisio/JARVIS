import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { formatClock } from '../lib/format'
import type { JSX } from 'react'

/**
 * The activity console.
 *
 * Shows what JARVIS is actually doing — every tool call, every security
 * decision, every failure. Entries can carry a detail payload (arguments,
 * plan steps, error output) revealed when the console is expanded.
 */
export function Console(): JSX.Element {
  const entries = useStore((s) => s.consoleEntries)
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pinned) return
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [entries, pinned, expanded])

  const onScroll = () => {
    const list = listRef.current
    if (!list) return
    setPinned(list.scrollHeight - list.scrollTop - list.clientHeight < 40)
  }

  return (
    <div className={`console panel ${expanded ? 'expanded' : ''}`}>
      <span className="corner tr" /><span className="corner bl" />
      <div className="console-head">
        <span className="label">Activity</span>
        <div className="console-actions">
          {!pinned && (
            <button className="btn ghost tiny" onClick={() => setPinned(true)} title="Jump to latest">
              Latest
            </button>
          )}
          <button className="btn ghost tiny" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>

      <div className="console-body scroll" ref={listRef} onScroll={onScroll}>
        {entries.length === 0 && <div className="empty">Standing by.</div>}
        {entries.map((entry) => (
          <div className={`console-line source-${entry.source.toLowerCase()} level-${entry.level ?? 'info'}`} key={entry.id}>
            <span className="console-time mono">{formatClock(entry.ts)}</span>
            <span className="console-source">{entry.source}</span>
            <span className="console-text">
              {entry.text}
              {expanded && entry.detail && <span className="console-detail mono">{entry.detail}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Live tool calls, rendered as nodes linked to the core. */
export function ActivityNodes(): JSX.Element | null {
  const activity = useStore((s) => s.activity)
  const recent = activity.filter((item) => Date.now() - item.ts < 30_000).slice(-6)
  if (!recent.length) return null

  return (
    <div className="nodes" aria-live="polite">
      {recent.map((item) => (
        <div className={`node node-${item.status}`} key={item.id} title={item.summary ?? item.name}>
          <span className="node-pip" />
          <span className="node-name mono">{item.name.replace(/_/g, ' ')}</span>
          <span className="node-status">{item.status === 'running' ? '···' : item.status === 'ok' ? '✓' : item.status === 'blocked' ? '⃠' : '✕'}</span>
        </div>
      ))}
    </div>
  )
}
