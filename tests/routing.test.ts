import { describe, it, expect } from 'vitest'
import { routeRequest, scoreComplexity } from '../src/main/core/ai/router'

const both = { claudeAvailable: true, groqAvailable: true, mode: 'auto' as const }

describe('scoreComplexity', () => {
  it('scores short, obvious commands low', () => {
    for (const text of ['open chrome', 'hey jarvis', 'thanks', 'lock my computer', 'volume 40']) {
      expect(scoreComplexity(text), text).toBeLessThan(3)
    }
  })

  it('scores multi-step and ambiguous requests high', () => {
    for (const text of [
      'prepare my computer for work and open the project I was on yesterday',
      'clean up my downloads folder and archive anything older than six months',
      'close everything except Discord and Spotify, then start my game',
      'why is my computer slow, and what should I do about it'
    ]) {
      expect(scoreComplexity(text), text).toBeGreaterThanOrEqual(3)
    }
  })

  it('treats an empty utterance as trivial', () => {
    expect(scoreComplexity('   ')).toBe(0)
  })

  it('raises the score once a conversation is several tool calls deep', () => {
    const text = 'open chrome'
    const shallow = scoreComplexity(text, { hasToolResults: true, turnIndex: 0 })
    const deep = scoreComplexity(text, { hasToolResults: true, turnIndex: 3 })
    expect(deep).toBeGreaterThan(shallow)
  })
})

describe('routeRequest', () => {
  it('sends simple requests to Groq', () => {
    const decision = routeRequest({ text: 'open chrome', ...both })
    expect(decision.provider).toBe('groq')
    expect(decision.fallback).toBe('claude')
  })

  it('sends reasoning to Claude', () => {
    const decision = routeRequest({
      text: 'prepare my computer for work and open the project I was editing yesterday',
      ...both
    })
    expect(decision.provider).toBe('claude')
    expect(decision.fallback).toBe('groq')
  })

  it('sends anything visual to Claude', () => {
    const decision = routeRequest({ text: 'what is this', ...both, needsVision: true })
    expect(decision.provider).toBe('claude')
  })

  it('honours a manual override in both directions', () => {
    expect(routeRequest({ text: 'plan a complicated multi-step thing and then do it', ...both, mode: 'groq' }).provider).toBe('groq')
    expect(routeRequest({ text: 'hi', ...both, mode: 'claude' }).provider).toBe('claude')
  })

  it('falls back to whichever provider is configured', () => {
    const noClaude = routeRequest({ text: 'plan my whole work setup and then open everything', mode: 'auto', claudeAvailable: false, groqAvailable: true })
    expect(noClaude.provider).toBe('groq')
    expect(noClaude.fallback).toBeNull()

    const noGroq = routeRequest({ text: 'open chrome', mode: 'auto', claudeAvailable: true, groqAvailable: false })
    expect(noGroq.provider).toBe('claude')
  })

  it('falls back even when a provider was chosen manually', () => {
    const decision = routeRequest({ text: 'open chrome', mode: 'claude', claudeAvailable: false, groqAvailable: true })
    expect(decision.provider).toBe('groq')
  })

  it('returns no provider when none is configured', () => {
    const decision = routeRequest({ text: 'open chrome', mode: 'auto', claudeAvailable: false, groqAvailable: false })
    expect(decision.provider).toBeNull()
    expect(decision.reason).toMatch(/no ai provider/i)
  })

  it('always explains its choice', () => {
    expect(routeRequest({ text: 'open chrome', ...both }).reason.length).toBeGreaterThan(0)
  })
})
