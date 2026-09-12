import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStore } from './store'
import { dataFile, dataDir } from '../util/paths'
import { logger } from './logging'

import { PROVIDERS } from '@shared/providers'

/** Any environment variable a catalogued provider declares. */
export type SecretName = string

/** The set JARVIS will store, so an arbitrary name cannot be written. */
const KNOWN_SECRETS = new Set(PROVIDERS.map((provider) => provider.envVar).filter(Boolean))

export function isKnownSecret(name: string): boolean {
  return KNOWN_SECRETS.has(name)
}

export interface KeyStatus {
  name: SecretName
  configured: boolean
  /** Where the value came from. Never includes the value itself. */
  source: 'env' | 'encrypted' | 'session' | 'none'
  /** Last four characters only, for "is this the right key?" recognition. */
  hint: string
  /** True when the OS could not provide encrypted storage. */
  insecureStorage: boolean
}

interface SecretsFile {
  /** base64 of the OS-encrypted blob, keyed by secret name. */
  encrypted: Partial<Record<SecretName, string>>
}

type SafeStorage = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}

/**
 * API keys live only in the main process.
 *
 * Precedence: process environment (including a `.env` file loaded at startup)
 * → OS-encrypted store → in-memory session value. The renderer can set and
 * clear keys but can never read one back.
 */
class SecretStore {
  private store = new JsonStore<SecretsFile>(dataFile('secrets.json'), { encrypted: {} })
  private session = new Map<SecretName, string>()
  private safeStorage: SafeStorage | null = null

  bindSafeStorage(safeStorage: SafeStorage): void {
    this.safeStorage = safeStorage
  }

  private encryptionAvailable(): boolean {
    try {
      return !!this.safeStorage?.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  get(name: SecretName): string | null {
    const fromEnv = process.env[name]
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()

    const session = this.session.get(name)
    if (session) return session

    const blob = this.store.get().encrypted[name]
    if (blob && this.encryptionAvailable()) {
      try {
        return this.safeStorage!.decryptString(Buffer.from(blob, 'base64')).trim() || null
      } catch {
        logger.warn('secrets', 'Stored key could not be decrypted; it may have been written by another user account.', { name })
        return null
      }
    }
    return null
  }

  set(name: SecretName, value: string): KeyStatus {
    const trimmed = value.trim()
    if (!trimmed) return this.clear(name)

    this.session.set(name, trimmed)
    if (this.encryptionAvailable()) {
      try {
        const blob = this.safeStorage!.encryptString(trimmed).toString('base64')
        this.store.update((s) => ({ encrypted: { ...s.encrypted, [name]: blob } }))
        this.store.flush()
      } catch {
        logger.warn('secrets', 'Encrypted storage failed; key kept for this session only.', { name })
      }
    } else {
      logger.warn('secrets', 'OS encrypted storage unavailable; key kept for this session only.', { name })
    }
    return this.status(name)
  }

  clear(name: SecretName): KeyStatus {
    this.session.delete(name)
    this.store.update((s) => {
      const next = { ...s.encrypted }
      delete next[name]
      return { encrypted: next }
    })
    this.store.flush()
    return this.status(name)
  }

  status(name: SecretName): KeyStatus {
    const insecureStorage = !this.encryptionAvailable()
    const env = process.env[name]
    if (env && env.trim()) {
      return { name, configured: true, source: 'env', hint: hint(env.trim()), insecureStorage }
    }
    const stored = this.store.get().encrypted[name]
    if (stored && !insecureStorage) {
      const value = this.get(name)
      if (value) return { name, configured: true, source: 'encrypted', hint: hint(value), insecureStorage }
    }
    const session = this.session.get(name)
    if (session) return { name, configured: true, source: 'session', hint: hint(session), insecureStorage }
    return { name, configured: false, source: 'none', hint: '', insecureStorage }
  }

  allStatus(): KeyStatus[] {
    return [...KNOWN_SECRETS].map((name) => this.status(name))
  }
}

function hint(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`
}

/**
 * Minimal `.env` loader. Values already present in the environment win, so a
 * real environment variable always overrides the file.
 */
export function loadEnvFiles(roots: string[]): void {
  for (const root of [...roots, dataDir()]) {
    const file = join(root, '.env')
    if (!existsSync(file)) continue
    try {
      for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        if (!(key in process.env) && value) process.env[key] = value
      }
      logger.info('secrets', 'Loaded environment file.', { file })
    } catch {
      logger.warn('secrets', 'Environment file could not be read.', { file })
    }
  }
}

export const secrets = new SecretStore()
