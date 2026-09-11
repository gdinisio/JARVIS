import { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { playCue } from '../lib/sound'
import type { JSX } from 'react'

/**
 * The confirmation gate.
 *
 * Nothing destructive happens without passing through here. The dialog states
 * exactly what will happen, to what, and cannot be dismissed by accident:
 * Escape cancels, and focus is trapped until a choice is made.
 */
export function ConfirmDialog(): JSX.Element | null {
  const request = useStore((s) => s.confirm)
  const settings = useStore((s) => s.settings)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!request) return
    // Focus lands on Cancel: the safe option is the default.
    cancelRef.current?.focus()
    if (settings?.sound.enabled) playCue('confirm', settings.sound.volume)

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void window.jarvis.confirm(request.id, false)
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const target = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current
        target?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request, settings])

  if (!request) return null

  const respond = (approved: boolean) => {
    void window.jarvis.confirm(request.id, approved)
  }

  return (
    <div className="confirm-backdrop" role="presentation">
      <div
        className={`confirm panel risk-${request.risk}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />

        <div className="confirm-head">
          <div className={`risk-badge risk-${request.risk}`}>{request.risk} risk</div>
          <div className="label">{request.tool.replace(/_/g, ' ')}</div>
        </div>

        <h2 className="confirm-title" id="confirm-title">{request.title}</h2>
        <p className="confirm-body" id="confirm-body">{request.body}</p>

        {request.details && request.details.length > 0 && (
          <ul className="confirm-details scroll mono">
            {request.details.map((detail, index) => (
              <li key={`${detail}-${index}`}>{detail}</li>
            ))}
          </ul>
        )}

        <div className="confirm-actions">
          <button className="btn" ref={cancelRef} onClick={() => respond(false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            className={`btn ${request.risk === 'high' ? 'danger' : 'primary'}`}
            ref={confirmRef}
            onClick={() => respond(true)}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
