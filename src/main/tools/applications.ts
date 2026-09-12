import type { ToolResult } from '@shared/types'
import { platform } from '../platform'
import { validateAppName } from './validate'
import { ok, fail, blocked, type ToolHandler } from './context'
import { memory } from '../core/memory'

/** Words that mean "whatever the user prefers" rather than a literal app name. */
const PREFERENCE_ALIASES: Record<string, keyof ReturnType<typeof memory.preferences>> = {
  browser: 'browser',
  'my browser': 'browser',
  'web browser': 'browser',
  editor: 'editor',
  'my editor': 'editor',
  'code editor': 'editor',
  music: 'musicApp',
  'music app': 'musicApp',
  'my music': 'musicApp',
  chat: 'chatApp',
  'chat app': 'chatApp',
  terminal: 'terminal'
}

function resolvePreference(name: string): string {
  const key = PREFERENCE_ALIASES[name.trim().toLowerCase()]
  if (!key) return name
  const preferred = memory.preferences()[key]
  return preferred || name
}

export const openApplication: ToolHandler = async (args) => {
  const requested = resolvePreference(String(args.name ?? ''))
  const check = validateAppName(requested)
  if (!check.ok) return blocked(check.reason)

  const adapter = platform()
  const app = await adapter.resolveApplication(check.name)
  if (!app) return fail(`I could not find ${check.name} on this computer.`)

  try {
    await adapter.openApplication(app)
    return ok(`Opening ${app.name}.`, { application: app.name, target: app.target })
  } catch (error) {
    return fail(`I could not open ${app.name}. ${cleanMessage(error)}`.trim())
  }
}

export const closeApplication: ToolHandler = async (args) => {
  const requested = resolvePreference(String(args.name ?? ''))
  const check = validateAppName(requested)
  if (!check.ok) return blocked(check.reason)

  try {
    const result = await platform().closeApplication(check.name, args.force === true)
    return ok(`Closed ${result.closed.join(', ')}.`, result)
  } catch (error) {
    return fail(cleanMessage(error) || `I could not close ${check.name}.`)
  }
}

export const listApplications: ToolHandler = async (args): Promise<ToolResult> => {
  const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : ''
  try {
    const apps = await platform().listApplications()
    const matched = filter ? apps.filter((a) => a.name.toLowerCase().includes(filter)) : apps
    const names = matched.slice(0, 120).map((a) => a.name)
    return ok(
      matched.length
        ? `${matched.length} application${matched.length === 1 ? '' : 's'} found.`
        : 'No matching applications are installed.',
      { count: matched.length, applications: names }
    )
  } catch (error) {
    return fail(`I could not read the installed application list. ${cleanMessage(error)}`.trim())
  }
}

/**
 * Closes everything except the applications named.
 *
 * "Close everything except Discord and Spotify" is one instruction, and doing
 * it as one call means one confirmation rather than a prompt per application
 * — and one consistent list of what the platform refuses to touch.
 */
export const closeOtherApplications: ToolHandler = async (args) => {
  const raw = Array.isArray(args.keep) ? (args.keep as unknown[]) : []
  const keep: string[] = []
  for (const entry of raw) {
    const resolved = resolvePreference(String(entry))
    const check = validateAppName(resolved)
    if (!check.ok) return blocked(`${check.reason} Nothing was closed.`)
    keep.push(check.name)
  }

  const adapter = platform()
  if (!adapter.closeOtherApplications) {
    return fail('Closing everything at once is not supported on this system.')
  }

  try {
    const result = await adapter.closeOtherApplications(keep)
    if (!result.closed.length) {
      return ok('Nothing needed closing.', result)
    }
    return ok(
      `Closed ${result.closed.length} application${result.closed.length === 1 ? '' : 's'}${keep.length ? `, keeping ${keep.join(' and ')}` : ''}.`,
      result
    )
  } catch (error) {
    return fail(cleanMessage(error) || 'Applications could not be closed.')
  }
}

function cleanMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 197)}…` : message
}
