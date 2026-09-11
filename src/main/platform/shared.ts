import { writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'

/** Recursive shortcut/app scan used by the Windows and Linux adapters. */
export async function scanDir(
  root: string,
  extensions: string[],
  maxDepth = 4
): Promise<Array<{ name: string; target: string }>> {
  const found: Array<{ name: string; target: string }> = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length && found.length < 600) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 })
      } else if (extensions.includes(extname(entry.name).toLowerCase())) {
        found.push({ name: basename(entry.name, extname(entry.name)), target: full })
      }
    }
  }
  return found
}

/**
 * Cross-platform screen capture through Electron.
 *
 * Uses the compositor rather than shelling out, so it behaves the same on
 * Windows and macOS and respects the OS screen-recording permission prompt.
 */
export async function captureScreenToFile(target: string): Promise<string> {
  const { desktopCapturer, screen } = await import('electron')
  const primary = screen.getPrimaryDisplay()
  const width = Math.round(primary.size.width * primary.scaleFactor)
  const height = Math.round(primary.size.height * primary.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  })
  if (!sources.length) throw new Error('No screen source is available. Screen recording permission may be denied.')
  const image = sources[0].thumbnail
  if (image.isEmpty()) throw new Error('The captured image was empty. Screen recording permission may be denied.')
  await writeFile(target, image.toPNG())
  return target
}

/** Returns a PNG data URL of the primary screen, downscaled for vision models. */
export async function captureScreenDataUrl(maxWidth = 1400): Promise<{ dataUrl: string; width: number; height: number }> {
  const { desktopCapturer, screen } = await import('electron')
  const primary = screen.getPrimaryDisplay()
  const ratio = primary.size.height / primary.size.width
  const width = Math.min(maxWidth, Math.round(primary.size.width * primary.scaleFactor))
  const height = Math.round(width * ratio)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  if (!sources.length) throw new Error('No screen source is available.')
  const image = sources[0].thumbnail
  if (image.isEmpty()) throw new Error('The captured image was empty. Screen recording permission may be denied.')
  return { dataUrl: image.toDataURL(), width, height }
}

/** Electron's cross-platform "move to the recycle bin / trash". */
export async function trashItem(path: string): Promise<boolean> {
  try {
    const { shell } = await import('electron')
    await shell.trashItem(path)
    return true
  } catch {
    return false
  }
}
