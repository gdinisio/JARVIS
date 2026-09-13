import { ipcMain, shell, app, dialog } from 'electron'
import type { Snapshot, SubmitRequest, Settings } from '@shared/types'
import type { ProviderId } from '@shared/providers'
import { IPC, type WindowCommand } from '@shared/ipc'
import { engine } from '../core/engine'
import { settings } from '../services/settings'
import { secrets, isKnownSecret, type SecretName } from '../services/secrets'
import { providers } from '../core/ai'
import { memory } from '../core/memory'
import { routines } from '../core/routines'
import { history } from '../services/history'
import { monitoring } from '../services/monitoring'
import { bus } from '../services/bus'
import { logger } from '../services/logging'
import { TOOL_DESCRIPTORS } from '../tools/descriptors'
import { executeTool } from '../tools/registry'
import { decide } from '../core/permissions'
import { platform } from '../platform'
import { captureScreenDataUrl } from '../platform/shared'
import { getWindow, applyWindowAppearance, showWindow } from '../windows/mainWindow'
import { refreshTrayMenu } from '../windows/tray'
import { registerHotkeys } from '../windows/hotkeys'
import { speakNative, stopNativeSpeech } from '../services/speech'
import { MODEL_EXTENSIONS } from '@shared/geometry'
import { listModels, getModel, onModelsChanged, loadModelFile, closeModel, exportModel, GeometryError } from '../geometry'

/**
 * The IPC surface.
 *
 * Every channel is explicit and validated here; the renderer has no other way
 * to reach the main process, and never receives an API key.
 */
/** Windows and macOS support login items; elsewhere this is a no-op. */
export function applyLoginItem(config = settings.get()): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  try {
    // "Start minimised" is honoured by the window itself, so openAtLogin is
    // the only flag the OS needs from us.
    app.setLoginItemSettings({ openAtLogin: config.general.launchOnStartup })
  } catch (error) {
    logger.warn('ipc', 'Launch at login could not be configured.', { error: String(error) })
  }
}

/** Shared by the file dialog and drag-and-drop: open, announce, report. */
async function openFromDisk(path: string): Promise<{ ok: boolean; error?: string; summary?: unknown }> {
  if (!path) return { ok: false, error: 'No file was chosen.' }
  try {
    const summary = await loadModelFile(path)
    bus.say('SYSTEM', `Opened ${summary.name} — ${summary.stats.triangles.toLocaleString()} triangles.`)
    return { ok: true, summary }
  } catch (error) {
    const message = error instanceof GeometryError
      ? error.message
      : `That model could not be opened — ${String(error).slice(0, 160)}`
    logger.warn('geometry', 'Model open failed.', { error: String(error) })
    bus.say('SYSTEM', message, { level: 'error' })
    return { ok: false, error: message }
  }
}

export function registerIpc(): void {
  // The workshop keeps its own state in the main process; push it whenever it
  // changes so every open window stays in step.
  onModelsChanged((models, focus) => bus.emit({ type: 'models', models, ...(focus ? { focus } : {}) }))

  const handle = <T>(channel: string, handler: (payload: T, event: Electron.IpcMainInvokeEvent) => unknown) => {
    ipcMain.handle(channel, async (event, payload: T) => {
      try {
        return await handler(payload, event)
      } catch (error) {
        logger.error('ipc', `${channel} failed.`, { error: String(error) })
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  handle(IPC.invoke.snapshot, async (): Promise<Snapshot> => {
    return {
      status: engine.isBusy() ? 'thinking' : 'idle',
      settings: settings.get(),
      provider: providers.status(),
      memory: memory.state(),
      routines: routines.list(),
      history: history.list(100),
      console: bus.consoleHistory(),
      messages: engine.messages(),
      stats: monitoring.latest(),
      tools: TOOL_DESCRIPTORS,
      platform: process.platform,
      appVersion: app.getVersion(),
      plan: engine.currentPlan(),
      models: listModels()
    }
  })

  handle<SubmitRequest>(IPC.invoke.submit, async (payload) => {
    if (!payload?.text?.trim()) return { ok: false, error: 'Nothing to do.' }
    void engine.submit({ text: payload.text.slice(0, 4000), source: payload.source ?? 'text' })
    return { ok: true }
  })

  handle(IPC.invoke.cancel, async () => {
    engine.cancel('Stopped.')
    return { ok: true }
  })

  handle<{ id: string; approved: boolean }>(IPC.invoke.confirm, async (payload) => {
    const resolved = engine.resolveConfirm(payload.id, payload.approved === true)
    return { ok: resolved }
  })

  handle<Partial<Settings>>(IPC.invoke.updateSettings, async (patch) => {
    const before = settings.get()
    const next = settings.update(patch)

    if (JSON.stringify(before.hotkeys) !== JSON.stringify(next.hotkeys)) {
      const { failed } = registerHotkeys()
      if (failed.length) {
        return { ok: true, settings: next, warning: `These shortcuts are already in use: ${failed.join(', ')}` }
      }
    }
    if (JSON.stringify(before.appearance) !== JSON.stringify(next.appearance)) applyWindowAppearance()

    if (
      before.general.launchOnStartup !== next.general.launchOnStartup ||
      before.general.startMinimised !== next.general.startMinimised
    ) {
      applyLoginItem(next)
    }
    refreshTrayMenu()
    providers.broadcast()
    return { ok: true, settings: next }
  })

  handle(IPC.invoke.resetSettings, async () => {
    const next = settings.reset()
    registerHotkeys()
    applyWindowAppearance()
    refreshTrayMenu()
    return { ok: true, settings: next }
  })

  handle<{ name: SecretName; value: string }>(IPC.invoke.setApiKey, async (payload) => {
    // Only keys a catalogued provider declares may be stored.
    if (!isKnownSecret(payload.name)) return { ok: false, error: 'Unknown key.' }
    const status = payload.value?.trim() ? secrets.set(payload.name, payload.value) : secrets.clear(payload.name)
    providers.broadcast()
    return { ok: true, status }
  })

  handle(IPC.invoke.keyStatus, async () => secrets.allStatus())

  handle<{ provider: ProviderId }>(IPC.invoke.testProvider, async (payload) => {
    const result = await providers.test(payload.provider)
    bus.say('SYSTEM', `${providers.get(payload.provider).name}: ${result.message}`, {
      level: result.ok ? 'success' : 'error'
    })
    return result
  })

  /** Lists what a local backend actually has installed. */
  handle<{ provider: ProviderId }>(IPC.invoke.listModels, async (payload) => {
    const models = await providers.get(payload.provider).availableModels()
    return { ok: true, models }
  })

  handle<{ audio: ArrayBuffer; mimeType: string; language?: string }>(IPC.invoke.transcribe, async (payload) => {
    if (!payload?.audio) return { ok: false, error: 'No audio was supplied.' }
    const transcriber = providers.transcriber()
    if (!transcriber) {
      return { ok: false, error: 'Speech recognition needs a Groq API key — it is free. Add one in Settings → AI.' }
    }
    const extension = payload.mimeType?.includes('wav') ? 'wav' : payload.mimeType?.includes('ogg') ? 'ogg' : 'webm'
    const result = await transcriber.transcribe(Buffer.from(payload.audio), `speech.${extension}`, payload.language)
    return { ok: true, text: result.text, durationMs: result.durationMs }
  })

  handle<{ text: string; voice?: string; speed?: number }>(IPC.invoke.synthesise, async (payload) => {
    const text = String(payload?.text ?? '').trim()
    if (!text) return { ok: false, error: 'Nothing to say.' }
    const synthesiser = providers.synthesiser()
    if (!synthesiser) {
      return { ok: false, error: 'The neural voice needs a Groq API key — it is free. Add one in Settings \u2192 AI.' }
    }
    const config = settings.get().voice
    const result = await synthesiser.synthesise(text, {
      voice: payload.voice || config.neuralVoice,
      speed: payload.speed ?? config.rate
    })
    // Sent as a plain array buffer; the renderer decodes and plays it.
    return { ok: true, audio: result.audio.buffer.slice(result.audio.byteOffset, result.audio.byteOffset + result.audio.byteLength), mimeType: result.mimeType }
  })

  handle<{ text: string }>(IPC.invoke.speakNative, async (payload) => speakNative(payload.text))
  handle(IPC.invoke.stopNativeSpeech, async () => {
    stopNativeSpeech()
    return { ok: true }
  })

  handle<{ name: string; args: Record<string, unknown> }>(IPC.invoke.runTool, async (payload) => {
    // Tools invoked from the UI take exactly the same security path as the model's.
    const config = settings.get()
    const verdict = decide(payload.name, payload.args ?? {}, config)
    if (verdict.action === 'deny') return { ok: false, blocked: true, error: verdict.reason }

    return executeTool(payload.name, payload.args ?? {}, {
      settings: config,
      pathPolicy: {
        protectedPaths: config.automation.protectedPaths,
        workspaceRoots: config.automation.workspaceRoots,
        platform: process.platform
      },
      runRoutine: (name) => engine.runRoutine(name),
      onScreenAccess: (active) => bus.emit({ type: 'screen-access', active })
    })
  })

  handle<{ name: string }>(IPC.invoke.runRoutine, async (payload) => {
    showWindow(false)
    return engine.runRoutine(payload.name)
  })

  handle<Parameters<typeof routines.save>[0]>(IPC.invoke.saveRoutine, async (payload) => {
    const saved = routines.save(payload)
    refreshTrayMenu()
    return { ok: true, routine: saved }
  })

  handle<{ id: string }>(IPC.invoke.deleteRoutine, async (payload) => {
    const removed = routines.delete(payload.id)
    refreshTrayMenu()
    return { ok: removed }
  })

  handle<{ id: string }>(IPC.invoke.duplicateRoutine, async (payload) => {
    const copy = routines.duplicate(payload.id)
    refreshTrayMenu()
    return copy ? { ok: true, routine: copy } : { ok: false, error: 'Routine not found.' }
  })

  handle<{ key: string; value: string }>(IPC.invoke.saveMemory, async (payload) => {
    const entry = memory.remember(payload.key, payload.value, 'user', settings.get().memory.maxEntries)
    return { ok: true, entry }
  })

  handle<{ id: string }>(IPC.invoke.deleteMemory, async (payload) => ({ ok: memory.deleteById(payload.id) }))

  handle(IPC.invoke.clearMemory, async () => {
    memory.clear()
    return { ok: true }
  })

  handle(IPC.invoke.history, async () => history.list(200))

  handle(IPC.invoke.clearHistory, async () => {
    history.clear()
    return { ok: true }
  })

  handle(IPC.invoke.logs, async () => logger.readFile(400))

  handle(IPC.invoke.clearLogs, async () => {
    logger.clear()
    return { ok: true }
  })

  handle(IPC.invoke.openLogFolder, async () => {
    await shell.openPath(logger.logDir())
    return { ok: true }
  })

  handle(IPC.invoke.captureScreen, async () => {
    if (!settings.get().permissions.screenAccess) {
      return { ok: false, error: 'Screen access is switched off in Settings → Permissions.' }
    }
    bus.emit({ type: 'screen-access', active: true })
    try {
      const shot = await captureScreenDataUrl(1200)
      return { ok: true, ...shot }
    } finally {
      bus.emit({ type: 'screen-access', active: false })
    }
  })

  handle(IPC.invoke.listGeometry, async () => ({ ok: true, models: listModels() }))

  /**
   * Geometry crosses the bridge as flat typed arrays. Structured clone keeps
   * them binary, so a half-million-triangle part arrives in one copy rather
   * than being rebuilt number by number from JSON.
   */
  handle<{ id: string }>(IPC.invoke.getMesh, async (payload) => {
    const entry = getModel(String(payload?.id ?? ''))
    if (!entry) return { ok: false, error: 'That model is no longer loaded.' }
    return {
      ok: true,
      summary: entry.summary,
      positions: entry.payload.positions,
      normals: entry.payload.normals,
      indices: entry.payload.indices,
      groups: entry.payload.groups
    }
  })

  handle(IPC.invoke.openModelDialog, async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Open a 3D model',
      properties: ['openFile'],
      filters: [
        { name: '3D models', extensions: MODEL_EXTENSIONS.map((extension) => extension.slice(1)) },
        { name: 'CAD', extensions: ['step', 'stp', 'iges', 'igs', 'brep'] },
        { name: 'Meshes', extensions: ['stl', 'obj', 'ply', '3mf'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const [path] = result.filePaths
    if (result.canceled || !path) return { ok: false, cancelled: true }
    return openFromDisk(path)
  })

  handle<{ path: string }>(IPC.invoke.dropModel, async (payload) => openFromDisk(String(payload?.path ?? '')))

  handle<{ id: string }>(IPC.invoke.closeModel, async (payload) => ({
    ok: closeModel(String(payload?.id ?? ''))
  }))

  handle<{ id?: string; name?: string }>(IPC.invoke.saveModelDialog, async (payload) => {
    const entry = getModel(String(payload?.id ?? '')) ?? null
    if (!entry) return { ok: false, error: 'That model is no longer loaded.' }
    const win = getWindow()
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Export model',
      defaultPath: `${entry.summary.name.replace(/[^\w .-]/g, '_')}.stl`,
      filters: [{ name: 'STL', extensions: ['stl'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
    const { bytes } = await exportModel(entry.summary.id, result.filePath)
    bus.say('SYSTEM', `Exported ${entry.summary.name} to ${result.filePath}.`)
    return { ok: true, path: result.filePath, bytes }
  })

  handle<{ url: string }>(IPC.invoke.openExternal, async (payload) => {
    if (!/^https?:\/\//i.test(payload.url ?? '')) return { ok: false, error: 'Only web links can be opened.' }
    await shell.openExternal(payload.url)
    return { ok: true }
  })

  handle<{ listening: boolean }>(IPC.invoke.setListening, async (payload) => {
    bus.emit({ type: 'status', status: payload.listening ? 'listening' : 'idle' })
    return { ok: true }
  })

  handle<{ command: WindowCommand }>(IPC.invoke.window, async (payload) => {
    const win = getWindow()
    if (!win) return { ok: false }
    switch (payload.command) {
      case 'minimise': win.minimize(); break
      case 'maximise': win.isMaximized() ? win.unmaximize() : win.maximize(); break
      case 'close': win.hide(); break
      case 'hide': win.hide(); break
      case 'toggle-fullscreen': {
        const next = !win.isFullScreen()
        win.setFullScreen(next)
        settings.update({ appearance: { fullscreen: next } })
        break
      }
      case 'toggle-always-on-top': {
        const next = !win.isAlwaysOnTop()
        win.setAlwaysOnTop(next)
        settings.update({ appearance: { alwaysOnTop: next } })
        break
      }
    }
    return { ok: true }
  })

  logger.info('ipc', 'IPC handlers registered.', { platform: platform().label })
}
