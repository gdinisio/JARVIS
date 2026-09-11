import { globalShortcut } from 'electron'
import { settings } from '../services/settings'
import { bus } from '../services/bus'
import { logger } from '../services/logging'
import { engine } from '../core/engine'
import { showWindow, toggleWindow } from './mainWindow'

let registered: string[] = []

/**
 * Global hotkeys.
 *
 * Registration can legitimately fail — Cmd+Space belongs to Spotlight until
 * the user gives it up — so every failure is reported rather than swallowed.
 */
export function registerHotkeys(): { failed: string[] } {
  unregisterHotkeys()
  const { hotkeys } = settings.get()
  const failed: string[] = []

  const attempt = (accelerator: string, handler: () => void) => {
    if (!accelerator?.trim()) return
    try {
      if (globalShortcut.register(accelerator, handler)) registered.push(accelerator)
      else failed.push(accelerator)
    } catch (error) {
      logger.warn('hotkeys', 'Shortcut could not be registered.', { accelerator, error: String(error) })
      failed.push(accelerator)
    }
  }

  attempt(hotkeys.activate, () => {
    toggleWindow()
    bus.emit({ type: 'activate', source: 'hotkey' })
  })

  attempt(hotkeys.pushToTalk, () => {
    showWindow()
    bus.emit({ type: 'listen', listening: true })
  })

  attempt(hotkeys.stopSpeaking, () => {
    bus.emit({ type: 'stop-speaking' })
    engine.cancel('Stopped.')
  })

  if (failed.length) {
    logger.warn('hotkeys', 'Some shortcuts are already taken by the system.', { failed })
  } else {
    logger.info('hotkeys', 'Global shortcuts registered.', { registered })
  }
  return { failed }
}

export function unregisterHotkeys(): void {
  for (const accelerator of registered) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      /* already gone */
    }
  }
  registered = []
}
