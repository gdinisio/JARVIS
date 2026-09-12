import { describe, it, expect, beforeEach } from 'vitest'
import { memory, derivePreferences } from '../src/main/core/memory'
import { routines } from '../src/main/core/routines'
import { matchLocalIntent, isInterrupt, isBareWake } from '../src/main/core/intent'
import { matchWakePhrase } from '../src/renderer/src/lib/wake'
import { mergeSettings, defaultSettings } from '../src/shared/defaults'
import { redact } from '../src/main/services/logging'
import type { MemoryEntry } from '../src/shared/types'

describe('memory', () => {
  beforeEach(() => {
    memory.clear()
  })

  it('stores and recalls a fact', () => {
    memory.remember('favourite editor', 'Neovim')
    expect(memory.recall('editor')[0]?.value).toBe('Neovim')
  })

  it('updates rather than duplicating an existing key', () => {
    memory.remember('preferred browser', 'Chrome')
    memory.remember('Preferred Browser', 'Firefox')
    expect(memory.entries()).toHaveLength(1)
    expect(memory.entries()[0].value).toBe('Firefox')
  })

  it('derives structured preferences from natural keys', () => {
    memory.remember('preferred browser', 'Firefox')
    memory.remember('music app', 'Spotify')
    memory.remember('work project folder', '~/code/aurora')
    const preferences = memory.preferences()
    expect(preferences.browser).toBe('Firefox')
    expect(preferences.musicApp).toBe('Spotify')
    expect(preferences.projectFolder).toBe('~/code/aurora')
  })

  it('forgets on request', () => {
    memory.remember('temporary', 'value')
    expect(memory.forget('temporary')).toBe(true)
    expect(memory.forget('temporary')).toBe(false)
    expect(memory.entries()).toHaveLength(0)
  })

  it('enforces the configured entry limit', () => {
    for (let i = 0; i < 12; i++) memory.remember(`key ${i}`, `value ${i}`, 'user', 5)
    expect(memory.entries().length).toBeLessThanOrEqual(5)
  })

  it('produces a prompt block only when something is stored', () => {
    expect(memory.promptBlock()).toBe('')
    memory.remember('preferred browser', 'Firefox')
    expect(memory.promptBlock()).toContain('Firefox')
  })

  it('drops a preference when its backing entry is removed', () => {
    memory.remember('preferred browser', 'Firefox')
    memory.forget('preferred browser')
    expect(memory.preferences().browser).toBeUndefined()
  })
})

describe('derivePreferences', () => {
  it('ignores keys that match nothing', () => {
    const entries: MemoryEntry[] = [
      { id: '1', key: 'lucky number', value: '7', origin: 'user', createdAt: 0, updatedAt: 0 }
    ]
    expect(derivePreferences(entries, {})).toEqual({})
  })
})

describe('routines', () => {
  beforeEach(() => {
    for (const routine of routines.list()) routines.delete(routine.id)
  })

  it('saves and finds a routine by name or trigger', () => {
    routines.save({
      name: 'Work Mode',
      actions: [{ tool: 'open_application', args: { name: 'Code' } }],
      triggers: ['start work']
    })
    expect(routines.find('Work Mode')?.actions).toHaveLength(1)
    expect(routines.find('start work')?.name).toBe('Work Mode')
    expect(routines.find('work')?.name).toBe('Work Mode')
  })

  it('updates an existing routine instead of creating a second one', () => {
    routines.save({ name: 'Gaming Mode', actions: [{ tool: 'open_application', args: { name: 'Steam' } }] })
    routines.save({
      name: 'Gaming Mode',
      actions: [
        { tool: 'open_application', args: { name: 'Steam' } },
        { tool: 'open_application', args: { name: 'Discord' } }
      ]
    })
    expect(routines.list()).toHaveLength(1)
    expect(routines.list()[0].actions).toHaveLength(2)
  })

  it('matches whole utterances, including natural prefixes', () => {
    routines.save({
      name: 'Work Mode',
      actions: [{ tool: 'open_application', args: { name: 'Code' } }],
      triggers: ['start work']
    })
    for (const phrase of ['work mode', 'start work', 'run work mode', 'Start work.', 'activate work mode']) {
      expect(routines.matchUtterance(phrase)?.name, phrase).toBe('Work Mode')
    }
  })

  it('does not match an utterance that merely mentions the routine', () => {
    routines.save({ name: 'Work Mode', actions: [{ tool: 'open_application', args: { name: 'Code' } }] })
    expect(routines.matchUtterance('what does work mode do again')).toBeNull()
    expect(routines.matchUtterance('delete the work mode routine')).toBeNull()
  })

  it('ignores disabled routines when matching', () => {
    const saved = routines.save({ name: 'Work Mode', actions: [{ tool: 'open_application', args: {} }] })
    routines.save({ ...saved, enabled: false })
    expect(routines.matchUtterance('work mode')).toBeNull()
  })

  it('duplicates a routine without its triggers', () => {
    const saved = routines.save({
      name: 'Focus',
      actions: [{ tool: 'open_application', args: { name: 'Code' } }],
      triggers: ['focus']
    })
    const copy = routines.duplicate(saved.id)
    expect(copy?.name).toBe('Focus copy')
    expect(copy?.triggers).toEqual([])
    expect(routines.list()).toHaveLength(2)
  })

  it('counts runs', () => {
    const saved = routines.save({ name: 'Counted', actions: [{ tool: 'get_system_stats', args: {} }] })
    routines.markRun(saved.id)
    routines.markRun(saved.id)
    expect(routines.find('Counted')?.runCount).toBe(2)
  })
})

describe('offline intent matching', () => {
  it('understands common commands without a model', () => {
    expect(matchLocalIntent('open chrome')?.call.name).toBe('open_application')
    expect(matchLocalIntent('Hey JARVIS, open Spotify')?.call.name).toBe('open_application')
    expect(matchLocalIntent('close discord')?.call.name).toBe('close_application')
    expect(matchLocalIntent('take a screenshot')?.call.name).toBe('take_screenshot')
    expect(matchLocalIntent('lock my computer')?.call.name).toBe('lock_computer')
    expect(matchLocalIntent('what is my cpu usage')?.call.name).toBe('get_system_stats')
    expect(matchLocalIntent("what's running in the background")?.call.name).toBe('get_running_processes')
    expect(matchLocalIntent('search for the latest spacex launch')?.call.name).toBe('web_search')
  })

  it('extracts arguments correctly', () => {
    expect(matchLocalIntent('set volume to 40')?.call.args).toEqual({ level: 40 })
    expect(matchLocalIntent('mute')?.call.args).toEqual({ level: 0 })
    expect(matchLocalIntent('find all pdf files in Downloads')?.call.args).toMatchObject({
      extensions: ['pdf'],
      folder: 'Downloads'
    })
    expect(matchLocalIntent('create a folder called Projects')?.call.args).toEqual({ path: '~/Projects' })
  })

  it('routes a URL to the browser rather than the application launcher', () => {
    expect(matchLocalIntent('open github.com')?.call.name).toBe('open_url')
    expect(matchLocalIntent('open https://example.com')?.call.name).toBe('open_url')
  })

  it('understands the newer capabilities offline too', () => {
    expect(matchLocalIntent("what's taking up all my storage")?.call.name).toBe('find_large_files')
    expect(matchLocalIntent('show me my biggest files')?.call.name).toBe('find_large_files')
    expect(matchLocalIntent('empty the trash')?.call.name).toBe('empty_trash')
    expect(matchLocalIntent("what's on my clipboard")?.call.name).toBe('read_clipboard')
  })

  it('extracts which applications to keep when closing the rest', () => {
    const intent = matchLocalIntent('close everything except Discord and Spotify')
    expect(intent?.call.name).toBe('close_other_applications')
    expect(intent?.call.args).toEqual({ keep: ['Discord', 'Spotify'] })
  })

  it('returns nothing for a request that needs real reasoning', () => {
    for (const text of [
      'prepare my computer for work',
      'clean up my downloads and archive the old stuff',
      'why is my laptop so slow today'
    ]) {
      expect(matchLocalIntent(text), text).toBeNull()
    }
  })

  it('recognises interrupts and bare wake words', () => {
    for (const text of ['stop', 'Stop.', 'cancel', 'never mind', 'be quiet']) {
      expect(isInterrupt(text), text).toBe(true)
    }
    expect(isInterrupt('stop the music')).toBe(false)
    expect(isBareWake('hey jarvis')).toBe(true)
    expect(isBareWake('jarvis')).toBe(true)
    expect(isBareWake('hey jarvis open chrome')).toBe(false)
  })
})

describe('wake phrase matching', () => {
  it('returns the remainder when the phrase leads the utterance', () => {
    expect(matchWakePhrase('hey jarvis open chrome', 'hey jarvis', 0.6)).toBe('open chrome')
    expect(matchWakePhrase('Hey, JARVIS! Open Chrome.', 'hey jarvis', 0.6)).toBe('open chrome')
  })

  it('returns an empty string for a bare wake word', () => {
    expect(matchWakePhrase('hey jarvis', 'hey jarvis', 0.6)).toBe('')
  })

  it('tolerates common mis-transcriptions at higher sensitivity', () => {
    expect(matchWakePhrase('hey jarvus what time is it', 'hey jarvis', 0.8)).toBe('what time is it')
  })

  it('ignores speech that does not contain the phrase', () => {
    expect(matchWakePhrase('the weather looks good today', 'hey jarvis', 0.6)).toBeNull()
    expect(matchWakePhrase('', 'hey jarvis', 1)).toBeNull()
  })

  it('ignores the phrase buried deep in a sentence', () => {
    expect(matchWakePhrase('I was telling Bob about hey jarvis yesterday', 'hey jarvis', 0.2)).toBeNull()
  })
})

describe('settings merge', () => {
  it('keeps defaults for keys the stored file does not have', () => {
    const base = defaultSettings('win32')
    const merged = mergeSettings(base, { ai: { temperature: 0.9 } })
    expect(merged.ai.temperature).toBe(0.9)
    expect(merged.ai.maxToolCalls).toBe(base.ai.maxToolCalls)
    expect(merged.appearance.accent).toBe(base.appearance.accent)
  })

  it('replaces arrays rather than merging them', () => {
    const merged = mergeSettings(defaultSettings('linux'), { automation: { allowedCommands: ['git'] } })
    expect(merged.automation.allowedCommands).toEqual(['git'])
  })

  it('survives a corrupt or hostile stored value', () => {
    const base = defaultSettings('linux')
    expect(mergeSettings(base, null)).toEqual(base)
    expect(mergeSettings(base, 'nonsense')).toEqual(base)
    expect(mergeSettings(base, 42)).toEqual(base)
  })

  it('gives each platform its own protected paths and hotkeys', () => {
    expect(defaultSettings('win32').automation.protectedPaths.some((p) => p.includes('Windows'))).toBe(true)
    expect(defaultSettings('darwin').automation.protectedPaths).toContain('/System')
    expect(defaultSettings('darwin').hotkeys.activate).toContain('Command')
    expect(defaultSettings('win32').hotkeys.activate).toContain('Control')
  })
})

describe('log redaction', () => {
  it('removes API keys from free text', () => {
    expect(redact('key is sk-ant-api03-abcdef123456 ok')).not.toContain('abcdef123456')
    expect(redact('gsk_abcdefghijklmnop')).toBe('[REDACTED]')
    expect(redact('Authorization: Bearer abcdef1234567890')).toContain('[REDACTED]')
  })

  it('removes credential-shaped keys from objects, at any depth', () => {
    const redacted = redact({
      safe: 'visible',
      apiKey: 'sk-ant-secret-value',
      nested: { authorization: 'Bearer xyz', password: 'hunter2', path: '~/Documents' }
    }) as Record<string, unknown>
    expect(redacted.safe).toBe('visible')
    expect(redacted.apiKey).toBe('[REDACTED]')
    expect((redacted.nested as Record<string, unknown>).authorization).toBe('[REDACTED]')
    expect((redacted.nested as Record<string, unknown>).password).toBe('[REDACTED]')
    expect((redacted.nested as Record<string, unknown>).path).toBe('~/Documents')
  })

  it('leaves ordinary values alone', () => {
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
    expect(redact(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('does not recurse forever on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(() => redact(cyclic)).not.toThrow()
  })
})
