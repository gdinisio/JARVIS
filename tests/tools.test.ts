import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTool } from '../src/main/tools/registry'
import { TOOL_DESCRIPTORS, TOOL_BY_NAME } from '../src/main/tools/descriptors'
import { defaultSettings } from '../src/shared/defaults'
import type { ToolContext } from '../src/main/tools/context'

let root: string
let context: ToolContext

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-tools-'))
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

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('tool catalogue', () => {
  it('publishes a schema for every tool', () => {
    for (const tool of TOOL_DESCRIPTORS) {
      expect(tool.parameters.type, tool.name).toBe('object')
      expect(tool.description.length, tool.name).toBeGreaterThan(20)
      expect(['low', 'medium', 'high'], tool.name).toContain(tool.risk)
    }
  })

  it('classifies destructive tools as high risk', () => {
    for (const name of ['delete_file', 'execute_command', 'restart_computer', 'shutdown_computer']) {
      expect(TOOL_BY_NAME.get(name)?.risk, name).toBe('high')
    }
  })

  it('classifies read-only tools as low risk', () => {
    for (const name of ['get_system_stats', 'search_files', 'list_applications', 'get_running_processes']) {
      expect(TOOL_BY_NAME.get(name)?.risk, name).toBe('low')
    }
  })

  it('has a unique name per tool', () => {
    const names = TOOL_DESCRIPTORS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('argument validation', () => {
  it('refuses a tool that does not exist', async () => {
    const result = await executeTool('definitely_not_a_tool', {}, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it('refuses arguments that do not match the schema', async () => {
    const missing = await executeTool('open_application', {}, context)
    expect(missing.ok).toBe(false)

    const wrongType = await executeTool('set_volume', { level: 'loud' }, context)
    expect(wrongType.ok).toBe(false)

    const outOfRange = await executeTool('set_volume', { level: 5000 }, context)
    expect(outOfRange.ok).toBe(false)
  })

  it('refuses an oversized batch of deletions', async () => {
    const result = await executeTool('delete_file', { paths: new Array(900).fill('~/x') }, context)
    expect(result.ok).toBe(false)
  })

  it('reports which argument was wrong', async () => {
    const result = await executeTool('create_folder', { path: '' }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/path/i)
  })
})

describe('filesystem tools', () => {
  it('creates, reads, copies, renames and moves files', async () => {
    const created = await executeTool('create_folder', { path: join(root, 'work') }, context)
    expect(created.ok).toBe(true)
    expect(existsSync(join(root, 'work'))).toBe(true)

    const file = await executeTool(
      'create_file',
      { path: join(root, 'work', 'notes.txt'), content: 'hello jarvis' },
      context
    )
    expect(file.ok).toBe(true)

    const read = await executeTool('read_text_file', { path: join(root, 'work', 'notes.txt') }, context)
    expect(read.ok).toBe(true)
    expect((read.data as { content: string }).content).toBe('hello jarvis')

    const copied = await executeTool(
      'copy_file',
      { source: join(root, 'work', 'notes.txt'), destination: join(root, 'work', 'copy.txt') },
      context
    )
    expect(copied.ok).toBe(true)

    const renamed = await executeTool(
      'rename_file',
      { path: join(root, 'work', 'copy.txt'), new_name: 'renamed.txt' },
      context
    )
    expect(renamed.ok).toBe(true)
    expect(existsSync(join(root, 'work', 'renamed.txt'))).toBe(true)

    mkdirSync(join(root, 'archive'), { recursive: true })
    const moved = await executeTool(
      'move_file',
      { source: join(root, 'work', 'renamed.txt'), destination: join(root, 'archive') },
      context
    )
    expect(moved.ok).toBe(true)
    expect(existsSync(join(root, 'archive', 'renamed.txt'))).toBe(true)
  })

  it('will not overwrite an existing file unless asked', async () => {
    writeFileSync(join(root, 'existing.txt'), 'original')
    const blocked = await executeTool('create_file', { path: join(root, 'existing.txt'), content: 'new' }, context)
    expect(blocked.ok).toBe(false)

    const forced = await executeTool(
      'create_file',
      { path: join(root, 'existing.txt'), content: 'new', overwrite: true },
      context
    )
    expect(forced.ok).toBe(true)
  })

  it('refuses a rename that contains a directory component', async () => {
    writeFileSync(join(root, 'target.txt'), 'x')
    const result = await executeTool(
      'rename_file',
      { path: join(root, 'target.txt'), new_name: '../escaped.txt' },
      context
    )
    expect(result.ok).toBe(false)
  })

  it('blocks writes outside the allowed roots', async () => {
    const result = await executeTool('create_folder', { path: '/etc/jarvis-should-not-exist' }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(existsSync('/etc/jarvis-should-not-exist')).toBe(false)
  })

  it('blocks traversal in every path argument', async () => {
    const move = await executeTool(
      'move_file',
      { source: join(root, 'existing.txt'), destination: '../../../../etc/passwd' },
      context
    )
    expect(move.ok).toBe(false)
    expect(move.blocked).toBe(true)
  })

  it('refuses to read a binary file as text', async () => {
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = await executeTool('read_text_file', { path: join(root, 'image.png') }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/binary/i)
  })

  it('searches by extension and reports what it found', async () => {
    const result = await executeTool('search_files', { folder: root, extensions: ['txt'], limit: 10 }, context)
    expect(result.ok).toBe(true)
    expect((result.data as { count: number }).count).toBeGreaterThan(0)
  })

  it('reports a missing folder instead of throwing', async () => {
    const result = await executeTool('search_files', { folder: join(root, 'nope'), limit: 5 }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not find/i)
  })

  it('refuses to delete a protected location and leaves it alone', async () => {
    const result = await executeTool('delete_file', { paths: ['/etc'] }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(existsSync('/etc')).toBe(true)
  })

  it('refuses the whole batch when one path is invalid', async () => {
    const good = join(root, 'keep-me.txt')
    writeFileSync(good, 'keep')
    const result = await executeTool('delete_file', { paths: [good, '/etc/passwd'], permanent: true }, context)
    expect(result.ok).toBe(false)
    expect(existsSync(good)).toBe(true)
  })

  it('deletes permanently when explicitly asked', async () => {
    const doomed = join(root, 'doomed.txt')
    writeFileSync(doomed, 'bye')
    const result = await executeTool('delete_file', { paths: [doomed], permanent: true }, context)
    expect(result.ok).toBe(true)
    expect(existsSync(doomed)).toBe(false)
  })
})

describe('batch file moves', () => {
  it('moves several files into one folder in a single call', async () => {
    const source = join(root, 'batch')
    mkdirSync(source, { recursive: true })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(source, name), name)

    const result = await executeTool(
      'move_files',
      { sources: ['a.txt', 'b.txt', 'c.txt'].map((name) => join(source, name)), destination: join(root, 'batch-archive') },
      context
    )
    expect(result.ok).toBe(true)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      expect(existsSync(join(root, 'batch-archive', name)), name).toBe(true)
    }
  })

  it('creates the destination folder if it is missing', async () => {
    const file = join(root, 'lonely.txt')
    writeFileSync(file, 'x')
    const result = await executeTool('move_files', { sources: [file], destination: join(root, 'made/up/path') }, context)
    expect(result.ok).toBe(true)
    expect(existsSync(join(root, 'made/up/path/lonely.txt'))).toBe(true)
  })

  it('refuses the whole batch when any path is out of bounds, moving nothing', async () => {
    const keeper = join(root, 'keeper.txt')
    writeFileSync(keeper, 'keep')
    const result = await executeTool(
      'move_files',
      { sources: [keeper, '/etc/passwd'], destination: join(root, 'nope') },
      context
    )
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(existsSync(keeper)).toBe(true)
    expect(existsSync(join(root, 'nope'))).toBe(false)
  })

  it('refuses a destination outside the allowed roots', async () => {
    const file = join(root, 'stay.txt')
    writeFileSync(file, 'x')
    const result = await executeTool('move_files', { sources: [file], destination: '/etc/jarvis' }, context)
    expect(result.ok).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('reports per-file failures without abandoning the rest', async () => {
    const real = join(root, 'real.txt')
    writeFileSync(real, 'x')
    const result = await executeTool(
      'move_files',
      { sources: [real, join(root, 'ghost.txt')], destination: join(root, 'partial') },
      context
    )
    expect(result.ok).toBe(true)
    expect((result.data as { failed: unknown[] }).failed).toHaveLength(1)
    expect(existsSync(join(root, 'partial/real.txt'))).toBe(true)
  })
})

describe('storage analysis', () => {
  it('finds the largest files and breaks usage down by folder', async () => {
    const big = join(root, 'storage')
    mkdirSync(join(big, 'videos'), { recursive: true })
    mkdirSync(join(big, 'notes'), { recursive: true })
    writeFileSync(join(big, 'videos', 'clip.bin'), Buffer.alloc(400 * 1024))
    writeFileSync(join(big, 'notes', 'small.txt'), 'tiny')

    const result = await executeTool('find_large_files', { folder: big, minimum_mb: 0, limit: 5 }, context)
    expect(result.ok).toBe(true)
    const data = result.data as { files: Array<{ name: string }>; largestFolders: Array<{ folder: string }> }
    expect(data.files[0].name).toBe('clip.bin')
    expect(data.largestFolders[0].folder).toBe('videos')
  })

  it('says so plainly when nothing meets the threshold', async () => {
    const result = await executeTool('find_large_files', { folder: join(root, 'storage'), minimum_mb: 500 }, context)
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/holds/i)
  })

  it('measures a folder', async () => {
    const result = await executeTool('get_folder_size', { path: join(root, 'storage') }, context)
    expect(result.ok).toBe(true)
    expect((result.data as { sizeBytes: number }).sizeBytes).toBeGreaterThan(300 * 1024)
  })

  it('will not measure a protected location', async () => {
    const result = await executeTool('find_large_files', { folder: '/etc' }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })
})

describe('terminal tool', () => {
  it('refuses a command that is not on the allow-list', async () => {
    const result = await executeTool('execute_command', { command: 'curl', args: ['https://example.com'] }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it('refuses shell interpreters', async () => {
    const result = await executeTool('execute_command', { command: 'sh', args: ['-c', 'echo pwned'] }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it('refuses a command carrying shell syntax', async () => {
    const result = await executeTool('execute_command', { command: 'echo; rm -rf /', args: [] }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it('runs an approved command and returns its output', async () => {
    if (process.platform === 'win32') return
    const result = await executeTool('execute_command', { command: 'echo', args: ['hello'] }, context)
    expect(result.ok).toBe(true)
    expect((result.data as { stdout: string }).stdout).toContain('hello')
  })

  it('passes metacharacters through as literal arguments', async () => {
    if (process.platform === 'win32') return
    const result = await executeTool('execute_command', { command: 'echo', args: ['a; touch /tmp/jarvis-pwned'] }, context)
    expect(result.ok).toBe(true)
    expect((result.data as { stdout: string }).stdout).toContain('a; touch')
    expect(existsSync('/tmp/jarvis-pwned')).toBe(false)
  })

  it('refuses a working directory outside the allowed roots', async () => {
    const result = await executeTool('execute_command', { command: 'echo', args: ['x'], cwd: '/etc' }, context)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })
})

describe('web tools', () => {
  it('blocks dangerous URL schemes before touching the platform', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>']) {
      const result = await executeTool('open_url', { url }, context)
      expect(result.ok, url).toBe(false)
      expect(result.blocked, url).toBe(true)
    }
  })
})
