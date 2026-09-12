import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { Core } from './Core'
import { PlanPanel } from './PlanPanel'
import { ActivityNodes } from './Console'
import { greeting } from '../lib/format'
import type { JSX } from 'react'

const STATUS_TEXT: Record<string, string> = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  executing: 'Executing',
  speaking: 'Speaking',
  complete: 'Complete',
  error: 'Attention required'
}

/** The centre of the interface: the core, what JARVIS is doing, and the plan. */
export function Stage(): JSX.Element {
  const status = useStore((s) => s.status)
  const messages = useStore((s) => s.messages)
  const provider = useStore((s) => s.provider)
  const memory = useStore((s) => s.memory)
  const transcribing = useStore((s) => s.transcribing)
  const [size, setSize] = useState(400)
  const hostRef = useRef<HTMLDivElement>(null)

  // The core scales with the space available rather than assuming a 4K display.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      setSize(Math.max(210, Math.min(480, Math.min(box.width - 40, box.height - 150))))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const name = memory.preferences.userName

  return (
    <div className="stage" ref={hostRef}>
      <div className="stage-core">
        <Core size={size} />
        <div className="stage-readout">
          <div className={`stage-status status-${status}`}>
            <span className="stage-status-text">{transcribing ? 'Transcribing' : STATUS_TEXT[status] ?? status}</span>
            <span className="stage-status-rule" />
          </div>
          {provider?.active && (
          <div className="stage-provider label">{provider.providers[provider.active]?.name ?? provider.active} engaged</div>
        )}
        </div>
      </div>

      <div className="stage-dialogue">
        {!lastUser && !lastAssistant ? (
          <div className="stage-welcome">
            <div className="stage-welcome-line">{greeting()}{name ? `, ${name}` : ''}. I am JARVIS.</div>
            <div className="stage-welcome-sub">
              {provider?.demo
                ? 'Running in demo mode — the interface is live, but nothing is executed.'
                : 'Ask me to open something, find something, or tell you how this machine is doing.'}
            </div>
          </div>
        ) : (
          <>
            {lastUser && (
              <div className="exchange user">
                <span className="exchange-role label">You</span>
                <p>{lastUser.text}</p>
              </div>
            )}
            {lastAssistant && (
              <div className={`exchange assistant ${lastAssistant.simulated ? 'simulated' : ''}`}>
                <span className="exchange-role label">
                  JARVIS{lastAssistant.provider ? ` · ${lastAssistant.provider}` : ''}
                </span>
                <p>{lastAssistant.text}</p>
              </div>
            )}
          </>
        )}
      </div>

      <ActivityNodes />
      <PlanPanel />
    </div>
  )
}
