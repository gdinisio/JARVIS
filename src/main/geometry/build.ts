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

export type ShapeKind =
  | 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus'
  | 'rounded_box' | 'rounded_cylinder' | 'prism' | 'profile' | 'revolve'

export type Axis = 'x' | 'y' | 'z'

/**
 * Copies of a feature, the way a CAD package patterns one.
 *
 * `step` walks in a straight line; `circle` places copies on a bolt circle;
 * neither together rotates the feature in place about the axis. This is the
 * difference between a model that can draw a plate and one that can draw a
 * flange with six bolt holes.
 */
export interface RepeatSpec {
  count: number
  step?: [number, number, number]
  circle?: number
  axis?: Axis
  /** Total sweep in degrees for a circular pattern. Defaults to a full turn. */
  angle?: number
}

export interface ShapeSpec {
  shape: ShapeKind
  size?: [number, number, number]
  radius?: number
  radiusTop?: number
  radiusBottom?: number
  height?: number
  innerRadius?: number
  roundRadius?: number
  sides?: number
  /** 2D outline for `profile` and `revolve`, as [x, y] pairs. */
  points?: Array<[number, number]>
  /** Sweep of a partial revolve, in degrees. Defaults to a full turn. */
  angle?: number
  at?: [number, number, number]
  rotate?: [number, number, number]
  scale?: [number, number, number]
  repeat?: RepeatSpec
  /** Keep a mirrored copy across this plane as well as the original. */
  mirror?: Axis
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

const MAX_POINTS = 512

/** Validates and builds the 2D outline used by `profile` and `revolve`. */
function outline(spec: ShapeSpec, minimum: number): jscad.geometries.geom2.Geom2 {
  const points = spec.points
  if (!Array.isArray(points) || points.length < minimum) {
    throw new GeometryError(`A ${spec.shape} needs at least ${minimum} points describing its outline.`)
  }
  if (points.length > MAX_POINTS) {
    throw new GeometryError(`An outline of ${points.length} points is more than JARVIS will model.`)
  }
  const cleaned = points.map((point, index) => {
    if (!Array.isArray(point) || point.length < 2) {
      throw new GeometryError(`Point ${index + 1} of the outline is not an [x, y] pair.`)
    }
    return [guard(point[0], 0, 'A point'), guard(point[1], 0, 'A point')] as [number, number]
  })
  // extrudeRotate sweeps about Z using x as the radius, so a negative x would
  // turn the solid inside out.
  if (spec.shape === 'revolve' && cleaned.some(([x]) => x < 0)) {
    throw new GeometryError('A revolve profile cannot cross its own axis — every x must be zero or greater.')
  }
  return primitives.polygon({ points: cleaned })
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
    case 'rounded_cylinder': {
      const height = Math.max(0.02, guard(spec.height, 10, 'A height'))
      const radius = Math.max(0.01, guard(spec.radius, 5, 'A radius'))
      solid = primitives.roundedCylinder({
        height,
        radius,
        // The fillet cannot exceed half the height or the radius itself.
        roundRadius: Math.min(guard(spec.roundRadius, Math.min(radius, height / 2) / 3, 'A corner radius'), radius * 0.999, height / 2 * 0.999),
        segments: SEGMENTS
      })
      break
    }
    case 'profile': {
      // An arbitrary outline, extruded. This is how a shape that is not a
      // primitive gets made: an L-bracket, a gasket, a cam plate.
      solid = extrusions.extrudeLinear(
        { height: Math.max(0.01, guard(spec.height, 10, 'A height')) },
        outline(spec, 3)
      )
      // Centre it in Z so `at` behaves the same as it does for every solid.
      solid = transforms.translate([0, 0, -guard(spec.height, 10, 'A height') / 2], solid)
      break
    }
    case 'revolve': {
      // A lathe profile: x is the distance from the axis, y the height. The
      // result keeps those coordinates rather than being re-centred, because
      // the points already say where the material is.
      const sweep = Math.min(360, Math.max(1, guard(spec.angle, 360, 'An angle')))
      solid = extrusions.extrudeRotate({ segments: SEGMENTS, angle: degrees(sweep) }, outline(spec, 3))
      break
    }
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

const MAX_COPIES = 256

/**
 * One entry in the shape list, with its pattern expanded.
 *
 * Patterning happens after the shape's own placement, so `at` positions the
 * first copy and the pattern walks from there — which is what someone means
 * by "a hole at 15 millimetres, repeated six times around".
 */
function buildFeature(spec: ShapeSpec): jscad.geometries.geom3.Geom3 {
  const base = buildShape(spec)
  let copies: jscad.geometries.geom3.Geom3[] = [base]

  const repeat = spec.repeat
  if (repeat) {
    const count = Math.round(guard(repeat.count, 1, 'A copy count'))
    if (count < 1) throw new GeometryError('A pattern needs at least one copy.')
    if (count > MAX_COPIES) throw new GeometryError(`${count} copies is more than JARVIS will pattern.`)

    if (repeat.step) {
      const step = repeat.step
      copies = Array.from({ length: count }, (_, index) =>
        index === 0
          ? base
          : transforms.translate(
              [
                guard(step[0], 0, 'A step') * index,
                guard(step[1], 0, 'A step') * index,
                guard(step[2], 0, 'A step') * index
              ],
              base
            )
      )
    } else {
      // Circular. A full turn divides evenly; a partial sweep puts a copy at
      // each end, which is what "three ribs over 90 degrees" means.
      const sweep = guard(repeat.angle, 360, 'An angle')
      const full = Math.abs(sweep) >= 359.999
      const divisor = full ? count : Math.max(1, count - 1)
      const radius = repeat.circle === undefined ? 0 : guard(repeat.circle, 0, 'A bolt circle radius')
      const seated = radius ? transforms.translate(offsetFor(repeat.axis ?? 'z', radius), base) : base

      copies = Array.from({ length: count }, (_, index) => {
        const theta = (sweep / divisor) * index
        return theta === 0 ? seated : transforms.rotate(rotationFor(repeat.axis ?? 'z', (theta * Math.PI) / 180), seated)
      })
    }
  }

  if (spec.mirror) {
    const normal = spec.mirror === 'x' ? [1, 0, 0] : spec.mirror === 'y' ? [0, 1, 0] : [0, 0, 1]
    copies = copies.flatMap((copy) => [copy, transforms.mirror({ normal: normal as [number, number, number] }, copy)])
  }

  return copies.length === 1 ? copies[0] : booleans.union(copies)
}

/** Where a bolt-circle copy sits before it is swung around the axis. */
function offsetFor(axis: Axis, radius: number): [number, number, number] {
  if (axis === 'x') return [0, radius, 0]
  if (axis === 'y') return [0, 0, radius]
  return [radius, 0, 0]
}

function rotationFor(axis: Axis, radians: number): [number, number, number] {
  if (axis === 'x') return [radians, 0, 0]
  if (axis === 'y') return [0, radians, 0]
  return [0, 0, radians]
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
    const shape = buildFeature(shapeSpec)
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
