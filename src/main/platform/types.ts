/** Everything platform-specific hides behind this interface. */

export interface AppInfo {
  /** Display name, e.g. "Visual Studio Code". */
  name: string
  /** Launch target: an .app bundle, .lnk, .desktop id or executable. */
  target: string
  /** Where the entry was discovered. */
  source: 'start-menu' | 'applications' | 'desktop-entry' | 'path' | 'registry' | 'builtin'
}

export interface FileHit {
  path: string
  name: string
  size: number
  modified: number
  isDirectory: boolean
  ext: string
}

export interface SearchQuery {
  root: string
  /** Case-insensitive substring / glob-ish term matched against the file name. */
  query?: string
  extensions?: string[]
  modifiedAfter?: number
  modifiedBefore?: number
  limit: number
  maxDepth: number
  includeDirectories?: boolean
}

export interface ProcessInfo {
  pid: number
  name: string
  cpu: number
  memoryMB: number
}

export interface VolumeState {
  level: number | null
  muted: boolean | null
}

export interface PlatformAdapter {
  readonly platform: NodeJS.Platform
  readonly label: string

  /** Applications */
  listApplications(): Promise<AppInfo[]>
  resolveApplication(name: string): Promise<AppInfo | null>
  openApplication(app: AppInfo): Promise<void>
  closeApplication(name: string, force: boolean): Promise<{ closed: string[] }>
  isApplicationRunning(name: string): Promise<boolean>

  /** Files + shell integration */
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  openUrl(url: string, browser?: string): Promise<void>
  moveToTrash(path: string): Promise<boolean>

  /** System */
  setVolume(level: number): Promise<void>
  getVolume(): Promise<VolumeState>
  lock(): Promise<void>
  sleep(): Promise<void>
  restart(): Promise<void>
  shutdown(): Promise<void>
  openSettings(section?: string): Promise<{ opened: string }>
  killProcess(pid: number): Promise<void>
  defaultBrowser(): Promise<string | null>

  /** Screenshot to a file path; returns the path actually written. */
  screenshot(target: string): Promise<string>

  /**
   * Optional OS-indexed search (Spotlight, Windows Search). Returns `null`
   * when the index is unavailable so the caller falls back to walking.
   */
  fastSearch?(query: SearchQuery): Promise<FileHit[] | null>
}
