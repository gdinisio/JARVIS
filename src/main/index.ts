import { app, BrowserWindow, safeStorage, powerMonitor, net } from 'electron'
import { join } from 'node:path'
import electron from 'electron'
import { bindElectron } from './util/paths'
import { logger } from './services/logging'

// Electron must own the data directory before any store is constructed.
bindElectron(electron as unknown as { app: { getPath(name: string): string } })

import { loadEnvFiles, secrets } from './services/secrets'
import { settings } from './services/settings'
import { bus } from './services/bus'
import { monitoring } from './services/monitoring'
import { proactive } from './services/proactive'
import { providers } from './core/ai'
import { registerIpc } from './ipc'
import { createMainWindow, configurePermissions, showWindow, markQuitting, getWindow } from './windows/mainWindow'
import { createTray, refreshTrayMenu, destroyTray } from './windows/tray'
import { registerHotkeys, unregisterHotkeys } from './windows/hotkeys'
import { IPC } from '@shared/ipc'
import { platform } from './platform'

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  loadEnvFiles([app.getAppPath(), join(app.getAppPath(), '..'), process.cwd()])
  if (process.env.JARVIS_DEMO === '1') settings.update({ general: { demoMode: true } })

  app.setName('JARVIS')
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    secrets.bindSafeStorage(safeStorage)
    logger.info('app', 'JARVIS starting.', {
      version: app.getVersion(),
      platform: platform().label,
      electron: process.versions.electron,
      demo: settings.get().general.demoMode
    })

    configurePermissions()
    registerIpc()

    const window = createMainWindow()
    // Every window subscribes to the same event stream.
    const unsubscribe = bus.registerSender((event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC.event, event)
    })
    window.on('closed', unsubscribe)

    createTray()
    refreshTrayMenu()
    const { failed } = registerHotkeys()
    if (failed.length) {
      bus.say('SYSTEM', `These shortcuts are already in use: ${failed.join(', ')}. Change them in Settings → Hotkeys.`, {
        level: 'warn'
      })
    }

    void monitoring.start()
    proactive.start()
    providers.setOnline(net.isOnline())
    providers.broadcast()

    // Network and power transitions matter to a voice assistant.
    const onlinePoll = setInterval(() => providers.setOnline(net.isOnline()), 15_000)
    onlinePoll.unref?.()
    powerMonitor.on('suspend', () => {
      monitoring.stop()
      logger.info('app', 'System suspended.')
    })
    powerMonitor.on('resume', () => {
      void monitoring.start()
      providers.setOnline(net.isOnline())
      logger.info('app', 'System resumed.')
    })

    if (process.env.JARVIS_SMOKE === '1') {
      // End-to-end verification run; see src/main/dev/smoke.ts.
      window.once('ready-to-show', () => void import('./dev/smoke').then((module) => module.runSmoke(window)))
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      else showWindow()
    })
  })

  app.on('window-all-closed', () => {
    // JARVIS lives in the tray; it does not quit when the window closes.
  })

  app.on('before-quit', () => {
    markQuitting()
    unregisterHotkeys()
    destroyTray()
    monitoring.stop()
    settings.flush()
    logger.info('app', 'JARVIS shutting down.')
  })

  process.on('uncaughtException', (error) => {
    logger.error('app', 'Uncaught exception.', { error: error.message, stack: error.stack })
    bus.say('ERROR', 'An internal error occurred. JARVIS is still running.', { level: 'error' })
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('app', 'Unhandled rejection.', { reason: String(reason) })
  })
}

export { getWindow }
