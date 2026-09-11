import type { Settings, ToolResult } from '@shared/types'
import type { PathPolicy } from './validate'

/** Everything a tool handler is allowed to see. */
export interface ToolContext {
  settings: Settings
  pathPolicy: PathPolicy
  /** Cancels long-running work when the user says "stop". */
  signal?: AbortSignal
  /** Routine execution is injected to avoid a cycle between tools and the engine. */
  runRoutine?: (name: string) => Promise<ToolResult>
  /** Set when the model asked to look at the screen; used to surface the indicator. */
  onScreenAccess?: (active: boolean) => void
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

export function ok(summary: string, data?: unknown): ToolResult {
  return { ok: true, summary, data }
}

export function fail(error: string, data?: unknown): ToolResult {
  return { ok: false, error, summary: error, data }
}

export function blocked(error: string): ToolResult {
  return { ok: false, blocked: true, error, summary: error }
}
