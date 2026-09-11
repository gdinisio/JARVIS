import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'node:path'
import { settings } from '../services/settings'
import { routines } from '../core/routines'
import { engine } from '../core/engine'
import { bus } from '../services/bus'
import { logger } from '../services/logging'
import { showWindow, markQuitting } from './mainWindow'

let tray: Tray | null = null

/**
 * System tray (Windows) / menu bar (macOS).
 *
 * JARVIS keeps running here when the window is closed, so voice, routines and
 * monitoring survive a stray Cmd+W.
 */
export function createTray(): Tray | null {
  if (tray) return tray
  try {
    const iconPath = join(__dirname, '../../resources', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
    const image = nativeImage.createFromPath(iconPath)
    if (process.platform === 'darwin') image.setTemplateImage(true)

    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip('JARVIS')
    refreshTrayMenu()
    tray.on('click', () => showWindow())
    logger.info('tray', 'Tray icon created.')
    return tray
  } catch (error) {
    logger.warn('tray', 'Tray icon could not be created.', { error: String(error) })
    return null
  }
}

export function refreshTrayMenu(): void {
  if (!tray) return
  const config = settings.get()
  const savedRoutines = routines.list().filter((r) => r.enabled).slice(0, 8)

  const menu = Menu.buildFromTemplate([
    { label: 'Open JARVIS', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Speak replies',
      type: 'checkbox',
      checked: config.voice.enabled,
      click: (item) => settings.update({ voice: { enabled: item.checked } })
    },
    {
      label: `Listen for "${config.wakeWord.phrase}"`,
      type: 'checkbox',
      checked: config.wakeWord.enabled,
      click: (item) => settings.update({ wakeWord: { enabled: item.checked } })
    },
    { type: 'separator' },
    {
      label: 'Run routine',
      enabled: savedRoutines.length > 0,
      submenu: savedRoutines.length
        ? savedRoutines.map((routine) => ({
            label: routine.name,
            click: () => {
              showWindow()
              void engine.submit({ text: routine.name, source: 'routine' })
            }
          }))
        : [{ label: 'No routines saved', enabled: false }]
    },
    {
      label: 'Settings…',
      click: () => {
        showWindow()
        bus.emit({ type: 'activate', source: 'tray' })
      }
    },
    { type: 'separator' },
    {
      label: 'Quit JARVIS',
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
