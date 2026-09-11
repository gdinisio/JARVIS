import { stat, mkdir, writeFile, readFile, rename, cp, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, basename, dirname, extname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { ToolResult } from '@shared/types'
import { validatePath } from './validate'
import { walkSearch } from '../platform/search'
import { platform } from '../platform'
import { ok, fail, blocked, type ToolHandler } from './context'
import { logger } from '../services/logging'

/** Shared folder aliases so "Downloads" resolves without the model guessing paths. */
const FOLDER_ALIASES: Record<string, string> = {
  home: '~',
  desktop: '~/Desktop',
  downloads: '~/Downloads',
  documents: '~/Documents',
  pictures: '~/Pictures',
  photos: '~/Pictures',
  music: '~/Music',
  videos: '~/Videos',
  movies: '~/Movies'
}

function resolveAlias(input: string): string {
  return FOLDER_ALIASES[input.trim().toLowerCase()] ?? input
}

export const searchFiles: ToolHandler = async (args, ctx) => {
  const folderInput = resolveAlias(String(args.folder ?? '~'))
  const check = validatePath(folderInput, { ...ctx.pathPolicy, allowReadAnywhere: true }, 'read')
  if (!check.ok) return blocked(check.reason)

  try {
    const info = await stat(check.path)
    if (!info.isDirectory()) return fail(`${check.path} is not a folder.`)
  } catch {
    return fail(`I could not find the folder ${folderInput}.`)
  }

  const limit = clampInt(args.limit, 25, 1, 200)
  const days = args.modified_within_days ? clampInt(args.modified_within_days, 30, 1, 3650) : undefined
  const query = {
    root: check.path,
    query: typeof args.query === 'string' ? args.query : undefined,
    extensions: Array.isArray(args.extensions) ? (args.extensions as string[]).map(String) : undefined,
    modifiedAfter: days ? Date.now() - days * 86_400_000 : undefined,
    limit,
    maxDepth: 6
  }

  const adapter = platform()
  let hits = adapter.fastSearch ? await adapter.fastSearch(query).catch(() => null) : null
  if (!hits || !hits.length) hits = await walkSearch(query)

  if (!hits.length) {
    return ok(`No matching files in ${shorten(check.path)}.`, { count: 0, files: [] })
  }
  return ok(
    `Found ${hits.length} file${hits.length === 1 ? '' : 's'} in ${shorten(check.path)}.`,
    {
      count: hits.length,
      files: hits.map((h) => ({
        path: h.path,
        name: h.name,
        sizeBytes: h.size,
        modified: new Date(h.modified).toISOString(),
        extension: h.ext
      }))
    }
  )
}

export const getFileInfo: ToolHandler = async (args, ctx) => {
  const check = validatePath(resolveAlias(String(args.path ?? '')), { ...ctx.pathPolicy, allowReadAnywhere: true }, 'read')
  if (!check.ok) return blocked(check.reason)
  try {
    const info = await stat(check.path)
    return ok(`${basename(check.path)} — ${formatBytes(info.size)}, modified ${new Date(info.mtimeMs).toLocaleString()}.`, {
      path: check.path,
      name: basename(check.path),
      isDirectory: info.isDirectory(),
      sizeBytes: info.size,
      created: new Date(info.birthtimeMs).toISOString(),
      modified: new Date(info.mtimeMs).toISOString(),
      extension: extname(check.path)
    })
  } catch {
    return fail(`I could not find ${check.path}.`)
  }
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.dmg', '.iso', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.psd', '.sqlite', '.db'
])

export const readTextFile: ToolHandler = async (args, ctx) => {
  const check = validatePath(String(args.path ?? ''), { ...ctx.pathPolicy, allowReadAnywhere: true }, 'read')
  if (!check.ok) return blocked(check.reason)
  if (BINARY_EXTENSIONS.has(extname(check.path).toLowerCase())) {
    return fail(`${basename(check.path)} is a binary file, so there is no text to read.`)
  }
  try {
    const info = await stat(check.path)
    if (info.isDirectory()) return fail(`${basename(check.path)} is a folder.`)
    if (info.size > 5 * 1024 * 1024) return fail(`${basename(check.path)} is too large to read (${formatBytes(info.size)}).`)

    const max = clampInt(args.max_characters, 8000, 100, 40000)
    const raw = await readFile(check.path, 'utf8')
    const truncated = raw.length > max
    return ok(`Read ${basename(check.path)}${truncated ? ' (truncated)' : ''}.`, {
      path: check.path,
      truncated,
      characters: raw.length,
      content: truncated ? `${raw.slice(0, max)}\n…[truncated]` : raw
    })
  } catch (error) {
    return fail(readableError(error, `read ${basename(check.path)}`))
  }
}

export const createFolder: ToolHandler = async (args, ctx) => {
  const check = validatePath(String(args.path ?? ''), ctx.pathPolicy, 'write')
  if (!check.ok) return blocked(check.reason)
  try {
    await mkdir(check.path, { recursive: true })
    return ok(`Created ${shorten(check.path)}.`, { path: check.path })
  } catch (error) {
    return fail(readableError(error, `create ${shorten(check.path)}`))
  }
}

export const createFile: ToolHandler = async (args, ctx) => {
  const check = validatePath(String(args.path ?? ''), ctx.pathPolicy, 'write')
  if (!check.ok) return blocked(check.reason)
  const overwrite = args.overwrite === true
  try {
    if (!overwrite && (await exists(check.path))) {
      return fail(`${basename(check.path)} already exists. Ask me to overwrite it if that is what you want.`)
    }
    await mkdir(dirname(check.path), { recursive: true })
    await writeFile(check.path, String(args.content ?? ''), 'utf8')
    return ok(`Created ${shorten(check.path)}.`, { path: check.path })
  } catch (error) {
    return fail(readableError(error, `create ${shorten(check.path)}`))
  }
}

async function transfer(args: Record<string, unknown>, ctx: Parameters<ToolHandler>[1], mode: 'move' | 'copy'): Promise<ToolResult> {
  const source = validatePath(String(args.source ?? ''), ctx.pathPolicy, 'write')
  if (!source.ok) return blocked(source.reason)
  const destInput = String(args.destination ?? '')
  const dest = validatePath(resolveAlias(destInput), ctx.pathPolicy, 'write')
  if (!dest.ok) return blocked(dest.reason)

  try {
    const sourceInfo = await stat(source.path)
    let target = dest.path
    // Moving into an existing folder keeps the original file name.
    if (await isDirectory(target)) target = join(target, basename(source.path))
    if (target === source.path) return fail('The source and destination are the same.')
    if (await exists(target)) return fail(`${basename(target)} already exists at the destination.`)

    await mkdir(dirname(target), { recursive: true })
    if (mode === 'move') {
      try {
        await rename(source.path, target)
      } catch (error) {
        // Cross-device moves need copy + delete.
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        await cp(source.path, target, { recursive: true })
        await rm(source.path, { recursive: true, force: true })
      }
    } else {
      await cp(source.path, target, { recursive: sourceInfo.isDirectory() })
    }
    return ok(`${mode === 'move' ? 'Moved' : 'Copied'} ${basename(source.path)} to ${shorten(dirname(target))}.`, {
      source: source.path,
      destination: target
    })
  } catch (error) {
    return fail(readableError(error, `${mode} ${basename(source.path)}`))
  }
}

export const moveFile: ToolHandler = (args, ctx) => transfer(args, ctx, 'move')
export const copyFile: ToolHandler = (args, ctx) => transfer(args, ctx, 'copy')

export const renameFile: ToolHandler = async (args, ctx) => {
  const check = validatePath(String(args.path ?? ''), ctx.pathPolicy, 'write')
  if (!check.ok) return blocked(check.reason)
  const newName = String(args.new_name ?? '').trim()
  if (!newName || newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
    return fail('The new name must be a plain file name without any folders in it.')
  }
  const target = join(dirname(check.path), newName)
  const targetCheck = validatePath(target, ctx.pathPolicy, 'write')
  if (!targetCheck.ok) return blocked(targetCheck.reason)
  try {
    if (await exists(targetCheck.path)) return fail(`${newName} already exists in that folder.`)
    await rename(check.path, targetCheck.path)
    return ok(`Renamed to ${newName}.`, { from: check.path, to: targetCheck.path })
  } catch (error) {
    return fail(readableError(error, `rename ${basename(check.path)}`))
  }
}

export const deleteFile: ToolHandler = async (args, ctx) => {
  const raw = Array.isArray(args.paths) ? (args.paths as unknown[]) : []
  if (!raw.length) return fail('No files were specified.')

  const targets: string[] = []
  for (const entry of raw) {
    const check = validatePath(String(entry), ctx.pathPolicy, 'write')
    if (!check.ok) return blocked(`${check.reason} Nothing was deleted.`)
    if (check.path === homedir()) return blocked('I will not delete your home folder.')
    targets.push(check.path)
  }

  const permanent = args.permanent === true
  const adapter = platform()
  const deleted: string[] = []
  const failed: Array<{ path: string; error: string }> = []

  for (const target of targets) {
    try {
      if (!(await exists(target))) {
        failed.push({ path: target, error: 'not found' })
        continue
      }
      if (permanent) {
        await rm(target, { recursive: true, force: true })
      } else if (!(await adapter.moveToTrash(target))) {
        failed.push({ path: target, error: 'the recycle bin refused this item' })
        continue
      }
      deleted.push(target)
    } catch (error) {
      failed.push({ path: target, error: readableError(error, 'delete') })
    }
  }

  logger.info('filesystem', 'Delete completed.', { requested: targets.length, deleted: deleted.length, permanent })

  if (!deleted.length) return fail(`Nothing was deleted. ${failed[0]?.error ?? ''}`.trim(), { failed })
  const where = permanent ? 'permanently' : process.platform === 'win32' ? 'to the recycle bin' : 'to the trash'
  return ok(
    `Deleted ${deleted.length} item${deleted.length === 1 ? '' : 's'} ${where}${failed.length ? `; ${failed.length} could not be deleted` : ''}.`,
    { deleted, failed }
  )
}

export const openPath: ToolHandler = async (args, ctx) => {
  const check = validatePath(resolveAlias(String(args.path ?? '')), { ...ctx.pathPolicy, allowReadAnywhere: true }, 'read')
  if (!check.ok) return blocked(check.reason)
  if (!(await exists(check.path))) return fail(`I could not find ${check.path}.`)
  try {
    if (args.reveal === true) await platform().revealPath(check.path)
    else await platform().openPath(check.path)
    return ok(`Opening ${basename(check.path) || check.path}.`, { path: check.path })
  } catch (error) {
    return fail(readableError(error, `open ${basename(check.path)}`))
  }
}

/* helpers */

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown size'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function shorten(path: string): string {
  const home = homedir()
  if (isAbsolute(path) && path.startsWith(home)) return `~${path.slice(home.length)}`
  return path
}

function readableError(error: unknown, action: string): string {
  const code = (error as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `I do not have permission to ${action}.`
    case 'ENOENT':
      return `I could not find what I needed to ${action}.`
    case 'ENOTEMPTY':
      return `That folder is not empty, so I could not ${action}.`
    case 'EBUSY':
      return `Something else is using that file, so I could not ${action}.`
    case 'ENOSPC':
      return 'There is no space left on the disk.'
    default:
      return `I could not ${action}.`
  }
}
