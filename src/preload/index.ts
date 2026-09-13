import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type WindowCommand } from '@shared/ipc'
import type { EngineEvent, HistoryEntry, Routine, Settings, Snapshot, ToolResult } from '@shared/types'
import type { ProviderId } from '@shared/providers'
import type { MeshPayload, ModelSummary } from '@shared/geometry'

/**
 * The preload bridge.
 *
 * The renderer gets this object and nothing else: no Node, no `ipcRenderer`,
 * no filesystem, and no way to read an API key. Every method maps to one
 * explicitly registered IPC channel.
 */
const api = {
  snapshot: (): Promise<Snapshot> => ipcRenderer.invoke(IPC.invoke.snapshot),

  submit: (text: string, source: 'voice' | 'text' | 'routine' | 'hotkey' = 'text') =>
    ipcRenderer.invoke(IPC.invoke.submit, { text, source }),

  cancel: () => ipcRenderer.invoke(IPC.invoke.cancel),

  confirm: (id: string, approved: boolean) => ipcRenderer.invoke(IPC.invoke.confirm, { id, approved }),

  updateSettings: (patch: unknown): Promise<{ ok: boolean; settings?: Settings; warning?: string }> =>
    ipcRenderer.invoke(IPC.invoke.updateSettings, patch),

  resetSettings: (): Promise<{ ok: boolean; settings?: Settings }> => ipcRenderer.invoke(IPC.invoke.resetSettings),

  /** `name` is a provider's environment variable, e.g. GROQ_API_KEY. */
  setApiKey: (name: string, value: string) => ipcRenderer.invoke(IPC.invoke.setApiKey, { name, value }),

  keyStatus: () => ipcRenderer.invoke(IPC.invoke.keyStatus),

  testProvider: (provider: ProviderId) => ipcRenderer.invoke(IPC.invoke.testProvider, { provider }),

  /** Lists the models a backend actually has, for local servers. */
  listModels: (provider: ProviderId): Promise<{ ok: boolean; models?: string[] }> =>
    ipcRenderer.invoke(IPC.invoke.listModels, { provider }),

  transcribe: (audio: ArrayBuffer, mimeType: string, language?: string) =>
    ipcRenderer.invoke(IPC.invoke.transcribe, { audio, mimeType, language }),

  speakNative: (text: string) => ipcRenderer.invoke(IPC.invoke.speakNative, { text }),

  /** Neural speech; returns WAV bytes for the renderer to play. */
  synthesise: (
    text: string,
    voice?: string,
    speed?: number
  ): Promise<{ ok: boolean; audio?: ArrayBuffer; mimeType?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.invoke.synthesise, { text, voice, speed }),
  stopNativeSpeech: () => ipcRenderer.invoke(IPC.invoke.stopNativeSpeech),

  runTool: (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    ipcRenderer.invoke(IPC.invoke.runTool, { name, args }),

  runRoutine: (name: string): Promise<ToolResult> => ipcRenderer.invoke(IPC.invoke.runRoutine, { name }),
  saveRoutine: (routine: unknown): Promise<{ ok: boolean; routine?: Routine }> =>
    ipcRenderer.invoke(IPC.invoke.saveRoutine, routine),
  deleteRoutine: (id: string) => ipcRenderer.invoke(IPC.invoke.deleteRoutine, { id }),
  duplicateRoutine: (id: string) => ipcRenderer.invoke(IPC.invoke.duplicateRoutine, { id }),

  saveMemory: (key: string, value: string) => ipcRenderer.invoke(IPC.invoke.saveMemory, { key, value }),
  deleteMemory: (id: string) => ipcRenderer.invoke(IPC.invoke.deleteMemory, { id }),
  clearMemory: () => ipcRenderer.invoke(IPC.invoke.clearMemory),

  history: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.invoke.history),
  clearHistory: () => ipcRenderer.invoke(IPC.invoke.clearHistory),

  logs: () => ipcRenderer.invoke(IPC.invoke.logs),
  clearLogs: () => ipcRenderer.invoke(IPC.invoke.clearLogs),
  openLogFolder: () => ipcRenderer.invoke(IPC.invoke.openLogFolder),

  captureScreen: () => ipcRenderer.invoke(IPC.invoke.captureScreen),

  /** 3D workshop. Geometry is fetched on demand so the event stream stays small. */
  models: (): Promise<{ ok: boolean; models: ModelSummary[] }> => ipcRenderer.invoke(IPC.invoke.listGeometry),
  mesh: (id: string): Promise<{ ok: boolean; error?: string; summary?: ModelSummary } & Partial<MeshPayload>> =>
    ipcRenderer.invoke(IPC.invoke.getMesh, { id }),
  pickModel: (): Promise<{ ok: boolean; cancelled?: boolean; error?: string; summary?: ModelSummary }> =>
    ipcRenderer.invoke(IPC.invoke.openModelDialog),
  exportModel: (id: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string; path?: string; bytes?: number }> =>
    ipcRenderer.invoke(IPC.invoke.saveModelDialog, { id }),
  closeModel: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.invoke.closeModel, { id }),

  /**
   * Drag-and-drop. The renderer cannot read a File's path directly under
   * sandboxing; `webUtils` resolves it here, and only the path crosses over.
   */
  dropModel: (file: File): Promise<{ ok: boolean; error?: string; summary?: ModelSummary }> => {
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      return Promise.resolve({ ok: false, error: 'That file could not be read from the drop.' })
    }
    return ipcRenderer.invoke(IPC.invoke.dropModel, { path })
  },
  openExternal: (url: string) => ipcRenderer.invoke(IPC.invoke.openExternal, { url }),
  setListening: (listening: boolean) => ipcRenderer.invoke(IPC.invoke.setListening, { listening }),
  window: (command: WindowCommand) => ipcRenderer.invoke(IPC.invoke.window, { command }),

  /** Subscribes to the main-process event stream. Returns an unsubscribe function. */
  onEvent: (callback: (event: EngineEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: EngineEvent) => callback(payload)
    ipcRenderer.on(IPC.event, listener)
    return () => ipcRenderer.removeListener(IPC.event, listener)
  }
}

export type JarvisApi = typeof api

contextBridge.exposeInMainWorld('jarvis', api)
