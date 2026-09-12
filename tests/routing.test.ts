import { describe, it, expect } from 'vitest'
import { routeRequest, scoreComplexity, type RoutingCandidate } from '../src/main/core/ai/router'
import { PROVIDER_BY_ID } from '../src/shared/providers'
import type { ProviderId } from '../src/shared/providers'

/** Builds a candidate from the real catalogue ranking, so tests track it. */
function candidate(id: ProviderId, options: { available?: boolean; vision?: boolean } = {}): RoutingCandidate {
  const descriptor = PROVIDER_BY_ID.get(id)!
  return {
    id,
    available: options.available ?? true,
    rank: descriptor.rank,
    vision: options.vision ?? descriptor.models.some((model) => model.vision && model.id === descriptor.defaultModel)
  }
}

const both = [candidate('groq'), candidate('gemini')]

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
    const shallow = scoreComplexity('open chrome', { hasToolResults: true, turnIndex: 0 })
    const deep = scoreComplexity('open chrome', { hasToolResults: true, turnIndex: 3 })
    expect(deep).toBeGreaterThan(shallow)
  })
})

describe('routeRequest', () => {
  it('sends a simple command to the fastest provider', () => {
    const decision = routeRequest({ text: 'open chrome', mode: 'auto', candidates: both })
    expect(decision.provider).toBe('groq')
    expect(decision.role).toBe('fast')
    expect(decision.fallback).toBe('gemini')
  })

  it('sends reasoning to the strongest provider', () => {
    const decision = routeRequest({
      text: 'prepare my computer for work and open the project I was editing yesterday',
      mode: 'auto',
      candidates: both
    })
    expect(decision.provider).toBe('gemini')
    expect(decision.role).toBe('reasoning')
  })

  it('sends anything visual to a provider that can see', () => {
    const decision = routeRequest({
      text: 'what is this',
      mode: 'auto',
      candidates: [candidate('groq', { vision: false }), candidate('gemini', { vision: true })],
      needsVision: true
    })
    expect(decision.provider).toBe('gemini')
    expect(decision.role).toBe('vision')
  })

  it('honours a pinned provider', () => {
    expect(
      routeRequest({ text: 'plan a complicated multi-step thing and then do it', mode: 'groq', candidates: both }).provider
    ).toBe('groq')
    expect(routeRequest({ text: 'hi', mode: 'gemini', candidates: both }).provider).toBe('gemini')
  })

  it('overrides a pinned provider that cannot see, and says why', () => {
    const decision = routeRequest({
      text: 'what is on my screen',
      mode: 'groq',
      candidates: [candidate('groq', { vision: false }), candidate('gemini', { vision: true })],
      needsVision: true
    })
    expect(decision.provider).toBe('gemini')
    expect(decision.reason).toMatch(/cannot read images/i)
  })

  it('falls back to whichever provider is configured', () => {
    const onlyGroq = routeRequest({
      text: 'plan my whole work setup and then open everything',
      mode: 'auto',
      candidates: [candidate('groq'), candidate('gemini', { available: false })]
    })
    expect(onlyGroq.provider).toBe('groq')
    expect(onlyGroq.fallback).toBeNull()

    const onlyGemini = routeRequest({
      text: 'open chrome',
      mode: 'auto',
      candidates: [candidate('groq', { available: false }), candidate('gemini')]
    })
    expect(onlyGemini.provider).toBe('gemini')
  })

  it('falls back even when a provider was pinned but is unavailable', () => {
    const decision = routeRequest({
      text: 'open chrome',
      mode: 'gemini',
      candidates: [candidate('groq'), candidate('gemini', { available: false })]
    })
    expect(decision.provider).toBe('groq')
  })

  it('still answers when nothing can see, rather than going silent', () => {
    const decision = routeRequest({
      text: 'what is on my screen',
      mode: 'auto',
      candidates: [candidate('groq', { vision: false })],
      needsVision: true
    })
    expect(decision.provider).toBe('groq')
    expect(decision.reason).toMatch(/no configured provider can read images/i)
  })

  it('returns no provider when none is configured', () => {
    const decision = routeRequest({
      text: 'open chrome',
      mode: 'auto',
      candidates: [candidate('groq', { available: false }), candidate('gemini', { available: false })]
    })
    expect(decision.provider).toBeNull()
    expect(decision.reason).toMatch(/no ai provider/i)
  })

  it('prefers a hosted provider over the local one when both are available', () => {
    const decision = routeRequest({
      text: 'open chrome',
      mode: 'auto',
      candidates: [candidate('groq'), candidate('ollama')]
    })
    expect(decision.provider).toBe('groq')
    expect(decision.fallback).toBe('ollama')
  })

  it('uses the local provider when it is all that is left', () => {
    const decision = routeRequest({
      text: 'plan something complicated and then carry it out',
      mode: 'auto',
      candidates: [candidate('groq', { available: false }), candidate('ollama')]
    })
    expect(decision.provider).toBe('ollama')
  })

  it('always explains its choice', () => {
    expect(routeRequest({ text: 'open chrome', mode: 'auto', candidates: both }).reason.length).toBeGreaterThan(0)
  })
})
