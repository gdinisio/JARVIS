import { describe, it, expect } from 'vitest'
// @ts-expect-error - build-time script, run by plain node, so it has no types
import { classifyFailure, riskyLocation } from '../scripts/lib/electron-diagnosis.mjs'

/**
 * The first version of this guard told everyone their download was blocked,
 * including a user whose real problem was Windows refusing to write the file.
 * Wrong advice is worse than no advice, so the classifier is pinned here.
 */

const HOME = 'C:\\Users\\Giovanni'

describe('classifyFailure', () => {
  it('recognises the Windows permission failure verbatim', () => {
    const real =
      "Error: failed to create '\\\\?\\C:\\Users\\Giovanni\\Documents\\JARVIS\\node_modules\\electron\\dist\\electron.exe': Access is denied. (os error 5)"
    expect(classifyFailure(real)).toBe('permission')
  })

  it.each([
    'EPERM: operation not permitted, open',
    'EACCES: permission denied',
    'EBUSY: resource busy or locked',
    'The process cannot access the file because it is being used by another process'
  ])('recognises %s as a permission problem', (output) => {
    expect(classifyFailure(output)).toBe('permission')
  })

  it.each([
    'getaddrinfo ENOTFOUND github.com',
    'connect ETIMEDOUT 140.82.121.4:443',
    'unable to verify the first certificate',
    'self signed certificate in certificate chain',
    'tunneling socket could not be established, statusCode=403',
    'socket hang up'
  ])('recognises %s as a network problem', (output) => {
    expect(classifyFailure(output)).toBe('network')
  })

  it('reports both when the output contains each kind', () => {
    expect(classifyFailure('ETIMEDOUT while fetching\nthen EPERM on write')).toBe('both')
  })

  it('does not guess when the output says neither', () => {
    expect(classifyFailure('')).toBe('unknown')
    expect(classifyFailure('Downloading electron-v44.3.0-win32-x64.zip')).toBe('unknown')
    expect(classifyFailure(undefined)).toBe('unknown')
  })
})

describe('riskyLocation', () => {
  it('names the Documents folder, which Controlled Folder Access protects', () => {
    expect(riskyLocation('C:\\Users\\Giovanni\\Documents\\JARVIS', HOME, 'win32')).toBe('your Documents folder')
  })

  it.each(['Desktop', 'Pictures'])('names the %s folder too', (folder) => {
    expect(riskyLocation(`C:\\Users\\Giovanni\\${folder}\\JARVIS`, HOME, 'win32')).toBe(`your ${folder} folder`)
  })

  it('spots a OneDrive-synced path anywhere in the tree', () => {
    expect(riskyLocation('C:\\Users\\Giovanni\\OneDrive\\code\\JARVIS', HOME, 'win32')).toBe('OneDrive')
  })

  it('is quiet about an ordinary location', () => {
    expect(riskyLocation('C:\\dev\\JARVIS', HOME, 'win32')).toBeNull()
    expect(riskyLocation('D:\\projects\\JARVIS', HOME, 'win32')).toBeNull()
  })

  it('does not match a sibling folder by prefix', () => {
    expect(riskyLocation('C:\\Users\\Giovanni\\Documents-backup\\JARVIS', HOME, 'win32')).toBeNull()
  })

  it('says nothing on platforms without these features', () => {
    expect(riskyLocation('/home/g/Documents/JARVIS', '/home/g', 'linux')).toBeNull()
    expect(riskyLocation('/Users/g/Documents/JARVIS', '/Users/g', 'darwin')).toBeNull()
  })
})
