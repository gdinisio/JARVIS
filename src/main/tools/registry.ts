import type { ToolResult } from '@shared/types'
import { TOOL_BY_NAME, schemaFor } from './descriptors'
import type { ToolContext, ToolHandler } from './context'
import { fail, blocked } from './context'
import { logger } from '../services/logging'

import { openApplication, closeApplication, listApplications } from './applications'
import {
  searchFiles, getFileInfo, readTextFile, createFolder, createFile,
  moveFile, copyFile, renameFile, deleteFile, openPath
} from './filesystem'
import { getSystemStats, getRunningProcesses, setVolume, openSettings } from './system'
import { openUrl, webSearch } from './web'
import { takeScreenshot, readScreen } from './screen'
import { executeCommand } from './terminal'
import { lockComputer, restartComputer, shutdownComputer } from './power'
import { remember, forget, recall, createRoutine, runRoutine, listRoutines, deleteRoutine } from './knowledge'

const HANDLERS: Record<string, ToolHandler> = {
  open_application: openApplication,
  close_application: closeApplication,
  list_applications: listApplications,
  get_running_processes: getRunningProcesses,
  get_system_stats: getSystemStats,
  search_files: searchFiles,
  get_file_info: getFileInfo,
  read_text_file: readTextFile,
  create_folder: createFolder,
  create_file: createFile,
  move_file: moveFile,
  copy_file: copyFile,
  rename_file: renameFile,
  delete_file: deleteFile,
  open_path: openPath,
  open_url: openUrl,
  web_search: webSearch,
  take_screenshot: takeScreenshot,
  read_screen: readScreen,
  set_volume: setVolume,
  execute_command: executeCommand,
  open_settings: openSettings,
  lock_computer: lockComputer,
  restart_computer: restartComputer,
  shutdown_computer: shutdownComputer,
  remember,
  forget,
  recall,
  create_routine: createRoutine,
  run_routine: runRoutine,
  list_routines: listRoutines,
  delete_routine: deleteRoutine
}

/**
 * Validates and runs a single tool call.
 *
 * Arguments are parsed against the tool's zod schema before the handler sees
 * them, so a handler never receives a shape it did not ask for — whatever the
 * model produced.
 */
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const started = Date.now()
  const descriptor = TOOL_BY_NAME.get(name)
  const handler = HANDLERS[name]

  if (!descriptor || !handler) {
    logger.warn('tools', 'Unknown tool requested.', { name })
    return blocked(`"${name}" is not a tool I can run.`)
  }

  const schema = schemaFor(descriptor.name)
  if (!schema) return blocked(`"${name}" cannot be called directly.`)

  const parsed = schema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path?.length ? `${issue.path.join('.')}: ` : ''
    logger.warn('tools', 'Tool arguments rejected.', { name, issue: `${where}${issue?.message ?? 'invalid'}` })
    return fail(`Those arguments were not valid — ${where}${issue?.message ?? 'invalid input'}.`)
  }

  try {
    const result = await handler(parsed.data as Record<string, unknown>, ctx)
    const durationMs = Date.now() - started
    logger.log(
      result.ok ? 'info' : 'warn',
      'tools',
      `${name} ${result.ok ? 'succeeded' : 'failed'}.`,
      ctx.settings.privacy.logArguments
        ? { name, args: parsed.data as Record<string, unknown>, summary: result.summary, error: result.error }
        : { name, summary: result.summary, error: result.error },
      durationMs
    )
    return { ...result, durationMs }
  } catch (error) {
    const durationMs = Date.now() - started
    logger.error('tools', `${name} threw.`, { name, error: String(error) })
    return { ...fail(`${name.replace(/_/g, ' ')} failed unexpectedly.`), durationMs }
  }
}

export function hasTool(name: string): boolean {
  return name in HANDLERS
}
