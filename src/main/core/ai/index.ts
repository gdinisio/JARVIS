import type { ProviderId, ProviderStatus, ProviderSelection } from '@shared/types'
import type { AIProvider, ProviderTestResult } from './types'
import { ClaudeProvider } from './claude'
import { GroqProvider } from './groq'
import { routeRequest, type RoutingDecision } from './router'
import { settings } from '../../services/settings'
import { bus } from '../../services/bus'
import { logger } from '../../services/logging'

/**
 * Owns the provider instances and their health, and answers the question
 * "who should handle this request?".
 */
class ProviderManager {
  readonly claude = new ClaudeProvider()
  readonly groq = new GroqProvider()

  private health: Record<ProviderId, { ok: boolean; message?: string; lastCheck?: number }> = {
    claude: { ok: true },
    groq: { ok: true }
  }
  private online = true

  get(id: ProviderId): AIProvider {
    return id === 'claude' ? this.claude : this.groq
  }

  configuredCount(): number {
    return [this.claude, this.groq].filter((p) => p.isConfigured()).length
  }

  anyConfigured(): boolean {
    return this.configuredCount() > 0
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    logger.info('ai', online ? 'Network connection restored.' : 'Network connection lost.')
    this.broadcast()
  }

  isOnline(): boolean {
    return this.online
  }

  /** Chooses a provider for this utterance, honouring the manual override. */
  route(text: string, options: { hasToolResults?: boolean; turnIndex?: number; needsVision?: boolean } = {}): RoutingDecision {
    const mode: ProviderSelection = settings.get().ai.provider
    return routeRequest({
      text,
      mode,
      claudeAvailable: this.claude.isConfigured() && this.health.claude.ok,
      groqAvailable: this.groq.isConfigured() && this.health.groq.ok,
      ...options
    })
  }

  markFailure(id: ProviderId, message: string, retryable: boolean): void {
    // A retryable blip should not take a provider out of rotation permanently.
    this.health[id] = { ok: retryable, message, lastCheck: Date.now() }
    this.broadcast()
  }

  markSuccess(id: ProviderId): void {
    if (!this.health[id].ok || this.health[id].message) {
      this.health[id] = { ok: true, lastCheck: Date.now() }
      this.broadcast()
    }
  }

  async test(id: ProviderId): Promise<ProviderTestResult> {
    const result = await this.get(id).test()
    this.health[id] = { ok: result.ok, message: result.ok ? undefined : result.message, lastCheck: Date.now() }
    this.broadcast()
    return result
  }

  status(activeOverride?: ProviderId | null): ProviderStatus {
    const config = settings.get().ai
    return {
      active: activeOverride ?? null,
      mode: config.provider,
      online: this.online,
      // Demo mode is a deliberate choice. Having no key configured is a
      // different state: JARVIS still executes, using offline matching.
      demo: settings.get().general.demoMode,
      claude: {
        configured: this.claude.isConfigured(),
        ok: this.health.claude.ok,
        model: this.claude.model(),
        message: this.health.claude.message,
        lastCheck: this.health.claude.lastCheck
      },
      groq: {
        configured: this.groq.isConfigured(),
        ok: this.health.groq.ok,
        model: this.groq.model(),
        message: this.health.groq.message,
        lastCheck: this.health.groq.lastCheck
      }
    }
  }

  broadcast(active?: ProviderId | null): void {
    bus.emit({ type: 'provider', status: this.status(active) })
  }
}

export const providers = new ProviderManager()
export { routeRequest, scoreComplexity } from './router'
export type { RoutingDecision } from './router'
