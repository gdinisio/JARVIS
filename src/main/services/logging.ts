import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../util/paths'
import { id, now } from '../util/id'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  ts: number
  level: LogLevel
  scope: string
  message: string
  data?: Record<string, unknown>
  durationMs?: number
}

/** Patterns that must never reach disk or the UI. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/g,
  /gsk_[A-Za-z0-9_\-]{10,}/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-]{12,}/gi,
  /\b(?:eyJ[A-Za-z0-9_\-]{10,}\.){2}[A-Za-z0-9_\-]{10,}\b/g
]

const SECRET_KEYS = /^(.*_)?(api_?key|apikey|authorization|auth|token|secret|password|passwd|pwd|credential|cookie)(_.*)?$/i

/** Strips anything that looks like a credential out of arbitrary values. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return '[depth-limit]' as unknown as T
  if (typeof value === 'string') {
    let out: string = value
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
    return out as unknown as T
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}

const RING_SIZE = 600
const MAX_LOG_FILES = 7

class Logger {
  private ring: LogEntry[] = []
  private file: string | null = null
  private failed = false

  private target(): string | null {
    if (this.failed) return null
    if (this.file) return this.file
    try {
      const dir = join(dataDir(), 'logs')
      mkdirSync(dir, { recursive: true })
      this.rotate(dir)
      const day = new Date().toISOString().slice(0, 10)
      this.file = join(dir, `jarvis-${day}.log`)
      return this.file
    } catch {
      this.failed = true
      return null
    }
  }

  private rotate(dir: string): void {
    try {
      const files = readdirSync(dir).filter((f) => f.startsWith('jarvis-') && f.endsWith('.log')).sort()
      while (files.length > MAX_LOG_FILES) {
        const oldest = files.shift()
        if (oldest) unlinkSync(join(dir, oldest))
      }
    } catch {
      /* non-fatal */
    }
  }

  log(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>, durationMs?: number): LogEntry {
    const entry: LogEntry = {
      id: id('log'),
      ts: now(),
      level,
      scope,
      message: redact(message),
      ...(data ? { data: redact(data) } : {}),
      ...(durationMs !== undefined ? { durationMs } : {})
    }
    this.ring.push(entry)
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)

    const file = this.target()
    if (file) {
      try {
        appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
      } catch {
        this.failed = true
      }
    }
    if (process.env.JARVIS_VERBOSE === '1' || level === 'error') {
      const tag = `[${new Date(entry.ts).toISOString()}] ${level.toUpperCase()} ${scope}`
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : 'log'](tag, entry.message, entry.data ?? '')
    }
    return entry
  }

  debug(scope: string, message: string, data?: Record<string, unknown>) { return this.log('debug', scope, message, data) }
  info(scope: string, message: string, data?: Record<string, unknown>) { return this.log('info', scope, message, data) }
  warn(scope: string, message: string, data?: Record<string, unknown>) { return this.log('warn', scope, message, data) }
  error(scope: string, message: string, data?: Record<string, unknown>) { return this.log('error', scope, message, data) }

  recent(limit = 300): LogEntry[] {
    return this.ring.slice(-limit)
  }

  /** Reads today's log file, falling back to the in-memory ring. */
  readFile(limit = 500): LogEntry[] {
    const file = this.target()
    if (!file || !existsSync(file)) return this.recent(limit)
    try {
      const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-limit)
      return lines.flatMap((line) => {
        try { return [JSON.parse(line) as LogEntry] } catch { return [] }
      })
    } catch {
      return this.recent(limit)
    }
  }

  clear(): void {
    this.ring = []
    const file = this.target()
    if (file) {
      try { unlinkSync(file) } catch { /* ignore */ }
      this.file = null
    }
  }

  logDir(): string {
    return join(dataDir(), 'logs')
  }
}

export const logger = new Logger()
