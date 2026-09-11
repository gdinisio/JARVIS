import { useEffect } from 'react'
import { useStore } from '../store/useStore'
import { playCue } from '../lib/sound'
import type { JSX } from 'react'

/** Transient, quiet notifications. They stack to four and expire on their own. */
export function Notifications(): JSX.Element | null {
  const notifications = useStore((s) => s.notifications)
  const dismiss = useStore((s) => s.dismissNotification)
  const settings = useStore((s) => s.settings)

  useEffect(() => {
    if (!notifications.length) return
    const latest = notifications[notifications.length - 1]
    if (settings?.sound.enabled) {
      playCue(latest.level === 'error' || latest.level === 'warn' ? 'error' : 'complete', settings.sound.volume * 0.6)
    }
    const timer = setTimeout(() => dismiss(latest.id), latest.level === 'error' ? 9000 : 6500)
    return () => clearTimeout(timer)
  }, [notifications, dismiss, settings])

  if (!notifications.length) return null

  return (
    <div className="toasts" role="status" aria-live="polite">
      {notifications.map((notification) => (
        <div className={`toast level-${notification.level}`} key={notification.id}>
          <span className="toast-bar" aria-hidden="true" />
          <div className="toast-body">
            <div className="toast-title">{notification.title}</div>
            {notification.body && <div className="toast-text">{notification.body}</div>}
          </div>
          <button className="toast-close" onClick={() => dismiss(notification.id)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
