import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A tiny JSON document store with atomic writes.
 *
 * Deliberately synchronous: these documents are small (settings, memory,
 * routines) and always written from the main process, where a torn file on
 * crash would be far more expensive than a few milliseconds of blocking.
 */
export class JsonStore<T> {
  private value: T
  private writeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly file: string,
    private readonly fallback: T,
    private readonly revive: (raw: unknown, fallback: T) => T = (raw, fb) => (raw === undefined || raw === null ? fb : (raw as T))
  ) {
    this.value = this.load()
  }

  private load(): T {
    try {
      if (!existsSync(this.file)) return this.fallback
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return this.revive(raw, this.fallback)
    } catch {
      // A corrupt file must never stop JARVIS from starting.
      return this.fallback
    }
  }

  get(): T {
    return this.value
  }

  set(next: T): T {
    this.value = next
    this.scheduleWrite()
    return this.value
  }

  update(mutator: (current: T) => T): T {
    return this.set(mutator(this.value))
  }

  /** Coalesces bursts of writes (e.g. a settings slider being dragged). */
  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), 120)
    this.writeTimer.unref?.()
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.value, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      /* disk full / read-only volume — keep running with in-memory state */
    }
  }
}
