import { readdir, stat } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import type { FileHit, SearchQuery } from './types'

/** Directories that are never worth walking and are slow or noisy. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '__pycache__', '.venv', 'venv',
  'System Volume Information', '$Recycle.Bin', 'Windows', 'WinSxS', 'AppData',
  'Library', '.Trash', '.Trashes', 'Photos Library.photoslibrary', 'dist', 'build',
  '.next', '.nuxt', 'target', 'Pods', '.gradle', '.m2'
])

/**
 * Bounded, cross-platform file search.
 *
 * A breadth-first walk with hard caps on depth, visited directories and time,
 * so a request like "find my PDFs" can never turn into an unbounded traversal
 * of the whole disk.
 */
export async function walkSearch(query: SearchQuery, deadlineMs = 8000): Promise<FileHit[]> {
  const started = Date.now()
  const results: FileHit[] = []
  const term = query.query?.trim().toLowerCase() ?? ''
  const extensions = (query.extensions ?? []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
  const queue: Array<{ dir: string; depth: number }> = [{ dir: query.root, depth: 0 }]
  let visited = 0

  while (queue.length && results.length < query.limit && visited < 6000) {
    if (Date.now() - started > deadlineMs) break
    const { dir, depth } = queue.shift()!
    visited++

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // permission denied, vanished, or a mount point we can't read
    }

    for (const entry of entries) {
      if (results.length >= query.limit) break
      const name = entry.name
      if (name.startsWith('.') && name !== '.') continue
      const full = join(dir, name)

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(name) && depth < query.maxDepth) queue.push({ dir: full, depth: depth + 1 })
        if (!query.includeDirectories) continue
      } else if (!entry.isFile()) {
        continue
      }

      if (term && !matches(name, term)) continue
      const ext = extname(name).toLowerCase()
      if (extensions.length && !extensions.includes(ext)) continue

      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (query.modifiedAfter && info.mtimeMs < query.modifiedAfter) continue
      if (query.modifiedBefore && info.mtimeMs > query.modifiedBefore) continue

      results.push({
        path: full,
        name: basename(full),
        size: info.size,
        modified: Math.round(info.mtimeMs),
        isDirectory: entry.isDirectory(),
        ext
      })
    }
  }

  return results.sort((a, b) => b.modified - a.modified)
}

/** Substring match with `*` wildcards, case-insensitive. */
function matches(name: string, term: string): boolean {
  const lower = name.toLowerCase()
  if (!term.includes('*')) return lower.includes(term)
  const pattern = new RegExp(
    `^${term.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
  )
  return pattern.test(lower)
}
