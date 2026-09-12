import OpenAI from 'openai'
import type { ToolCallRequest, ToolDescriptor } from '@shared/types'
import type { ProviderDescriptor, ProviderId } from '@shared/providers'
import { modelSupportsVision, isChatModel } from '@shared/providers'
import type { AIProvider, AiMessage, AiRequest, AiResponse, ProviderTestResult } from './types'
import { ProviderError } from './types'
import { secrets } from '../../services/secrets'
import { logger } from '../../services/logging'
import { settings } from '../../services/settings'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

/**
 * One provider implementation for every backend.
 *
 * Groq, Google Gemini, OpenRouter, a local Ollama and any self-hosted server
 * all speak the OpenAI chat API, so the differences between them are data —
 * a base URL, a key and a model list — rather than code. See
 * `shared/providers.ts` for the catalogue.
 */
export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI | null = null
  private clientKey: string | null = null
  private clientBaseUrl: string | null = null
  /**
   * Whether a local backend actually answered. Null until probed, and treated
   * as unavailable until proven otherwise — a URL existing is not evidence
   * that anything is listening on it.
   */
  private reachable: boolean | null = null
  /**
   * Chat models the account can actually use, as reported by the provider.
   * Null until fetched. Providers retire models, so a hardcoded list is a
   * guess with an expiry date; this is the authority when available.
   */
  private available: string[] | null = null

  constructor(readonly descriptor: ProviderDescriptor) {}

  get id(): ProviderId {
    return this.descriptor.id
  }

  get name(): string {
    return this.descriptor.name
  }

  /**
   * A keyed provider is configured when it has a key; a local one only when
   * it has answered a probe.
   */
  isConfigured(): boolean {
    if (!this.baseUrl()) return false
    if (this.descriptor.requiresKey) return !!this.apiKey()
    return this.reachable === true
  }

  /**
   * Checks whether a local backend is actually running.
   *
   * Cheap (localhost, short timeout) and safe to call repeatedly; hosted
   * providers are assumed reachable and are judged by real requests instead.
   */
  async probe(): Promise<boolean> {
    if (this.descriptor.requiresKey) return this.isConfigured()
    if (!this.baseUrl()) {
      this.reachable = false
      return false
    }
    try {
      await this.sdk().models.list({ timeout: 2500, maxRetries: 0 })
      if (this.reachable !== true) logger.info(this.id, 'Local backend detected.', { baseUrl: this.baseUrl() })
      this.reachable = true
    } catch {
      this.reachable = false
    }
    return this.reachable
  }

  /**
    * The model to use.
    *
    * Prefers what the user chose, then the catalogue default, but never
    * returns a model the provider has told us it does not serve: a
    * deprecation should degrade to a working model, not to an error.
    */
  model(): string {
    const configured = settings.get().ai.models?.[this.id]
    const preferred = configured || this.descriptor.defaultModel
    if (!this.available || this.available.includes(preferred)) return preferred

    const substitute =
      this.descriptor.models.find((entry) => this.available!.includes(entry.id))?.id ?? this.available[0]
    if (substitute) {
      logger.warn(this.id, 'Configured model is unavailable; using an available one.', {
        configured: preferred,
        using: substitute
      })
      return substitute
    }
    return preferred
  }

  /** Models the provider reports, once known. */
  knownModels(): string[] | null {
    return this.available
  }

  /** True when the chosen model is one the provider does not serve. */
  configuredModelMissing(): boolean {
    const preferred = settings.get().ai.models?.[this.id] || this.descriptor.defaultModel
    return !!this.available && !this.available.includes(preferred)
  }

  supportsVision(): boolean {
    return modelSupportsVision(this.id, this.model())
  }

  private apiKey(): string | null {
    if (!this.descriptor.envVar) return null
    return secrets.get(this.descriptor.envVar)
  }

  private baseUrl(): string {
    // A custom endpoint has no built-in URL; the user supplies it.
    const override = settings.get().ai.baseUrls?.[this.id]
    return (override || this.descriptor.baseUrl).trim()
  }

  sdk(): OpenAI {
    const key = this.apiKey()
    const baseURL = this.baseUrl()

    if (!baseURL) {
      throw new ProviderError(`${this.name} has no endpoint configured.`, 'auth', this.id, false)
    }
    if (this.descriptor.requiresKey && !key) {
      throw new ProviderError(`No ${this.name} API key is configured.`, 'auth', this.id, false)
    }

    if (!this.client || this.clientKey !== key || this.clientBaseUrl !== baseURL) {
      this.client = new OpenAI({
        // Local servers ignore the key but the client requires a non-empty one.
        apiKey: key ?? 'not-needed',
        baseURL,
        maxRetries: 1,
        timeout: this.descriptor.local ? 180_000 : 60_000,
        ...(this.descriptor.headers ? { defaultHeaders: this.descriptor.headers } : {})
      })
      this.clientKey = key
      this.clientBaseUrl = baseURL
    }
    return this.client
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const model = this.model()
    const vision = this.supportsVision()

    const messages: ChatMessage[] = [{ role: 'system', content: request.system }]
    for (const message of request.messages) messages.push(...toChatMessages(message, vision))

    try {
      const response = await this.sdk().chat.completions.create(
        {
          model,
          messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.tools.length ? { tools: request.tools.map(toChatTool), tool_choice: 'auto' as const } : {})
        },
        { signal: request.signal }
      )

      const choice = response.choices?.[0]
      const toolCalls: ToolCallRequest[] = (choice?.message?.tool_calls ?? []).flatMap((call) => {
        if (!('function' in call) || !call.function) return []
        let args: Record<string, unknown> = {}
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
        } catch {
          // Malformed arguments are a model error, not a crash.
          logger.warn(this.id, 'Tool arguments were not valid JSON.', { tool: call.function.name })
          return []
        }
        return [{ id: call.id, name: call.function.name, args }]
      })

      return {
        text: (choice?.message?.content ?? '').trim(),
        toolCalls,
        provider: this.id,
        model,
        stopReason: choice?.finish_reason ?? undefined,
        usage: response.usage
          ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
          : undefined
      }
    } catch (error) {
      throw normaliseError(error, this.id, this.name)
    }
  }

  async test(): Promise<ProviderTestResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        message: this.descriptor.requiresKey
          ? `No ${this.name} API key is configured.`
          : `${this.name} has no endpoint configured.`
      }
    }
    const started = Date.now()
    try {
      const response = await this.sdk().chat.completions.create({
        model: this.model(),
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: online' }]
      })
      logger.info(this.id, 'Connectivity test succeeded.', { model: this.model() })
      return {
        ok: true,
        message: `Connected. ${(response.choices?.[0]?.message?.content ?? 'Responding.').trim().slice(0, 40)}`,
        latencyMs: Date.now() - started,
        model: this.model()
      }
    } catch (error) {
      const normalised = normaliseError(error, this.id, this.name)
      logger.warn(this.id, 'Connectivity test failed.', { kind: normalised.kind })
      return { ok: false, message: normalised.message, latencyMs: Date.now() - started, model: this.model() }
    }
  }

  /**
    * Asks the provider which models this account can use, and caches the
    * answer. Non-chat models (speech, guards, embeddings) are filtered out.
    */
  async availableModels(): Promise<string[]> {
    try {
      const response = await this.sdk().models.list()
      const ids = response.data.map((entry) => entry.id).filter(isChatModel).sort()
      if (ids.length) this.available = ids
      return ids
    } catch (error) {
      logger.debug(this.id, 'Model list unavailable.', { error: String(error) })
      return this.available ?? []
    }
  }

  /* ─────────────────────────────── Speech ──────────────────────────────── */

  async transcribe(audio: Buffer, filename: string, language?: string): Promise<{ text: string; durationMs: number }> {
    const model = this.descriptor.transcriptionModel
    if (!model) throw new ProviderError(`${this.name} does not transcribe audio.`, 'invalid', this.id, false)

    const started = Date.now()
    try {
      const file = new File([new Uint8Array(audio)], filename, { type: mimeFor(filename) })
      const response = await this.sdk().audio.transcriptions.create({
        file,
        model,
        ...(language ? { language: language.slice(0, 2) } : {}),
        temperature: 0,
        response_format: 'json'
      })
      return { text: (response.text ?? '').trim(), durationMs: Date.now() - started }
    } catch (error) {
      throw normaliseError(error, this.id, this.name)
    }
  }

  async synthesise(
    text: string,
    options: { voice?: string; speed?: number } = {}
  ): Promise<{ audio: Buffer; mimeType: string; durationMs: number }> {
    const model = this.descriptor.speechModel
    if (!model) throw new ProviderError(`${this.name} does not synthesise speech.`, 'invalid', this.id, false)

    // A voice name saved before the provider changed its speech model would
    // be rejected outright; fall back to one this model actually offers.
    const voices = this.descriptor.speechVoices ?? []
    const requested = options.voice
    const voice = requested && voices.some((entry) => entry.value === requested) ? requested : voices[0]?.value ?? 'troy'

    const started = Date.now()
    try {
      const response = await this.sdk().audio.speech.create({
        model,
        voice,
        input: text.slice(0, 4000),
        response_format: 'wav',
        speed: Math.max(0.5, Math.min(5, options.speed ?? 1))
      })
      const audio = Buffer.from(await response.arrayBuffer())
      if (!audio.length) throw new ProviderError('The speech service returned no audio.', 'invalid', this.id, false)
      return { audio, mimeType: 'audio/wav', durationMs: Date.now() - started }
    } catch (error) {
      throw normaliseSpeechError(error, this.id, this.name)
    }
  }
}

/* ──────────────────────────── Message mapping ───────────────────────────── */

function toChatTool(tool: ToolDescriptor): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters.properties,
        required: tool.parameters.required ?? []
      } as Record<string, unknown>
    }
  }
}

/** Maps the shared message shape onto OpenAI-style chat messages. */
function toChatMessages(message: AiMessage, vision: boolean): ChatMessage[] {
  const out: ChatMessage[] = []

  if (message.role === 'assistant') {
    const text = message.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
    const toolUses = message.content.filter((c) => c.type === 'tool_use') as Array<{
      id: string
      name: string
      input: Record<string, unknown>
    }>
    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolUses.length
        ? {
            tool_calls: toolUses.map((tool) => ({
              id: tool.id,
              type: 'function' as const,
              function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) }
            }))
          }
        : {})
    } as ChatMessage)
    return out
  }

  // Tool results must precede any new user text in the same turn.
  const results = message.content.filter((c) => c.type === 'tool_result') as Array<{
    toolUseId: string
    text: string
    imageDataUrl?: string
  }>
  for (const result of results) {
    out.push({ role: 'tool', tool_call_id: result.toolUseId, content: result.text || '(no output)' })
  }

  const texts = message.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).filter(Boolean)
  const images = message.content.filter((c) => c.type === 'image') as Array<{ dataUrl: string }>
  const resultImages = results.filter((r) => r.imageDataUrl).map((r) => ({ dataUrl: r.imageDataUrl! }))
  const allImages = [...images, ...resultImages]

  if (vision && allImages.length) {
    out.push({
      role: 'user',
      content: [
        ...texts.map((text) => ({ type: 'text' as const, text })),
        ...allImages.map((image) => ({ type: 'image_url' as const, image_url: { url: image.dataUrl } }))
      ]
    } as ChatMessage)
  } else if (texts.length) {
    out.push({ role: 'user', content: texts.join('\n') })
  } else if (allImages.length) {
    out.push({ role: 'user', content: 'A screenshot was captured, but this model cannot look at images.' })
  }

  return out
}

/* ───────────────────────────── Error handling ───────────────────────────── */

export function normaliseError(error: unknown, provider: ProviderId, name: string = provider): ProviderError {
  if (error instanceof ProviderError) return error

  const status = (error as { status?: number }).status
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = rawMessage.replace(/\b(sk|gsk|sk-or|AIza)[-_][A-Za-z0-9_-]{6,}/g, '[REDACTED]')

  if (status === 401 || status === 403) {
    return new ProviderError(`The ${name} API key was rejected. Check it in Settings → AI.`, 'auth', provider, false)
  }
  if (status === 429) {
    return new ProviderError(`${name} is rate limiting. Its free tier has a cap.`, 'rate-limit', provider, true)
  }
  if (status === 404) {
    return new ProviderError(`That model is not available on ${name}.`, 'invalid', provider, false)
  }
  if (status === 400 || status === 422) {
    return new ProviderError(`${name} rejected the request: ${message}`, 'invalid', provider, false)
  }
  if (status && status >= 500) {
    return new ProviderError(`${name} is unavailable right now.`, 'overloaded', provider, true)
  }
  if (/abort/i.test(message)) {
    return new ProviderError('Cancelled.', 'unknown', provider, false)
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up/i.test(message)) {
    return new ProviderError(
      provider === 'ollama'
        ? 'Ollama is not responding. Is it running? Start it with `ollama serve`.'
        : 'No network connection.',
      'network',
      provider,
      true
    )
  }
  return new ProviderError(message || `The ${name} request failed.`, 'unknown', provider, true)
}

/**
 * Hosted voice models often sit behind a separate terms acceptance, and the
 * resulting 400 is otherwise indistinguishable from a malformed request.
 */
function normaliseSpeechError(error: unknown, provider: ProviderId, name: string): ProviderError {
  const message = error instanceof Error ? error.message : String(error)
  if (/terms acceptance|model_terms_required|accept the terms/i.test(message)) {
    return new ProviderError(
      'The neural voice needs its terms accepted once, at console.groq.com/playground under playai-tts.',
      'invalid',
      provider,
      false
    )
  }
  if (/model_not_found|does not exist|invalid_model/i.test(message)) {
    return new ProviderError(`That voice model is not available on ${name}.`, 'invalid', provider, false)
  }
  if (/voice/i.test(message) && /not.*(found|valid|supported)/i.test(message)) {
    return new ProviderError('That voice name is not recognised by the speech service.', 'invalid', provider, false)
  }
  return normaliseError(error, provider, name)
}

function mimeFor(filename: string): string {
  if (filename.endsWith('.webm')) return 'audio/webm'
  if (filename.endsWith('.ogg')) return 'audio/ogg'
  if (filename.endsWith('.mp3')) return 'audio/mpeg'
  if (filename.endsWith('.m4a')) return 'audio/mp4'
  return 'audio/wav'
}
