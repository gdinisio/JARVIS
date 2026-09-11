import { describe, it, expect } from 'vitest'
import { matchesAccelerator } from '../src/renderer/src/lib/hotkey'

function press(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', code: '', ...init } as KeyboardEvent
}

describe('matchesAccelerator', () => {
  it('matches a modifier chord exactly', () => {
    const event = press({ ctrlKey: true, shiftKey: true, key: ' ', code: 'Space' })
    expect(matchesAccelerator(event, 'Control+Shift+Space')).toBe(true)
    expect(matchesAccelerator(event, 'Control+Space')).toBe(false)
    expect(matchesAccelerator(event, 'Command+Shift+Space')).toBe(false)
  })

  it('matches letter keys by name or code', () => {
    expect(matchesAccelerator(press({ ctrlKey: true, key: 'k', code: 'KeyK' }), 'Control+K')).toBe(true)
    expect(matchesAccelerator(press({ metaKey: true, key: 'K', code: 'KeyK' }), 'Command+K')).toBe(true)
  })

  it('accepts either modifier for CommandOrControl', () => {
    expect(matchesAccelerator(press({ ctrlKey: true, key: ' ', code: 'Space' }), 'CommandOrControl+Space')).toBe(true)
    expect(matchesAccelerator(press({ metaKey: true, key: ' ', code: 'Space' }), 'CommandOrControl+Space')).toBe(true)
    expect(matchesAccelerator(press({ key: ' ', code: 'Space' }), 'CommandOrControl+Space')).toBe(false)
  })

  it('ignores empty or modifier-only accelerators', () => {
    expect(matchesAccelerator(press({ key: 'a' }), '')).toBe(false)
    expect(matchesAccelerator(press({ ctrlKey: true, key: 'Control' }), 'Control')).toBe(false)
  })
})
