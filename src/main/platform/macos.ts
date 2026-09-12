import { join } from 'node:path'
import { homedir } from 'node:os'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { AppInfo, FileHit, PlatformAdapter, SearchQuery, VolumeState } from './types'
import { run, applescript } from './exec'
import { captureScreenToFile, trashItem } from './shared'
import { logger } from '../services/logging'

const APP_ROOTS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  join(homedir(), 'Applications')
]

const ALIASES: Record<string, string> = {
  chrome: 'Google Chrome',
  browser: 'Safari',
  'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code',
  code: 'Visual Studio Code',
  terminal: 'Terminal',
  finder: 'Finder',
  files: 'Finder',
  settings: 'System Settings',
  preferences: 'System Settings',
  'system preferences': 'System Settings',
  music: 'Music',
  mail: 'Mail',
  calendar: 'Calendar',
  notes: 'Notes',
  photos: 'Photos',
  messages: 'Messages',
  activity: 'Activity Monitor',
  'task manager': 'Activity Monitor'
}

const SETTINGS_PANES: Record<string, string> = {
  '': 'x-apple.systempreferences:',
  display: 'x-apple.systempreferences:com.apple.Displays-Settings.extension',
  sound: 'x-apple.systempreferences:com.apple.Sound-Settings.extension',
  audio: 'x-apple.systempreferences:com.apple.Sound-Settings.extension',
  network: 'x-apple.systempreferences:com.apple.Network-Settings.extension',
  wifi: 'x-apple.systempreferences:com.apple.wifi-settings-extension',
  bluetooth: 'x-apple.systempreferences:com.apple.BluetoothSettings',
  battery: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  power: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  privacy: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.universalaccess',
  keyboard: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension',
  notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  storage: 'x-apple.systempreferences:com.apple.settings.Storage',
  update: 'x-apple.systempreferences:com.apple.Software-Update-Settings.extension'
}

const SAFE_NAME = /^[A-Za-z0-9 ._+()'&-]{1,80}$/

export class MacOSAdapter implements PlatformAdapter {
  readonly platform: NodeJS.Platform = 'darwin'
  readonly label = 'macOS'

  private appCache: { apps: AppInfo[]; ts: number } | null = null

  async listApplications(): Promise<AppInfo[]> {
    if (this.appCache && Date.now() - this.appCache.ts < 5 * 60_000) return this.appCache.apps

    const seen = new Map<string, AppInfo>()
    for (const root of APP_ROOTS) {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.name.endsWith('.app')) continue
        const name = basename(entry.name, '.app')
        const key = name.toLowerCase()
        if (!seen.has(key)) seen.set(key, { name, target: join(root, entry.name), source: 'applications' })
      }
    }
    const apps = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.appCache = { apps, ts: Date.now() }
    return apps
  }

  async resolveApplication(name: string): Promise<AppInfo | null> {
    const raw = name.trim()
    const wanted = (ALIASES[raw.toLowerCase()] ?? raw).toLowerCase()
    if (!wanted) return null

    const apps = await this.listApplications()
    const hit =
      apps.find((a) => a.name.toLowerCase() === wanted) ??
      apps.find((a) => a.name.toLowerCase().startsWith(wanted)) ??
      apps.find((a) => a.name.toLowerCase().includes(wanted))
    if (hit) return hit
    // `open -a` resolves plenty of names Launch Services knows but we didn't scan.
    return SAFE_NAME.test(raw) ? { name: ALIASES[raw.toLowerCase()] ?? raw, target: ALIASES[raw.toLowerCase()] ?? raw, source: 'path' } : null
  }

  async openApplication(app: AppInfo): Promise<void> {
    const target = app.target.endsWith('.app') ? app.target : app.name
    const result = await run('open', ['-a', target], { timeoutMs: 15_000 })
    if (result.code !== 0) throw new Error(firstLine(result.stderr) || `macOS could not open ${app.name}.`)
  }

  async closeApplication(name: string, force: boolean): Promise<{ closed: string[] }> {
    const app = (await this.resolveApplication(name)) ?? { name, target: name, source: 'path' as const }
    if (!SAFE_NAME.test(app.name)) throw new Error('That application name is not valid.')

    if (!force) {
      const result = await applescript(
        `set appName to system attribute "JARVIS_APP"
tell application "System Events"
  if (exists process appName) then
    tell application appName to quit
    return "closed"
  end if
end tell
return "not-running"`,
        { app: app.name },
        { timeoutMs: 15_000 }
      )
      if (result.stdout.trim() === 'closed') return { closed: [app.name] }
      if (result.stdout.trim() === 'not-running') throw new Error(`${app.name} is not running.`)
    }
    const killed = await run('pkill', ['-x', app.name], { timeoutMs: 8000 })
    if (killed.code !== 0) throw new Error(`No running process matched "${app.name}".`)
    return { closed: [app.name] }
  }

  async isApplicationRunning(name: string): Promise<boolean> {
    const app = (await this.resolveApplication(name)) ?? { name, target: name, source: 'path' as const }
    const result = await applescript(
      `set appName to system attribute "JARVIS_APP"
tell application "System Events"
  if (exists process appName) then return "yes"
end tell
return "no"`,
      { app: app.name },
      { timeoutMs: 10_000 }
    )
    return result.stdout.trim() === 'yes'
  }

  async openPath(path: string): Promise<void> {
    const result = await run('open', [path], { timeoutMs: 10_000 })
    if (result.code !== 0) throw new Error(firstLine(result.stderr) || 'macOS could not open that path.')
  }

  async revealPath(path: string): Promise<void> {
    await run('open', ['-R', path], { timeoutMs: 10_000 })
  }

  async openUrl(url: string, browser?: string): Promise<void> {
    const args = browser ? ['-a', (await this.resolveApplication(browser))?.name ?? browser, url] : [url]
    const result = await run('open', args, { timeoutMs: 12_000 })
    if (result.code !== 0) {
      if (browser) {
        logger.warn('macos', 'Named browser failed; using the default browser.', { browser })
        const fallback = await run('open', [url], { timeoutMs: 12_000 })
        if (fallback.code === 0) return
      }
      throw new Error(firstLine(result.stderr) || 'macOS could not open that link.')
    }
  }

  moveToTrash(path: string): Promise<boolean> {
    return trashItem(path)
  }

  async setVolume(level: number): Promise<void> {
    const percent = Math.round(Math.max(0, Math.min(1, level)) * 100)
    const result = await applescript(
      `set lvl to (system attribute "JARVIS_LEVEL") as integer
set volume output volume lvl
if lvl > 0 then set volume without output muted`,
      { level: String(percent) }
    )
    if (result.code !== 0) throw new Error('The system volume could not be changed.')
  }

  async getVolume(): Promise<VolumeState> {
    const result = await applescript(
      `set s to get volume settings
return ((output volume of s) as text) & ";" & ((output muted of s) as text)`
    )
    if (result.code !== 0) return { level: null, muted: null }
    const [levelText, mutedText] = result.stdout.trim().split(';')
    const level = Number.parseFloat(levelText)
    return { level: Number.isFinite(level) ? level / 100 : null, muted: /true/i.test(mutedText ?? '') }
  }

  async lock(): Promise<void> {
    const cg = await run(
      '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession',
      ['-suspend'],
      { timeoutMs: 6000 }
    )
    if (cg.code !== 0) await run('pmset', ['displaysleepnow'], { timeoutMs: 6000 })
  }

  async sleep(): Promise<void> {
    await run('pmset', ['sleepnow'], { timeoutMs: 6000 })
  }

  async restart(): Promise<void> {
    const result = await applescript('tell application "System Events" to restart')
    if (result.code !== 0) throw new Error('macOS refused the restart request. Check Automation permissions.')
  }

  async shutdown(): Promise<void> {
    const result = await applescript('tell application "System Events" to shut down')
    if (result.code !== 0) throw new Error('macOS refused the shutdown request. Check Automation permissions.')
  }

  async openSettings(section = ''): Promise<{ opened: string }> {
    const key = section.trim().toLowerCase()
    const uri = SETTINGS_PANES[key] ?? SETTINGS_PANES['']
    const result = await run('open', [uri], { timeoutMs: 10_000 })
    if (result.code !== 0) await run('open', ['-b', 'com.apple.systempreferences'], { timeoutMs: 10_000 })
    return { opened: uri }
  }

  async killProcess(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process id.')
    await run('kill', ['-TERM', String(pid)], { timeoutMs: 5000 })
  }

  async defaultBrowser(): Promise<string | null> {
    const result = await run(
      'plutil',
      ['-convert', 'json', '-o', '-', join(homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist')],
      { timeoutMs: 8000 }
    )
    if (result.code !== 0) return 'Safari'
    try {
      const parsed = JSON.parse(result.stdout) as { LSHandlers?: Array<{ LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }> }
      const handler = parsed.LSHandlers?.find((h) => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll ?? ''
      if (/chrome/i.test(handler)) return 'Google Chrome'
      if (/firefox/i.test(handler)) return 'Firefox'
      if (/brave/i.test(handler)) return 'Brave Browser'
      if (/edge/i.test(handler)) return 'Microsoft Edge'
      if (/arc/i.test(handler)) return 'Arc'
      return 'Safari'
    } catch {
      return 'Safari'
    }
  }

  async emptyTrash(): Promise<{ summary: string }> {
    const result = await applescript('tell application "Finder" to empty trash')
    if (result.code !== 0) {
      throw new Error('macOS refused the request. Check Automation permissions for Finder.')
    }
    return { summary: 'The trash is empty.' }
  }

  /**
   * Quits everything with a visible presence except the applications named.
   *
   * Uses System Events' list of windowed processes, so background daemons and
   * the shell are never candidates.
   */
  async closeOtherApplications(keep: string[]): Promise<{ closed: string[]; kept: string[] }> {
    const resolved = await Promise.all(keep.map((name) => this.resolveApplication(name)))
    const keepNames = new Set(
      [...keep, ...resolved.map((app) => app?.name ?? '')].map((name) => name.trim().toLowerCase()).filter(Boolean)
    )

    const listed = await applescript(
      `tell application "System Events" to get name of every process whose background only is false`,
      {},
      { timeoutMs: 15_000 }
    )
    const running = listed.stdout.split(',').map((name) => name.trim()).filter(Boolean)

    const closed: string[] = []
    const kept: string[] = []
    for (const name of running) {
      const lower = name.toLowerCase()
      if (keepNames.has(lower) || PROTECTED_PROCESSES.has(lower) || !SAFE_NAME.test(name)) {
        kept.push(name)
        continue
      }
      const result = await applescript(
        `set appName to system attribute "JARVIS_APP"
tell application appName to quit`,
        { app: name },
        { timeoutMs: 12_000 }
      )
      if (result.code === 0) closed.push(name)
      else kept.push(name)
    }
    return { closed, kept }
  }

  async screenshot(target: string): Promise<string> {
    const result = await run('screencapture', ['-x', '-t', 'png', target], { timeoutMs: 15_000 })
    if (result.code === 0) return target
    logger.warn('macos', 'screencapture failed; using the compositor instead.', { code: result.code })
    return captureScreenToFile(target)
  }

  /** Spotlight, when it is available — far faster than walking the tree. */
  async fastSearch(query: SearchQuery): Promise<FileHit[] | null> {
    const term = query.query?.trim()
    if (!term) return null
    const args = ['-onlyin', query.root, `kMDItemDisplayName == "*${term.replace(/["\\]/g, '')}*"c`]
    const result = await run('mdfind', args, { timeoutMs: 8000 })
    if (result.code !== 0) return null

    const paths = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, query.limit * 3)
    const hits: FileHit[] = []
    const extensions = (query.extensions ?? []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
    for (const path of paths) {
      if (hits.length >= query.limit) break
      const ext = extname(path).toLowerCase()
      if (extensions.length && !extensions.includes(ext)) continue
      try {
        const info = await stat(path)
        if (query.modifiedAfter && info.mtimeMs < query.modifiedAfter) continue
        if (query.modifiedBefore && info.mtimeMs > query.modifiedBefore) continue
        if (info.isDirectory() && !query.includeDirectories) continue
        hits.push({
          path,
          name: basename(path),
          size: info.size,
          modified: Math.round(info.mtimeMs),
          isDirectory: info.isDirectory(),
          ext
        })
      } catch {
        continue
      }
    }
    return hits.sort((a, b) => b.modified - a.modified)
  }
}

/** Never quit: the shell, the window server, and JARVIS itself. */
const PROTECTED_PROCESSES = new Set(['finder', 'dock', 'systemuiserver', 'loginwindow', 'windowserver', 'jarvis', 'electron'])

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? ''
}
