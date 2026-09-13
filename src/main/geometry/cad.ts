import type { RawPart } from './mesh'
import { ParseError } from './parsers'
import { logger } from '../services/logging'

/**
 * STEP, IGES and BREP, through OpenCascade compiled to WebAssembly.
 *
 * These are the formats that carry real CAD: boundary representations with
 * exact surfaces rather than a triangle approximation. OpenCascade tessellates
 * them for display; the underlying precision is not something a viewer can
 * show, but the dimensions it reports are exact.
 */

type OcctModule = {
  ReadStepFile(data: Uint8Array, params: unknown): OcctResult
  ReadIgesFile(data: Uint8Array, params: unknown): OcctResult
  ReadBrepFile(data: Uint8Array, params: unknown): OcctResult
}

interface OcctResult {
  success: boolean
  meshes: Array<{
    name?: string
    attributes: { position: { array: number[] }; normal?: { array: number[] } }
    index: { array: number[] }
  }>
}

let modulePromise: Promise<OcctModule> | null = null

/** The WASM module is a few megabytes; load it once, and only on demand. */
async function occt(): Promise<OcctModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const factory = (await import('occt-import-js')).default
      const instance = (await factory()) as OcctModule
      logger.info('geometry', 'OpenCascade loaded for CAD import.')
      return instance
    })().catch((error) => {
      modulePromise = null
      throw error
    })
  }
  return modulePromise
}

export async function parseCad(buffer: Buffer, extension: string, name: string): Promise<RawPart[]> {
  const instance = await occt()
  const data = new Uint8Array(buffer)

  let result: OcctResult
  try {
    if (extension === '.step' || extension === '.stp') result = instance.ReadStepFile(data, null)
    else if (extension === '.iges' || extension === '.igs') result = instance.ReadIgesFile(data, null)
    else result = instance.ReadBrepFile(data, null)
  } catch (error) {
    throw new ParseError(`OpenCascade could not read that file: ${String(error).slice(0, 120)}`)
  }

  if (!result.success || !result.meshes?.length) {
    throw new ParseError('That CAD file could not be read. It may be corrupt, or use a format variant OpenCascade does not support.')
  }

  return result.meshes.map((mesh, index) => ({
    name: mesh.name?.trim() || `${name} part ${index + 1}`,
    positions: mesh.attributes.position.array,
    normals: mesh.attributes.normal?.array,
    indices: mesh.index.array
  }))
}
