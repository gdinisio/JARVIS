import { BrowserWindow, shell, session, nativeImage } from 'electron'
import { join } from 'node:path'
import { settings } from '../services/settings'
import { logger } from '../services/logging'
import { monitoring } from '../services/monitoring'

let window: BrowserWindow | null = null
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function getWindow(): BrowserWindow | null {
  return window
}

export function createMainWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window

  const appearance = settings.get().appearance
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png'))

  window = new BrowserWindow({
    width: appearance.compact ? 980 : 1320,
    height: appearance.compact ? 680 : 860,
    minWidth: 880,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#05060a',
    // A dark ground behind the canvas keeps the boot fade from flashing white.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    alwaysOnTop: appearance.alwaysOnTop,
    fullscreen: appearance.fullscreen,
    autoHideMenuBar: true,
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Animations must stop costing anything when the window is not visible.
      backgroundThrottling: true
    }
  })

  window.once('ready-to-show', () => {
    if (!settings.get().general.startMinimised) {
      window?.show()
      void monitoring.start()
    }
  })

  window.on('show', () => void monitoring.start())
  window.on('restore', () => void monitoring.start())
  window.on('minimize', () => monitoring.stop())

  // Closing sends JARVIS to the tray; quitting is explicit.
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window?.hide()
    monitoring.stop()
  })

  window.on('closed', () => {
    window = null
  })

  // External links never open inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url)
    if (target.protocol !== 'file:' && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173')) {
      event.preventDefault()
      if (/^https?:$/.test(target.protocol)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  logger.info('window', 'Main window created.')
  return window
}

/** The renderer is the only thing allowed to use the microphone. */
export function configurePermissions(): void {
  const allowed = new Set(['media', 'audioCapture', 'clipboard-sanitized-write'])

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const fromOurWindow = contents === window?.webContents
    const granted = fromOurWindow && allowed.has(permission) && settings.get().permissions.microphoneAccess
    logger.info('window', 'Permission request.', { permission, granted })
    callback(granted)
  })

  session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
    return allowed.has(permission) && settings.get().permissions.microphoneAccess
  })

  // Only the microphone is ever handed over, and only for our own window.
  session.defaultSession.setDisplayMediaRequestHandler?.((_request, callback) => {
    callback({})
  })
}

export function showWindow(focus = true): void {
  const win = window && !window.isDestroyed() ? window : createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  if (focus) win.focus()
  void monitoring.start()
}

export function toggleWindow(): void {
  if (window && window.isVisible() && window.isFocused()) {
    window.hide()
    monitoring.stop()
  } else {
    showWindow()
  }
}

export function applyWindowAppearance(): void {
  if (!window || window.isDestroyed()) return
  const appearance = settings.get().appearance
  window.setAlwaysOnTop(appearance.alwaysOnTop)
  if (window.isFullScreen() !== appearance.fullscreen) window.setFullScreen(appearance.fullscreen)
}
