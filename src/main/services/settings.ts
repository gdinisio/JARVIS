import type { Settings } from '@shared/types'
import { defaultSettings, mergeSettings } from '@shared/defaults'
import { JsonStore } from './store'
import { dataFile } from '../util/paths'
import { bus } from './bus'
import { logger } from './logging'

class SettingsService {
  private store: JsonStore<Settings>

  constructor(private readonly platform: NodeJS.Platform = process.platform) {
    this.store = new JsonStore<Settings>(
      dataFile('settings.json'),
      defaultSettings(this.platform),
      (raw, fallback) => mergeSettings(fallback, raw)
    )
  }

  get(): Settings {
    return this.store.get()
  }

  /** Deep-merges a partial patch and broadcasts the result. */
  update(patch: unknown): Settings {
    const next = this.store.set(mergeSettings(this.store.get(), patch))
    logger.debug('settings', 'Settings updated.', { keys: Object.keys((patch as object) ?? {}) })
    bus.emit({ type: 'settings', settings: next })
    return next
  }

  reset(): Settings {
    const next = this.store.set(defaultSettings(this.platform))
    bus.emit({ type: 'settings', settings: next })
    return next
  }

  flush(): void {
    this.store.flush()
  }
}

export const settings = new SettingsService()
