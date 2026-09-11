/**
 * Works out *why* the Electron binary could not be installed.
 *
 * The failure modes look identical to electron-vite (`Error: Electron
 * uninstall`) but need opposite fixes: a blocked download wants proxy or
 * mirror settings, while a refused write wants antivirus, folder protection
 * or a different directory. Guessing wrong sends people the wrong way, so
 * the classification is kept pure and tested.
 */
import { join, sep } from 'node:path'

const DENIED = /access is denied|EPERM|EACCES|os error 5|EBUSY|operation not permitted|permission denied|resource busy|being used by another process/i
const OFFLINE = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|certificate|self.signed|unable to verify|socket hang up|getaddrinfo|tunneling socket|502 Bad Gateway|403 Forbidden|404 Not Found|ENETUNREACH/i

/** Returns 'permission', 'network', 'both' or 'unknown'. */
export function classifyFailure(output = '') {
  const text = String(output)
  const denied = DENIED.test(text)
  const offline = OFFLINE.test(text)
  if (denied && offline) return 'both'
  if (denied) return 'permission'
  if (offline) return 'network'
  return 'unknown'
}

/**
 * Names the folder-protection or sync feature likely to be interfering, or
 * null when the project sits somewhere unremarkable.
 */
export function riskyLocation(root, home, platform = process.platform) {
  if (platform !== 'win32') return null
  const lower = String(root).toLowerCase().replace(/\//g, '\\')
  if (lower.includes('\\onedrive\\')) return 'OneDrive'

  const base = String(home).toLowerCase().replace(/\//g, '\\')
  for (const folder of ['documents', 'desktop', 'pictures']) {
    const guarded = join(base, folder).toLowerCase().replace(/\//g, '\\')
    if (lower === guarded || lower.startsWith(guarded + '\\')) {
      return `your ${folder[0].toUpperCase()}${folder.slice(1)} folder`
    }
  }
  return null
}

export { sep }
