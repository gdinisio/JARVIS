import { describe, it, expect } from 'vitest'
import { decide, describeAction } from '../src/main/core/permissions'
import { defaultSettings } from '../src/shared/defaults'
import type { Settings } from '../src/shared/types'

function settings(patch: (base: Settings) => void = () => undefined): Settings {
  const base = defaultSettings('linux')
  patch(base)
  return base
}

describe('decide', () => {
  it('allows low-risk actions automatically by default', () => {
    const verdict = decide('open_application', { name: 'Chrome' }, settings())
    expect(verdict.action).toBe('allow')
    expect(verdict.risk).toBe('low')
  })

  it('confirms medium-risk actions by default', () => {
    const verdict = decide('move_file', { source: '~/a.txt', destination: '~/b' }, settings())
    expect(verdict.action).toBe('confirm')
    expect(verdict.confirm?.title).toBeTruthy()
  })

  it('always confirms deletion, whatever the settings say', () => {
    const permissive = settings((s) => {
      s.automation.confirmMediumRisk = false
      s.automation.autoRunLowRisk = true
      s.permissions.tools.delete_file = 'allow'
    })
    const verdict = decide('delete_file', { paths: ['~/a.txt', '~/b.txt'] }, permissive)
    expect(verdict.action).toBe('confirm')
    expect(verdict.confirm?.risk).toBe('high')
    expect(verdict.confirm?.details).toContain('~/a.txt')
  })

  it('always confirms a shell command, even inside an approved plan', () => {
    const verdict = decide('execute_command', { command: 'git', args: ['status'] }, settings(), { planApproved: true })
    expect(verdict.action).toBe('confirm')
    expect(verdict.confirm?.details?.some((line) => line.includes('git'))).toBe(true)
  })

  it('says permanent deletion cannot be undone', () => {
    const verdict = decide('delete_file', { paths: ['~/a.txt'], permanent: true }, settings())
    expect(verdict.confirm?.body).toMatch(/cannot be undone/i)
  })

  it('denies a tool the user switched off', () => {
    const locked = settings((s) => {
      s.permissions.tools.open_application = 'deny'
    })
    const verdict = decide('open_application', { name: 'Chrome' }, locked)
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toMatch(/permissions/i)
  })

  it('denies screen tools until screen access is granted', () => {
    expect(decide('read_screen', {}, settings()).action).toBe('deny')
    const allowed = settings((s) => {
      s.permissions.screenAccess = true
    })
    expect(decide('read_screen', {}, allowed).action).toBe('confirm')
  })

  it('denies power tools until they are enabled, then still confirms', () => {
    expect(decide('restart_computer', {}, settings()).action).toBe('deny')
    const allowed = settings((s) => {
      s.automation.allowPower = true
    })
    expect(decide('restart_computer', {}, allowed).action).toBe('confirm')
  })

  it('denies web tools when web access is off', () => {
    const offline = settings((s) => {
      s.permissions.webAccess = false
    })
    expect(decide('open_url', { url: 'https://example.com' }, offline).action).toBe('deny')
  })

  it('denies memory tools when memory is off', () => {
    const forgetful = settings((s) => {
      s.memory.enabled = false
    })
    expect(decide('remember', { key: 'a', value: 'b' }, forgetful).action).toBe('deny')
  })

  it('always confirms closing everything, and names what survives', () => {
    const verdict = decide('close_other_applications', { keep: ['Discord', 'Spotify'] }, settings())
    expect(verdict.action).toBe('confirm')
    expect(verdict.confirm?.risk).toBe('high')
    expect(verdict.confirm?.body).toContain('Discord and Spotify')
  })

  it('warns that emptying the trash cannot be undone', () => {
    const verdict = decide('empty_trash', {}, settings())
    expect(verdict.action).toBe('confirm')
    expect(verdict.confirm?.body).toMatch(/cannot be undone/i)
  })

  it('denies the clipboard until it is switched on', () => {
    expect(decide('read_clipboard', {}, settings()).action).toBe('deny')
    const allowed = settings((s) => {
      s.permissions.clipboardAccess = true
    })
    expect(decide('read_clipboard', {}, allowed).action).toBe('confirm')
  })

  it('treats measuring storage as read-only', () => {
    expect(decide('find_large_files', { folder: '~' }, settings()).action).toBe('allow')
    expect(decide('get_folder_size', { path: '~' }, settings()).action).toBe('allow')
  })

  it('rejects a tool that does not exist', () => {
    const verdict = decide('rm_rf_everything', {}, settings())
    expect(verdict.action).toBe('deny')
    expect(verdict.risk).toBe('high')
  })

  it('lets an approved plan cover medium-risk steps but never high-risk ones', () => {
    expect(decide('create_folder', { path: '~/x' }, settings(), { planApproved: true }).action).toBe('allow')
    expect(decide('delete_file', { paths: ['~/x'] }, settings(), { planApproved: true }).action).toBe('confirm')
  })

  it('confirms everything when the user asks it to', () => {
    const cautious = settings((s) => {
      s.automation.autoRunLowRisk = false
    })
    expect(decide('get_system_stats', {}, cautious).action).toBe('confirm')
  })

  it('respects a per-tool always-allow override for medium risk', () => {
    const trusted = settings((s) => {
      s.permissions.tools.move_file = 'allow'
    })
    expect(decide('move_file', { source: '~/a', destination: '~/b' }, trusted).action).toBe('allow')
  })
})

describe('describeAction', () => {
  it('describes calls in plain language', () => {
    expect(describeAction('open_application', { name: 'Chrome' })).toBe('Open Chrome.')
    expect(describeAction('delete_file', { paths: ['a', 'b', 'c'] })).toBe('Delete 3 item(s).')
    expect(describeAction('set_volume', { level: 40 })).toBe('Set the system volume to 40%.')
    expect(describeAction('execute_command', { command: 'git', args: ['status'] })).toBe('Run git status.')
  })

  it('never throws on unexpected arguments', () => {
    expect(() => describeAction('open_application', {})).not.toThrow()
    expect(() => describeAction('unknown_tool', { a: 1 })).not.toThrow()
  })
})
