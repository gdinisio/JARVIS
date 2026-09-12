/** IPC channel names. Renderer may only reach these — see the preload bridge. */
export const IPC = {
  /** Renderer → main, request/response. */
  invoke: {
    snapshot: 'jarvis:snapshot',
    submit: 'jarvis:submit',
    cancel: 'jarvis:cancel',
    confirm: 'jarvis:confirm',
    approvePlan: 'jarvis:approve-plan',
    updateSettings: 'jarvis:settings:update',
    resetSettings: 'jarvis:settings:reset',
    setApiKey: 'jarvis:keys:set',
    keyStatus: 'jarvis:keys:status',
    testProvider: 'jarvis:provider:test',
    listModels: 'jarvis:provider:models',
    transcribe: 'jarvis:voice:transcribe',
    speakNative: 'jarvis:voice:speak-native',
    synthesise: 'jarvis:voice:synthesise',
    stopNativeSpeech: 'jarvis:voice:stop-native',
    runTool: 'jarvis:tool:run',
    runRoutine: 'jarvis:routine:run',
    saveRoutine: 'jarvis:routine:save',
    deleteRoutine: 'jarvis:routine:delete',
    duplicateRoutine: 'jarvis:routine:duplicate',
    saveMemory: 'jarvis:memory:save',
    deleteMemory: 'jarvis:memory:delete',
    clearMemory: 'jarvis:memory:clear',
    history: 'jarvis:history:list',
    clearHistory: 'jarvis:history:clear',
    logs: 'jarvis:logs:read',
    clearLogs: 'jarvis:logs:clear',
    openLogFolder: 'jarvis:logs:open-folder',
    window: 'jarvis:window',
    setListening: 'jarvis:listening',
    captureScreen: 'jarvis:screen:capture',
    openExternal: 'jarvis:open-external'
  },
  /** Main → renderer, push. */
  event: 'jarvis:event'
} as const

export type WindowCommand =
  | 'minimise'
  | 'maximise'
  | 'close'
  | 'hide'
  | 'toggle-fullscreen'
  | 'toggle-always-on-top'
