import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type WindowCommand } from '@shared/ipc'
import type {
  EngineEvent, HistoryEntry, ProviderId, Routine, Settings, Snapshot, ToolResult
} from '@shared/types'

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

  setApiKey: (name: 'ANTHROPIC_API_KEY' | 'GROQ_API_KEY', value: string) =>
    ipcRenderer.invoke(IPC.invoke.setApiKey, { name, value }),

  keyStatus: () => ipcRenderer.invoke(IPC.invoke.keyStatus),

  testProvider: (provider: ProviderId) => ipcRenderer.invoke(IPC.invoke.testProvider, { provider }),

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
