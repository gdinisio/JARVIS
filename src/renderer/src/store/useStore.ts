import { create } from 'zustand'
import type {
  ChatMessage, ConfirmRequest, ConsoleEntry, EngineEvent, HistoryEntry, JarvisNotification,
  JarvisStatus, MemoryState, ProviderStatus, Routine, Settings, Snapshot, SystemStats,
  TaskPlan, ToolActivity, ToolDescriptor
} from '@shared/types'

export type ViewName = 'command' | 'history' | 'routines' | 'memory' | 'settings'

interface JarvisState {
  ready: boolean
  booted: boolean
  view: ViewName
  status: JarvisStatus
  busy: boolean

  /** Renderer-owned voice state — it owns the microphone and the speech engine. */
  listening: boolean
  speaking: boolean
  micLevel: number
  speechLevel: number
  wakeArmed: boolean
  voiceError: string | null
  transcribing: boolean

  settings: Settings | null
  provider: ProviderStatus | null
  stats: SystemStats | null
  consoleEntries: ConsoleEntry[]
  messages: ChatMessage[]
  plan: TaskPlan | null
  confirm: ConfirmRequest | null
  notifications: JarvisNotification[]
  activity: ToolActivity[]
  history: HistoryEntry[]
  routines: Routine[]
  memory: MemoryState
  tools: ToolDescriptor[]
  platform: NodeJS.Platform
  appVersion: string
  screenAccess: boolean
  /** Incremented when the hotkey or tray asks the window to take focus. */
  activationSignal: number
  /** Incremented when something asks the renderer to start listening. */
  listenSignal: number
  speakRequest: { id: string; text: string } | null
  stopSpeakingSignal: number

  applySnapshot: (snapshot: Snapshot) => void
  applyEvent: (event: EngineEvent) => void
  setView: (view: ViewName) => void
  setBooted: (booted: boolean) => void
  setListening: (listening: boolean) => void
  setSpeaking: (speaking: boolean) => void
  setMicLevel: (level: number) => void
  setSpeechLevel: (level: number) => void
  setWakeArmed: (armed: boolean) => void
  setVoiceError: (error: string | null) => void
  setTranscribing: (value: boolean) => void
  dismissNotification: (id: string) => void
  setHistory: (history: HistoryEntry[]) => void
  clearSpeakRequest: () => void
  pushLocalConsole: (entry: ConsoleEntry) => void
}

const MAX_CONSOLE = 300

export const useStore = create<JarvisState>((set, get) => ({
  ready: false,
  booted: false,
  view: 'command',
  status: 'idle',
  busy: false,

  listening: false,
  speaking: false,
  micLevel: 0,
  speechLevel: 0,
  wakeArmed: false,
  voiceError: null,
  transcribing: false,

  settings: null,
  provider: null,
  stats: null,
  consoleEntries: [],
  messages: [],
  plan: null,
  confirm: null,
  notifications: [],
  activity: [],
  history: [],
  routines: [],
  memory: { entries: [], preferences: {} },
  tools: [],
  platform: 'linux',
  appVersion: '1.0.0',
  screenAccess: false,
  activationSignal: 0,
  listenSignal: 0,
  speakRequest: null,
  stopSpeakingSignal: 0,

  applySnapshot: (snapshot) =>
    set({
      ready: true,
      status: snapshot.status,
      settings: snapshot.settings,
      provider: snapshot.provider,
      stats: snapshot.stats,
      consoleEntries: snapshot.console.slice(-MAX_CONSOLE),
      messages: snapshot.messages,
      plan: snapshot.plan,
      history: snapshot.history,
      routines: snapshot.routines,
      memory: snapshot.memory,
      tools: snapshot.tools,
      platform: snapshot.platform,
      appVersion: snapshot.appVersion
    }),

  applyEvent: (event) => {
    switch (event.type) {
      case 'status':
        // Speech state is owned by the renderer; ignore a stale idle while talking.
        if (event.status === 'idle' && get().speaking) return
        set({ status: event.status })
        break
      case 'busy':
        set({ busy: event.busy })
        break
      case 'console':
        set((state) => ({ consoleEntries: [...state.consoleEntries, event.entry].slice(-MAX_CONSOLE) }))
        break
      case 'message':
        set((state) => ({ messages: [...state.messages, event.message].slice(-200) }))
        break
      case 'plan':
        set({ plan: event.plan })
        break
      case 'plan-step':
        set((state) =>
          state.plan && state.plan.id === event.planId
            ? {
                plan: {
                  ...state.plan,
                  steps: state.plan.steps.map((step) =>
                    step.id === event.stepId ? { ...step, status: event.status, detail: event.detail ?? step.detail } : step
                  )
                }
              }
            : {}
        )
        break
      case 'confirm':
        set({ confirm: event.request })
        break
      case 'confirm-closed':
        set((state) => (state.confirm?.id === event.id ? { confirm: null } : {}))
        break
      case 'tool':
        set((state) => {
          const existing = state.activity.findIndex((a) => a.id === event.activity.id)
          const activity = existing >= 0 ? [...state.activity] : [...state.activity, event.activity]
          if (existing >= 0) activity[existing] = event.activity
          return { activity: activity.slice(-14) }
        })
        break
      case 'notification':
        set((state) => ({ notifications: [...state.notifications, event.notification].slice(-4) }))
        break
      case 'history':
        set((state) => ({ history: [event.entry, ...state.history].slice(0, 200) }))
        break
      case 'provider':
        set({ provider: event.status })
        break
      case 'settings':
        set({ settings: event.settings })
        break
      case 'memory':
        set({ memory: event.memory })
        break
      case 'routines':
        set({ routines: event.routines })
        break
      case 'stats':
        set({ stats: event.stats })
        break
      case 'screen-access':
        set({ screenAccess: event.active })
        break
      case 'speak':
        set({ speakRequest: { id: event.id, text: event.text } })
        break
      case 'stop-speaking':
        set((state) => ({ stopSpeakingSignal: state.stopSpeakingSignal + 1, speakRequest: null }))
        break
      case 'activate':
        set((state) => ({ activationSignal: state.activationSignal + 1, view: event.source === 'tray' ? 'settings' : state.view }))
        break
      case 'listen':
        if (event.listening) set((state) => ({ listenSignal: state.listenSignal + 1 }))
        break
    }
  },

  setView: (view) => set({ view }),
  setBooted: (booted) => set({ booted }),
  setListening: (listening) => set({ listening, ...(listening ? { status: 'listening' as JarvisStatus } : {}) }),
  setSpeaking: (speaking) => set({ speaking, ...(speaking ? { status: 'speaking' as JarvisStatus } : {}) }),
  setMicLevel: (micLevel) => set({ micLevel }),
  setSpeechLevel: (speechLevel) => set({ speechLevel }),
  setWakeArmed: (wakeArmed) => set({ wakeArmed }),
  setVoiceError: (voiceError) => set({ voiceError }),
  setTranscribing: (transcribing) => set({ transcribing }),
  dismissNotification: (id) => set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),
  setHistory: (history) => set({ history }),
  clearSpeakRequest: () => set({ speakRequest: null }),
  pushLocalConsole: (entry) => set((state) => ({ consoleEntries: [...state.consoleEntries, entry].slice(-MAX_CONSOLE) }))
}))

/** Convenience selector: the settings object is non-null after boot. */
export function useSettings(): Settings | null {
  return useStore((state) => state.settings)
}
