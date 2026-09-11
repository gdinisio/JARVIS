import type { ProviderId, ToolCallRequest, ToolDescriptor } from '@shared/types'

export type AiContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; text: string; isError?: boolean; imageDataUrl?: string }
  | { type: 'image'; dataUrl: string }

export interface AiMessage {
  role: 'user' | 'assistant'
  content: AiContent[]
}

export interface AiRequest {
  system: string
  messages: AiMessage[]
  tools: ToolDescriptor[]
  temperature: number
  maxTokens: number
  signal?: AbortSignal
}

export interface AiResponse {
  text: string
  toolCalls: ToolCallRequest[]
  provider: ProviderId
  model: string
  stopReason?: string
  usage?: { inputTokens: number; outputTokens: number }
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
  model?: string
}

/** Every model backend implements exactly this. */
export interface AIProvider {
  readonly id: ProviderId
  readonly name: string
  isConfigured(): boolean
  model(): string
  supportsVision(): boolean
  complete(request: AiRequest): Promise<AiResponse>
  test(): Promise<ProviderTestResult>
}

/** Normalised failure so the engine can decide whether to fall back. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate-limit' | 'network' | 'invalid' | 'overloaded' | 'unknown',
    readonly provider: ProviderId,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'ProviderError'
  }

  /** Message suitable for speaking aloud. */
  spoken(): string {
    switch (this.kind) {
      case 'auth': return `My ${this.provider === 'claude' ? 'Claude' : 'Groq'} key was rejected. Check it in Settings.`
      case 'rate-limit': return 'I am being rate limited. Give me a moment.'
      case 'network': return 'I cannot reach the network right now.'
      case 'overloaded': return 'The model is overloaded. I will try the alternative.'
      case 'invalid': return 'The model returned something I could not use.'
      default: return this.message
    }
  }
}
