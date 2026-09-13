import { extname, join, basename, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { isCadFormat, isModelFile, MODEL_EXTENSIONS, type MeshBounds, type ModelSummary } from '@shared/geometry'
import { validatePath } from './validate'
import { ok, fail, blocked, type ToolHandler } from './context'
import { createModel, exportModel, listModels, loadModelFile, GeometryError, resolveModel } from '../geometry'
import type { ModelSpec, ShapeSpec } from '../geometry/build'
import { logger } from '../services/logging'

/**
 * The 3D workshop tools.
 *
 * Two halves, and both of them stay inside the same rule as every other tool:
 * the model describes what it wants, and this code decides whether that is
 * allowed and then does it. Opening a file goes through the same path
 * validation as any read. Building a solid takes a validated tree of
 * primitives and boolean operations — never code, never a script.
 */

function describeBounds(bounds: MeshBounds, units = 'mm'): string {
  const [x, y, z] = bounds.size
  return `${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} ${units}`
}

function describe(summary: ModelSummary): string {
  const parts: string[] = [describeBounds(summary.bounds)]
  if (summary.stats.volumeMm3 && summary.stats.volumeMm3 > 0) {
    parts.push(`${summary.stats.volumeMm3.toFixed(0)} mm³`)
  }
  parts.push(`${summary.stats.triangles.toLocaleString()} triangles`)
  if (summary.stats.parts > 1) parts.push(`${summary.stats.parts} parts`)
  return parts.join(', ')
}

function payload(summary: ModelSummary): Record<string, unknown> {
  return {
    id: summary.id,
    name: summary.name,
    format: summary.format,
    parametric_cad: isCadFormat(summary.format),
    size_mm: summary.bounds.size.map((value) => Number(value.toFixed(3))),
    centre_mm: summary.bounds.center.map((value) => Number(value.toFixed(3))),
    triangles: summary.stats.triangles,
    parts: summary.stats.parts,
    volume_mm3: summary.stats.volumeMm3 ? Number(summary.stats.volumeMm3.toFixed(2)) : undefined,
    surface_area_mm2: summary.stats.surfaceAreaMm2 ? Number(summary.stats.surfaceAreaMm2.toFixed(2)) : undefined
  }
}

export const open3dModel: ToolHandler = async (args, ctx) => {
  const raw = String(args.path ?? '').trim()
  if (!raw) return fail('I need the path of a model file to open.')

  const check = validatePath(raw, { ...ctx.pathPolicy, allowReadAnywhere: true }, 'read')
  if (!check.ok) return blocked(check.reason)

  if (!isModelFile(check.path)) {
    const extension = extname(check.path).toLowerCase() || 'that'
    return fail(`I cannot open ${extension} files in the viewer. I handle ${MODEL_EXTENSIONS.join(', ')}.`)
  }

  try {
    const summary = await loadModelFile(check.path)
    const kind = isCadFormat(summary.format) ? 'CAD model' : 'mesh'
    return ok(`Opened ${summary.name} — ${describe(summary)}.`, {
      ...payload(summary),
      kind,
      displayed: true,
      note: 'The model is now on screen in the Workshop. The user can orbit, pan and zoom it.'
    })
  } catch (error) {
    if (error instanceof GeometryError) {
      logger.warn('geometry', 'Model could not be read.', { reason: error.message })
      return fail(error.message)
    }
    logger.error('geometry', 'Model open failed.', { error: String(error) })
    return fail(`I could not open that model — ${String(error).slice(0, 160)}`)
  }
}

/**
 * The tool vocabulary is snake_case, because that is what reads naturally in a
 * JSON schema; the kernel's is camelCase. Translating here keeps the seam in
 * one place rather than scattering both spellings through the geometry code.
 */
interface RawShape {
  shape: ShapeSpec['shape']
  size?: [number, number, number]
  radius?: number
  radius_top?: number
  radius_bottom?: number
  height?: number
  inner_radius?: number
  round_radius?: number
  sides?: number
  at?: [number, number, number]
  rotate?: [number, number, number]
  scale?: [number, number, number]
  op?: ShapeSpec['op']
  name?: string
}

function toShapeSpec(raw: RawShape): ShapeSpec {
  return {
    shape: raw.shape,
    ...(raw.size ? { size: raw.size } : {}),
    ...(raw.radius !== undefined ? { radius: raw.radius } : {}),
    ...(raw.radius_top !== undefined ? { radiusTop: raw.radius_top } : {}),
    ...(raw.radius_bottom !== undefined ? { radiusBottom: raw.radius_bottom } : {}),
    ...(raw.height !== undefined ? { height: raw.height } : {}),
    ...(raw.inner_radius !== undefined ? { innerRadius: raw.inner_radius } : {}),
    ...(raw.round_radius !== undefined ? { roundRadius: raw.round_radius } : {}),
    ...(raw.sides !== undefined ? { sides: raw.sides } : {}),
    ...(raw.at ? { at: raw.at } : {}),
    ...(raw.rotate ? { rotate: raw.rotate } : {}),
    ...(raw.scale ? { scale: raw.scale } : {}),
    ...(raw.op ? { op: raw.op } : {}),
    ...(raw.name ? { name: raw.name } : {})
  }
}

export const create3dModel: ToolHandler = async (args) => {
  const spec: ModelSpec = {
    name: String(args.name ?? 'Model'),
    units: (args.units as ModelSpec['units']) ?? 'mm',
    shapes: ((args.shapes as RawShape[]) ?? []).map(toShapeSpec)
  }
  if (!spec.shapes.length) return fail('A model needs at least one shape.')

  try {
    const summary = createModel(spec)
    if (summary.stats.triangles === 0) {
      return fail('That description produced an empty solid — the subtractions may have removed everything.')
    }
    return ok(`Built ${summary.name} — ${describe(summary)}.`, {
      ...payload(summary),
      displayed: true,
      note: 'The model is on screen in the Workshop and can be exported as STL.'
    })
  } catch (error) {
    if (error instanceof GeometryError) {
      logger.warn('geometry', 'Model could not be built.', { reason: error.message })
      return fail(error.message)
    }
    logger.error('geometry', 'Model build failed.', { error: String(error) })
    return fail(`I could not build that — ${String(error).slice(0, 160)}`)
  }
}

export const export3dModel: ToolHandler = async (args, ctx) => {
  const entry = resolveModel(args.model as string | undefined)
  if (!entry) {
    return fail(listModels().length ? 'I could not find that model.' : 'There is no model open to export.')
  }

  const requested = String(args.path ?? '').trim()
  const fallback = join(homedir(), 'Documents', `${entry.summary.name.replace(/[^\w .-]/g, '_')}.stl`)
  let target = requested || fallback
  if (!requested) target = fallback
  else if (!isAbsolute(target) && !target.startsWith('~')) target = join(homedir(), 'Documents', target)
  if (extname(target).toLowerCase() !== '.stl') target = `${target}.stl`

  const check = validatePath(target, ctx.pathPolicy, 'write')
  if (!check.ok) return blocked(check.reason)

  try {
    const { summary, bytes } = await exportModel(entry.summary.id, check.path)
    return ok(`Saved ${summary.name} to ${basename(check.path)} — ${(bytes / 1024).toFixed(0)} KB.`, {
      path: check.path,
      bytes,
      format: 'stl'
    })
  } catch (error) {
    if (error instanceof GeometryError) return fail(error.message)
    logger.error('geometry', 'Model export failed.', { error: String(error) })
    return fail(`I could not save that model — ${String(error).slice(0, 160)}`)
  }
}

export const list3dModels: ToolHandler = async () => {
  const models = listModels()
  if (!models.length) return ok('No models are open.', { count: 0, models: [] })
  return ok(
    `${models.length} model${models.length === 1 ? '' : 's'} open: ${models.map((model) => model.name).join(', ')}.`,
    { count: models.length, models: models.map(payload) }
  )
}
