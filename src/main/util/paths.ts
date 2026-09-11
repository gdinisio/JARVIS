import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

let cached: string | null = null

/**
 * Root directory for JARVIS runtime data (settings, memory, routines, logs).
 *
 * Resolution order: `JARVIS_DATA_DIR` → Electron's per-user app data dir →
 * `~/.jarvis`. The Electron lookup is deferred and guarded so this module can
 * be imported from plain Node (tests, scripts).
 */
export function dataDir(): string {
  if (cached) return cached
  const override = process.env.JARVIS_DATA_DIR
  if (override && override.trim()) {
    cached = override.trim()
  } else {
    cached = electronUserData() ?? join(homedir(), '.jarvis')
  }
  mkdirSync(cached, { recursive: true })
  return cached
}

function electronUserData(): string | null {
  try {
    // Bare dynamic lookup — absent outside the Electron runtime.
    const electron = globalThis.process?.versions?.electron
      ? (globalThis as unknown as { __electron__?: { app?: { getPath(n: string): string } } }).__electron__
      : null
    if (electron?.app) return electron.app.getPath('userData')
  } catch {
    /* ignore */
  }
  return null
}

/** Called once from the main entrypoint so `dataDir()` can use Electron paths. */
export function bindElectron(electron: { app: { getPath(name: string): string } }): void {
  ;(globalThis as unknown as { __electron__?: unknown }).__electron__ = electron
  cached = null
}

export function dataFile(name: string): string {
  return join(dataDir(), name)
}

/** Expands a leading `~` and Windows `%VAR%` references. */
export function expandHome(input: string): string {
  let value = input
  if (value.startsWith('~')) value = join(homedir(), value.slice(1))
  value = value.replace(/%([A-Z_][A-Z0-9_]*)%/gi, (match, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? process.env[key] ?? match : match
  })
  return value
}
