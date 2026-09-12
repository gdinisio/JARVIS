import { readdir, stat } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { homedir } from 'node:os'
import type { ToolResult } from '@shared/types'
import { validatePath } from './validate'
import { ok, fail, blocked, type ToolHandler } from './context'
import { formatBytes, shorten } from './filesystem'

/** Directories that are slow, enormous, or not the user's to reorganise. */
const SKIP = new Set([
  'node_modules', '.git', '.cache', 'Library', 'AppData', 'Windows', 'WinSxS',
  '$Recycle.Bin', 'System Volume Information', '.Trash', '.Trashes', 'venv', '.venv'
])

interface Entry {
  path: string
  name: string
  size: number
  modified: number
  extension: string
}

/**
 * Walks a tree accumulating file sizes, bounded by time and directory count
 * so "what is using my storage" can never turn into an unbounded scan.
 */
async function measure(
  root: string,
  deadlineMs: number
): Promise<{ files: Entry[]; folders: Map<string, number>; total: number; complete: boolean }> {
  const started = Date.now()
  const files: Entry[] = []
  const folders = new Map<string, number>()
  const queue: Array<{ dir: string; depth: number; top: string | null }> = [{ dir: root, depth: 0, top: null }]
  let visited = 0
  let total = 0
  let complete = true

  while (queue.length) {
    if (Date.now() - started > deadlineMs || visited > 12_000) {
      complete = false
      break
    }
    const { dir, depth, top } = queue.shift()!
    visited++

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || depth >= 8) continue
        queue.push({ dir: full, depth: depth + 1, top: top ?? entry.name })
        continue
      }
      if (!entry.isFile()) continue

      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      total += info.size
      if (top) folders.set(top, (folders.get(top) ?? 0) + info.size)
      files.push({
        path: full,
        name: basename(full),
        size: info.size,
        modified: Math.round(info.mtimeMs),
        extension: extname(full).toLowerCase()
      })
    }
  }

  return { files, folders, total, complete }
}

/**
 * Answers "what is taking up all my storage" with the actual offenders,
 * rather than making the model page through a file listing.
 */
export const findLargeFiles: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const folderInput = String(args.folder ?? '~')
  const check = validatePath(folderInput, { ...ctx.pathPolicy, allowReadAnywhere: true }, 'read')
  if (!check.ok) return blocked(check.reason)

  try {
    const info = await stat(check.path)
    if (!info.isDirectory()) return fail(`${check.path} is not a folder.`)
  } catch {
    return fail(`I could not find the folder ${folderInput}.`)
  }

  const minimumBytes = Math.max(0, Number(args.minimum_mb ?? 100)) * 1024 * 1024
  const limit = Math.max(1, Math.min(100, Number(args.limit ?? 15)))
  const { files, folders, total, complete } = await measure(check.path, 12_000)

  const largest = files
    .filter((file) => file.size >= minimumBytes)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)

  const byFolder = [...folders.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, size]) => ({ folder: name, size: formatBytes(size), sizeBytes: size }))

  if (!largest.length && !byFolder.length) {
    return ok(`Nothing over ${formatBytes(minimumBytes)} in ${shorten(check.path)}.`, { total: formatBytes(total), files: [] })
  }

  const headline = largest[0]
    ? `${shorten(check.path)} holds ${formatBytes(total)}; the largest item is ${headlineName(largest[0])} at ${formatBytes(largest[0].size)}.`
    : `${shorten(check.path)} holds ${formatBytes(total)}.`

  return ok(headline, {
    scanned: shorten(check.path),
    totalBytes: total,
    total: formatBytes(total),
    complete,
    ...(complete ? {} : { note: 'The scan hit its time limit, so these are the largest found so far.' }),
    largestFolders: byFolder,
    files: largest.map((file) => ({
      path: file.path,
      name: file.name,
      size: formatBytes(file.size),
      sizeBytes: file.size,
      modified: new Date(file.modified).toISOString()
    }))
  })
}

function headlineName(entry: Entry): string {
  return entry.name.length > 48 ? `${entry.name.slice(0, 45)}…` : entry.name
}

/** Folder sizes only, for "where has my disk gone" without the file list. */
export const getFolderSize: ToolHandler = async (args, ctx) => {
  const check = validatePath(String(args.path ?? '~'), { ...ctx.pathPolicy, allowReadAnywhere: true }, 'read')
  if (!check.ok) return blocked(check.reason)
  try {
    const info = await stat(check.path)
    if (!info.isDirectory()) {
      return ok(`${basename(check.path)} is ${formatBytes(info.size)}.`, { path: check.path, sizeBytes: info.size })
    }
  } catch {
    return fail(`I could not find ${check.path}.`)
  }

  const { total, folders, complete } = await measure(check.path, 9000)
  return ok(`${shorten(check.path)} is ${formatBytes(total)}${complete ? '' : ' so far'}.`, {
    path: check.path,
    sizeBytes: total,
    size: formatBytes(total),
    complete,
    breakdown: [...folders.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, size]) => ({ folder: name, size: formatBytes(size), sizeBytes: size }))
  })
}

/** Where the trash lives on each platform, for reporting only. */
export function trashLocation(): string {
  if (process.platform === 'win32') return 'the recycle bin'
  if (process.platform === 'darwin') return join(homedir(), '.Trash')
  return join(homedir(), '.local/share/Trash')
}
