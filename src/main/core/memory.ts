import type { MemoryEntry, MemoryState, Preferences } from '@shared/types'
import { JsonStore } from '../services/store'
import { dataFile } from '../util/paths'
import { bus } from '../services/bus'
import { id, now } from '../util/id'

/** Keys that also populate the structured preference block. */
const PREFERENCE_KEYS: Array<{ match: RegExp; field: keyof Preferences }> = [
  { match: /\b(browser)\b/i, field: 'browser' },
  { match: /\b(editor|ide|code editor)\b/i, field: 'editor' },
  { match: /\b(music|spotify|player)\b/i, field: 'musicApp' },
  { match: /\b(chat|messaging|communication|slack|discord|teams)\b/i, field: 'chatApp' },
  { match: /\b(terminal|shell|console)\b/i, field: 'terminal' },
  { match: /\b(project|workspace|dev folder|development folder)\b/i, field: 'projectFolder' },
  { match: /\b(name|call me)\b/i, field: 'userName' }
]

const emptyState: MemoryState = { entries: [], preferences: {} }

/**
 * Long-term memory.
 *
 * Deliberately small and legible: a list of key/value facts the user can read
 * and delete at any time, plus a derived preference block the planner reads
 * directly (preferred browser, editor, project folder…).
 */
class MemoryService {
  private store = new JsonStore<MemoryState>(dataFile('memory.json'), emptyState, (raw, fb) => {
    if (!raw || typeof raw !== 'object') return fb
    const value = raw as Partial<MemoryState>
    return { entries: Array.isArray(value.entries) ? value.entries : [], preferences: value.preferences ?? {} }
  })

  state(): MemoryState {
    return this.store.get()
  }

  entries(): MemoryEntry[] {
    return this.store.get().entries
  }

  preferences(): Preferences {
    return this.store.get().preferences
  }

  remember(key: string, value: string, origin: MemoryEntry['origin'] = 'user', maxEntries = 200): MemoryEntry {
    const cleanKey = key.trim().slice(0, 80)
    const cleanValue = value.trim().slice(0, 1000)
    let entry: MemoryEntry | null = null

    this.store.update((state) => {
      const entries = [...state.entries]
      const existing = entries.findIndex((e) => e.key.toLowerCase() === cleanKey.toLowerCase())
      if (existing >= 0) {
        entry = { ...entries[existing], value: cleanValue, origin, updatedAt: now() }
        entries[existing] = entry
      } else {
        entry = { id: id('m'), key: cleanKey, value: cleanValue, origin, createdAt: now(), updatedAt: now() }
        entries.unshift(entry)
      }
      return {
        entries: entries.slice(0, maxEntries),
        preferences: derivePreferences(entries, state.preferences)
      }
    })

    this.broadcast()
    return entry!
  }

  forget(key: string): boolean {
    const before = this.store.get().entries.length
    this.store.update((state) => {
      const entries = state.entries.filter((e) => e.key.toLowerCase() !== key.trim().toLowerCase())
      return { entries, preferences: derivePreferences(entries, {}) }
    })
    this.broadcast()
    return this.store.get().entries.length < before
  }

  deleteById(entryId: string): boolean {
    const before = this.store.get().entries.length
    this.store.update((state) => {
      const entries = state.entries.filter((e) => e.id !== entryId)
      return { entries, preferences: derivePreferences(entries, {}) }
    })
    this.broadcast()
    return this.store.get().entries.length < before
  }

  recall(query?: string): MemoryEntry[] {
    const entries = this.store.get().entries
    if (!query?.trim()) return entries
    const q = query.trim().toLowerCase()
    return entries.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q))
  }

  clear(): void {
    this.store.set({ entries: [], preferences: {} })
    this.store.flush()
    this.broadcast()
  }

  /** Compact text block injected into the model's system prompt. */
  promptBlock(): string {
    const { entries, preferences } = this.store.get()
    if (!entries.length && !Object.keys(preferences).length) return ''
    const lines: string[] = []
    for (const [key, value] of Object.entries(preferences)) {
      if (value) lines.push(`- ${key}: ${value}`)
    }
    for (const entry of entries.slice(0, 40)) {
      lines.push(`- ${entry.key}: ${entry.value}`)
    }
    return lines.join('\n')
  }

  private broadcast(): void {
    bus.emit({ type: 'memory', memory: this.store.get() })
  }
}

export function derivePreferences(entries: MemoryEntry[], base: Preferences): Preferences {
  const preferences: Preferences = { ...base }
  for (const entry of entries) {
    for (const { match, field } of PREFERENCE_KEYS) {
      if (match.test(entry.key)) {
        preferences[field] = entry.value
        break
      }
    }
  }
  return preferences
}

export const memory = new MemoryService()
