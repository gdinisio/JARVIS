/**
 * The provider catalogue.
 *
 * Every backend JARVIS speaks to exposes an OpenAI-compatible chat API, so a
 * provider is data rather than code: a base URL, a key, and what it can do.
 * Adding one is an entry in this list.
 *
 * Only providers with a genuinely free tier are listed. "Free" here means a
 * key you can obtain with an email address and no payment method — trials
 * that require a card are not included.
 */

export type ProviderId = 'groq' | 'gemini' | 'openrouter' | 'ollama' | 'custom'

export type ProviderRole = 'fast' | 'reasoning' | 'vision'

export interface ProviderModel {
  id: string
  label: string
  /** Accepts image input. */
  vision?: boolean
  /** Suited to short, latency-sensitive turns. */
  fast?: boolean
  /** Suited to planning and multi-step work. */
  reasoning?: boolean
}

export interface ProviderDescriptor {
  id: ProviderId
  name: string
  /** One line shown in Settings, describing what the free tier actually gives. */
  freeTier: string
  /** Where to get a key. */
  signupUrl: string
  /** OpenAI-compatible base URL. */
  baseUrl: string
  /** Environment variable read at startup. Empty when no key is needed. */
  envVar: string
  /** False for local backends, which need no credential. */
  requiresKey: boolean
  /** True when the backend runs on this machine, so it works with no network. */
  local?: boolean
  models: ProviderModel[]
  defaultModel: string
  /** Speech-to-text model, when the provider offers one. */
  transcriptionModel?: string
  /** Text-to-speech model and its voices, when offered. */
  speechModel?: string
  speechVoices?: Array<{ value: string; label: string }>
  /** Headers some providers ask for, such as attribution. */
  headers?: Record<string, string>
  /** How strong a candidate this is for each role; higher wins. */
  rank: Record<ProviderRole, number>
}

/**
 * Matches model ids that are not conversational — speech models, safety
 * classifiers, embeddings. A provider's live model list contains these
 * alongside chat models, and offering them as the assistant's brain would
 * simply fail at request time.
 */
const NON_CHAT = /(whisper|tts|orpheus|speech|embed|rerank|guard|safeguard|moderation|vision-encoder)/i

export function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id)
}

export const PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'groq',
    name: 'Groq',
    freeTier: 'Free, no card. Roughly 30 requests a minute. Also provides speech recognition and the neural voice.',
    signupUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    envVar: 'GROQ_API_KEY',
    requiresKey: true,
    defaultModel: 'openai/gpt-oss-120b',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B — recommended', fast: true, reasoning: true },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — fastest', fast: true },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B', fast: true, reasoning: true },
      { id: 'groq/compound', label: 'Compound — built-in web search', reasoning: true },
      { id: 'groq/compound-mini', label: 'Compound Mini — built-in web search', fast: true }
    ],
    transcriptionModel: 'whisper-large-v3-turbo',
    speechModel: 'canopylabs/orpheus-v1-english',
    speechVoices: [
      { value: 'troy', label: 'Troy — low, measured' },
      { value: 'daniel', label: 'Daniel — even, neutral' },
      { value: 'austin', label: 'Austin — warm, relaxed' },
      { value: 'autumn', label: 'Autumn — clear, bright' },
      { value: 'diana', label: 'Diana — calm, precise' },
      { value: 'hannah', label: 'Hannah — light, quick' }
    ],
    // The fastest useful inference available for free, by a wide margin.
    rank: { fast: 100, reasoning: 60, vision: 40 }
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    freeTier: 'Free from Google AI Studio, no card. Large context, and the only free option here that reads the screen well.',
    signupUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    envVar: 'GEMINI_API_KEY',
    requiresKey: true,
    defaultModel: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash — recommended', vision: true, fast: true, reasoning: true },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', vision: true, fast: true, reasoning: true },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', vision: true, fast: true, reasoning: true }
    ],
    // Best free reasoning, and the only dependable free vision.
    rank: { fast: 55, reasoning: 100, vision: 100 }
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    freeTier: 'Free models, no card, but only about 50 requests a day. Useful as a fallback rather than a main engine.',
    signupUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    requiresKey: true,
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)', fast: true, reasoning: true },
      { id: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash (free)', vision: true, fast: true },
      { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder (free)', reasoning: true },
      { id: 'mistralai/mistral-small-3.2-24b-instruct:free', label: 'Mistral Small 3.2 (free)', fast: true }
    ],
    headers: {
      'HTTP-Referer': 'https://github.com/gdinisio/JARVIS',
      'X-Title': 'JARVIS'
    },
    // Genuinely free, but the daily cap makes it a poor primary.
    rank: { fast: 30, reasoning: 45, vision: 35 }
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    freeTier: 'Runs entirely on this computer. No key, no account, no network, no limits — you supply the hardware.',
    signupUrl: 'https://ollama.com/download',
    baseUrl: 'http://127.0.0.1:11434/v1',
    envVar: '',
    requiresKey: false,
    local: true,
    defaultModel: 'llama3.2',
    models: [
      { id: 'llama3.2', label: 'Llama 3.2 3B — light', fast: true },
      { id: 'llama3.1:8b', label: 'Llama 3.1 8B', fast: true, reasoning: true },
      { id: 'qwen3:8b', label: 'Qwen3 8B', fast: true, reasoning: true },
      { id: 'qwen2.5:14b', label: 'Qwen2.5 14B', reasoning: true },
      { id: 'llama3.2-vision', label: 'Llama 3.2 Vision — sees images', vision: true },
      { id: 'mistral', label: 'Mistral 7B', fast: true }
    ],
    // Slower on typical hardware, but private and always available.
    rank: { fast: 20, reasoning: 25, vision: 20 }
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    freeTier: 'Any other OpenAI-compatible server — a self-hosted model, a company gateway, or a provider not listed here.',
    signupUrl: '',
    baseUrl: '',
    envVar: 'JARVIS_CUSTOM_API_KEY',
    requiresKey: false,
    defaultModel: '',
    models: [],
    rank: { fast: 10, reasoning: 10, vision: 10 }
  }
]

export const PROVIDER_BY_ID = new Map<ProviderId, ProviderDescriptor>(PROVIDERS.map((p) => [p.id, p]))

export function providerDescriptor(id: ProviderId): ProviderDescriptor {
  const descriptor = PROVIDER_BY_ID.get(id)
  if (!descriptor) throw new Error(`Unknown provider: ${id}`)
  return descriptor
}

/** True when the named model on that provider accepts images. */
export function modelSupportsVision(id: ProviderId, model: string): boolean {
  const descriptor = PROVIDER_BY_ID.get(id)
  if (!descriptor) return false
  const known = descriptor.models.find((entry) => entry.id === model)
  if (known) return !!known.vision
  // An unlisted model on a vision-capable provider is assumed capable only
  // when every listed model is.
  return descriptor.models.length > 0 && descriptor.models.every((entry) => entry.vision)
}

/** Providers that can transcribe speech. */
export function transcriptionProviders(): ProviderDescriptor[] {
  return PROVIDERS.filter((provider) => provider.transcriptionModel)
}

/** Providers that can synthesise speech. */
export function speechProviders(): ProviderDescriptor[] {
  return PROVIDERS.filter((provider) => provider.speechModel)
}
