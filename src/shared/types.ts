/**
 * Shared domain types.
 *
 * This module is the contract between the privileged main process and the
 * sandboxed renderer. It must never import from either side — only plain types
 * and constants live here.
 */

/* ───────────────────────────── Core state ──────────────────────────────── */

/** Visual + behavioural state of the JARVIS core. */
export type JarvisStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'executing'
  | 'speaking'
  | 'complete'
  | 'error'

export type ConsoleSource = 'JARVIS' | 'SYSTEM' | 'USER' | 'TOOL' | 'SECURITY' | 'ERROR'

export interface ConsoleEntry {
  id: string
  ts: number
  source: ConsoleSource
  text: string
  /** Optional structured payload shown when the console is expanded. */
  detail?: string
  level?: 'info' | 'warn' | 'error' | 'success'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
  /** Which provider produced an assistant message. */
  provider?: ProviderId
  /** True when produced by demo mode rather than a real model. */
  simulated?: boolean
}

/* ─────────────────────────────── Providers ─────────────────────────────── */

export type ProviderId = 'claude' | 'groq'
export type ProviderSelection = ProviderId | 'auto'

export interface ProviderStatus {
  /** Provider currently selected for the next request. */
  active: ProviderId | null
  mode: ProviderSelection
  claude: ProviderHealth
  groq: ProviderHealth
  online: boolean
  demo: boolean
}

export interface ProviderHealth {
  configured: boolean
  ok: boolean
  model: string
  /** Human-readable reason when `ok` is false. */
  message?: string
  lastCheck?: number
}

/* ───────────────────────────── Tools + security ────────────────────────── */

export type RiskLevel = 'low' | 'medium' | 'high'

export type ToolName =
  | 'open_application'
  | 'close_application'
  | 'close_other_applications'
  | 'list_applications'
  | 'get_running_processes'
  | 'get_system_stats'
  | 'search_files'
  | 'get_file_info'
  | 'read_text_file'
  | 'create_folder'
  | 'create_file'
  | 'move_file'
  | 'move_files'
  | 'copy_file'
  | 'rename_file'
  | 'delete_file'
  | 'empty_trash'
  | 'find_large_files'
  | 'get_folder_size'
  | 'open_path'
  | 'open_url'
  | 'web_search'
  | 'take_screenshot'
  | 'read_screen'
  | 'set_volume'
  | 'read_clipboard'
  | 'write_clipboard'
  | 'execute_command'
  | 'open_settings'
  | 'lock_computer'
  | 'restart_computer'
  | 'shutdown_computer'
  | 'remember'
  | 'forget'
  | 'recall'
  | 'create_routine'
  | 'run_routine'
  | 'list_routines'
  | 'delete_routine'

/**
 * Tools that are offered to the model but never touch the operating system.
 * `present_plan` only declares intent, so the engine handles it directly.
 */
export type MetaToolName = 'present_plan'
export type AnyToolName = ToolName | MetaToolName

export interface ToolDescriptor {
  name: AnyToolName
  description: string
  risk: RiskLevel
  /** Grouping used by the permissions UI. */
  category:
    | 'applications' | 'filesystem' | 'system' | 'web' | 'screen'
    | 'terminal' | 'power' | 'memory' | 'clipboard'
  /** JSON schema (draft 2020-12 subset) describing the arguments. */
  parameters: JsonSchemaObject
  /** True when the tool works without any network/AI access. */
  offline: boolean
}

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolCallRequest {
  id: string
  name: ToolName | string
  args: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  /** Structured payload handed back to the model. */
  data?: unknown
  /** Short human-readable summary shown in the console and spoken aloud. */
  summary?: string
  error?: string
  /** Set when the security layer stopped the call. */
  blocked?: boolean
  durationMs?: number
}

/** Live tool activity, rendered as nodes orbiting the core. */
export interface ToolActivity {
  id: string
  name: string
  status: 'running' | 'ok' | 'error' | 'blocked'
  ts: number
  summary?: string
}

export interface ConfirmRequest {
  id: string
  title: string
  /** Plain-language description of exactly what will happen. */
  body: string
  risk: RiskLevel
  tool: string
  /** Bullet points, e.g. the files affected. */
  details?: string[]
  confirmLabel?: string
  cancelLabel?: string
}

/* ─────────────────────────────── Planning ──────────────────────────────── */

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlanStep {
  id: string
  label: string
  status: PlanStepStatus
  detail?: string
}

export interface TaskPlan {
  id: string
  title: string
  steps: PlanStep[]
  /** Set when the plan is awaiting [EXECUTE]/[CANCEL]. */
  awaitingApproval?: boolean
  createdAt: number
  done?: boolean
}

/* ─────────────────────────────── Monitoring ────────────────────────────── */

export interface SystemStats {
  ts: number
  cpu: { usage: number; cores: number; model: string; speedGHz?: number; tempC?: number | null }
  memory: { total: number; used: number; free: number; percent: number }
  gpu: Array<{ model: string; vendor?: string; vramMB?: number | null; usage?: number | null; tempC?: number | null }>
  disks: Array<{ mount: string; total: number; used: number; percent: number }>
  network: { online: boolean; iface?: string; rxSec?: number | null; txSec?: number | null; ip?: string | null; ssid?: string | null }
  battery: { hasBattery: boolean; percent: number | null; charging: boolean; minutesRemaining: number | null }
  os: { platform: NodeJS.Platform; distro: string; release: string; hostname: string; arch: string; uptimeSec: number }
  processes: Array<{ pid: number; name: string; cpu: number; memoryMB: number }>
}

export interface JarvisNotification {
  id: string
  title: string
  body?: string
  level: 'info' | 'success' | 'warn' | 'error'
  ts: number
  /** Suppressed notifications are logged but not surfaced. */
  actionLabel?: string
  actionId?: string
}

/* ─────────────────────────────── History ───────────────────────────────── */

export type HistoryOutcome = 'success' | 'failed' | 'blocked' | 'cancelled'

export interface HistoryEntry {
  id: string
  ts: number
  command: string
  /** Tools actually invoked, in order. */
  actions: string[]
  outcome: HistoryOutcome
  detail?: string
  durationMs: number
  provider?: ProviderId | 'local' | 'demo'
  source: 'voice' | 'text' | 'routine' | 'hotkey'
}

/* ─────────────────────────── Memory + routines ─────────────────────────── */

export interface MemoryEntry {
  id: string
  key: string
  value: string
  /** Where the memory came from. */
  origin: 'user' | 'inferred' | 'setup'
  createdAt: number
  updatedAt: number
}

export interface RoutineAction {
  tool: ToolName | string
  args: Record<string, unknown>
  label?: string
}

export interface Routine {
  id: string
  name: string
  description?: string
  actions: RoutineAction[]
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRun?: number
  runCount: number
  /** Spoken/typed phrases that trigger the routine locally, without the model. */
  triggers: string[]
}

export interface MemoryState {
  entries: MemoryEntry[]
  preferences: Preferences
}

export interface Preferences {
  browser?: string
  editor?: string
  musicApp?: string
  chatApp?: string
  terminal?: string
  projectFolder?: string
  userName?: string
}

/* ─────────────────────────────── Settings ──────────────────────────────── */

export interface Settings {
  general: {
    /** Marks first-run onboarding as finished. */
    onboarded: boolean
    launchOnStartup: boolean
    startMinimised: boolean
    demoMode: boolean
    language: string
  }
  ai: {
    provider: ProviderSelection
    claudeModel: string
    groqModel: string
    temperature: number
    maxTokens: number
    autoFallback: boolean
    /** Maximum tool calls per request — a runaway-loop guard. */
    maxToolCalls: number
  }
  voice: {
    enabled: boolean
    /**
     * 'neural' synthesises through Groq and sounds markedly more natural;
     * 'system' uses the OS voices via the renderer; 'native' shells out to
     * say/SAPI for systems that expose no voice to Chromium.
     */
    engine: 'neural' | 'system' | 'native' | 'off'
    voiceURI: string
    /** Voice name for the neural engine, e.g. "Fritz-PlayAI". */
    neuralVoice: string
    rate: number
    pitch: number
    volume: number
    /** Speak tool results as well as replies. */
    speakActions: boolean
    /**
     * Deliver a reply one sentence at a time. Engines shape prosody per
     * utterance, so this is most of the difference between read and spoken.
     */
    chunked: boolean
  }
  microphone: {
    deviceId: string
    /** Input gain applied before VAD, 0.5–3. */
    gain: number
    /** RMS threshold (0–1) above which speech is considered present. */
    threshold: number
    /** Milliseconds of silence that end an utterance. */
    silenceMs: number
    pushToTalkOnly: boolean
  }
  wakeWord: {
    enabled: boolean
    phrase: string
    /** 0–1; higher is more permissive. */
    sensitivity: number
    /** Play a short cue when the wake word fires. */
    chime: boolean
  }
  automation: {
    /** Auto-run low-risk tools without asking. */
    autoRunLowRisk: boolean
    confirmMediumRisk: boolean
    /** High risk always confirms; kept for display only. */
    confirmHighRisk: true
    allowShell: boolean
    allowedCommands: string[]
    allowPower: boolean
    protectedPaths: string[]
    workspaceRoots: string[]
  }
  permissions: {
    /** Per-tool override: 'allow' | 'confirm' | 'deny'. */
    tools: Record<string, 'allow' | 'confirm' | 'deny'>
    screenAccess: boolean
    microphoneAccess: boolean
    webAccess: boolean
    clipboardAccess: boolean
  }
  memory: {
    enabled: boolean
    rememberConversations: boolean
    maxEntries: number
  }
  appearance: {
    accent: string
    /** 0–1 multiplier on red intensity. */
    redIntensity: number
    /** 0–1 multiplier on animation amplitude/speed. */
    animationIntensity: number
    hudDensity: 'minimal' | 'standard' | 'dense'
    reducedMotion: boolean
    compact: boolean
    alwaysOnTop: boolean
    fullscreen: boolean
    bootAnimation: boolean
    scanlines: boolean
  }
  sound: {
    enabled: boolean
    volume: number
  }
  hotkeys: {
    activate: string
    pushToTalk: string
    stopSpeaking: string
  }
  privacy: {
    /** Log tool arguments (paths, URLs) alongside the action name. */
    logArguments: boolean
    /** Keep transcripts of what was said. */
    storeTranscripts: boolean
    proactiveSuggestions: boolean
    telemetry: false
  }
}

/* ─────────────────────────────── Events ────────────────────────────────── */

/** Everything the main process pushes to the renderer, as one union. */
export type EngineEvent =
  | { type: 'status'; status: JarvisStatus }
  | { type: 'console'; entry: ConsoleEntry }
  | { type: 'message'; message: ChatMessage }
  | { type: 'plan'; plan: TaskPlan | null }
  | { type: 'plan-step'; planId: string; stepId: string; status: PlanStepStatus; detail?: string }
  | { type: 'speak'; id: string; text: string }
  | { type: 'stop-speaking' }
  | { type: 'confirm'; request: ConfirmRequest }
  | { type: 'confirm-closed'; id: string }
  | { type: 'tool'; activity: ToolActivity }
  | { type: 'notification'; notification: JarvisNotification }
  | { type: 'history'; entry: HistoryEntry }
  | { type: 'provider'; status: ProviderStatus }
  | { type: 'settings'; settings: Settings }
  | { type: 'memory'; memory: MemoryState }
  | { type: 'routines'; routines: Routine[] }
  | { type: 'stats'; stats: SystemStats }
  | { type: 'screen-access'; active: boolean }
  | { type: 'activate'; source: 'hotkey' | 'tray' | 'wake-word' }
  | { type: 'listen'; listening: boolean }
  | { type: 'busy'; busy: boolean }

export interface SubmitRequest {
  text: string
  source: 'voice' | 'text' | 'routine' | 'hotkey'
}

export interface Snapshot {
  status: JarvisStatus
  settings: Settings
  provider: ProviderStatus
  memory: MemoryState
  routines: Routine[]
  history: HistoryEntry[]
  console: ConsoleEntry[]
  messages: ChatMessage[]
  stats: SystemStats | null
  tools: ToolDescriptor[]
  platform: NodeJS.Platform
  appVersion: string
  plan: TaskPlan | null
}
