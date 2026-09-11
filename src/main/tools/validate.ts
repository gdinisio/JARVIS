import { win32, posix, basename as nativeBasename, type PlatformPath } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/**
 * Validation primitives for everything the model can reach.
 *
 * Pure functions with no I/O and no Electron dependency, so the rules that
 * keep JARVIS safe are directly unit-testable.
 */

export interface PathPolicy {
  /** Directories that are never writable, may contain `~` or `%VAR%`. */
  protectedPaths: string[]
  /** Extra roots the user has opted into beyond their home directory. */
  workspaceRoots: string[]
  home?: string
  platform?: NodeJS.Platform
  /** Allow reads outside the allowed roots (still never inside protected ones). */
  allowReadAnywhere?: boolean
}

export type PathFailureCode = 'invalid' | 'traversal' | 'protected' | 'outside'

export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; code: PathFailureCode; reason: string }

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Path rules are evaluated with the semantics of the *target* platform, not
 * the host. Without this, a Windows path checked on any other system parses
 * as a single relative filename and every rule silently passes.
 */
function pathFor(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/
const NUL = '\u0000'

/** Expands `~` and `%VAR%` / `$VAR` references using the supplied environment. */
export function expandPath(
  input: string,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const path = pathFor(platform)
  let value = input.trim()
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) value = path.resolve(home, value.slice(2))
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === String(name).toLowerCase())
    return key && env[key] ? env[key]! : match
  })
  value = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, name: string) => env[name] ?? match)
  return value
}

/** True when `child` is `parent` or lives underneath it (segment-aware). */
export function isInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = pathFor(platform)
  const normalise = (value: string) => {
    const unified = platform === 'win32' ? value.replace(/\//g, '\\').toLowerCase() : value
    return path.normalize(unified).replace(/[\\/]+$/, '') || path.sep
  }
  const a = normalise(parent)
  const b = normalise(child)
  if (a === b) return true
  const rel = path.relative(a, b)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Resolves and authorises a filesystem path.
 *
 * A path is rejected when it is malformed, escapes the allowed roots via
 * `..`, or lands inside a protected system directory. Model-supplied paths
 * are never used before passing through here.
 */
export function validatePath(input: unknown, policy: PathPolicy, mode: 'read' | 'write' = 'write'): PathCheck {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, code: 'invalid', reason: 'A file path is required.' }
  }
  if (CONTROL_CHARS.test(input)) {
    return { ok: false, code: 'invalid', reason: 'That path contains an illegal character.' }
  }

  const platform = policy.platform ?? process.platform
  const path = pathFor(platform)
  const home = policy.home ?? homedir()
  const expanded = expandPath(input, home, process.env, platform)

  if (platform === 'win32' && WINDOWS_DEVICE_NAMES.test(path.basename(expanded.replace(/\//g, '\\')))) {
    return { ok: false, code: 'invalid', reason: 'That name is reserved by Windows.' }
  }
  // UNC and device paths bypass normal drive semantics - refuse them outright.
  if (platform === 'win32' && /^(\\\\|\/\/)/.test(expanded.trim())) {
    return { ok: false, code: 'invalid', reason: 'Network and device paths are not supported.' }
  }

  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(home, expanded)

  const protectedRoots = policy.protectedPaths.map((entry) => expandPath(entry, home, process.env, platform))
  for (const root of protectedRoots) {
    if (isInside(root, absolute, platform)) {
      return { ok: false, code: 'protected', reason: `${absolute} is inside a protected system location.` }
    }
  }

  const allowedRoots = [home, tmpdir(), ...policy.workspaceRoots.map((entry) => expandPath(entry, home, process.env, platform))]
  const inAllowed = allowedRoots.some((root) => isInside(root, absolute, platform))

  if (!inAllowed) {
    if (mode === 'read' && policy.allowReadAnywhere) return { ok: true, path: absolute }
    const escaped = /(^|[\\/])\.\.([\\/]|$)/.test(input)
    return {
      ok: false,
      code: escaped ? 'traversal' : 'outside',
      reason: escaped
        ? 'That path escapes the folders JARVIS is allowed to touch.'
        : `${absolute} is outside the folders JARVIS is allowed to touch.`
    }
  }

  return { ok: true, path: absolute }
}

/* URLs */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string }

/** Only web links. `javascript:`, `file:` and `data:` are refused. */
export function validateUrl(input: unknown): UrlCheck {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'A URL is required.' }
  const raw = input.trim()
  if (CONTROL_CHARS.test(raw)) return { ok: false, reason: 'That URL contains control characters.' }

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' }
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `Links using ${parsed.protocol} are not allowed.` }
  }
  if (parsed.protocol !== 'mailto:' && !parsed.hostname) {
    return { ok: false, reason: 'That URL has no host.' }
  }
  return { ok: true, url: parsed.toString() }
}

/* Commands */

export interface CommandPolicy {
  allowedCommands: string[]
  /** When false, only allow-listed programs may run. */
  allowShell: boolean
}

export type CommandCheck =
  | { ok: true; file: string; args: string[]; allowListed: boolean }
  | { ok: false; reason: string }

/** Characters that only matter to a shell - their presence means someone is reaching for one. */
const SHELL_METACHARACTERS = /[;&|`$><(){}\[\]!*?~\n\r]/

const SHELL_INTERPRETERS = ['bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'osascript']

/**
 * Validates a command for the terminal tool.
 *
 * JARVIS never spawns a shell, so arguments cannot be re-parsed into new
 * commands. This check exists so that an attempt to do so is *visible*:
 * anything carrying shell syntax in the program name is refused outright,
 * and the program itself must be on the allow-list unless the user has
 * explicitly enabled unrestricted commands.
 */
export function validateCommand(command: unknown, rawArgs: unknown, policy: CommandPolicy): CommandCheck {
  if (typeof command !== 'string' || !command.trim()) return { ok: false, reason: 'A command is required.' }
  const file = command.trim()

  if (CONTROL_CHARS.test(file)) return { ok: false, reason: 'That command contains an illegal character.' }
  if (/\s/.test(file)) {
    return { ok: false, reason: 'Pass the program and its arguments separately, not as one string.' }
  }
  const withoutPathChars = file.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '')
  if (SHELL_METACHARACTERS.test(withoutPathChars)) {
    return { ok: false, reason: 'That command contains shell syntax, which is not allowed.' }
  }

  const args: string[] = []
  if (rawArgs !== undefined && rawArgs !== null) {
    if (!Array.isArray(rawArgs)) return { ok: false, reason: 'Command arguments must be a list of strings.' }
    for (const arg of rawArgs) {
      if (typeof arg !== 'string') return { ok: false, reason: 'Command arguments must be strings.' }
      if (arg.includes(NUL)) return { ok: false, reason: 'An argument contains an illegal character.' }
      if (arg.length > 4096) return { ok: false, reason: 'An argument is too long.' }
      args.push(arg)
    }
  }
  if (args.length > 64) return { ok: false, reason: 'Too many arguments.' }

  const program = nativeBasename(file.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|com|ps1|sh)$/i, '').toLowerCase()
  const allowListed = policy.allowedCommands.some((c) => c.toLowerCase().replace(/\.exe$/i, '') === program)

  // Shell interpreters would re-introduce string parsing; never allow them implicitly.
  if (SHELL_INTERPRETERS.includes(program) && !policy.allowShell) {
    return { ok: false, reason: 'Shell interpreters are not allowed unless unrestricted commands are enabled in Settings > Automation.' }
  }
  if (!allowListed && !policy.allowShell) {
    return {
      ok: false,
      reason: `"${program}" is not on the approved command list. Add it in Settings > Automation, or enable unrestricted commands.`
    }
  }

  return { ok: true, file, args, allowListed }
}

/** Application names must look like names, never like arguments. */
export function validateAppName(input: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'An application name is required.' }
  const name = input.trim()
  if (name.length > 80) return { ok: false, reason: 'That application name is too long.' }
  if (!/^[A-Za-z0-9 ._+()'&:\\/-]+$/.test(name)) {
    return { ok: false, reason: 'That application name contains characters JARVIS will not pass to the system.' }
  }
  return { ok: true, name }
}
