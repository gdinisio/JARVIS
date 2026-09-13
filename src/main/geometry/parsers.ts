import { inflateRawSync } from 'node:zlib'
import type { RawPart } from './mesh'
import { ParseError } from './errors'

export { ParseError }

/**
 * Mesh format parsers.
 *
 * Written directly rather than pulled from a loader library because these run
 * in the main process, where a parser is also an attack surface: every one
 * here reads only what it declares, bounds every loop by the buffer length,
 * and refuses a file that claims more geometry than it contains.
 */

const MAX_TRIANGLES = 8_000_000



/* ─────────────────────────────────── STL ────────────────────────────────── */

/**
 * Binary STL is 80 bytes of header, a triangle count, then 50 bytes each.
 * ASCII STL is keywords. Sniffing the header is unreliable — plenty of binary
 * files start with "solid" — so the length is the real test.
 */
export function parseStl(buffer: Buffer, name: string): RawPart[] {
  if (buffer.length >= 84) {
    const declared = buffer.readUInt32LE(80)
    if (buffer.length === 84 + declared * 50) return [parseBinaryStl(buffer, declared, name)]
  }
  const text = buffer.toString('utf8', 0, Math.min(buffer.length, 2048))
  if (/^\s*solid/i.test(text) && /facet\s+normal/i.test(buffer.toString('utf8'))) {
    return [parseAsciiStl(buffer.toString('utf8'), name)]
  }
  if (buffer.length >= 84) {
    // Some exporters write a wrong length; trust the count but clamp it.
    const declared = Math.min(buffer.readUInt32LE(80), Math.floor((buffer.length - 84) / 50))
    if (declared > 0) return [parseBinaryStl(buffer, declared, name)]
  }
  throw new ParseError('That does not look like an STL file.')
}

function parseBinaryStl(buffer: Buffer, count: number, name: string): RawPart {
  if (count > MAX_TRIANGLES) throw new ParseError(`That STL has ${count} triangles, which is too many to display.`)
  const positions = new Array<number>(count * 9)
  const normals = new Array<number>(count * 9)

  for (let i = 0; i < count; i++) {
    const offset = 84 + i * 50
    const nx = buffer.readFloatLE(offset)
    const ny = buffer.readFloatLE(offset + 4)
    const nz = buffer.readFloatLE(offset + 8)
    for (let vertex = 0; vertex < 3; vertex++) {
      const at = offset + 12 + vertex * 12
      const base = i * 9 + vertex * 3
      positions[base] = buffer.readFloatLE(at)
      positions[base + 1] = buffer.readFloatLE(at + 4)
      positions[base + 2] = buffer.readFloatLE(at + 8)
      normals[base] = nx
      normals[base + 1] = ny
      normals[base + 2] = nz
    }
  }
  return { name, positions, normals }
}

function parseAsciiStl(text: string, name: string): RawPart {
  const positions: number[] = []
  const normals: number[] = []
  let normal: [number, number, number] = [0, 0, 0]

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('facet normal')) {
      const parts = trimmed.split(/\s+/)
      normal = [Number(parts[2]) || 0, Number(parts[3]) || 0, Number(parts[4]) || 0]
    } else if (trimmed.startsWith('vertex')) {
      const parts = trimmed.split(/\s+/)
      positions.push(Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0)
      normals.push(...normal)
    }
  }
  if (!positions.length) throw new ParseError('That STL file contains no triangles.')
  return { name, positions, normals }
}

/* ─────────────────────────────────── OBJ ────────────────────────────────── */

export function parseObj(text: string, name: string): RawPart[] {
  const vertices: number[] = []
  const vertexNormals: number[] = []
  const parts: RawPart[] = []
  let current: RawPart = { name, positions: [], normals: [] }

  const pushFace = (tokens: string[]) => {
    // A face is a polygon; fan-triangulate it.
    const corners = tokens.map((token) => {
      const [v, , n] = token.split('/')
      return { v: Number(v), n: n ? Number(n) : 0 }
    })
    for (let i = 1; i + 1 < corners.length; i++) {
      for (const corner of [corners[0], corners[i], corners[i + 1]]) {
        const vi = (corner.v > 0 ? corner.v - 1 : vertices.length / 3 + corner.v) * 3
        if (vi < 0 || vi + 2 >= vertices.length) continue
        current.positions.push(vertices[vi], vertices[vi + 1], vertices[vi + 2])
        if (corner.n && vertexNormals.length) {
          const ni = (corner.n > 0 ? corner.n - 1 : vertexNormals.length / 3 + corner.n) * 3
          if (ni >= 0 && ni + 2 < vertexNormals.length) {
            current.normals!.push(vertexNormals[ni], vertexNormals[ni + 1], vertexNormals[ni + 2])
          }
        }
      }
    }
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const tokens = trimmed.split(/\s+/)
    switch (tokens[0]) {
      case 'v':
        vertices.push(Number(tokens[1]) || 0, Number(tokens[2]) || 0, Number(tokens[3]) || 0)
        break
      case 'vn':
        vertexNormals.push(Number(tokens[1]) || 0, Number(tokens[2]) || 0, Number(tokens[3]) || 0)
        break
      case 'f':
        pushFace(tokens.slice(1))
        break
      case 'o':
      case 'g':
        if (current.positions.length) parts.push(current)
        current = { name: tokens.slice(1).join(' ') || name, positions: [], normals: [] }
        break
    }
  }
  if (current.positions.length) parts.push(current)
  if (!parts.length) throw new ParseError('That OBJ file contains no faces.')

  // Normals are only usable when there is one per vertex.
  for (const part of parts) {
    if (part.normals?.length !== part.positions.length) delete part.normals
  }
  return parts
}

/* ─────────────────────────────────── PLY ────────────────────────────────── */

export function parsePly(buffer: Buffer, name: string): RawPart[] {
  const headerEnd = buffer.indexOf('end_header')
  if (headerEnd < 0) throw new ParseError('That PLY file has no header.')
  const headerText = buffer.toString('utf8', 0, headerEnd)
  const afterHeader = buffer.indexOf('\n', headerEnd) + 1

  const binary = /format\s+binary_little_endian/i.test(headerText)
  if (!binary && !/format\s+ascii/i.test(headerText)) {
    throw new ParseError('Only ASCII and little-endian binary PLY files are supported.')
  }

  const vertexCount = Number(/element\s+vertex\s+(\d+)/i.exec(headerText)?.[1] ?? 0)
  const faceCount = Number(/element\s+face\s+(\d+)/i.exec(headerText)?.[1] ?? 0)
  if (!vertexCount) throw new ParseError('That PLY file declares no vertices.')

  const vertices: number[] = []
  const indices: number[] = []

  if (!binary) {
    const lines = buffer.toString('utf8', afterHeader).split('\n')
    let cursor = 0
    for (let i = 0; i < vertexCount && cursor < lines.length; i++, cursor++) {
      const tokens = lines[cursor].trim().split(/\s+/)
      vertices.push(Number(tokens[0]) || 0, Number(tokens[1]) || 0, Number(tokens[2]) || 0)
    }
    for (let i = 0; i < faceCount && cursor < lines.length; i++, cursor++) {
      const tokens = lines[cursor].trim().split(/\s+/).map(Number)
      const count = tokens[0]
      for (let corner = 1; corner + 1 < count; corner++) {
        indices.push(tokens[1], tokens[corner + 1], tokens[corner + 2])
      }
    }
  } else {
    // Properties before x/y/z would shift the stride; only the common
    // float x,y,z layout is handled, and anything else is refused.
    const properties = [...headerText.matchAll(/property\s+(\w+)\s+(\w+)/gi)]
    const first = properties.slice(0, 3).map((match) => match[2].toLowerCase())
    if (first.join(',') !== 'x,y,z') {
      throw new ParseError('That binary PLY has an unsupported vertex layout.')
    }
    const stride = properties.filter((match) => !/list/i.test(match[1])).length * 4
    let offset = afterHeader
    for (let i = 0; i < vertexCount; i++) {
      if (offset + 12 > buffer.length) throw new ParseError('That PLY file ended early.')
      vertices.push(buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8))
      offset += stride
    }
    for (let i = 0; i < faceCount; i++) {
      if (offset >= buffer.length) break
      const count = buffer.readUInt8(offset)
      offset += 1
      const corners: number[] = []
      for (let corner = 0; corner < count; corner++) {
        if (offset + 4 > buffer.length) throw new ParseError('That PLY file ended early.')
        corners.push(buffer.readUInt32LE(offset))
        offset += 4
      }
      for (let corner = 1; corner + 1 < corners.length; corner++) {
        indices.push(corners[0], corners[corner], corners[corner + 1])
      }
    }
  }

  if (!indices.length) throw new ParseError('That PLY file contains no faces.')
  return [{ name, positions: vertices, indices }]
}

/* ─────────────────────────────────── 3MF ────────────────────────────────── */

/**
 * 3MF is a zip holding an XML model. Only the central directory is walked,
 * and only the one entry that matters is inflated.
 */
export function parse3mf(buffer: Buffer, name: string): RawPart[] {
  const xml = readZipEntry(buffer, /3dmodel\.model$/i)
  if (!xml) throw new ParseError('That 3MF file contains no model.')

  const text = xml.toString('utf8')
  const parts: RawPart[] = []

  for (const objectMatch of text.matchAll(/<object\b[^>]*>([\s\S]*?)<\/object>/gi)) {
    const body = objectMatch[1]
    const objectName = /name="([^"]*)"/i.exec(objectMatch[0])?.[1] || name

    const positions: number[] = []
    const vertices: number[] = []
    for (const vertex of body.matchAll(/<vertex\b[^>]*x="([-\d.eE+]+)"[^>]*y="([-\d.eE+]+)"[^>]*z="([-\d.eE+]+)"[^>]*\/>/gi)) {
      vertices.push(Number(vertex[1]), Number(vertex[2]), Number(vertex[3]))
    }
    for (const triangle of body.matchAll(/<triangle\b[^>]*v1="(\d+)"[^>]*v2="(\d+)"[^>]*v3="(\d+)"[^>]*\/>/gi)) {
      for (const corner of [triangle[1], triangle[2], triangle[3]]) {
        const index = Number(corner) * 3
        if (index + 2 >= vertices.length) continue
        positions.push(vertices[index], vertices[index + 1], vertices[index + 2])
      }
    }
    if (positions.length) parts.push({ name: objectName, positions })
  }

  if (!parts.length) throw new ParseError('That 3MF file contains no triangles.')
  return parts
}

/** Minimal zip reader: finds one entry by name and inflates it. */
function readZipEntry(buffer: Buffer, match: RegExp): Buffer | null {
  // Locate the end-of-central-directory record, searching back from the end.
  const limit = Math.max(0, buffer.length - 66_000)
  let eocd = -1
  for (let i = buffer.length - 22; i >= limit; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ParseError('That file is not a valid zip archive.')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  for (let i = 0; i < entryCount && offset + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const entryName = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    if (match.test(entryName)) {
      if (localOffset + 30 > buffer.length) throw new ParseError('That archive is truncated.')
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const data = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data)
      throw new ParseError('That archive uses an unsupported compression method.')
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return null
}
