import type { JarvisNotification } from '@shared/types'
import { bus } from './bus'
import { id, now } from '../util/id'
import { logger } from './logging'

/** Per-key cooldown so JARVIS never nags. */
const COOLDOWN_MS = 15 * 60 * 1000

class NotificationService {
  private lastShown = new Map<string, number>()

  notify(
    title: string,
    options: { body?: string; level?: JarvisNotification['level']; key?: string; actionLabel?: string; actionId?: string } = {}
  ): JarvisNotification | null {
    const key = options.key ?? title
    const last = this.lastShown.get(key) ?? 0
    if (now() - last < COOLDOWN_MS) {
      logger.debug('notifications', 'Suppressed by cooldown.', { key })
      return null
    }
    this.lastShown.set(key, now())

    const notification: JarvisNotification = {
      id: id('n'),
      title,
      level: options.level ?? 'info',
      ts: now(),
      ...(options.body ? { body: options.body } : {}),
      ...(options.actionLabel ? { actionLabel: options.actionLabel } : {}),
      ...(options.actionId ? { actionId: options.actionId } : {})
    }
    bus.emit({ type: 'notification', notification })
    return notification
  }
}

export const notifications = new NotificationService()
