/**
 * Geometry passed between the main process and the viewer.
 *
 * Meshes are transferred as flat typed arrays rather than object graphs: a
 * moderately complex CAD part is hundreds of thousands of numbers, and
 * anything else would spend more time in serialisation than in rendering.
 */

export interface MeshBounds {
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
  center: [number, number, number]
}

export interface MeshStats {
  triangles: number
  vertices: number
  /** Enclosed volume in model units, when the mesh is closed. */
  volumeMm3?: number
  surfaceAreaMm2?: number
  parts: number
}

/** A loaded or generated model, ready to display. */
export interface ModelSummary {
  id: string
  name: string
  /** Where it came from: a file on disk, or generated from a description. */
  origin: 'file' | 'generated'
  path?: string
  format: string
  stats: MeshStats
  bounds: MeshBounds
  createdAt: number
}

/** The geometry itself, fetched separately so events stay small. */
export interface MeshPayload {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /** Index ranges per named part, for the outline panel. */
  groups: Array<{ name: string; start: number; count: number }>
}

export const MODEL_EXTENSIONS = [
  '.stl', '.obj', '.ply', '.3mf', '.step', '.stp', '.iges', '.igs', '.brep'
] as const

export function isModelFile(path: string): boolean {
  const lower = path.toLowerCase()
  return MODEL_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** Formats that carry true parametric CAD geometry rather than a mesh. */
export function isCadFormat(format: string): boolean {
  return ['step', 'stp', 'iges', 'igs', 'brep'].includes(format.toLowerCase().replace('.', ''))
}
