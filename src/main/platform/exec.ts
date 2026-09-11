import { spawn } from 'node:child_process'
import { logger } from '../services/logging'

export interface ExecOptions {
  /** Hard kill after this many milliseconds. */
  timeoutMs?: number
  cwd?: string
  /** Extra environment variables — the safe way to pass dynamic values into a script. */
  env?: Record<string, string>
  /** Data written to stdin then closed. */
  input?: string
  /** Abandon the child and resolve immediately (used for launching apps). */
  detached?: boolean
  maxOutputBytes?: number
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export class ExecError extends Error {
  constructor(message: string, readonly result: ExecResult) {
    super(message)
    this.name = 'ExecError'
  }
}

const DEFAULT_TIMEOUT = 20_000
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024

/**
 * Runs a program with an explicit argument array.
 *
 * `shell` is never enabled: arguments are handed to the OS as a vector, so no
 * amount of quoting, `;`, `&&`, backticks or `$(...)` in a value can turn into
 * another command. Every OS interaction in JARVIS goes through here.
 */
export function run(file: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now()
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        shell: false,
        detached: !!options.detached,
        stdio: options.detached ? 'ignore' : ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(new ExecError(`Could not start ${file}: ${String(error)}`, empty(started)))
      return
    }

    if (options.detached) {
      child.unref()
      resolve({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: Date.now() - started })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, options.timeoutMs ?? DEFAULT_TIMEOUT)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new ExecError(`Could not start ${file}: ${error.message}`, { ...empty(started), stderr: error.message }))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: ExecResult = { code, stdout, stderr, timedOut, durationMs: Date.now() - started }
      logger.debug('exec', `${file} exited`, { file, argc: args.length, code, timedOut, durationMs: result.durationMs })
      resolve(result)
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

/** Like `run`, but rejects on a non-zero exit code. */
export async function runOrThrow(file: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const result = await run(file, args, options)
  if (result.timedOut) throw new ExecError(`${file} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT}ms`, result)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 4).join(' ')
    throw new ExecError(detail || `${file} exited with code ${result.code}`, result)
  }
  return result
}

/**
 * Runs a PowerShell script.
 *
 * The script itself is always a static string written by JARVIS. Dynamic
 * values are injected as environment variables and read inside the script via
 * `$env:JARVIS_X`, so user or model text is never parsed as PowerShell.
 */
export function powershell(script: string, vars: Record<string, string> = {}, options: ExecOptions = {}): Promise<ExecResult> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars)) env[`JARVIS_${key.toUpperCase()}`] = value
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { ...options, env: { ...env, ...(options.env ?? {}) }, timeoutMs: options.timeoutMs ?? 30_000 }
  )
}

/**
 * Runs an AppleScript.
 *
 * Dynamic values are passed as environment variables and read inside the
 * script with `system attribute "JARVIS_X"`, which keeps user and model text
 * out of the AppleScript source entirely.
 */
export function applescript(script: string, vars: Record<string, string> = {}, options: ExecOptions = {}): Promise<ExecResult> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars)) env[`JARVIS_${key.toUpperCase()}`] = value
  return run('osascript', ['-e', script], {
    ...options,
    env: { ...env, ...(options.env ?? {}) },
    timeoutMs: options.timeoutMs ?? 20_000
  })
}

function empty(started: number): ExecResult {
  return { code: null, stdout: '', stderr: '', timedOut: false, durationMs: Date.now() - started }
}
