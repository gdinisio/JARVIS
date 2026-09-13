import jscad from '@jscad/modeling'
import type { RawPart } from './mesh'
import { GeometryError } from './errors'

/**
 * Parametric solid modelling from a structured description.
 *
 * The model never writes code here. It emits a validated tree of primitives,
 * transforms and boolean operations — the same discipline as every other tool
 * — and this evaluates it with a real CSG kernel. The result has exact
 * dimensions, which is the part that makes it useful rather than decorative:
 * "a 40 by 20 by 10 plate with a 4 millimetre hole" produces exactly that.
 */

const { primitives, booleans, transforms, extrusions, measurements, geometries } = jscad

export interface ShapeSpec {
  shape: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'rounded_box' | 'prism'
  size?: [number, number, number]
  radius?: number
  radiusTop?: number
  radiusBottom?: number
  height?: number
  innerRadius?: number
  roundRadius?: number
  sides?: number
  at?: [number, number, number]
  rotate?: [number, number, number]
  scale?: [number, number, number]
  /** How this shape combines with everything before it. */
  op?: 'add' | 'subtract' | 'intersect'
  name?: string
}

export interface ModelSpec {
  name: string
  units?: 'mm' | 'cm' | 'in'
  shapes: ShapeSpec[]
}

const SEGMENTS = 64
const MAX_DIMENSION = 10_000

function guard(value: number | undefined, fallback: number, what: string): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  if (Math.abs(number) > MAX_DIMENSION) {
    throw new GeometryError(`${what} of ${number} is beyond what JARVIS will model.`)
  }
  return number
}

function buildShape(spec: ShapeSpec): jscad.geometries.geom3.Geom3 {
  const degrees = (value: number) => (value * Math.PI) / 180

  let solid: jscad.geometries.geom3.Geom3
  switch (spec.shape) {
    case 'box':
      solid = primitives.cuboid({
        size: [
          guard(spec.size?.[0], 10, 'A width'),
          guard(spec.size?.[1], 10, 'A depth'),
          guard(spec.size?.[2], 10, 'A height')
        ]
      })
      break
    case 'rounded_box':
      solid = primitives.roundedCuboid({
        size: [
          guard(spec.size?.[0], 10, 'A width'),
          guard(spec.size?.[1], 10, 'A depth'),
          guard(spec.size?.[2], 10, 'A height')
        ],
        roundRadius: Math.max(0.01, guard(spec.roundRadius, 1, 'A corner radius')),
        segments: 32
      })
      break
    case 'cylinder':
      solid = primitives.cylinder({
        radius: Math.max(0.01, guard(spec.radius, 5, 'A radius')),
        height: Math.max(0.01, guard(spec.height, 10, 'A height')),
        segments: SEGMENTS
      })
      break
    case 'cone':
      solid = primitives.cylinderElliptic({
        startRadius: [Math.max(0.001, guard(spec.radiusBottom ?? spec.radius, 5, 'A radius')), Math.max(0.001, guard(spec.radiusBottom ?? spec.radius, 5, 'A radius'))],
        endRadius: [Math.max(0.001, guard(spec.radiusTop, 0.001, 'A radius')), Math.max(0.001, guard(spec.radiusTop, 0.001, 'A radius'))],
        height: Math.max(0.01, guard(spec.height, 10, 'A height')),
        segments: SEGMENTS
      })
      break
    case 'sphere':
      solid = primitives.sphere({ radius: Math.max(0.01, guard(spec.radius, 5, 'A radius')), segments: 48 })
      break
    case 'torus':
      solid = primitives.torus({
        innerRadius: Math.max(0.01, guard(spec.innerRadius, 2, 'A radius')),
        outerRadius: Math.max(0.02, guard(spec.radius, 8, 'A radius')),
        innerSegments: 32,
        outerSegments: 64
      })
      break
    case 'prism': {
      const sides = Math.max(3, Math.min(64, Math.round(guard(spec.sides, 6, 'A side count'))))
      const polygon = primitives.circle({ radius: Math.max(0.01, guard(spec.radius, 5, 'A radius')), segments: sides })
      solid = extrusions.extrudeLinear({ height: Math.max(0.01, guard(spec.height, 10, 'A height')) }, polygon)
      // extrudeLinear builds upward from z=0; centre it like the primitives.
      solid = transforms.translate([0, 0, -guard(spec.height, 10, 'A height') / 2], solid)
      break
    }
    default:
      throw new GeometryError(`"${String(spec.shape)}" is not a shape JARVIS can build.`)
  }

  if (spec.scale) {
    solid = transforms.scale(
      [
        Math.max(0.001, guard(spec.scale[0], 1, 'A scale')),
        Math.max(0.001, guard(spec.scale[1], 1, 'A scale')),
        Math.max(0.001, guard(spec.scale[2], 1, 'A scale'))
      ],
      solid
    )
  }
  if (spec.rotate) {
    solid = transforms.rotate(
      [degrees(guard(spec.rotate[0], 0, 'A rotation')), degrees(guard(spec.rotate[1], 0, 'A rotation')), degrees(guard(spec.rotate[2], 0, 'A rotation'))],
      solid
    )
  }
  if (spec.at) {
    solid = transforms.translate(
      [guard(spec.at[0], 0, 'A position'), guard(spec.at[1], 0, 'A position'), guard(spec.at[2], 0, 'A position')],
      solid
    )
  }
  return solid
}

export interface BuiltModel {
  parts: RawPart[]
  volume: number
  boundingBox: [[number, number, number], [number, number, number]]
}

/** Evaluates a model description into geometry. */
export function buildModel(spec: ModelSpec): BuiltModel {
  if (!spec.shapes?.length) throw new GeometryError('A model needs at least one shape.')
  if (spec.shapes.length > 64) throw new GeometryError('That is more shapes than JARVIS will combine in one model.')

  let solid: jscad.geometries.geom3.Geom3 | null = null

  for (const shapeSpec of spec.shapes) {
    const shape = buildShape(shapeSpec)
    if (!solid) {
      // The first shape is the body, whatever operation it claims.
      solid = shape
      continue
    }
    switch (shapeSpec.op) {
      case 'subtract':
        solid = booleans.subtract(solid, shape)
        break
      case 'intersect':
        solid = booleans.intersect(solid, shape)
        break
      default:
        solid = booleans.union(solid, shape)
    }
  }

  if (!solid) throw new GeometryError('That description produced no geometry.')

  // The kernel works in polygons; the viewer and every export want triangles.
  //
  // `toPolygons` rather than `.polygons`: JSCAD keeps translate, rotate and
  // scale as a pending matrix and only bakes it in here. Reading the raw array
  // silently drops every transform, which puts holes in the wrong place.
  const positions: number[] = []
  for (const polygon of geometries.geom3.toPolygons(solid)) {
    const vertices = polygon.vertices
    for (let i = 1; i + 1 < vertices.length; i++) {
      for (const vertex of [vertices[0], vertices[i], vertices[i + 1]]) {
        positions.push(vertex[0], vertex[1], vertex[2])
      }
    }
  }
  if (!positions.length) throw new GeometryError('That description produced an empty solid — check that the shapes overlap.')

  const scale = spec.units === 'cm' ? 10 : spec.units === 'in' ? 25.4 : 1
  if (scale !== 1) {
    for (let i = 0; i < positions.length; i++) positions[i] *= scale
  }

  const box = measurements.measureBoundingBox(solid)
  return {
    parts: [{ name: spec.name, positions }],
    volume: measurements.measureVolume(solid) * scale ** 3,
    boundingBox: [
      [box[0][0] * scale, box[0][1] * scale, box[0][2] * scale],
      [box[1][0] * scale, box[1][1] * scale, box[1][2] * scale]
    ]
  }
}

/** Writes a binary STL, the format every slicer and printer accepts. */
export function toStl(positions: Float32Array, indices: Uint32Array, name: string): Buffer {
  const triangles = indices.length / 3
  const buffer = Buffer.alloc(84 + triangles * 50)
  buffer.write(`JARVIS ${name}`.slice(0, 79).padEnd(80, ' '), 0, 80, 'ascii')
  buffer.writeUInt32LE(triangles, 80)

  for (let i = 0; i < triangles; i++) {
    const offset = 84 + i * 50
    const a = indices[i * 3] * 3
    const b = indices[i * 3 + 1] * 3
    const c = indices[i * 3 + 2] * 3

    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz) || 1
    nx /= length
    ny /= length
    nz /= length

    buffer.writeFloatLE(nx, offset)
    buffer.writeFloatLE(ny, offset + 4)
    buffer.writeFloatLE(nz, offset + 8)
    for (const [index, corner] of [a, b, c].entries()) {
      const at = offset + 12 + index * 12
      buffer.writeFloatLE(positions[corner], at)
      buffer.writeFloatLE(positions[corner + 1], at + 4)
      buffer.writeFloatLE(positions[corner + 2], at + 8)
    }
  }
  return buffer
}
