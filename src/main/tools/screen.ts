import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { platform } from '../platform'
import { captureScreenDataUrl } from '../platform/shared'
import { validatePath } from './validate'
import { ok, fail, blocked, type ToolHandler } from './context'
import { logger } from '../services/logging'

function timestampName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `JARVIS-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
}

export const takeScreenshot: ToolHandler = async (args, ctx) => {
  const fallbackDir = join(homedir(), process.platform === 'darwin' ? 'Pictures' : 'Pictures')
  const requested = typeof args.save_to === 'string' && args.save_to.trim() ? args.save_to.trim() : join(fallbackDir, timestampName())
  const withExtension = requested.toLowerCase().endsWith('.png') ? requested : join(requested, timestampName())

  const check = validatePath(withExtension, ctx.pathPolicy, 'write')
  if (!check.ok) return blocked(check.reason)

  ctx.onScreenAccess?.(true)
  try {
    await mkdir(join(check.path, '..'), { recursive: true })
    const written = await platform().screenshot(check.path)
    logger.info('screen', 'Screenshot captured.', { path: written })
    return ok('Screenshot captured.', { path: written })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The screen could not be captured.')
  } finally {
    ctx.onScreenAccess?.(false)
  }
}

/**
 * Captures the screen for the model to look at.
 *
 * The image never touches disk and is passed straight into the next model
 * turn. The screen-access indicator is raised for the duration.
 */
export const readScreen: ToolHandler = async (args, ctx) => {
  ctx.onScreenAccess?.(true)
  try {
    const shot = await captureScreenDataUrl(1400)
    logger.info('screen', 'Screen contents read for the model.', { width: shot.width, height: shot.height })
    return ok('Looking at your screen.', {
      question: typeof args.question === 'string' ? args.question : undefined,
      width: shot.width,
      height: shot.height,
      imageDataUrl: shot.dataUrl
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The screen could not be read.')
  } finally {
    ctx.onScreenAccess?.(false)
  }
}
