import type { RoutineAction } from '@shared/types'
import { memory } from '../core/memory'
import { routines } from '../core/routines'
import { TOOL_BY_NAME } from './descriptors'
import { ok, fail, type ToolHandler } from './context'

export const remember: ToolHandler = async (args, ctx) => {
  const key = String(args.key ?? '').trim()
  const value = String(args.value ?? '').trim()
  if (!key || !value) return fail('I need both a label and a value to remember something.')
  memory.remember(key, value, 'user', ctx.settings.memory.maxEntries)
  return ok(`I will remember that ${key} is ${value}.`, { key, value })
}

export const forget: ToolHandler = async (args) => {
  const key = String(args.key ?? '').trim()
  const removed = memory.forget(key)
  return removed ? ok(`Forgotten: ${key}.`, { key }) : fail(`I had nothing stored under "${key}".`)
}

export const recall: ToolHandler = async (args) => {
  const entries = memory.recall(typeof args.query === 'string' ? args.query : undefined)
  if (!entries.length) return ok('I have nothing stored yet.', { count: 0, entries: [] })
  return ok(
    `${entries.length} stored item${entries.length === 1 ? '' : 's'}.`,
    { count: entries.length, entries: entries.map((e) => ({ key: e.key, value: e.value })) }
  )
}

export const createRoutine: ToolHandler = async (args) => {
  const name = String(args.name ?? '').trim()
  if (!name) return fail('A routine needs a name.')

  const rawActions = Array.isArray(args.actions) ? args.actions : []
  const actions: RoutineAction[] = []
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { tool?: unknown; args?: unknown; label?: unknown }
    const tool = String(entry.tool ?? '').trim()
    const descriptor = TOOL_BY_NAME.get(tool)
    if (!descriptor) return fail(`"${tool}" is not a tool I can run, so I did not save the routine.`)
    if (tool === 'run_routine') return fail('A routine cannot run another routine.')
    actions.push({
      tool,
      args: (entry.args && typeof entry.args === 'object' ? entry.args : {}) as Record<string, unknown>,
      label: typeof entry.label === 'string' ? entry.label : undefined
    })
  }
  if (!actions.length) return fail('A routine needs at least one step.')

  const triggers = Array.isArray(args.triggers)
    ? (args.triggers as unknown[]).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : []

  const saved = routines.save({
    name,
    description: typeof args.description === 'string' ? args.description : undefined,
    actions,
    triggers
  })
  return ok(`Routine "${saved.name}" saved with ${saved.actions.length} step${saved.actions.length === 1 ? '' : 's'}.`, {
    name: saved.name,
    steps: saved.actions.map((a) => a.label ?? a.tool),
    triggers: saved.triggers
  })
}

export const listRoutines: ToolHandler = async () => {
  const all = routines.list()
  if (!all.length) return ok('No routines are saved yet.', { count: 0, routines: [] })
  return ok(
    `${all.length} routine${all.length === 1 ? '' : 's'} saved.`,
    {
      count: all.length,
      routines: all.map((r) => ({
        name: r.name,
        enabled: r.enabled,
        steps: r.actions.length,
        triggers: r.triggers,
        lastRun: r.lastRun ? new Date(r.lastRun).toISOString() : null
      }))
    }
  )
}

export const deleteRoutine: ToolHandler = async (args) => {
  const name = String(args.name ?? '').trim()
  const removed = routines.delete(name)
  return removed ? ok(`Routine "${name}" deleted.`, { name }) : fail(`I could not find a routine called "${name}".`)
}

/** Execution is injected by the engine so routines reuse the same security path. */
export const runRoutine: ToolHandler = async (args, ctx) => {
  const name = String(args.name ?? '').trim()
  if (!ctx.runRoutine) return fail('Routines cannot be run from here.')
  const routine = routines.find(name)
  if (!routine) return fail(`I could not find a routine called "${name}".`)
  if (!routine.enabled) return fail(`The routine "${routine.name}" is disabled.`)
  return ctx.runRoutine(routine.name)
}
