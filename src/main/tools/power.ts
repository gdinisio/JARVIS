import { platform } from '../platform'
import { ok, fail, type ToolHandler } from './context'
import { logger } from '../services/logging'

/**
 * Power controls.
 *
 * The security layer has already obtained an explicit confirmation before any
 * of these run — see `core/permissions.ts`.
 */

export const lockComputer: ToolHandler = async () => {
  try {
    await platform().lock()
    logger.info('power', 'Workstation locked.')
    return ok('Locking the workstation.')
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The workstation could not be locked.')
  }
}

export const restartComputer: ToolHandler = async (args) => {
  const delay = Math.max(0, Math.min(300, Number(args.delay_seconds) || 0))
  try {
    if (delay) await wait(delay * 1000)
    await platform().restart()
    logger.warn('power', 'Restart requested.', { delay })
    return ok('Restarting now. Goodbye for a moment.')
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The restart request was refused.')
  }
}

export const shutdownComputer: ToolHandler = async (args) => {
  const delay = Math.max(0, Math.min(300, Number(args.delay_seconds) || 0))
  try {
    if (delay) await wait(delay * 1000)
    await platform().shutdown()
    logger.warn('power', 'Shutdown requested.', { delay })
    return ok('Shutting down.')
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The shutdown request was refused.')
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
