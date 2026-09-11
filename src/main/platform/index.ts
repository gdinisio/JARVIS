import type { PlatformAdapter } from './types'
import { WindowsAdapter } from './windows'
import { MacOSAdapter } from './macos'
import { LinuxAdapter } from './linux'
import { logger } from '../services/logging'

let adapter: PlatformAdapter | null = null

/**
 * The single place where platform branching happens.
 *
 * Everything above this line — tools, planner, UI — speaks only the
 * `PlatformAdapter` interface.
 */
export function platform(): PlatformAdapter {
  if (adapter) return adapter
  switch (process.platform) {
    case 'win32':
      adapter = new WindowsAdapter()
      break
    case 'darwin':
      adapter = new MacOSAdapter()
      break
    default:
      adapter = new LinuxAdapter()
      break
  }
  logger.info('platform', `Platform adapter ready: ${adapter.label}.`)
  return adapter
}

/** Test seam. */
export function setPlatformAdapter(next: PlatformAdapter | null): void {
  adapter = next
}

export type { PlatformAdapter } from './types'
