import type { Routine, RoutineAction } from '@shared/types'
import { JsonStore } from '../services/store'
import { dataFile } from '../util/paths'
import { bus } from '../services/bus'
import { id, now } from '../util/id'

/**
 * Saved routines.
 *
 * Storage and lookup only — execution lives in the engine, so a routine goes
 * through exactly the same validation and permission checks as a tool call
 * the model proposes.
 */
class RoutineService {
  private store = new JsonStore<Routine[]>(dataFile('routines.json'), [], (raw, fb) =>
    Array.isArray(raw) ? (raw as Routine[]) : fb
  )

  list(): Routine[] {
    return this.store.get()
  }

  find(name: string): Routine | null {
    const wanted = name.trim().toLowerCase()
    const all = this.store.get()
    return (
      all.find((r) => r.name.toLowerCase() === wanted) ??
      all.find((r) => r.triggers.some((t) => t.toLowerCase() === wanted)) ??
      all.find((r) => r.name.toLowerCase().includes(wanted)) ??
      null
    )
  }

  /** Matches a whole utterance against routine names and trigger phrases. */
  matchUtterance(text: string): Routine | null {
    const normalised = text.trim().toLowerCase().replace(/[.!?]+$/, '')
    if (!normalised) return null
    for (const routine of this.store.get()) {
      if (!routine.enabled) continue
      const candidates = [routine.name.toLowerCase(), ...routine.triggers.map((t) => t.toLowerCase())]
      for (const candidate of candidates) {
        if (!candidate) continue
        if (
          normalised === candidate ||
          normalised === `run ${candidate}` ||
          normalised === `start ${candidate}` ||
          normalised === `activate ${candidate}` ||
          normalised === `${candidate} please`
        ) {
          return routine
        }
      }
    }
    return null
  }

  save(input: {
    id?: string
    name: string
    description?: string
    actions: RoutineAction[]
    triggers?: string[]
    enabled?: boolean
  }): Routine {
    let saved: Routine | null = null
    this.store.update((list) => {
      const next = [...list]
      const index = input.id
        ? next.findIndex((r) => r.id === input.id)
        : next.findIndex((r) => r.name.toLowerCase() === input.name.trim().toLowerCase())

      const base: Routine =
        index >= 0
          ? next[index]
          : {
              id: id('r'),
              name: input.name.trim(),
              actions: [],
              enabled: true,
              createdAt: now(),
              updatedAt: now(),
              runCount: 0,
              triggers: []
            }

      saved = {
        ...base,
        name: input.name.trim(),
        description: input.description ?? base.description,
        actions: input.actions,
        triggers: input.triggers ?? base.triggers,
        enabled: input.enabled ?? base.enabled,
        updatedAt: now()
      }
      if (index >= 0) next[index] = saved
      else next.unshift(saved)
      return next
    })
    this.broadcast()
    return saved!
  }

  duplicate(routineId: string): Routine | null {
    const source = this.store.get().find((r) => r.id === routineId)
    if (!source) return null
    return this.save({
      name: `${source.name} copy`,
      description: source.description,
      actions: source.actions,
      triggers: [],
      enabled: source.enabled
    })
  }

  delete(idOrName: string): boolean {
    const before = this.store.get().length
    this.store.update((list) =>
      list.filter((r) => r.id !== idOrName && r.name.toLowerCase() !== idOrName.trim().toLowerCase())
    )
    this.broadcast()
    return this.store.get().length < before
  }

  markRun(routineId: string): void {
    this.store.update((list) =>
      list.map((r) => (r.id === routineId ? { ...r, lastRun: now(), runCount: r.runCount + 1 } : r))
    )
    this.broadcast()
  }

  /** Compact list for the model's system prompt. */
  promptBlock(): string {
    const routines = this.store.get().filter((r) => r.enabled)
    if (!routines.length) return ''
    return routines
      .map((r) => `- ${r.name}${r.triggers.length ? ` (triggers: ${r.triggers.join(', ')})` : ''}: ${r.actions.length} step(s)`)
      .join('\n')
  }

  private broadcast(): void {
    bus.emit({ type: 'routines', routines: this.store.get() })
  }
}

export const routines = new RoutineService()
