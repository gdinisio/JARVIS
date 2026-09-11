import { validateCommand, validatePath } from './validate'
import { run } from '../platform/exec'
import { ok, fail, blocked, type ToolHandler } from './context'
import { logger } from '../services/logging'
import { shorten } from './filesystem'

const MAX_OUTPUT_CHARS = 6000

/**
 * Runs an approved program.
 *
 * Three independent guards apply: the program must pass `validateCommand`
 * (allow-list, no shell syntax, no interpreters), the working directory must
 * pass path validation, and the security layer has already taken an explicit
 * confirmation from the user — `execute_command` is high risk by definition.
 */
export const executeCommand: ToolHandler = async (args, ctx) => {
  const check = validateCommand(args.command, args.args ?? [], {
    allowedCommands: ctx.settings.automation.allowedCommands,
    allowShell: ctx.settings.automation.allowShell
  })
  if (!check.ok) return blocked(check.reason)

  let cwd: string | undefined
  if (args.cwd !== undefined && args.cwd !== null && String(args.cwd).trim()) {
    const cwdCheck = validatePath(String(args.cwd), ctx.pathPolicy, 'read')
    if (!cwdCheck.ok) return blocked(cwdCheck.reason)
    cwd = cwdCheck.path
  }

  const started = Date.now()
  try {
    const result = await run(check.file, check.args, { cwd, timeoutMs: 30_000, maxOutputBytes: 512 * 1024 })
    const stdout = truncate(result.stdout)
    const stderr = truncate(result.stderr)

    logger.info('terminal', 'Command executed.', {
      command: check.file,
      argc: check.args.length,
      exitCode: result.code,
      allowListed: check.allowListed,
      durationMs: result.durationMs
    })

    if (result.timedOut) return fail(`${check.file} did not finish within 30 seconds and was stopped.`, { stdout, stderr })
    if (result.code !== 0) {
      return fail(`${check.file} exited with code ${result.code}.`, { exitCode: result.code, stdout, stderr })
    }
    const summary = firstMeaningfulLine(stdout) ?? `${check.file} completed.`
    return ok(summary, { exitCode: 0, stdout, stderr, durationMs: Date.now() - started, cwd: cwd ? shorten(cwd) : undefined })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT/.test(message)) return fail(`${check.file} is not installed on this computer.`)
    return fail(`${check.file} could not be run.`)
  }
}

function truncate(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_OUTPUT_CHARS ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated]` : trimmed
}

function firstMeaningfulLine(text: string): string | null {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean)
  if (!line) return null
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}
