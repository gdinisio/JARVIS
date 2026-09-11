import Groq from 'groq-sdk'
import type { ProviderId, ToolCallRequest, ToolDescriptor } from '@shared/types'
import type { AIProvider, AiMessage, AiRequest, AiResponse, ProviderTestResult } from './types'
import { ProviderError } from './types'
import { normaliseError } from './claude'
import { secrets } from '../../services/secrets'
import { logger } from '../../services/logging'
import { settings } from '../../services/settings'

type ChatMessage = Groq.Chat.Completions.ChatCompletionMessageParam

/** Groq models that accept image content. */
const VISION_MODELS = /(scout|maverick|vision|llava)/i

/**
 * Groq — the low-latency provider.
 *
 * Handles short conversational turns, quick classification and simple single
 * tool calls, where round-trip time is what the user actually notices. Also
 * provides speech-to-text (Whisper) for the voice pipeline.
 */
export class GroqProvider implements AIProvider {
  readonly id: ProviderId = 'groq'
  readonly name = 'Groq'

  private client: Groq | null = null
  private clientKey: string | null = null

  isConfigured(): boolean {
    return !!secrets.get('GROQ_API_KEY')
  }

  model(): string {
    return settings.get().ai.groqModel || 'llama-3.3-70b-versatile'
  }

  supportsVision(): boolean {
    return VISION_MODELS.test(this.model())
  }

  sdk(): Groq {
    const key = secrets.get('GROQ_API_KEY')
    if (!key) throw new ProviderError('No Groq API key is configured.', 'auth', this.id, false)
    if (!this.client || this.clientKey !== key) {
      this.client = new Groq({ apiKey: key, maxRetries: 1, timeout: 45_000 })
      this.clientKey = key
    }
    return this.client
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const client = this.sdk()
    const model = this.model()

    const messages: ChatMessage[] = [{ role: 'system', content: request.system }]
    for (const message of request.messages) messages.push(...toChatMessages(message, this.supportsVision()))

    try {
      const response = await client.chat.completions.create(
        {
          model,
          messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.tools.length ? { tools: request.tools.map(toChatTool), tool_choice: 'auto' as const } : {})
        },
        { signal: request.signal }
      )

      const choice = response.choices[0]
      const toolCalls: ToolCallRequest[] = (choice?.message?.tool_calls ?? []).flatMap((call) => {
        if (!('function' in call) || !call.function) return []
        let args: Record<string, unknown> = {}
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
        } catch {
          // A malformed argument blob is a model error, not a crash.
          logger.warn('groq', 'Tool arguments were not valid JSON.', { tool: call.function.name })
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
      throw normaliseError(error, this.id)
    }
  }

  async test(): Promise<ProviderTestResult> {
    if (!this.isConfigured()) return { ok: false, message: 'No Groq API key is configured.' }
    const started = Date.now()
    try {
      const response = await this.sdk().chat.completions.create({
        model: this.model(),
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: online' }]
      })
      logger.info('groq', 'Connectivity test succeeded.', { model: this.model() })
      return {
        ok: true,
        message: `Connected. ${(response.choices[0]?.message?.content ?? 'Responding.').trim().slice(0, 40)}`,
        latencyMs: Date.now() - started,
        model: this.model()
      }
    } catch (error) {
      const normalised = normaliseError(error, this.id)
      logger.warn('groq', 'Connectivity test failed.', { kind: normalised.kind })
      return { ok: false, message: normalised.message, latencyMs: Date.now() - started, model: this.model() }
    }
  }

  /** Speech-to-text for the voice pipeline. */
  async transcribe(audio: Buffer, filename: string, language?: string): Promise<{ text: string; durationMs: number }> {
    const started = Date.now()
    const model = process.env.JARVIS_GROQ_STT_MODEL || 'whisper-large-v3-turbo'
    try {
      const file = new File([new Uint8Array(audio)], filename, { type: mimeFor(filename) })
      const response = await this.sdk().audio.transcriptions.create({
        file,
        model,
        ...(language ? { language } : {}),
        temperature: 0,
        response_format: 'json'
      })
      return { text: (response.text ?? '').trim(), durationMs: Date.now() - started }
    } catch (error) {
      throw normaliseError(error, this.id)
    }
  }
}

function mimeFor(filename: string): string {
  if (filename.endsWith('.webm')) return 'audio/webm'
  if (filename.endsWith('.ogg')) return 'audio/ogg'
  if (filename.endsWith('.mp3')) return 'audio/mpeg'
  if (filename.endsWith('.m4a')) return 'audio/mp4'
  return 'audio/wav'
}

function toChatTool(tool: ToolDescriptor): Groq.Chat.Completions.ChatCompletionTool {
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
    const toolUses = message.content.filter((c) => c.type === 'tool_use') as Array<{ id: string; name: string; input: Record<string, unknown> }>
    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolUses.length
        ? {
            tool_calls: toolUses.map((t) => ({
              id: t.id,
              type: 'function' as const,
              function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) }
            }))
          }
        : {})
    } as ChatMessage)
    return out
  }

  // A user turn may carry tool results, which chat-completions models expect
  // as separate `tool` messages that must precede any new user text.
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
        ...allImages.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } }))
      ]
    } as ChatMessage)
  } else if (texts.length) {
    out.push({ role: 'user', content: texts.join('\n') })
  } else if (allImages.length) {
    out.push({ role: 'user', content: 'A screenshot was captured, but this model cannot look at images.' })
  }

  return out
}
