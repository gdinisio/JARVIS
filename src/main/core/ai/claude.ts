import Anthropic from '@anthropic-ai/sdk'
import type { ProviderId, ToolCallRequest, ToolDescriptor } from '@shared/types'
import type { AIProvider, AiMessage, AiRequest, AiResponse, ProviderTestResult } from './types'
import { ProviderError } from './types'
import { secrets } from '../../services/secrets'
import { logger } from '../../services/logging'
import { settings } from '../../services/settings'

type AnthropicMessageParam = Anthropic.Messages.MessageParam
type AnthropicContentBlock = Anthropic.Messages.ContentBlockParam

/**
 * Claude — the reasoning provider.
 *
 * Used for planning, multi-step automation, ambiguous requests and anything
 * that needs to look at the screen.
 */
export class ClaudeProvider implements AIProvider {
  readonly id: ProviderId = 'claude'
  readonly name = 'Claude'

  private client: Anthropic | null = null
  private clientKey: string | null = null

  isConfigured(): boolean {
    return !!secrets.get('ANTHROPIC_API_KEY')
  }

  model(): string {
    return settings.get().ai.claudeModel || 'claude-sonnet-5'
  }

  supportsVision(): boolean {
    return true
  }

  private sdk(): Anthropic {
    const key = secrets.get('ANTHROPIC_API_KEY')
    if (!key) throw new ProviderError('No Anthropic API key is configured.', 'auth', this.id, false)
    if (!this.client || this.clientKey !== key) {
      this.client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 })
      this.clientKey = key
    }
    return this.client
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const client = this.sdk()
    const model = this.model()

    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          system: request.system,
          messages: request.messages.map(toAnthropicMessage),
          ...(request.tools.length ? { tools: request.tools.map(toAnthropicTool) } : {})
        },
        { signal: request.signal }
      )

      const text = response.content
        .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()

      const toolCalls: ToolCallRequest[] = response.content
        .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> }))

      return {
        text,
        toolCalls,
        provider: this.id,
        model,
        stopReason: response.stop_reason ?? undefined,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      }
    } catch (error) {
      throw normaliseError(error, this.id)
    }
  }

  async test(): Promise<ProviderTestResult> {
    if (!this.isConfigured()) return { ok: false, message: 'No Anthropic API key is configured.' }
    const started = Date.now()
    try {
      const response = await this.sdk().messages.create({
        model: this.model(),
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: online' }]
      })
      const text = response.content.find((b) => b.type === 'text')
      logger.info('claude', 'Connectivity test succeeded.', { model: this.model() })
      return {
        ok: true,
        message: `Connected. ${text && text.type === 'text' ? text.text.trim().slice(0, 40) : 'Responding.'}`,
        latencyMs: Date.now() - started,
        model: this.model()
      }
    } catch (error) {
      const normalised = normaliseError(error, this.id)
      logger.warn('claude', 'Connectivity test failed.', { kind: normalised.kind })
      return { ok: false, message: normalised.message, latencyMs: Date.now() - started, model: this.model() }
    }
  }
}

function toAnthropicTool(tool: ToolDescriptor): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: tool.parameters.properties as Record<string, unknown>,
      required: tool.parameters.required ?? []
    } as Anthropic.Messages.Tool.InputSchema
  }
}

function toAnthropicMessage(message: AiMessage): AnthropicMessageParam {
  const content: AnthropicContentBlock[] = []

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.trim()) content.push({ type: 'text', text: block.text })
        break
      case 'tool_use':
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
        break
      case 'image': {
        const image = dataUrlToBlock(block.dataUrl)
        if (image) content.push(image)
        break
      }
      case 'tool_result': {
        const inner: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> = [
          { type: 'text', text: block.text || '(no output)' }
        ]
        if (block.imageDataUrl) {
          const image = dataUrlToBlock(block.imageDataUrl)
          if (image) inner.push(image)
        }
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: inner,
          ...(block.isError ? { is_error: true } : {})
        })
        break
      }
    }
  }

  if (!content.length) content.push({ type: 'text', text: '(empty)' })
  return { role: message.role, content }
}

function dataUrlToBlock(dataUrl: string): Anthropic.Messages.ImageBlockParam | null {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  return {
    type: 'image',
    source: { type: 'base64', media_type: match[1] as 'image/png', data: match[2] }
  }
}

export function normaliseError(error: unknown, provider: ProviderId): ProviderError {
  if (error instanceof ProviderError) return error

  const status = (error as { status?: number }).status
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = rawMessage.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')

  if (status === 401 || status === 403) {
    return new ProviderError('The API key was rejected. Check it in Settings → AI.', 'auth', provider, false)
  }
  if (status === 429) {
    return new ProviderError('Rate limit reached.', 'rate-limit', provider, true)
  }
  if (status === 400 || status === 422) {
    return new ProviderError(`The request was rejected: ${message}`, 'invalid', provider, false)
  }
  if (status && status >= 500) {
    return new ProviderError('The provider is unavailable right now.', 'overloaded', provider, true)
  }
  if (/abort/i.test(message)) {
    return new ProviderError('Cancelled.', 'unknown', provider, false)
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(message)) {
    return new ProviderError('No network connection.', 'network', provider, true)
  }
  return new ProviderError(message || 'The model request failed.', 'unknown', provider, true)
}
