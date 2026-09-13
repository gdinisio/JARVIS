import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MeshPayload, ModelSummary } from '@shared/geometry'
import { isCadFormat } from '@shared/geometry'
import { assemble, type RawPart } from './mesh'
import { parse3mf, parseObj, parsePly, parseStl } from './parsers'
import { GeometryError, ParseError } from './errors'
import { parseCad } from './cad'
import { buildModel, toStl, type ModelSpec } from './build'
import { logger } from '../services/logging'

/**
 * The workshop: every model JARVIS has loaded or built this session.
 *
 * Meshes stay in the main process. The renderer receives summaries — a few
 * hundred bytes — and fetches the geometry itself only for the model it is
 * actually showing. Holding them here also means "export what you just made"
 * works without re-reading anything from disk.
 */

export { GeometryError, ParseError }

/** A CAD file large enough to stall the main process is refused, not attempted. */
const MAX_FILE_BYTES = 256 * 1024 * 1024
/** Meshes are heavy; keep the recent ones and let the rest go. */
const MAX_RETAINED = 8

interface StoredModel {
  summary: ModelSummary
  payload: MeshPayload
  /** Monotonic arrival order. Wall-clock ties when several models are built in the same millisecond. */
  seq: number
}

const models = new Map<string, StoredModel>()
let sequence = 0
let listener: ((models: ModelSummary[], focus?: string) => void) | null = null

/** The workshop view subscribes through this; `focus` is the model to show. */
export function onModelsChanged(callback: (models: ModelSummary[], focus?: string) => void): void {
  listener = callback
}

function announce(focus?: string): void {
  listener?.(listModels(), focus)
}

export function listModels(): ModelSummary[] {
  return [...models.values()].sort((a, b) => b.seq - a.seq).map((entry) => entry.summary)
}

export function getModel(id: string): StoredModel | undefined {
  return models.get(id)
}

export function latestModel(): StoredModel | undefined {
  const [first] = listModels()
  return first ? models.get(first.id) : undefined
}

/** Resolves "the model", "that model" and an explicit id to one stored model. */
export function resolveModel(id?: string): StoredModel | undefined {
  if (id && models.get(id)) return models.get(id)
  if (id) {
    const lower = id.toLowerCase()
    const byName = listModels().find((model) => model.name.toLowerCase() === lower)
    if (byName) return models.get(byName.id)
  }
  return id ? undefined : latestModel()
}

function retain(summary: ModelSummary, payload: MeshPayload): ModelSummary {
  sequence += 1
  models.set(summary.id, { summary, payload, seq: sequence })
  const ordered = listModels()
  for (const stale of ordered.slice(MAX_RETAINED)) models.delete(stale.id)
  announce(summary.id)
  return summary
}

function store(parts: RawPart[], meta: { name: string; origin: 'file' | 'generated'; path?: string; format: string }): ModelSummary {
  const { payload, bounds, stats } = assemble(parts)
  const summary: ModelSummary = {
    id: randomUUID(),
    name: meta.name,
    origin: meta.origin,
    format: meta.format,
    stats,
    bounds,
    createdAt: Date.now(),
    ...(meta.path ? { path: meta.path } : {})
  }
  return retain(summary, payload)
}

/** Parses one model file. The extension decides the reader; nothing is guessed from content. */
export async function loadModelFile(path: string): Promise<ModelSummary> {
  const info = await stat(path).catch(() => {
    throw new ParseError('I could not find that file.')
  })
  if (!info.isFile()) throw new ParseError('That path is a folder, not a model file.')
  if (info.size > MAX_FILE_BYTES) {
    throw new ParseError(`That file is ${(info.size / 1024 / 1024).toFixed(0)} MB — too large to open safely.`)
  }
  if (info.size === 0) throw new ParseError('That file is empty.')

  const extension = extname(path).toLowerCase()
  const name = basename(path, extname(path))
  const buffer = await readFile(path)
  const started = Date.now()

  let parts: RawPart[]
  switch (extension) {
    case '.stl':
      parts = parseStl(buffer, name)
      break
    case '.obj':
      parts = parseObj(buffer.toString('utf8'), name)
      break
    case '.ply':
      parts = parsePly(buffer, name)
      break
    case '.3mf':
      parts = parse3mf(buffer, name)
      break
    case '.step':
    case '.stp':
    case '.iges':
    case '.igs':
    case '.brep':
      parts = await parseCad(buffer, extension, name)
      break
    default:
      throw new ParseError(`I cannot read ${extension || 'that'} files. I handle STL, OBJ, PLY, 3MF, STEP, IGES and BREP.`)
  }

  if (!parts.length) throw new ParseError('That file contains no geometry.')

  const summary = store(parts, { name, origin: 'file', path, format: extension.replace('.', '') })
  logger.log('info', 'geometry', 'Model loaded.', {
    format: summary.format,
    triangles: summary.stats.triangles,
    parts: summary.stats.parts,
    cad: isCadFormat(summary.format)
  }, Date.now() - started)
  return summary
}

/** Builds a model from a validated description — the model never runs code to do this. */
export function createModel(spec: ModelSpec): ModelSummary {
  const started = Date.now()
  const built = buildModel(spec)
  const summary = store(built.parts, { name: spec.name, origin: 'generated', format: 'csg' })
  logger.log('info', 'geometry', 'Model generated.', {
    name: spec.name,
    shapes: spec.shapes.length,
    triangles: summary.stats.triangles
  }, Date.now() - started)
  return summary
}

/** Writes a stored model to disk as binary STL. */
export async function exportModel(id: string | undefined, path: string): Promise<{ summary: ModelSummary; bytes: number }> {
  const entry = resolveModel(id)
  if (!entry) throw new GeometryError('There is no model open to export.')
  const stl = toStl(entry.payload.positions, entry.payload.indices, entry.summary.name)
  await writeFile(path, stl)
  return { summary: entry.summary, bytes: stl.length }
}

/** Removes one model from the workshop. */
export function closeModel(id: string): boolean {
  const existed = models.delete(id)
  if (existed) announce()
  return existed
}

/** Test seam: drops everything, so one suite cannot see another's models. */
export function clearModels(): void {
  models.clear()
  sequence = 0
  announce()
}
