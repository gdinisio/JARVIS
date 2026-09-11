import type { HistoryEntry } from '@shared/types'
import { JsonStore } from './store'
import { dataFile } from '../util/paths'
import { bus } from './bus'

const MAX_ENTRIES = 500

class HistoryService {
  private store = new JsonStore<HistoryEntry[]>(dataFile('history.json'), [], (raw, fb) =>
    Array.isArray(raw) ? (raw as HistoryEntry[]) : fb
  )

  add(entry: HistoryEntry): HistoryEntry {
    this.store.update((list) => {
      const next = [entry, ...list]
      return next.slice(0, MAX_ENTRIES)
    })
    bus.emit({ type: 'history', entry })
    return entry
  }

  list(limit = MAX_ENTRIES): HistoryEntry[] {
    return this.store.get().slice(0, limit)
  }

  clear(): void {
    this.store.set([])
    this.store.flush()
  }
}

export const history = new HistoryService()
