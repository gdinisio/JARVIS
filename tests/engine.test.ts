import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent, ProviderId } from '../src/shared/types'
import type { AiRequest, AiResponse } from '../src/main/core/ai/types'
import { ProviderError } from '../src/main/core/ai/types'

/**
 * The engine drives the whole request: routing, the tool-call loop, the
 * confirmation gate, plans and history. These tests stub only the model,
 * so the security layer, tool registry and filesystem are the real ones.
 */

interface Scripted {
  text?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  throws?: ProviderError
}

const scripts: Record<ProviderId, Scripted[]> = { claude: [], groq: [] }
const calls: Array<{ provider: ProviderId; request: AiRequest }> = []
let routeTo: ProviderId = 'claude'
let fallbackTo: ProviderId | null = 'groq'

function makeProvider(id: ProviderId) {
  return {
    id,
    name: id,
    isConfigured: () => true,
    model: () => `${id}-test`,
    supportsVision: () => id === 'claude',
    complete: async (request: AiRequest): Promise<AiResponse> => {
      calls.push({ provider: id, request })
      const next = scripts[id].shift()
      if (!next) return { text: 'Done.', toolCalls: [], provider: id, model: `${id}-test` }
      if (next.throws) throw next.throws
      return {
        text: next.text ?? '',
        toolCalls: next.toolCalls ?? [],
        provider: id,
        model: `${id}-test`
      }
    },
    test: async () => ({ ok: true, message: 'ok' })
  }
}

vi.mock('../src/main/core/ai', () => {
  const claude = makeProvider('claude')
  const groq = makeProvider('groq')
  return {
    providers: {
      claude,
      groq,
      get: (id: ProviderId) => (id === 'claude' ? claude : groq),
      anyConfigured: () => true,
      configuredCount: () => 2,
      isOnline: () => true,
      setOnline: () => undefined,
      route: () => ({ provider: routeTo, fallback: fallbackTo, reason: 'test', complexity: 0 }),
      markFailure: () => undefined,
      markSuccess: () => undefined,
      status: () => ({}),
      broadcast: () => undefined
    }
  }
})

const { engine } = await import('../src/main/core/engine')
const { bus } = await import('../src/main/services/bus')
const { settings } = await import('../src/main/services/settings')
const { history } = await import('../src/main/services/history')

const root = mkdtempSync(join(tmpdir(), 'jarvis-engine-'))

let events: EngineEvent[] = []
const unsubscribe = bus.subscribe((event) => events.push(event))

afterAll(() => {
  unsubscribe()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  events = []
  calls.length = 0
  scripts.claude = []
  scripts.groq = []
  routeTo = 'claude'
  fallbackTo = 'groq'
  engine.clearConversation()
  history.clear()
  settings.reset()
  settings.update({
    general: { onboarded: true, demoMode: false },
    voice: { enabled: false },
    automation: { workspaceRoots: [root] }
  })
})

function of<T extends EngineEvent['type']>(type: T): Array<Extract<EngineEvent, { type: T }>> {
  return events.filter((event) => event.type === type) as Array<Extract<EngineEvent, { type: T }>>
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('engine — plain replies', () => {
  it('answers, records history once, and returns to idle', async () => {
    scripts.claude.push({ text: 'CPU is at 28 percent.' })
    await engine.submit({ text: 'how is my system', source: 'text' })
    await settle()

    const messages = of('message')
    expect(messages).toHaveLength(1)
    expect(messages[0].message.text).toBe('CPU is at 28 percent.')
    expect(messages[0].message.provider).toBe('claude')

    expect(history.list()).toHaveLength(1)
    expect(history.list()[0].outcome).toBe('success')
    expect(history.list()[0].actions).toEqual([])

    const statuses = of('status').map((event) => event.status)
    expect(statuses).toContain('thinking')
    expect(statuses).toContain('complete')
  })

  it('carries the conversation forward between requests', async () => {
    scripts.claude.push({ text: 'Opening Chrome.' })
    await engine.submit({ text: 'open chrome', source: 'text' })
    await settle()

    scripts.claude.push({ text: 'Searching in Chrome.' })
    await engine.submit({ text: 'search for tesla', source: 'text' })
    await settle()

    const lastRequest = calls[calls.length - 1].request
    const texts = lastRequest.messages.flatMap((message) =>
      message.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text)
    )
    expect(texts).toContain('open chrome')
    expect(texts).toContain('search for tesla')
  })

  it('publishes the tool catalogue and a system prompt to the model', async () => {
    scripts.claude.push({ text: 'Done.' })
    await engine.submit({ text: 'hello', source: 'text' })
    await settle()

    const request = calls[0].request
    expect(request.system).toContain('JARVIS')
    expect(request.tools.some((tool) => tool.name === 'present_plan')).toBe(true)
    expect(request.tools.some((tool) => tool.name === 'get_system_stats')).toBe(true)
  })
})

describe('engine — tool calls', () => {
  it('executes a low-risk tool and feeds the result back to the model', async () => {
    scripts.claude.push({ toolCalls: [{ id: 't1', name: 'get_system_stats', args: {} }] })
    scripts.claude.push({ text: 'CPU is fine.' })

    await engine.submit({ text: 'how is my system', source: 'text' })
    await settle(400)

    expect(calls).toHaveLength(2)
    const followUp = calls[1].request.messages.at(-1)
    expect(followUp?.content.some((part) => part.type === 'tool_result')).toBe(true)

    const activity = of('tool').map((event) => event.activity)
    expect(activity.some((item) => item.name === 'get_system_stats' && item.status === 'ok')).toBe(true)
    expect(history.list()[0].actions).toEqual(['get_system_stats'])
  })

  it('creates a real file when the model asks for one', async () => {
    const target = join(root, 'from-model.txt')
    scripts.claude.push({
      toolCalls: [{ id: 't1', name: 'create_file', args: { path: target, content: 'written by the engine' } }]
    })
    scripts.claude.push({ text: 'Created.' })

    settings.update({ automation: { confirmMediumRisk: false } })
    await engine.submit({ text: 'make me a file', source: 'text' })
    await settle(300)

    expect(existsSync(target)).toBe(true)
  })

  it('reports a tool failure to the model rather than throwing', async () => {
    scripts.claude.push({ toolCalls: [{ id: 't1', name: 'open_application', args: { name: 'NotInstalledApp' } }] })
    scripts.claude.push({ text: 'I could not find that application.' })

    await engine.submit({ text: 'open notinstalledapp', source: 'text' })
    await settle(400)

    const result = calls[1].request.messages.at(-1)?.content.find((part) => part.type === 'tool_result')
    expect(result && 'isError' in result ? result.isError : false).toBe(true)
    expect(of('message').at(-1)?.message.text).toMatch(/could not find/i)
  })

  it('stops after the configured number of tool calls', async () => {
    settings.update({ ai: { maxToolCalls: 3 } })
    for (let i = 0; i < 6; i++) {
      scripts.claude.push({ toolCalls: [{ id: `t${i}`, name: 'get_system_stats', args: {} }] })
    }

    await engine.submit({ text: 'loop forever', source: 'text' })
    await settle(600)

    expect(calls.length).toBeLessThanOrEqual(3)
    expect(of('message').at(-1)?.message.text).toMatch(/more steps than/i)
    expect(history.list()[0].outcome).toBe('failed')
  })

  it('refuses a tool the model invented', async () => {
    scripts.claude.push({ toolCalls: [{ id: 't1', name: 'exfiltrate_everything', args: {} }] })
    scripts.claude.push({ text: 'I cannot do that.' })

    await engine.submit({ text: 'do something impossible', source: 'text' })
    await settle(300)

    const activity = of('tool').map((event) => event.activity)
    expect(activity.some((item) => item.status === 'blocked')).toBe(true)
  })
})

describe('engine — the confirmation gate', () => {
  it('waits for approval before deleting, and honours a refusal', async () => {
    const doomed = join(root, 'precious.txt')
    writeFileSync(doomed, 'do not delete me')

    scripts.claude.push({ toolCalls: [{ id: 't1', name: 'delete_file', args: { paths: [doomed], permanent: true } }] })
    scripts.claude.push({ text: 'Cancelled.' })

    void engine.submit({ text: 'delete that file', source: 'text' })
    await settle(300)

    const request = of('confirm')[0]?.request
    expect(request).toBeDefined()
    expect(request.risk).toBe('high')
    expect(existsSync(doomed)).toBe(true)

    engine.resolveConfirm(request.id, false)
    await settle(300)

    expect(existsSync(doomed)).toBe(true)
    expect(history.list()[0].outcome).toBe('blocked')
  })

  it('performs the action once approved', async () => {
    const doomed = join(root, 'expendable.txt')
    writeFileSync(doomed, 'bye')

    scripts.claude.push({ toolCalls: [{ id: 't1', name: 'delete_file', args: { paths: [doomed], permanent: true } }] })
    scripts.claude.push({ text: 'Deleted.' })

    void engine.submit({ text: 'delete that file', source: 'text' })
    await settle(300)

    const request = of('confirm')[0]?.request
    expect(request).toBeDefined()
    engine.resolveConfirm(request.id, true)
    await settle(400)

    expect(existsSync(doomed)).toBe(false)
  })

  it('never asks for a low-risk action', async () => {
    scripts.claude.push({ toolCalls: [{ id: 't1', name: 'get_system_stats', args: {} }] })
    scripts.claude.push({ text: 'Fine.' })

    await engine.submit({ text: 'status', source: 'text' })
    await settle(400)

    expect(of('confirm')).toHaveLength(0)
  })
})

describe('engine — plans', () => {
  it('shows a plan and waits for approval before acting', async () => {
    scripts.claude.push({
      toolCalls: [
        {
          id: 'p1',
          name: 'present_plan',
          args: { title: 'Preparing work environment', steps: ['Open the editor', 'Open the browser'], requires_approval: true }
        }
      ]
    })
    scripts.claude.push({ text: 'Cancelled.' })

    void engine.submit({ text: 'prepare my computer for work', source: 'text' })
    await settle(300)

    const plan = of('plan').map((event) => event.plan).filter(Boolean)[0]
    expect(plan?.title).toBe('Preparing work environment')
    expect(plan?.steps).toHaveLength(2)

    const request = of('confirm')[0]?.request
    expect(request?.details).toContain('Open the editor')

    engine.resolveConfirm(request.id, false)
    await settle(300)
    expect(history.list()[0].outcome).toBe('cancelled')
  })

  it('advances the plan as steps execute', async () => {
    scripts.claude.push({
      toolCalls: [{ id: 'p1', name: 'present_plan', args: { title: 'Check the machine', steps: ['Read metrics'] } }]
    })
    scripts.claude.push({ toolCalls: [{ id: 't1', name: 'get_system_stats', args: {} }] })
    scripts.claude.push({ text: 'All nominal.' })

    await engine.submit({ text: 'check everything and report', source: 'text' })
    await settle(500)

    const steps = of('plan-step').map((event) => event.status)
    expect(steps).toContain('running')
    expect(steps).toContain('done')
  })
})

describe('engine — provider failure', () => {
  it('falls back to the other provider on a transient failure', async () => {
    scripts.claude.push({ throws: new ProviderError('overloaded', 'overloaded', 'claude', true) })
    scripts.groq.push({ text: 'Answered by the fallback.' })

    await engine.submit({ text: 'hello', source: 'text' })
    await settle(300)

    expect(calls.map((call) => call.provider)).toEqual(['claude', 'groq'])
    expect(of('message').at(-1)?.message.text).toBe('Answered by the fallback.')
  })

  it('does not fall back when automatic fallback is switched off', async () => {
    settings.update({ ai: { autoFallback: false } })
    scripts.claude.push({ throws: new ProviderError('overloaded', 'overloaded', 'claude', true) })

    await engine.submit({ text: 'hello', source: 'text' })
    await settle(300)

    expect(calls.map((call) => call.provider)).toEqual(['claude'])
    expect(history.list()[0].outcome).toBe('failed')
  })

  it('explains an authentication failure instead of crashing', async () => {
    fallbackTo = null
    scripts.claude.push({ throws: new ProviderError('bad key', 'auth', 'claude', false) })

    await engine.submit({ text: 'hello', source: 'text' })
    await settle(300)

    expect(of('message').at(-1)?.message.text).toMatch(/key was rejected/i)
    expect(history.list()[0].outcome).toBe('failed')
  })
})

describe('engine — local handling', () => {
  it('answers a bare wake word without calling a model', async () => {
    await engine.submit({ text: 'Hey JARVIS', source: 'voice' })
    await settle()
    expect(calls).toHaveLength(0)
    expect(of('message').at(-1)?.message.text).toBe('Online.')
  })

  it('treats "stop" as an interrupt, not a request', async () => {
    await engine.submit({ text: 'stop', source: 'voice' })
    await settle()
    expect(calls).toHaveLength(0)
    expect(of('stop-speaking')).toHaveLength(1)
    expect(history.list()).toHaveLength(0)
  })
})
