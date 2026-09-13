import { z } from 'zod'
import type { JsonSchemaObject, RiskLevel, ToolDescriptor, ToolName } from '@shared/types'
import { MODEL_EXTENSIONS } from '@shared/geometry'

/**
 * The tool catalogue.
 *
 * This is the only surface the model can reach. Each entry owns its argument
 * schema (validated at runtime with zod, published to the model as JSON
 * Schema), its risk level and the category the permissions UI groups it under.
 */

const pathArg = z.string().min(1).max(1024)

/**
 * One solid in a generated model.
 *
 * This is deliberately a closed vocabulary. The model picks a primitive and
 * gives it dimensions; it cannot describe arbitrary geometry, and it certainly
 * cannot supply code for the kernel to run.
 */
const shapeArg = z.object({
  shape: z.enum(['box', 'cylinder', 'sphere', 'cone', 'torus', 'rounded_box', 'prism'])
    .describe('Which primitive to build.'),
  size: z.tuple([z.number(), z.number(), z.number()]).optional()
    .describe('Width, depth and height for box and rounded_box.'),
  radius: z.number().positive().max(10000).optional()
    .describe('Radius for sphere, cylinder, prism; outer radius for torus; base radius for cone.'),
  radius_top: z.number().min(0).max(10000).optional().describe('Top radius of a cone. 0 gives a point.'),
  radius_bottom: z.number().min(0).max(10000).optional().describe('Bottom radius of a cone.'),
  height: z.number().positive().max(10000).optional().describe('Height of cylinder, cone or prism.'),
  inner_radius: z.number().positive().max(10000).optional().describe('Tube radius of a torus.'),
  round_radius: z.number().positive().max(1000).optional().describe('Corner radius of a rounded_box.'),
  sides: z.number().int().min(3).max(64).optional().describe('Number of sides on a prism, e.g. 6 for a hexagon.'),
  at: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Centre position [x, y, z]. Defaults to the origin.'),
  rotate: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Rotation in degrees about x, y and z.'),
  scale: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Non-uniform scale factors.'),
  op: z.enum(['add', 'subtract', 'intersect']).optional()
    .describe('How this shape combines with everything before it. Use subtract to cut holes and pockets. Defaults to add.'),
  name: z.string().max(40).optional().describe('Label for this feature, shown in the parts list.')
})

export const toolSchemas = {
  open_application: z.object({
    name: z.string().min(1).max(80).describe('Application name as a person would say it, e.g. "Chrome", "Visual Studio Code", "Spotify".')
  }),
  close_application: z.object({
    name: z.string().min(1).max(80).describe('Application to close.'),
    force: z.boolean().optional().describe('Force-kill instead of asking the app to quit. Unsaved work may be lost.')
  }),
  list_applications: z.object({
    filter: z.string().max(80).optional().describe('Optional substring to filter the installed application list.')
  }),
  get_running_processes: z.object({
    sort_by: z.enum(['cpu', 'memory']).optional().describe('Sort key. Defaults to cpu.'),
    limit: z.number().int().min(1).max(50).optional().describe('How many processes to return. Defaults to 10.')
  }),
  get_system_stats: z.object({
    include: z.array(z.enum(['cpu', 'memory', 'gpu', 'disk', 'network', 'battery', 'os', 'processes'])).optional()
      .describe('Which sections to return. Defaults to everything.')
  }),
  search_files: z.object({
    query: z.string().max(120).optional().describe('Text to match in the file name. Supports * wildcards.'),
    folder: pathArg.optional().describe('Folder to search, e.g. "~/Downloads". Defaults to the home folder.'),
    extensions: z.array(z.string().max(12)).max(12).optional().describe('File extensions to include, e.g. ["pdf","docx"].'),
    modified_within_days: z.number().int().min(1).max(3650).optional().describe('Only files modified in the last N days.'),
    limit: z.number().int().min(1).max(200).optional().describe('Maximum results. Defaults to 25.')
  }),
  get_file_info: z.object({
    path: pathArg.describe('File or folder to inspect.')
  }),
  read_text_file: z.object({
    path: pathArg.describe('Text file to read.'),
    max_characters: z.number().int().min(100).max(40000).optional().describe('Truncation limit. Defaults to 8000.')
  }),
  create_folder: z.object({
    path: pathArg.describe('Folder to create, e.g. "~/Documents/Projects".')
  }),
  create_file: z.object({
    path: pathArg.describe('File to create.'),
    content: z.string().max(200000).optional().describe('Initial file contents.'),
    overwrite: z.boolean().optional().describe('Replace the file if it already exists.')
  }),
  move_files: z.object({
    sources: z.array(pathArg).min(1).max(200).describe('Files or folders to move.'),
    destination: pathArg.describe('Folder to move them into. Created if it does not exist.')
  }),
  close_other_applications: z.object({
    keep: z.array(z.string().min(1).max(80)).max(20).optional()
      .describe('Applications to leave running, e.g. ["Discord","Spotify"]. Everything else with a window is closed.')
  }),
  empty_trash: z.object({}),
  find_large_files: z.object({
    folder: pathArg.optional().describe('Folder to measure. Defaults to the home folder.'),
    minimum_mb: z.number().min(0).max(1_000_000).optional().describe('Ignore files smaller than this. Defaults to 100 MB.'),
    limit: z.number().int().min(1).max(100).optional().describe('How many files to return. Defaults to 15.')
  }),
  get_folder_size: z.object({
    path: pathArg.describe('Folder to measure.')
  }),
  read_clipboard: z.object({}),
  write_clipboard: z.object({
    text: z.string().min(1).max(200000).describe('Text to place on the clipboard.')
  }),
  move_file: z.object({
    source: pathArg.describe('File or folder to move.'),
    destination: pathArg.describe('Destination path or folder.')
  }),
  copy_file: z.object({
    source: pathArg.describe('File or folder to copy.'),
    destination: pathArg.describe('Destination path or folder.')
  }),
  rename_file: z.object({
    path: pathArg.describe('File or folder to rename.'),
    new_name: z.string().min(1).max(255).describe('New name, without a directory component.')
  }),
  delete_file: z.object({
    paths: z.array(pathArg).min(1).max(500).describe('Files or folders to delete.'),
    permanent: z.boolean().optional().describe('Bypass the recycle bin / trash. Cannot be undone.')
  }),
  open_path: z.object({
    path: pathArg.describe('File or folder to open in its default application.'),
    reveal: z.boolean().optional().describe('Reveal in the file manager instead of opening.')
  }),
  open_url: z.object({
    url: z.string().min(1).max(2048).describe('Web address to open. http/https only.'),
    browser: z.string().max(60).optional().describe('Specific browser to use. Defaults to the system default.')
  }),
  web_search: z.object({
    query: z.string().min(1).max(300).describe('What to search the web for.'),
    browser: z.string().max(60).optional().describe('Specific browser to use.')
  }),
  take_screenshot: z.object({
    save_to: pathArg.optional().describe('Where to save the PNG. Defaults to the Pictures folder.')
  }),
  read_screen: z.object({
    question: z.string().max(400).optional().describe('What the user wants to know about what is on screen.')
  }),
  set_volume: z.object({
    level: z.number().min(0).max(100).describe('Target output volume as a percentage.')
  }),
  execute_command: z.object({
    command: z.string().min(1).max(200).describe('Program to run, without arguments, e.g. "git".'),
    args: z.array(z.string().max(4096)).max(64).optional().describe('Arguments as separate list items. Never a single joined string.'),
    cwd: pathArg.optional().describe('Working directory.'),
    reason: z.string().max(300).optional().describe('Short explanation shown to the user in the confirmation prompt.')
  }),
  open_settings: z.object({
    section: z.string().max(40).optional().describe('Settings section, e.g. "display", "sound", "network", "privacy".')
  }),
  lock_computer: z.object({}),
  restart_computer: z.object({
    delay_seconds: z.number().int().min(0).max(300).optional().describe('Grace period before restarting.')
  }),
  shutdown_computer: z.object({
    delay_seconds: z.number().int().min(0).max(300).optional().describe('Grace period before shutting down.')
  }),
  remember: z.object({
    key: z.string().min(1).max(80).describe('Short label, e.g. "preferred browser" or "work project folder".'),
    value: z.string().min(1).max(1000).describe('What to remember.')
  }),
  forget: z.object({
    key: z.string().min(1).max(80).describe('Label of the memory to remove.')
  }),
  recall: z.object({
    query: z.string().max(120).optional().describe('Optional filter. Omit to list everything JARVIS remembers.')
  }),
  create_routine: z.object({
    name: z.string().min(1).max(60).describe('Routine name, e.g. "Work Mode".'),
    description: z.string().max(300).optional(),
    triggers: z.array(z.string().max(60)).max(8).optional().describe('Spoken phrases that run this routine, e.g. ["start work"].'),
    actions: z.array(
      z.object({
        tool: z.string().min(1).max(60).describe('Tool to call.'),
        args: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool.'),
        label: z.string().max(120).optional()
      })
    ).min(1).max(20).describe('Ordered steps to run.')
  }),
  run_routine: z.object({
    name: z.string().min(1).max(60).describe('Routine to run.')
  }),
  list_routines: z.object({}),
  open_3d_model: z.object({
    path: pathArg.describe(`Model file to open and display. Supported: ${MODEL_EXTENSIONS.join(', ')}.`)
  }),
  create_3d_model: z.object({
    name: z.string().min(1).max(60).describe('Short name for the model, e.g. "Bracket".'),
    units: z.enum(['mm', 'cm', 'in']).optional().describe('Units the dimensions are given in. Defaults to millimetres.'),
    shapes: z.array(shapeArg).min(1).max(64)
      .describe('Solids combined in order. The first is the base; each later one adds to, subtracts from, or intersects the result so far.')
  }),
  export_3d_model: z.object({
    path: pathArg.optional().describe('Where to save the .stl file. Defaults to the Documents folder.'),
    model: z.string().max(120).optional().describe('Which open model to export, by name or id. Defaults to the most recent.')
  }),
  list_3d_models: z.object({}),
  delete_routine: z.object({
    name: z.string().min(1).max(60).describe('Routine to delete.')
  })
} as const satisfies Record<ToolName, z.ZodType>

interface Meta {
  description: string
  risk: RiskLevel
  category: ToolDescriptor['category']
  offline: boolean
}

const meta: Record<ToolName, Meta> = {
  open_application: { description: 'Launch an application by name. Resolves common aliases and installed application names.', risk: 'low', category: 'applications', offline: true },
  close_application: { description: 'Ask an application to quit. Use force only when the user asks for it; unsaved work may be lost.', risk: 'medium', category: 'applications', offline: true },
  list_applications: { description: 'List applications installed on this computer.', risk: 'low', category: 'applications', offline: true },
  get_running_processes: { description: 'List running processes with CPU and memory usage. Use this to answer "what is slowing my computer down".', risk: 'low', category: 'system', offline: true },
  get_system_stats: { description: 'Read live system metrics: CPU, memory, GPU, disks, network, battery, OS and top processes.', risk: 'low', category: 'system', offline: true },
  search_files: { description: 'Search the user files for names, extensions or recent modifications. Bounded and safe.', risk: 'low', category: 'filesystem', offline: true },
  get_file_info: { description: 'Get size, type and timestamps for a file or folder.', risk: 'low', category: 'filesystem', offline: true },
  read_text_file: { description: 'Read the contents of a text file. Binary files are refused.', risk: 'medium', category: 'filesystem', offline: true },
  create_folder: { description: 'Create a folder, including any missing parent folders.', risk: 'medium', category: 'filesystem', offline: true },
  create_file: { description: 'Create a file, optionally with contents.', risk: 'medium', category: 'filesystem', offline: true },
  move_file: { description: 'Move a file or folder to another location.', risk: 'medium', category: 'filesystem', offline: true },
  move_files: { description: 'Move several files or folders into one destination folder in a single step. Prefer this over repeated move_file calls.', risk: 'medium', category: 'filesystem', offline: true },
  close_other_applications: { description: 'Close every running application except the ones named. Use for requests like "close everything except Discord and Spotify".', risk: 'high', category: 'applications', offline: true },
  empty_trash: { description: 'Empty the recycle bin or trash. This is permanent and cannot be undone.', risk: 'high', category: 'filesystem', offline: true },
  find_large_files: { description: 'Find what is using disk space in a folder, largest first, with a per-subfolder breakdown. Use this to answer "what is taking up my storage".', risk: 'low', category: 'filesystem', offline: true },
  get_folder_size: { description: 'Measure how much space a folder uses, with a breakdown of its largest subfolders.', risk: 'low', category: 'filesystem', offline: true },
  read_clipboard: { description: 'Read what is currently on the clipboard. May contain sensitive text, so it asks first.', risk: 'medium', category: 'clipboard', offline: true },
  write_clipboard: { description: 'Put text on the clipboard so the user can paste it.', risk: 'medium', category: 'clipboard', offline: true },
  copy_file: { description: 'Copy a file or folder to another location.', risk: 'medium', category: 'filesystem', offline: true },
  rename_file: { description: 'Rename a file or folder in place.', risk: 'medium', category: 'filesystem', offline: true },
  delete_file: { description: 'Delete files or folders. Goes to the recycle bin unless permanent is set. Always requires the user to confirm.', risk: 'high', category: 'filesystem', offline: true },
  open_path: { description: 'Open a file or folder in its default application, or reveal it in the file manager.', risk: 'low', category: 'filesystem', offline: true },
  open_url: { description: 'Open a web address in a browser.', risk: 'low', category: 'web', offline: true },
  web_search: { description: 'Search the web by opening a search results page in the browser.', risk: 'low', category: 'web', offline: true },
  take_screenshot: { description: 'Capture the screen and save it as a PNG file.', risk: 'medium', category: 'screen', offline: true },
  read_screen: { description: 'Capture the screen and look at it, to answer questions about what is currently displayed.', risk: 'medium', category: 'screen', offline: false },
  set_volume: { description: 'Set the system output volume.', risk: 'medium', category: 'system', offline: true },
  execute_command: { description: 'Run an approved command-line program with explicit arguments. Never pass a whole command line as one string.', risk: 'high', category: 'terminal', offline: true },
  open_settings: { description: 'Open the operating system settings, optionally at a specific section.', risk: 'low', category: 'system', offline: true },
  lock_computer: { description: 'Lock the workstation.', risk: 'medium', category: 'power', offline: true },
  restart_computer: { description: 'Restart the computer. Always requires confirmation.', risk: 'high', category: 'power', offline: true },
  shutdown_computer: { description: 'Shut the computer down. Always requires confirmation.', risk: 'high', category: 'power', offline: true },
  remember: { description: 'Store a durable preference or fact about the user, e.g. their preferred browser or project folder.', risk: 'low', category: 'memory', offline: true },
  forget: { description: 'Remove something JARVIS remembered.', risk: 'low', category: 'memory', offline: true },
  recall: { description: 'List what JARVIS remembers about the user.', risk: 'low', category: 'memory', offline: true },
  create_routine: { description: 'Save a named multi-step routine the user can run later by name or trigger phrase.', risk: 'low', category: 'memory', offline: true },
  run_routine: { description: 'Run a saved routine by name.', risk: 'medium', category: 'memory', offline: true },
  list_routines: { description: 'List the routines the user has saved, with their trigger phrases and step counts.', risk: 'low', category: 'memory', offline: true },
  delete_routine: { description: 'Delete a saved routine.', risk: 'medium', category: 'memory', offline: true },
  open_3d_model: { description: `Open a 3D or CAD file and display it in the Workshop, where the user can orbit, pan and zoom it. Reads ${MODEL_EXTENSIONS.join(', ')}. Use this whenever the user asks to see, open, view or inspect a model, part or CAD file.`, risk: 'low', category: 'modelling', offline: true },
  create_3d_model: { description: 'Build a 3D model from exact dimensions by combining primitives with add, subtract and intersect, then show it in the Workshop. Use this for requests like "make a 40 by 20 by 10 plate with a 4 mm hole" or "design a hex nut". Dimensions are exact, so state them in millimetres unless told otherwise.', risk: 'low', category: 'modelling', offline: true },
  export_3d_model: { description: 'Save an open model to disk as an STL file, ready for slicing or printing.', risk: 'medium', category: 'modelling', offline: true },
  list_3d_models: { description: 'List the models currently open in the Workshop.', risk: 'low', category: 'modelling', offline: true }
}

function jsonSchema(schema: z.ZodType): JsonSchemaObject {
  const generated = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  delete generated.$schema
  return {
    type: 'object',
    properties: (generated.properties as Record<string, unknown>) ?? {},
    required: (generated.required as string[]) ?? [],
    additionalProperties: false
  }
}

export const TOOL_DESCRIPTORS: ToolDescriptor[] = (Object.keys(meta) as ToolName[]).map((name) => ({
  name,
  description: meta[name].description,
  risk: meta[name].risk,
  category: meta[name].category,
  offline: meta[name].offline,
  parameters: jsonSchema(toolSchemas[name])
}))

export const TOOL_BY_NAME = new Map<string, ToolDescriptor>(TOOL_DESCRIPTORS.map((t) => [t.name, t]))

export function isToolName(value: string): value is ToolName {
  return TOOL_BY_NAME.has(value)
}

/** Schema lookup by name, for callers that only have a string. */
export function schemaFor(name: string): z.ZodType | undefined {
  return (toolSchemas as Record<string, z.ZodType>)[name]
}

export function riskOf(name: string): RiskLevel {
  return TOOL_BY_NAME.get(name)?.risk ?? 'high'
}
