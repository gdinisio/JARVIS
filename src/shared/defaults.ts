import type { Settings } from './types'

/** Commands the terminal tool may run without an explicit shell override. */
export const DEFAULT_ALLOWED_COMMANDS_WINDOWS = [
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'py', 'pip',
  'dir', 'whoami', 'hostname', 'ipconfig', 'ping', 'tasklist', 'systeminfo', 'where', 'echo'
]

export const DEFAULT_ALLOWED_COMMANDS_UNIX = [
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'python3', 'pip3',
  'ls', 'pwd', 'whoami', 'hostname', 'uname', 'df', 'du', 'ps', 'ping', 'which', 'echo', 'date', 'uptime'
]

/** Directories JARVIS refuses to write to, whatever the model asks. */
export function protectedPathsFor(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\$Recycle.Bin',
      '%APPDATA%\\Microsoft\\Crypto',
      '%LOCALAPPDATA%\\Microsoft\\Credentials',
      '%USERPROFILE%\\.ssh',
      '%USERPROFILE%\\.aws',
      '%USERPROFILE%\\AppData\\Roaming\\Mozilla',
      '%USERPROFILE%\\AppData\\Local\\Google\\Chrome\\User Data'
    ]
  }
  if (platform === 'darwin') {
    return [
      '/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/Applications/Utilities',
      '~/Library/Keychains', '~/Library/Application Support/com.apple.TCC',
      '~/.ssh', '~/.aws', '~/.gnupg', '~/Library/Cookies'
    ]
  }
  return ['/etc', '/usr', '/bin', '/sbin', '/boot', '/sys', '/proc', '/var/lib', '~/.ssh', '~/.aws', '~/.gnupg']
}

export function defaultHotkeys(platform: NodeJS.Platform) {
  const mod = platform === 'darwin' ? 'Command' : 'Control'
  return {
    // Cmd+Space is the Spotlight shortcut on macOS; JARVIS asks to take it
    // during onboarding instead of silently stealing it.
    activate: `${mod}+Space`,
    pushToTalk: `${mod}+Shift+Space`,
    stopSpeaking: `${mod}+Shift+X`
  }
}

export function defaultSettings(platform: NodeJS.Platform): Settings {
  return {
    general: {
      onboarded: false,
      launchOnStartup: false,
      startMinimised: false,
      demoMode: false,
      language: 'en-US'
    },
    ai: {
      provider: 'auto',
      // Empty means "use the catalogue default for that provider".
      models: {},
      baseUrls: {},
      temperature: 0.3,
      maxTokens: 1600,
      autoFallback: true,
      maxToolCalls: 12
    },
    voice: {
      enabled: true,
      // Upgraded to 'neural' automatically on first run when a Groq key is
      // present; 'system' is the dependency-free default.
      engine: 'system',
      voiceURI: '',
      neuralVoice: 'Fritz-PlayAI',
      rate: 1,
      // Shifting pitch away from 1 is what makes a synthetic voice sound
      // artificially deep rather than calm. Let the voice do the work.
      pitch: 1,
      volume: 0.9,
      speakActions: false,
      chunked: true
    },
    microphone: {
      deviceId: 'default',
      gain: 1,
      threshold: 0.018,
      silenceMs: 900,
      pushToTalkOnly: false
    },
    wakeWord: {
      enabled: false,
      phrase: 'hey jarvis',
      sensitivity: 0.6,
      chime: true
    },
    automation: {
      autoRunLowRisk: true,
      confirmMediumRisk: true,
      confirmHighRisk: true,
      allowShell: false,
      allowedCommands: platform === 'win32' ? DEFAULT_ALLOWED_COMMANDS_WINDOWS : DEFAULT_ALLOWED_COMMANDS_UNIX,
      allowPower: false,
      protectedPaths: protectedPathsFor(platform),
      workspaceRoots: []
    },
    permissions: {
      tools: {},
      screenAccess: false,
      microphoneAccess: true,
      webAccess: true,
      clipboardAccess: false
    },
    memory: {
      enabled: true,
      rememberConversations: true,
      maxEntries: 200
    },
    appearance: {
      accent: '#e01f3d',
      redIntensity: 0.85,
      animationIntensity: 1,
      hudDensity: 'standard',
      reducedMotion: false,
      compact: false,
      alwaysOnTop: false,
      fullscreen: false,
      bootAnimation: true,
      scanlines: true
    },
    sound: {
      enabled: true,
      volume: 0.35
    },
    hotkeys: defaultHotkeys(platform),
    privacy: {
      logArguments: true,
      storeTranscripts: true,
      proactiveSuggestions: true,
      telemetry: false
    }
  }
}

/** Deep-merges stored settings over defaults so new keys appear on upgrade. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  if (!patch || typeof patch !== 'object') return base
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key]
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current)
    ) {
      out[key] = mergeSettings(current as Settings, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as unknown as Settings
}
