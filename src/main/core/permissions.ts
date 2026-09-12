import type { ConfirmRequest, RiskLevel, Settings, ToolDescriptor } from '@shared/types'
import { TOOL_BY_NAME } from '../tools/descriptors'

/**
 * The security layer.
 *
 * Every tool call passes through `decide()` before it reaches the platform.
 * The model never influences this decision — it only proposes a call; the
 * user's settings and the tool's risk level decide what happens to it.
 */

export type PermissionAction = 'allow' | 'confirm' | 'deny'

export interface PermissionDecision {
  action: PermissionAction
  risk: RiskLevel
  /** Why, in language suitable for the console or a dialog. */
  reason: string
  confirm?: Omit<ConfirmRequest, 'id'>
}

export interface DecisionContext {
  /** The user already approved a plan containing this exact call. */
  planApproved?: boolean
  /** Running inside a routine the user explicitly started. */
  fromRoutine?: boolean
}

export function decide(
  toolName: string,
  args: Record<string, unknown>,
  settings: Settings,
  context: DecisionContext = {}
): PermissionDecision {
  const tool = TOOL_BY_NAME.get(toolName)
  if (!tool) {
    return { action: 'deny', risk: 'high', reason: `"${toolName}" is not a tool JARVIS can run.` }
  }

  const override = settings.permissions.tools[tool.name]
  if (override === 'deny') {
    return { action: 'deny', risk: tool.risk, reason: `${label(tool)} is switched off in Settings → Permissions.` }
  }

  // Category gates come before risk: a disabled capability is a hard no.
  const gate = categoryGate(tool, settings)
  if (gate) return gate

  const describe = describeAction(tool.name, args)

  if (tool.risk === 'high') {
    // High risk always confirms — an approved plan makes the dialog shorter,
    // never absent.
    return {
      action: 'confirm',
      risk: 'high',
      reason: `${label(tool)} is a high-risk action and always needs confirmation.`,
      confirm: buildConfirm(tool, args, describe)
    }
  }

  if (tool.risk === 'medium') {
    if (override === 'allow') return { action: 'allow', risk: 'medium', reason: 'Allowed by your per-tool permission.' }
    if (context.planApproved || context.fromRoutine) {
      return { action: 'allow', risk: 'medium', reason: 'Covered by the plan you approved.' }
    }
    if (!settings.automation.confirmMediumRisk) {
      return { action: 'allow', risk: 'medium', reason: 'Medium-risk confirmation is switched off.' }
    }
    return {
      action: 'confirm',
      risk: 'medium',
      reason: `${label(tool)} changes something on this computer.`,
      confirm: buildConfirm(tool, args, describe)
    }
  }

  if (!settings.automation.autoRunLowRisk && override !== 'allow') {
    return {
      action: 'confirm',
      risk: 'low',
      reason: 'You have asked JARVIS to confirm every action.',
      confirm: buildConfirm(tool, args, describe)
    }
  }
  return { action: 'allow', risk: 'low', reason: 'Low-risk action.' }
}

function categoryGate(tool: ToolDescriptor, settings: Settings): PermissionDecision | null {
  if (tool.category === 'screen' && !settings.permissions.screenAccess) {
    return {
      action: 'deny',
      risk: tool.risk,
      reason: 'Screen access is switched off. Enable it in Settings → Permissions.'
    }
  }
  if (tool.category === 'clipboard' && !settings.permissions.clipboardAccess) {
    return {
      action: 'deny',
      risk: tool.risk,
      reason: 'Clipboard access is switched off. Enable it in Settings → Permissions.'
    }
  }
  if (tool.category === 'web' && !settings.permissions.webAccess) {
    return { action: 'deny', risk: tool.risk, reason: 'Web access is switched off in Settings → Permissions.' }
  }
  if (tool.category === 'power' && !settings.automation.allowPower) {
    return {
      action: 'deny',
      risk: tool.risk,
      reason: 'Power controls are switched off. Enable them in Settings → Automation.'
    }
  }
  if (tool.category === 'memory' && !settings.memory.enabled) {
    return { action: 'deny', risk: tool.risk, reason: 'Memory is switched off in Settings → Memory.' }
  }
  return null
}

function buildConfirm(tool: ToolDescriptor, args: Record<string, unknown>, describe: string): Omit<ConfirmRequest, 'id'> {
  const details: string[] = []

  if (tool.name === 'delete_file') {
    const paths = Array.isArray(args.paths) ? (args.paths as string[]) : []
    details.push(...paths.slice(0, 12).map(String))
    if (paths.length > 12) details.push(`…and ${paths.length - 12} more`)
    return {
      title: args.permanent ? 'Permanent deletion' : 'Delete files',
      body: args.permanent
        ? `I have identified ${paths.length} item${paths.length === 1 ? '' : 's'} for permanent deletion. This cannot be undone. Proceed?`
        : `I have identified ${paths.length} item${paths.length === 1 ? '' : 's'} to move to the ${process.platform === 'win32' ? 'recycle bin' : 'trash'}. Proceed?`,
      risk: 'high',
      tool: tool.name,
      details,
      confirmLabel: args.permanent ? 'Delete permanently' : 'Delete',
      cancelLabel: 'Cancel'
    }
  }

  if (tool.name === 'close_other_applications') {
    const keep = Array.isArray(args.keep) ? (args.keep as string[]) : []
    return {
      title: 'Close other applications',
      body: keep.length
        ? `Everything except ${keep.join(' and ')} will be asked to quit. Unsaved work in those applications may be lost.`
        : 'Every open application will be asked to quit. Unsaved work may be lost.',
      risk: 'high',
      tool: tool.name,
      details: keep.length ? keep.map((name) => `Keeping: ${name}`) : ['Keeping: nothing'],
      confirmLabel: 'Close them',
      cancelLabel: 'Cancel'
    }
  }

  if (tool.name === 'empty_trash') {
    return {
      title: 'Empty the trash',
      body: `Everything in the ${process.platform === 'win32' ? 'recycle bin' : 'trash'} will be deleted permanently. This cannot be undone.`,
      risk: 'high',
      tool: tool.name,
      confirmLabel: 'Empty it',
      cancelLabel: 'Cancel'
    }
  }

  if (tool.name === 'execute_command') {
    const argv = Array.isArray(args.args) ? (args.args as string[]) : []
    details.push(`Program: ${String(args.command ?? '')}`)
    if (argv.length) details.push(`Arguments: ${argv.join(' ')}`)
    if (args.cwd) details.push(`Working directory: ${String(args.cwd)}`)
    if (args.reason) details.push(`Reason: ${String(args.reason)}`)
    return {
      title: 'Run a command',
      body: 'This runs a program on your computer with the arguments below. Review them before approving.',
      risk: 'high',
      tool: tool.name,
      details,
      confirmLabel: 'Run',
      cancelLabel: 'Cancel'
    }
  }

  if (tool.category === 'power') {
    return {
      title: tool.name === 'lock_computer' ? 'Lock this computer' : tool.name === 'restart_computer' ? 'Restart this computer' : 'Shut down this computer',
      body:
        tool.name === 'lock_computer'
          ? 'I will lock the workstation now.'
          : 'Unsaved work in other applications may be lost. Proceed?',
      risk: tool.risk,
      tool: tool.name,
      confirmLabel: tool.name === 'lock_computer' ? 'Lock' : 'Proceed',
      cancelLabel: 'Cancel'
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue
    details.push(`${key.replace(/_/g, ' ')}: ${preview(value)}`)
  }

  return {
    title: label(tool),
    body: `${describe} Proceed?`,
    risk: tool.risk,
    tool: tool.name,
    details,
    confirmLabel: 'Proceed',
    cancelLabel: 'Cancel'
  }
}

/** One-line, plain-language description of what a call will do. */
export function describeAction(toolName: string, args: Record<string, unknown>): string {
  const a = args ?? {}
  switch (toolName) {
    case 'open_application': return `Open ${String(a.name ?? 'an application')}.`
    case 'close_application': return `${a.force ? 'Force-close' : 'Close'} ${String(a.name ?? 'an application')}.`
    case 'list_applications': return 'List installed applications.'
    case 'get_running_processes': return 'Read the running process list.'
    case 'get_system_stats': return 'Read system metrics.'
    case 'search_files': return `Search ${String(a.folder ?? 'your files')}${a.query ? ` for "${String(a.query)}"` : ''}.`
    case 'get_file_info': return `Inspect ${String(a.path ?? 'a file')}.`
    case 'read_text_file': return `Read ${String(a.path ?? 'a text file')}.`
    case 'create_folder': return `Create the folder ${String(a.path ?? '')}.`
    case 'create_file': return `Create the file ${String(a.path ?? '')}.`
    case 'move_file': return `Move ${String(a.source ?? '')} to ${String(a.destination ?? '')}.`
    case 'move_files': return `Move ${Array.isArray(a.sources) ? a.sources.length : 0} item(s) to ${String(a.destination ?? '')}.`
    case 'close_other_applications': return `Close everything except ${Array.isArray(a.keep) && a.keep.length ? (a.keep as string[]).join(' and ') : 'nothing'}.`
    case 'empty_trash': return 'Empty the trash permanently.'
    case 'find_large_files': return `Measure what is using space in ${String(a.folder ?? 'your home folder')}.`
    case 'get_folder_size': return `Measure the size of ${String(a.path ?? '')}.`
    case 'read_clipboard': return 'Read the clipboard.'
    case 'write_clipboard': return 'Put text on the clipboard.'
    case 'copy_file': return `Copy ${String(a.source ?? '')} to ${String(a.destination ?? '')}.`
    case 'rename_file': return `Rename ${String(a.path ?? '')} to ${String(a.new_name ?? '')}.`
    case 'delete_file': return `Delete ${Array.isArray(a.paths) ? a.paths.length : 0} item(s).`
    case 'open_path': return `${a.reveal ? 'Reveal' : 'Open'} ${String(a.path ?? '')}.`
    case 'open_url': return `Open ${String(a.url ?? 'a link')}.`
    case 'web_search': return `Search the web for "${String(a.query ?? '')}".`
    case 'take_screenshot': return 'Capture the screen to a file.'
    case 'read_screen': return 'Look at what is currently on screen.'
    case 'set_volume': return `Set the system volume to ${String(a.level ?? '')}%.`
    case 'execute_command': return `Run ${String(a.command ?? '')}${Array.isArray(a.args) && a.args.length ? ` ${(a.args as string[]).join(' ')}` : ''}.`
    case 'open_settings': return `Open system settings${a.section ? ` at ${String(a.section)}` : ''}.`
    case 'lock_computer': return 'Lock the workstation.'
    case 'restart_computer': return 'Restart the computer.'
    case 'shutdown_computer': return 'Shut the computer down.'
    case 'remember': return `Remember "${String(a.key ?? '')}".`
    case 'forget': return `Forget "${String(a.key ?? '')}".`
    case 'recall': return 'Recall stored preferences.'
    case 'create_routine': return `Save the routine "${String(a.name ?? '')}".`
    case 'run_routine': return `Run the routine "${String(a.name ?? '')}".`
    case 'list_routines': return 'List saved routines.'
    case 'delete_routine': return `Delete the routine "${String(a.name ?? '')}".`
    default: return `Run ${toolName}.`
  }
}

function label(tool: ToolDescriptor): string {
  return tool.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function preview(value: unknown): string {
  if (Array.isArray(value)) {
    const shown = value.slice(0, 5).map((v) => String(v)).join(', ')
    return value.length > 5 ? `${shown} …(+${value.length - 5})` : shown
  }
  const text = String(value)
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}
