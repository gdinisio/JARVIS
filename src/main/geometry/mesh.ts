import type { MeshBounds, MeshPayload, MeshStats } from '@shared/geometry'
import { GeometryError } from './errors'

/** Above this the viewport stops being interactive, so it is refused instead. */
export const MAX_TRIANGLES = 8_000_000

/**
 * Mesh assembly and measurement.
 *
 * Parsers produce plain triangle soups; this turns them into the indexed,
 * bounded, measured form the viewer expects.
 */

export interface RawPart {
  name: string
  positions: ArrayLike<number>
  normals?: ArrayLike<number>
  indices?: ArrayLike<number>
}

export function boundsOf(positions: ArrayLike<number>): MeshBounds {
  if (!positions.length) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] }
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  }
}

/**
 * Signed volume by the divergence theorem, and total surface area.
 *
 * Only meaningful for a closed mesh; an open one gives a number that is not
 * wrong so much as meaningless, so the caller decides whether to show it.
 */
export function measure(positions: Float32Array, indices: Uint32Array): { volume: number; area: number } {
  let volume = 0
  let area = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3

    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]

    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6

    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2
  }
  return { volume: Math.abs(volume), area }
}

/** Face normals for a mesh that arrived without them. */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3

    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]

    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx

    for (const offset of [a, b, c]) {
      normals[offset] += nx
      normals[offset + 1] += ny
      normals[offset + 2] += nz
    }
  }
  // Normalise the accumulated face normals into smooth vertex normals.
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
    normals[i] /= length
    normals[i + 1] /= length
    normals[i + 2] /= length
  }
  return normals
}

/**
 * Combines parsed parts into one indexed mesh with per-part groups.
 *
 * Sized first, then filled. The obvious version — pushing each part onto a
 * plain array — overflows the call stack somewhere around seven thousand
 * triangles, which is smaller than almost any real model, and holds every
 * coordinate twice while it converts. Measuring first costs one extra pass
 * over the part list and nothing over the data.
 */
export function assemble(parts: RawPart[]): { payload: MeshPayload; bounds: MeshBounds; stats: MeshStats } {
  let vertexCount = 0
  let indexCount = 0
  let haveAllNormals = parts.length > 0

  for (const part of parts) {
    const vertices = part.positions.length / 3
    vertexCount += vertices
    indexCount += part.indices?.length ?? vertices
    if (part.normals?.length !== part.positions.length) haveAllNormals = false
  }

  if (indexCount / 3 > MAX_TRIANGLES) {
    throw new GeometryError(
      `That model has about ${Math.round(indexCount / 3 / 1e6)} million triangles, which is more than JARVIS will display.`
    )
  }

  const positionArray = new Float32Array(vertexCount * 3)
  const indexArray = new Uint32Array(indexCount)
  const normalArray = haveAllNormals ? new Float32Array(vertexCount * 3) : null
  const groups: MeshPayload['groups'] = []

  let vertexOffset = 0
  let writeIndex = 0

  for (const part of parts) {
    const indexStart = writeIndex
    positionArray.set(part.positions, vertexOffset * 3)
    if (normalArray && part.normals) normalArray.set(part.normals, vertexOffset * 3)

    const vertices = part.positions.length / 3
    if (part.indices?.length) {
      for (let i = 0; i < part.indices.length; i++) indexArray[writeIndex++] = part.indices[i] + vertexOffset
    } else {
      for (let i = 0; i < vertices; i++) indexArray[writeIndex++] = vertexOffset + i
    }

    groups.push({ name: part.name, start: indexStart, count: writeIndex - indexStart })
    vertexOffset += vertices
  }

  const normals = normalArray ?? computeNormals(positionArray, indexArray)
  const bounds = boundsOf(positionArray)
  const { volume, area } = measure(positionArray, indexArray)

  return {
    payload: { positions: positionArray, normals, indices: indexArray, groups },
    bounds,
    stats: {
      triangles: indexArray.length / 3,
      vertices: positionArray.length / 3,
      volumeMm3: volume,
      surfaceAreaMm2: area,
      parts: parts.length
    }
  }
}
