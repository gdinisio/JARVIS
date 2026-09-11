import type { EngineEvent, ConsoleEntry, ConsoleSource } from '@shared/types'
import { id, now } from '../util/id'
import { logger } from './logging'

type Sender = (event: EngineEvent) => void

/**
 * One-way channel from the main process to every open window, plus a small
 * replayable buffer so a window that opens late still sees recent activity.
 */
class EventBus {
  private senders = new Set<Sender>()
  private consoleBuffer: ConsoleEntry[] = []
  private listeners = new Set<(event: EngineEvent) => void>()

  registerSender(sender: Sender): () => void {
    this.senders.add(sender)
    return () => this.senders.delete(sender)
  }

  /** Main-process subscribers (tray state, proactive service, tests). */
  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: EngineEvent): void {
    if (event.type === 'console') {
      this.consoleBuffer.push(event.entry)
      if (this.consoleBuffer.length > 400) this.consoleBuffer.splice(0, this.consoleBuffer.length - 400)
    }
    for (const send of this.senders) {
      try {
        send(event)
      } catch {
        /* a window can disappear mid-send */
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        logger.error('bus', 'Event listener threw.', { error: String(error) })
      }
    }
  }

  /** Convenience for the activity console. */
  say(source: ConsoleSource, text: string, options: { detail?: string; level?: ConsoleEntry['level'] } = {}): ConsoleEntry {
    const entry: ConsoleEntry = {
      id: id('c'),
      ts: now(),
      source,
      text,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.level ? { level: options.level } : {})
    }
    this.emit({ type: 'console', entry })
    return entry
  }

  consoleHistory(): ConsoleEntry[] {
    return [...this.consoleBuffer]
  }
}

export const bus = new EventBus()
