import { describe, it, expect } from 'vitest'
import { normaliseError } from '../src/main/core/ai/claude'
import { ProviderError } from '../src/main/core/ai/types'
import { providers } from '../src/main/core/ai'

describe('provider error handling', () => {
  it('maps HTTP status codes onto actionable failures', () => {
    expect(normaliseError({ status: 401 }, 'claude').kind).toBe('auth')
    expect(normaliseError({ status: 403 }, 'claude').kind).toBe('auth')
    expect(normaliseError({ status: 429 }, 'groq').kind).toBe('rate-limit')
    expect(normaliseError({ status: 400, message: 'bad request' }, 'claude').kind).toBe('invalid')
    expect(normaliseError({ status: 503 }, 'claude').kind).toBe('overloaded')
  })

  it('recognises network failures', () => {
    for (const message of ['fetch failed', 'getaddrinfo ENOTFOUND api.example', 'connect ECONNREFUSED']) {
      expect(normaliseError(new Error(message), 'groq').kind, message).toBe('network')
    }
  })

  it('marks transient failures retryable and permanent ones not', () => {
    expect(normaliseError({ status: 429 }, 'groq').retryable).toBe(true)
    expect(normaliseError({ status: 503 }, 'groq').retryable).toBe(true)
    expect(normaliseError({ status: 401 }, 'groq').retryable).toBe(false)
    expect(normaliseError({ status: 400, message: 'schema' }, 'groq').retryable).toBe(false)
  })

  it('never leaks an API key through an error message', () => {
    const error = normaliseError(new Error('request failed with key sk-ant-api03-supersecret'), 'claude')
    expect(error.message).not.toContain('supersecret')
    expect(error.message).toContain('[REDACTED]')
  })

  it('passes an existing ProviderError through untouched', () => {
    const original = new ProviderError('already normalised', 'auth', 'groq', false)
    expect(normaliseError(original, 'claude')).toBe(original)
  })

  it('produces short spoken explanations', () => {
    expect(new ProviderError('x', 'auth', 'claude', false).spoken()).toMatch(/Claude/)
    expect(new ProviderError('x', 'rate-limit', 'groq', true).spoken()).toMatch(/rate limit/i)
    expect(new ProviderError('x', 'network', 'groq', true).spoken()).toMatch(/network/i)
    for (const kind of ['auth', 'rate-limit', 'network', 'overloaded', 'invalid', 'unknown'] as const) {
      expect(new ProviderError('fallback message', kind, 'claude', false).spoken().length).toBeGreaterThan(4)
    }
  })
})

describe('provider manager', () => {
  it('reports an honest status with no keys configured', () => {
    const status = providers.status()
    expect(status.claude.configured).toBe(false)
    expect(status.groq.configured).toBe(false)
    expect(status.mode).toBe('auto')
  })

  it('routes to nothing when no provider is available', () => {
    expect(providers.route('open chrome').provider).toBeNull()
  })

  it('tracks online state', () => {
    providers.setOnline(false)
    expect(providers.status().online).toBe(false)
    providers.setOnline(true)
    expect(providers.status().online).toBe(true)
  })

  it('takes a provider out of rotation only for permanent failures', () => {
    providers.markFailure('claude', 'bad key', false)
    expect(providers.status().claude.ok).toBe(false)
    providers.markSuccess('claude')
    expect(providers.status().claude.ok).toBe(true)

    providers.markFailure('groq', 'temporary blip', true)
    expect(providers.status().groq.ok).toBe(true)
    providers.markSuccess('groq')
  })

  it('exposes which models are in use', () => {
    const status = providers.status()
    expect(status.claude.model).toMatch(/claude/)
    expect(status.groq.model.length).toBeGreaterThan(3)
  })
})
