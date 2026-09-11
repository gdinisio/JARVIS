import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import type { AppInfo, PlatformAdapter, VolumeState } from './types'
import { run } from './exec'
import { scanDir, captureScreenToFile, trashItem } from './shared'

const DESKTOP_ROOTS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  '/var/lib/flatpak/exports/share/applications',
  join(homedir(), '.local/share/applications')
]

const SETTINGS_PANELS: Record<string, string> = {
  '': 'gnome-control-center',
  display: 'gnome-control-center display',
  sound: 'gnome-control-center sound',
  network: 'gnome-control-center network',
  power: 'gnome-control-center power',
  privacy: 'gnome-control-center privacy'
}

const SAFE_NAME = /^[A-Za-z0-9 ._+()'&-]{1,80}$/

/**
 * Linux adapter.
 *
 * JARVIS targets Windows and macOS, but a working Linux adapter keeps the
 * abstraction honest — nothing platform-specific may leak upward — and lets
 * the app run on Linux development machines and CI.
 */
export class LinuxAdapter implements PlatformAdapter {
  readonly platform: NodeJS.Platform = 'linux'
  readonly label = 'Linux'

  private appCache: { apps: AppInfo[]; ts: number } | null = null

  async listApplications(): Promise<AppInfo[]> {
    if (this.appCache && Date.now() - this.appCache.ts < 5 * 60_000) return this.appCache.apps
    const seen = new Map<string, AppInfo>()
    for (const root of DESKTOP_ROOTS) {
      for (const entry of await scanDir(root, ['.desktop'], 2)) {
        try {
          const content = await readFile(entry.target, 'utf8')
          if (/^NoDisplay\s*=\s*true/im.test(content)) continue
          const name = /^Name\s*=\s*(.+)$/im.exec(content)?.[1]?.trim() ?? entry.name
          const key = name.toLowerCase()
          if (!seen.has(key)) seen.set(key, { name, target: entry.target, source: 'desktop-entry' })
        } catch {
          continue
        }
      }
    }
    const apps = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.appCache = { apps, ts: Date.now() }
    return apps
  }

  async resolveApplication(name: string): Promise<AppInfo | null> {
    const wanted = name.trim().toLowerCase()
    if (!wanted) return null
    const apps = await this.listApplications()
    return (
      apps.find((a) => a.name.toLowerCase() === wanted) ??
      apps.find((a) => a.name.toLowerCase().startsWith(wanted)) ??
      apps.find((a) => a.name.toLowerCase().includes(wanted)) ??
      (SAFE_NAME.test(name) ? { name: name.trim(), target: name.trim(), source: 'path' } : null)
    )
  }

  async openApplication(app: AppInfo): Promise<void> {
    if (app.target.endsWith('.desktop')) {
      const launched = await run('gio', ['launch', app.target], { timeoutMs: 10_000 })
      if (launched.code === 0) return
      const content = await readFile(app.target, 'utf8').catch(() => '')
      const exec = /^Exec\s*=\s*(.+)$/im.exec(content)?.[1]?.replace(/%[a-zA-Z]/g, '').trim()
      if (exec) {
        const [file, ...args] = exec.split(/\s+/)
        await run(file, args, { detached: true })
        return
      }
      throw new Error(`No launch command found for ${app.name}.`)
    }
    await run(app.target, [], { detached: true })
  }

  async closeApplication(name: string, force: boolean): Promise<{ closed: string[] }> {
    if (!SAFE_NAME.test(name)) throw new Error('That application name is not valid.')
    const target = name.trim()
    const result = await run('pkill', force ? ['-9', '-f', target] : ['-f', target], { timeoutMs: 8000 })
    if (result.code !== 0) throw new Error(`No running process matched "${target}".`)
    return { closed: [target] }
  }

  async isApplicationRunning(name: string): Promise<boolean> {
    if (!SAFE_NAME.test(name)) return false
    const result = await run('pgrep', ['-f', name.trim()], { timeoutMs: 6000 })
    return result.code === 0 && result.stdout.trim().length > 0
  }

  async openPath(path: string): Promise<void> {
    await run('xdg-open', [path], { detached: true })
  }

  async revealPath(path: string): Promise<void> {
    await run('xdg-open', [join(path, '..')], { detached: true })
  }

  async openUrl(url: string, browser?: string): Promise<void> {
    if (browser) {
      const app = await this.resolveApplication(browser)
      if (app && !app.target.endsWith('.desktop')) {
        await run(app.target, [url], { detached: true })
        return
      }
    }
    await run('xdg-open', [url], { detached: true })
  }

  moveToTrash(path: string): Promise<boolean> {
    return trashItem(path)
  }

  async setVolume(level: number): Promise<void> {
    const percent = Math.round(Math.max(0, Math.min(1, level)) * 100)
    const pactl = await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${percent}%`], { timeoutMs: 6000 })
    if (pactl.code === 0) return
    const amixer = await run('amixer', ['-q', 'sset', 'Master', `${percent}%`], { timeoutMs: 6000 })
    if (amixer.code !== 0) throw new Error('No supported audio mixer was found.')
  }

  async getVolume(): Promise<VolumeState> {
    const result = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { timeoutMs: 6000 })
    const match = /(\d+)%/.exec(result.stdout)
    const muted = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], { timeoutMs: 6000 })
    return {
      level: match ? Number(match[1]) / 100 : null,
      muted: muted.code === 0 ? /yes/i.test(muted.stdout) : null
    }
  }

  async lock(): Promise<void> {
    const loginctl = await run('loginctl', ['lock-session'], { timeoutMs: 6000 })
    if (loginctl.code !== 0) await run('xdg-screensaver', ['lock'], { timeoutMs: 6000 })
  }

  async sleep(): Promise<void> {
    await run('systemctl', ['suspend'], { timeoutMs: 6000 })
  }

  async restart(): Promise<void> {
    await run('systemctl', ['reboot'], { timeoutMs: 6000 })
  }

  async shutdown(): Promise<void> {
    await run('systemctl', ['poweroff'], { timeoutMs: 6000 })
  }

  async openSettings(section = ''): Promise<{ opened: string }> {
    const command = SETTINGS_PANELS[section.trim().toLowerCase()] ?? SETTINGS_PANELS['']
    const [file, ...args] = command.split(' ')
    await run(file, args, { detached: true })
    return { opened: command }
  }

  async killProcess(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process id.')
    await run('kill', ['-TERM', String(pid)], { timeoutMs: 5000 })
  }

  async defaultBrowser(): Promise<string | null> {
    const result = await run('xdg-settings', ['get', 'default-web-browser'], { timeoutMs: 6000 })
    const value = result.stdout.trim().replace(/\.desktop$/, '')
    return value || null
  }

  screenshot(target: string): Promise<string> {
    return captureScreenToFile(target)
  }
}
