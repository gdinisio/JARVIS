import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AppInfo, PlatformAdapter, VolumeState } from './types'
import { run, powershell } from './exec'
import { scanDir, captureScreenToFile, trashItem } from './shared'
import { logger } from '../services/logging'

/** Names that map to a well-known executable, so we skip the Start Menu scan. */
const BUILTIN: Record<string, string> = {
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  calc: 'calc.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  'file explorer': 'explorer.exe',
  files: 'explorer.exe',
  cmd: 'cmd.exe',
  'command prompt': 'cmd.exe',
  powershell: 'powershell.exe',
  terminal: 'wt.exe',
  'windows terminal': 'wt.exe',
  'task manager': 'taskmgr.exe',
  taskmanager: 'taskmgr.exe',
  registry: 'regedit.exe',
  snip: 'snippingtool.exe',
  'snipping tool': 'snippingtool.exe',
  wordpad: 'write.exe',
  'character map': 'charmap.exe',
  'control panel': 'control.exe'
}

/** Human name → process image name, for close/running checks. */
const PROCESS_ALIASES: Record<string, string[]> = {
  chrome: ['chrome'],
  'google chrome': ['chrome'],
  edge: ['msedge'],
  'microsoft edge': ['msedge'],
  firefox: ['firefox'],
  brave: ['brave'],
  opera: ['opera'],
  code: ['Code'],
  'vs code': ['Code'],
  'visual studio code': ['Code'],
  vscode: ['Code'],
  spotify: ['Spotify'],
  discord: ['Discord'],
  slack: ['slack'],
  steam: ['steam'],
  notepad: ['notepad'],
  explorer: ['explorer'],
  terminal: ['WindowsTerminal'],
  teams: ['ms-teams', 'Teams'],
  outlook: ['OUTLOOK'],
  word: ['WINWORD'],
  excel: ['EXCEL'],
  powerpoint: ['POWERPNT']
}

const SETTINGS_SECTIONS: Record<string, string> = {
  '': 'ms-settings:',
  display: 'ms-settings:display',
  sound: 'ms-settings:sound',
  audio: 'ms-settings:sound',
  notifications: 'ms-settings:notifications',
  power: 'ms-settings:powersleep',
  battery: 'ms-settings:batterysaver',
  storage: 'ms-settings:storagesense',
  bluetooth: 'ms-settings:bluetooth',
  network: 'ms-settings:network',
  wifi: 'ms-settings:network-wifi',
  privacy: 'ms-settings:privacy',
  microphone: 'ms-settings:privacy-microphone',
  apps: 'ms-settings:appsfeatures',
  update: 'ms-settings:windowsupdate',
  personalisation: 'ms-settings:personalization',
  personalization: 'ms-settings:personalization',
  accounts: 'ms-settings:yourinfo',
  keyboard: 'ms-settings:keyboard',
  mouse: 'ms-settings:mousetouchpad',
  defaultapps: 'ms-settings:defaultapps'
}

/** C# shim for the Core Audio volume API — Windows ships no cmdlet for this. */
const VOLUME_SHIM = `
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l();
  int SetMute(bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr p, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class Audio {
  static IAudioEndpointVolume Vol() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv; Guid iid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out epv));
    return epv;
  }
  public static float Get() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
  public static void Mute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
"@
`

/** Process/app names must look like names — never like arguments or commands. */
const SAFE_NAME = /^[A-Za-z0-9 ._+()'&-]{1,80}$/

export class WindowsAdapter implements PlatformAdapter {
  readonly platform: NodeJS.Platform = 'win32'
  readonly label = 'Windows'

  private appCache: { apps: AppInfo[]; ts: number } | null = null

  async listApplications(): Promise<AppInfo[]> {
    if (this.appCache && Date.now() - this.appCache.ts < 5 * 60_000) return this.appCache.apps

    const roots = [
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    ]

    const seen = new Map<string, AppInfo>()
    for (const root of roots) {
      for (const entry of await scanDir(root, ['.lnk', '.url'], 4)) {
        const key = entry.name.toLowerCase()
        if (!seen.has(key)) seen.set(key, { name: entry.name, target: entry.target, source: 'start-menu' })
      }
    }
    for (const [name, exe] of Object.entries(BUILTIN)) {
      if (!seen.has(name)) seen.set(name, { name, target: exe, source: 'builtin' })
    }

    const apps = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.appCache = { apps, ts: Date.now() }
    return apps
  }

  async resolveApplication(name: string): Promise<AppInfo | null> {
    const wanted = name.trim().toLowerCase()
    if (!wanted) return null
    if (BUILTIN[wanted]) return { name, target: BUILTIN[wanted], source: 'builtin' }

    const apps = await this.listApplications()
    return (
      apps.find((a) => a.name.toLowerCase() === wanted) ??
      apps.find((a) => a.name.toLowerCase().startsWith(wanted)) ??
      apps.find((a) => a.name.toLowerCase().includes(wanted)) ??
      (SAFE_NAME.test(name) ? { name, target: wanted.endsWith('.exe') ? wanted : `${wanted}.exe`, source: 'path' } : null)
    )
  }

  async openApplication(app: AppInfo): Promise<void> {
    const result = await powershell(
      `$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:JARVIS_TARGET | Out-Null; exit 0`,
      { target: app.target }
    )
    if (result.code !== 0) throw new Error(cleanError(result.stderr) || `Windows could not start ${app.name}.`)
  }

  async closeApplication(name: string, force: boolean): Promise<{ closed: string[] }> {
    const candidates = processNames(name)
    const closed: string[] = []
    for (const candidate of candidates) {
      if (!SAFE_NAME.test(candidate)) continue
      const image = candidate.toLowerCase().endsWith('.exe') ? candidate : `${candidate}.exe`
      const args = ['/IM', image, '/T']
      if (force) args.push('/F')
      const result = await run('taskkill.exe', args, { timeoutMs: 10_000 })
      if (result.code === 0) closed.push(image)
    }
    if (!closed.length) throw new Error(`No running process matched "${name}".`)
    return { closed }
  }

  async isApplicationRunning(name: string): Promise<boolean> {
    for (const candidate of processNames(name)) {
      if (!SAFE_NAME.test(candidate)) continue
      const image = candidate.replace(/\.exe$/i, '')
      const result = await powershell(
        `if (Get-Process -Name $env:JARVIS_NAME -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
        { name: image },
        { timeoutMs: 8000 }
      )
      if (result.stdout.trim() === 'yes') return true
    }
    return false
  }

  async openPath(path: string): Promise<void> {
    await run('explorer.exe', [path], { detached: true })
  }

  async revealPath(path: string): Promise<void> {
    // explorer.exe requires the comma form with no space for /select.
    await run('explorer.exe', [`/select,${path}`], { detached: true })
  }

  async openUrl(url: string, browser?: string): Promise<void> {
    if (browser) {
      const app = await this.resolveApplication(browser)
      if (app) {
        const result = await powershell(
          `$ErrorActionPreference='Stop'; Start-Process -FilePath $env:JARVIS_TARGET -ArgumentList @($env:JARVIS_URL) | Out-Null; exit 0`,
          { target: app.target, url }
        )
        if (result.code === 0) return
        logger.warn('windows', 'Named browser failed; falling back to the default browser.', { browser })
      }
    }
    const result = await powershell(
      `$ErrorActionPreference='Stop'; Start-Process $env:JARVIS_URL | Out-Null; exit 0`,
      { url }
    )
    if (result.code !== 0) throw new Error(cleanError(result.stderr) || 'Windows could not open that link.')
  }

  moveToTrash(path: string): Promise<boolean> {
    return trashItem(path)
  }

  async setVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, level))
    const result = await powershell(
      `${VOLUME_SHIM}\n[Audio]::Mute($false); [Audio]::Set([float]$env:JARVIS_LEVEL)`,
      { level: clamped.toFixed(3) },
      { timeoutMs: 25_000 }
    )
    if (result.code !== 0) throw new Error('The system volume could not be changed.')
  }

  async getVolume(): Promise<VolumeState> {
    const result = await powershell(`${VOLUME_SHIM}\n"$([Audio]::Get());$([Audio]::GetMute())"`, {}, { timeoutMs: 25_000 })
    if (result.code !== 0) return { level: null, muted: null }
    const [levelText, mutedText] = result.stdout.trim().split(';')
    const level = Number.parseFloat(levelText)
    return { level: Number.isFinite(level) ? level : null, muted: /true/i.test(mutedText ?? '') }
  }

  async lock(): Promise<void> {
    await run('rundll32.exe', ['user32.dll,LockWorkStation'], { timeoutMs: 5000 })
  }

  async sleep(): Promise<void> {
    await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { timeoutMs: 5000 })
  }

  async restart(): Promise<void> {
    await run('shutdown.exe', ['/r', '/t', '5'], { timeoutMs: 5000 })
  }

  async shutdown(): Promise<void> {
    await run('shutdown.exe', ['/s', '/t', '5'], { timeoutMs: 5000 })
  }

  async openSettings(section = ''): Promise<{ opened: string }> {
    const key = section.trim().toLowerCase()
    const uri = SETTINGS_SECTIONS[key] ?? SETTINGS_SECTIONS['']
    await powershell(`Start-Process $env:JARVIS_URI | Out-Null`, { uri })
    return { opened: uri }
  }

  async killProcess(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process id.')
    await run('taskkill.exe', ['/PID', String(pid), '/T'], { timeoutMs: 8000 })
  }

  async defaultBrowser(): Promise<string | null> {
    const result = await powershell(
      `(Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -ErrorAction SilentlyContinue).ProgId`,
      {},
      { timeoutMs: 8000 }
    )
    const progId = result.stdout.trim()
    if (!progId) return null
    if (/chrome/i.test(progId)) return 'Google Chrome'
    if (/edge/i.test(progId)) return 'Microsoft Edge'
    if (/firefox/i.test(progId)) return 'Firefox'
    if (/brave/i.test(progId)) return 'Brave'
    if (/opera/i.test(progId)) return 'Opera'
    return progId
  }

  screenshot(target: string): Promise<string> {
    return captureScreenToFile(target)
  }
}

function processNames(name: string): string[] {
  const key = name.trim().toLowerCase().replace(/\.exe$/, '')
  return PROCESS_ALIASES[key] ?? [name.trim().replace(/\.exe$/i, '')]
}

function cleanError(stderr: string): string {
  return stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ')
}
