import { ok, fail, type ToolHandler } from './context'
import { logger } from '../services/logging'

const MAX_READ = 20_000

/**
 * Clipboard access.
 *
 * Electron's clipboard is promise-based and modelled on the W3C API, so every
 * call here is awaited. Reading can expose whatever was last copied, including
 * a password, so the tool is medium risk and reports what it found rather than
 * quietly forwarding it.
 */
export const readClipboard: ToolHandler = async () => {
  try {
    const { clipboard } = await import('electron')
    const text = (await clipboard.readText()) ?? ''

    if (!text.trim()) {
      const hasImage = await clipboard.has('image/png').catch(() => false)
      if (hasImage) return ok('The clipboard holds an image rather than text.', { kind: 'image' })
      return ok('The clipboard is empty.', { kind: 'empty', text: '' })
    }

    const truncated = text.length > MAX_READ
    logger.info('clipboard', 'Clipboard read.', { characters: text.length })
    return ok(`The clipboard holds ${text.length} character${text.length === 1 ? '' : 's'}.`, {
      kind: 'text',
      characters: text.length,
      truncated,
      text: truncated ? `${text.slice(0, MAX_READ)}\n…[truncated]` : text
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The clipboard could not be read.')
  }
}

export const writeClipboard: ToolHandler = async (args) => {
  const text = String(args.text ?? '')
  if (!text) return fail('There was nothing to copy.')
  try {
    const { clipboard } = await import('electron')
    await clipboard.writeText(text.slice(0, 200_000))
    return ok(`Copied ${text.length} character${text.length === 1 ? '' : 's'} to the clipboard.`, {
      characters: text.length
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The clipboard could not be written to.')
  }
}
