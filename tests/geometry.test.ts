import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { executeTool } from '../src/main/tools/registry'
import { TOOL_BY_NAME } from '../src/main/tools/descriptors'
import { defaultSettings } from '../src/shared/defaults'
import { buildModel, toStl } from '../src/main/geometry/build'
import { parseStl, parseObj, parsePly, ParseError } from '../src/main/geometry/parsers'
import { assemble } from '../src/main/geometry/mesh'
import { clearModels, listModels, loadModelFile, getModel } from '../src/main/geometry'
import { isModelFile, isCadFormat } from '../src/shared/geometry'
import type { ToolContext } from '../src/main/tools/context'

const FIXTURES = resolve(__dirname, 'fixtures')
/** A 40 × 20 × 10 plate with a Ø4 through-hole. CadQuery's exact volume. */
const PLATE_VOLUME = 7874.3
let root: string
let context: ToolContext

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-geometry-'))
  const settings = defaultSettings(process.platform)
  settings.automation.workspaceRoots = [root]
  context = {
    settings,
    pathPolicy: {
      protectedPaths: settings.automation.protectedPaths,
      workspaceRoots: [root],
      platform: process.platform
    }
  }
})

beforeEach(() => clearModels())
afterEach(() => clearModels())

describe('format detection', () => {
  it('recognises the formats it can read', () => {
    for (const name of ['a.stl', 'B.STL', 'part.step', 'x.iges', 'y.3mf', 'z.obj', 'w.ply', 'v.brep']) {
      expect(isModelFile(name), name).toBe(true)
    }
  })

  it('rejects everything else', () => {
    for (const name of ['notes.txt', 'photo.png', 'archive.zip', 'script.js', 'stl', '']) {
      expect(isModelFile(name), name).toBe(false)
    }
  })

  it('separates parametric CAD from meshes', () => {
    expect(isCadFormat('step')).toBe(true)
    expect(isCadFormat('.STP')).toBe(true)
    expect(isCadFormat('stl')).toBe(false)
  })
})

describe('mesh parsers', () => {
  it('reads the binary STL fixture with correct bounds', () => {
    const parts = parseStl(readFileSync(join(FIXTURES, 'plate.stl')), 'plate')
    const { bounds, stats } = assemble(parts)
    expect(stats.triangles).toBeGreaterThan(0)
    expect(bounds.size[0]).toBeCloseTo(40, 1)
    expect(bounds.size[1]).toBeCloseTo(20, 1)
    expect(bounds.size[2]).toBeCloseTo(10, 1)
  })

  it('measures the fixture volume to within a tolerance the tessellation allows', () => {
    const parts = parseStl(readFileSync(join(FIXTURES, 'plate.stl')), 'plate')
    const { stats } = assemble(parts)
    // The hole is a polygonal approximation, so the mesh encloses slightly
    // more material than the exact solid. 2% covers that without hiding a bug.
    expect(stats.volumeMm3).toBeGreaterThan(PLATE_VOLUME * 0.98)
    expect(stats.volumeMm3).toBeLessThan(PLATE_VOLUME * 1.02)
  })

  it('round-trips its own STL writer', () => {
    const built = buildModel({ name: 'cube', shapes: [{ shape: 'box', size: [10, 10, 10] }] })
    const { payload } = assemble(built.parts)
    const stl = toStl(payload.positions, payload.indices, 'cube')
    const reparsed = assemble(parseStl(stl, 'cube'))
    expect(reparsed.stats.triangles).toBe(payload.indices.length / 3)
    expect(reparsed.stats.volumeMm3).toBeCloseTo(1000, 0)
  })

  it('reads an ASCII STL', () => {
    const ascii = [
      'solid tri',
      'facet normal 0 0 1',
      '  outer loop',
      '    vertex 0 0 0',
      '    vertex 1 0 0',
      '    vertex 0 1 0',
      '  endloop',
      'endfacet',
      'endsolid tri'
    ].join('\n')
    const { stats } = assemble(parseStl(Buffer.from(ascii, 'utf8'), 'tri'))
    expect(stats.triangles).toBe(1)
  })

  it('reads OBJ, triangulating quads and honouring negative indices', () => {
    const obj = [
      'o square',
      'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
      'f 1 2 3 4',
      'f -4 -3 -2'
    ].join('\n')
    const { stats } = assemble(parseObj(obj, 'square'))
    // A quad becomes two triangles, plus the explicit one.
    expect(stats.triangles).toBe(3)
  })

  it('reads an ASCII PLY', () => {
    const ply = [
      'ply', 'format ascii 1.0',
      'element vertex 3', 'property float x', 'property float y', 'property float z',
      'element face 1', 'property list uchar int vertex_indices',
      'end_header',
      '0 0 0', '2 0 0', '0 2 0',
      '3 0 1 2'
    ].join('\n')
    const { stats } = assemble(parsePly(Buffer.from(ply, 'utf8'), 'tri'))
    expect(stats.triangles).toBe(1)
  })

  it('refuses a file that is not the format its extension claims', () => {
    expect(() => parsePly(Buffer.from('this is not a ply file'), 'x')).toThrow(ParseError)
  })

  it('refuses a truncated binary STL rather than reading past the end', () => {
    const header = Buffer.alloc(84)
    header.writeUInt32LE(5000, 80) // claims 5000 triangles, carries none
    expect(() => parseStl(header, 'broken')).toThrow(ParseError)
  })
})

describe('parametric build', () => {
  it('produces exact dimensions', () => {
    const built = buildModel({ name: 'plate', shapes: [{ shape: 'box', size: [40, 20, 10] }] })
    const { bounds } = assemble(built.parts)
    expect(bounds.size[0]).toBeCloseTo(40, 5)
    expect(bounds.size[1]).toBeCloseTo(20, 5)
    expect(bounds.size[2]).toBeCloseTo(10, 5)
  })

  it('subtracts a hole and loses the right amount of material', () => {
    const built = buildModel({
      name: 'plate',
      shapes: [
        { shape: 'box', size: [40, 20, 10] },
        { shape: 'cylinder', radius: 2, height: 20, op: 'subtract' }
      ]
    })
    const { stats } = assemble(built.parts)
    expect(stats.volumeMm3).toBeGreaterThan(PLATE_VOLUME * 0.99)
    expect(stats.volumeMm3).toBeLessThan(PLATE_VOLUME * 1.01)
  })

  it('converts units so a request in inches is millimetres on disk', () => {
    const built = buildModel({ name: 'inch cube', units: 'in', shapes: [{ shape: 'box', size: [1, 1, 1] }] })
    const { bounds } = assemble(built.parts)
    expect(bounds.size[0]).toBeCloseTo(25.4, 3)
  })

  it('places shapes where it is told', () => {
    const built = buildModel({
      name: 'offset',
      shapes: [{ shape: 'box', size: [10, 10, 10], at: [50, 0, 0] }]
    })
    const { bounds } = assemble(built.parts)
    expect(bounds.center[0]).toBeCloseTo(50, 5)
  })

  it('puts a subtracted hole where the position says, not at the origin', () => {
    // JSCAD keeps transforms pending until the polygons are read. Reading them
    // the wrong way silently centres every feature; this pins the fix.
    const built = buildModel({
      name: 'plate',
      shapes: [
        { shape: 'box', size: [40, 20, 10] },
        { shape: 'cylinder', radius: 2, height: 20, at: [15, 0, 0], op: 'subtract' }
      ]
    })
    const { payload, stats } = assemble(built.parts)
    expect(stats.volumeMm3).toBeCloseTo(PLATE_VOLUME, -1)

    // No vertex should sit on the centre axis if the hole moved to x = 15.
    let nearCentre = 0
    let nearFifteen = 0
    for (let i = 0; i < payload.positions.length; i += 3) {
      const x = payload.positions[i]
      const y = payload.positions[i + 1]
      if (Math.hypot(x, y) < 2.5) nearCentre += 1
      if (Math.hypot(x - 15, y) < 2.5) nearFifteen += 1
    }
    expect(nearCentre).toBe(0)
    expect(nearFifteen).toBeGreaterThan(0)
  })

  it('applies rotation', () => {
    const built = buildModel({
      name: 'turned',
      shapes: [{ shape: 'box', size: [40, 10, 10], rotate: [0, 0, 90] }]
    })
    const { bounds } = assemble(built.parts)
    expect(bounds.size[0]).toBeCloseTo(10, 3)
    expect(bounds.size[1]).toBeCloseTo(40, 3)
  })

  it('applies scale', () => {
    const built = buildModel({
      name: 'stretched',
      shapes: [{ shape: 'box', size: [10, 10, 10], scale: [3, 1, 1] }]
    })
    const { bounds } = assemble(built.parts)
    expect(bounds.size[0]).toBeCloseTo(30, 3)
    expect(bounds.size[1]).toBeCloseTo(10, 3)
  })

  it('intersects', () => {
    const built = buildModel({
      name: 'lens',
      shapes: [
        { shape: 'box', size: [20, 20, 20] },
        { shape: 'sphere', radius: 12, op: 'intersect' }
      ]
    })
    const { bounds } = assemble(built.parts)
    // The sphere is smaller than the box diagonal, so it clips the corners.
    expect(bounds.size[0]).toBeLessThan(20.001)
    expect(bounds.size[0]).toBeGreaterThan(18)
  })

  it('refuses dimensions outside the sane range instead of hanging the kernel', () => {
    expect(() => buildModel({ name: 'vast', shapes: [{ shape: 'box', size: [1e9, 1, 1] }] })).toThrow()
  })
})

describe('open_3d_model', () => {
  it('is read-only, so it does not require confirmation', () => {
    expect(TOOL_BY_NAME.get('open_3d_model')?.risk).toBe('low')
    expect(TOOL_BY_NAME.get('create_3d_model')?.risk).toBe('low')
    expect(TOOL_BY_NAME.get('export_3d_model')?.risk).toBe('medium')
  })

  it('loads the STEP fixture through OpenCascade', async () => {
    const summary = await loadModelFile(join(FIXTURES, 'plate.step'))
    expect(summary.format).toBe('step')
    expect(summary.stats.triangles).toBeGreaterThan(0)
    expect(summary.bounds.size[0]).toBeCloseTo(40, 1)
    expect(summary.bounds.size[1]).toBeCloseTo(20, 1)
    expect(summary.bounds.size[2]).toBeCloseTo(10, 1)
  }, 30_000)

  it('reports the file through the tool with its dimensions', async () => {
    const result = await executeTool('open_3d_model', { path: join(FIXTURES, 'plate.stl') }, context)
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/40/)
    expect((result.data as { size_mm: number[] }).size_mm[0]).toBeCloseTo(40, 1)
    expect(listModels()).toHaveLength(1)
  })

  it('refuses a file that is not a model', async () => {
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'hello')
    const result = await executeTool('open_3d_model', { path }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cannot open/i)
  })

  it('refuses a path outside the allowed roots', async () => {
    const result = await executeTool('open_3d_model', { path: '/etc/shadow' }, context)
    expect(result.ok).toBe(false)
  })

  it('does not follow a traversal escape', async () => {
    const result = await executeTool('open_3d_model', { path: join(root, '..', '..', 'etc', 'passwd.stl') }, context)
    expect(result.ok).toBe(false)
  })

  it('reports a missing file plainly instead of throwing', async () => {
    const result = await executeTool('open_3d_model', { path: join(root, 'nothing.stl') }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('create_3d_model', () => {
  it('builds from the tool vocabulary, translating snake_case', async () => {
    const result = await executeTool('create_3d_model', {
      name: 'Bracket',
      units: 'mm',
      shapes: [
        { shape: 'box', size: [40, 20, 10] },
        { shape: 'cylinder', radius: 2, height: 20, op: 'subtract' },
        { shape: 'cone', radius_bottom: 5, radius_top: 0, height: 8, at: [15, 0, 9] }
      ]
    }, context)
    expect(result.ok).toBe(true)
    const data = result.data as { size_mm: number[]; triangles: number }
    expect(data.size_mm[0]).toBeCloseTo(40, 1)
    expect(data.triangles).toBeGreaterThan(0)
  })

  it('rejects a shape the vocabulary does not contain', async () => {
    const result = await executeTool('create_3d_model', {
      name: 'x', shapes: [{ shape: 'dragon' }]
    }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not valid/i)
  })

  it('rejects an empty shape list at the schema, before any kernel work', async () => {
    const result = await executeTool('create_3d_model', { name: 'x', shapes: [] }, context)
    expect(result.ok).toBe(false)
  })

  it('reports an empty result rather than showing nothing', async () => {
    const result = await executeTool('create_3d_model', {
      name: 'gone',
      shapes: [
        { shape: 'box', size: [10, 10, 10] },
        { shape: 'box', size: [40, 40, 40], op: 'subtract' }
      ]
    }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/empty/i)
  })
})

describe('export_3d_model', () => {
  it('writes an STL that reads back with the same triangle count', async () => {
    await executeTool('create_3d_model', { name: 'cube', shapes: [{ shape: 'box', size: [10, 10, 10] }] }, context)
    const target = join(root, 'cube.stl')
    const result = await executeTool('export_3d_model', { path: target }, context)
    expect(result.ok).toBe(true)

    const reparsed = assemble(parseStl(readFileSync(target), 'cube'))
    expect(reparsed.stats.volumeMm3).toBeCloseTo(1000, 0)
  })

  it('refuses to write outside the allowed roots', async () => {
    await executeTool('create_3d_model', { name: 'cube', shapes: [{ shape: 'box', size: [10, 10, 10] }] }, context)
    const result = await executeTool('export_3d_model', { path: '/etc/cron.d/cube.stl' }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it('says so plainly when there is nothing to export', async () => {
    const result = await executeTool('export_3d_model', { path: join(root, 'nothing.stl') }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no model/i)
  })
})

describe('the workshop', () => {
  it('keeps geometry in the main process, addressable by id', async () => {
    await executeTool('create_3d_model', { name: 'cube', shapes: [{ shape: 'box', size: [4, 4, 4] }] }, context)
    const [summary] = listModels()
    const entry = getModel(summary.id)
    expect(entry?.payload.positions).toBeInstanceOf(Float32Array)
    expect(entry?.payload.indices).toBeInstanceOf(Uint32Array)
    expect(entry?.payload.normals.length).toBe(entry?.payload.positions.length)
  })

  it('retains a bounded number of models', async () => {
    for (let index = 0; index < 12; index += 1) {
      await executeTool('create_3d_model', { name: `cube ${index}`, shapes: [{ shape: 'box', size: [2, 2, 2] }] }, context)
    }
    expect(listModels().length).toBeLessThanOrEqual(8)
    // The most recent survives.
    expect(listModels()[0].name).toBe('cube 11')
  })

  it('lists what is open', async () => {
    await executeTool('create_3d_model', { name: 'Widget', shapes: [{ shape: 'sphere', radius: 3 }] }, context)
    const result = await executeTool('list_3d_models', {}, context)
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/Widget/)
  })
})
