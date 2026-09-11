/**
 * Matches a keyboard event against an Electron accelerator string.
 *
 * Used for in-window hold-to-talk: a global shortcut can only report a press,
 * so genuine push-to-talk needs the window's own keyup.
 */
export function matchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  if (!accelerator?.trim()) return false
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (!parts.length) return false

  const wantsControl = parts.includes('control') || parts.includes('ctrl') || parts.includes('commandorcontrol')
  const wantsCommand = parts.includes('command') || parts.includes('cmd') || parts.includes('meta') || parts.includes('commandorcontrol')
  const wantsAlt = parts.includes('alt') || parts.includes('option')
  const wantsShift = parts.includes('shift')

  const key = parts.find((part) => !['control', 'ctrl', 'command', 'cmd', 'meta', 'commandorcontrol', 'alt', 'option', 'shift'].includes(part))
  if (!key) return false

  // CommandOrControl accepts either modifier; anything else must match exactly.
  const flexible = parts.includes('commandorcontrol')
  if (flexible) {
    if (!event.ctrlKey && !event.metaKey) return false
  } else {
    if (wantsControl !== event.ctrlKey) return false
    if (wantsCommand !== event.metaKey) return false
  }
  if (wantsAlt !== event.altKey) return false
  if (wantsShift !== event.shiftKey) return false

  const pressed = event.key.toLowerCase()
  const code = event.code.toLowerCase()
  if (key === 'space') return pressed === ' ' || code === 'space'
  if (key === 'plus') return pressed === '+'
  return pressed === key || code === `key${key}` || code === `digit${key}`
}
