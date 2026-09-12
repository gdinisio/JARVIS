import { describe, it, expect } from 'vitest'
import { normaliseError } from '../src/main/core/ai/openai-compatible'
import { ProviderError } from '../src/main/core/ai/types'
import { providers } from '../src/main/core/ai'
import { PROVIDERS, PROVIDER_BY_ID, modelSupportsVision, transcriptionProviders, speechProviders } from '../src/shared/providers'

describe('provider catalogue', () => {
  it('offers only providers with a genuinely free tier', () => {
    for (const provider of PROVIDERS) {
      expect(provider.freeTier.length, provider.id).toBeGreaterThan(20)
      expect(provider.name.length, provider.id).toBeGreaterThan(2)
    }
  })

  it('gives every keyed provider an endpoint, a key name and a default model', () => {
    for (const provider of PROVIDERS.filter((entry) => entry.id !== 'custom')) {
      expect(provider.baseUrl, provider.id).toMatch(/^https?:\/\//)
      expect(provider.defaultModel.length, provider.id).toBeGreaterThan(0)
      expect(provider.models.some((model) => model.id === provider.defaultModel), provider.id).toBe(true)
      if (provider.requiresKey) expect(provider.envVar, provider.id).toMatch(/_API_KEY$/)
    }
  })

  it('requires no key for the local backend', () => {
    const ollama = PROVIDER_BY_ID.get('ollama')
    expect(ollama?.requiresKey).toBe(false)
    expect(ollama?.local).toBe(true)
    expect(ollama?.baseUrl).toMatch(/127\.0\.0\.1|localhost/)
  })

  it('knows which models can see', () => {
    expect(modelSupportsVision('gemini', 'gemini-3.8-flash')).toBe(true)
    expect(modelSupportsVision('groq', 'llama-3.3-70b-versatile')).toBe(false)
    expect(modelSupportsVision('groq', 'meta-llama/llama-4-scout-17b-16e-instruct')).toBe(true)
    expect(modelSupportsVision('ollama', 'llama3.2-vision')).toBe(true)
  })

  it('nominates exactly one provider for speech in and out', () => {
    expect(transcriptionProviders().map((p) => p.id)).toEqual(['groq'])
    expect(speechProviders().map((p) => p.id)).toEqual(['groq'])
  })

  it('ranks each provider for every role', () => {
    for (const provider of PROVIDERS) {
      for (const role of ['fast', 'reasoning', 'vision'] as const) {
        expect(provider.rank[role], `${provider.id}.${role}`).toBeGreaterThanOrEqual(0)
        expect(provider.rank[role], `${provider.id}.${role}`).toBeLessThanOrEqual(100)
      }
    }
  })

  it('puts Groq ahead for speed and Gemini ahead for reasoning and vision', () => {
    const groq = PROVIDER_BY_ID.get('groq')!
    const gemini = PROVIDER_BY_ID.get('gemini')!
    expect(groq.rank.fast).toBeGreaterThan(gemini.rank.fast)
    expect(gemini.rank.reasoning).toBeGreaterThan(groq.rank.reasoning)
    expect(gemini.rank.vision).toBeGreaterThan(groq.rank.vision)
  })
})

describe('provider error handling', () => {
  it('maps HTTP status codes onto actionable failures', () => {
    expect(normaliseError({ status: 401 }, 'groq').kind).toBe('auth')
    expect(normaliseError({ status: 403 }, 'groq').kind).toBe('auth')
    expect(normaliseError({ status: 429 }, 'gemini').kind).toBe('rate-limit')
    expect(normaliseError({ status: 404 }, 'groq').kind).toBe('invalid')
    expect(normaliseError({ status: 400, message: 'bad request' }, 'groq').kind).toBe('invalid')
    expect(normaliseError({ status: 503 }, 'groq').kind).toBe('overloaded')
  })

  it('says which provider hit its free limit', () => {
    expect(normaliseError({ status: 429 }, 'openrouter', 'OpenRouter').message).toMatch(/OpenRouter/)
    expect(normaliseError({ status: 429 }, 'openrouter', 'OpenRouter').message).toMatch(/free tier/i)
  })

  it('recognises network failures', () => {
    for (const message of ['fetch failed', 'getaddrinfo ENOTFOUND api.example', 'connect ECONNREFUSED']) {
      expect(normaliseError(new Error(message), 'groq').kind, message).toBe('network')
    }
  })

  it('tells the user to start Ollama rather than blaming the network', () => {
    const error = normaliseError(new Error('connect ECONNREFUSED 127.0.0.1:11434'), 'ollama')
    expect(error.kind).toBe('network')
    expect(error.message).toMatch(/ollama serve/i)
  })

  it('marks transient failures retryable and permanent ones not', () => {
    expect(normaliseError({ status: 429 }, 'groq').retryable).toBe(true)
    expect(normaliseError({ status: 503 }, 'groq').retryable).toBe(true)
    expect(normaliseError({ status: 401 }, 'groq').retryable).toBe(false)
    expect(normaliseError({ status: 400, message: 'schema' }, 'groq').retryable).toBe(false)
  })

  it('never leaks an API key through an error message', () => {
    for (const key of ['gsk_supersecretvalue123', 'AIza-supersecretvalue123', 'sk-or-supersecretvalue123']) {
      const error = normaliseError(new Error(`request failed with key ${key}`), 'groq')
      expect(error.message, key).not.toContain('supersecretvalue123')
      expect(error.message, key).toContain('[REDACTED]')
    }
  })

  it('passes an existing ProviderError through untouched', () => {
    const original = new ProviderError('already normalised', 'auth', 'groq', false)
    expect(normaliseError(original, 'gemini')).toBe(original)
  })

  it('produces short spoken explanations for every failure kind', () => {
    for (const kind of ['auth', 'rate-limit', 'network', 'overloaded', 'invalid', 'unknown'] as const) {
      expect(new ProviderError('fallback message', kind, 'groq', false).spoken().length).toBeGreaterThan(4)
    }
    expect(new ProviderError('x', 'rate-limit', 'groq', true).spoken()).toMatch(/free tier/i)
  })
})

describe('provider manager', () => {
  it('reports an honest status with no keys configured', () => {
    const status = providers.status()
    expect(status.mode).toBe('auto')
    for (const provider of PROVIDERS.filter((entry) => entry.requiresKey)) {
      expect(status.providers[provider.id]?.configured, provider.id).toBe(false)
    }
  })

  it('routes to nothing when no provider is available', () => {
    expect(providers.route('open chrome').provider).toBeNull()
  })

  it('does not treat a local backend as available until it has answered', () => {
    // A base URL existing is not evidence that anything is listening on it.
    expect(providers.get('ollama').isConfigured()).toBe(false)
    expect(providers.status().providers.ollama.configured).toBe(false)
  })

  it('marks a local backend unavailable when the probe fails', async () => {
    const reachable = await providers.get('ollama').probe()
    expect(reachable).toBe(false)
    expect(providers.get('ollama').isConfigured()).toBe(false)
  })

  it('tracks online state', () => {
    providers.setOnline(false)
    expect(providers.status().online).toBe(false)
    providers.setOnline(true)
    expect(providers.status().online).toBe(true)
  })

  it('takes a provider out of rotation only for permanent failures', () => {
    providers.markFailure('groq', 'bad key', false)
    expect(providers.status().providers.groq.ok).toBe(false)
    providers.markSuccess('groq')
    expect(providers.status().providers.groq.ok).toBe(true)

    providers.markFailure('gemini', 'temporary blip', true)
    expect(providers.status().providers.gemini.ok).toBe(true)
    providers.markSuccess('gemini')
  })

  it('exposes a model and capability flags for each provider', () => {
    const status = providers.status()
    expect(status.providers.groq.model.length).toBeGreaterThan(3)
    expect(status.providers.gemini.vision).toBe(true)
    expect(status.providers.ollama.local).toBe(true)
  })
})
