import type { ProviderHealth, ProviderStatus } from '@shared/types'
import type { ProviderId } from '@shared/providers'
import { PROVIDERS, providerDescriptor } from '@shared/providers'
import type { ProviderTestResult } from './types'
import { OpenAICompatibleProvider } from './openai-compatible'
import { routeRequest, type RoutingCandidate, type RoutingDecision } from './router'
import { settings } from '../../services/settings'
import { bus } from '../../services/bus'
import { logger } from '../../services/logging'

/**
 * Owns one instance per catalogued provider and answers the question
 * "who should handle this request?".
 */
class ProviderManager {
  private instances = new Map<ProviderId, OpenAICompatibleProvider>(
    PROVIDERS.map((descriptor) => [descriptor.id, new OpenAICompatibleProvider(descriptor)])
  )

  private health = new Map<ProviderId, { ok: boolean; message?: string; lastCheck?: number }>(
    PROVIDERS.map((descriptor) => [descriptor.id, { ok: true }])
  )

  private online = true
  private probeTimer: NodeJS.Timeout | null = null

  all(): OpenAICompatibleProvider[] {
    return [...this.instances.values()]
  }

  /**
   * Detects local backends, then keeps checking at a slow interval so that
   * starting Ollama after JARVIS is noticed without a restart.
   */
  async startLocalDiscovery(): Promise<void> {
    const probeAll = async () => {
      const before = this.configured().length
      await Promise.all(this.all().filter((provider) => provider.descriptor.local).map((provider) => provider.probe()))
      if (this.configured().length !== before) this.broadcast()
    }
    await probeAll()
    this.probeTimer = setInterval(() => void probeAll(), 60_000)
    this.probeTimer.unref?.()
  }

  /**
   * Asks every configured provider what it actually serves.
   *
   * Providers retire models — a list written into the source is a guess with
   * an expiry date. Fetching it means a deprecation shows up as a corrected
   * dropdown rather than a failed request.
   */
  async refreshModels(): Promise<void> {
    const configured = this.configured()
    await Promise.all(configured.map((provider) => provider.availableModels()))

    for (const provider of configured) {
      if (provider.configuredModelMissing()) {
        logger.warn('ai', 'The configured model is no longer offered.', {
          provider: provider.id,
          using: provider.model()
        })
        bus.say(
          'SYSTEM',
          `${provider.name} no longer offers the model that was selected. Using ${provider.model()} instead — pick another in Settings → AI.`,
          { level: 'warn' }
        )
      }
    }
    this.broadcast()
  }

  stopLocalDiscovery(): void {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
  }

  get(id: ProviderId): OpenAICompatibleProvider {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Unknown provider: ${id}`)
    return instance
  }

  configured(): OpenAICompatibleProvider[] {
    return this.all().filter((provider) => provider.isConfigured())
  }

  anyConfigured(): boolean {
    return this.configured().length > 0
  }

  /** The provider that will handle speech-to-text, if any. */
  transcriber(): OpenAICompatibleProvider | null {
    return this.configured().find((provider) => provider.descriptor.transcriptionModel) ?? null
  }

  /** The provider that will synthesise speech, if any. */
  synthesiser(): OpenAICompatibleProvider | null {
    return this.configured().find((provider) => provider.descriptor.speechModel) ?? null
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

  private candidates(): RoutingCandidate[] {
    return this.all().map((provider) => {
      const health = this.health.get(provider.id)
      const descriptor = provider.descriptor
      // A local backend keeps working with no network; the hosted ones do not.
      const reachable = descriptor.local || this.online
      return {
        id: provider.id,
        available: provider.isConfigured() && (health?.ok ?? true) && reachable,
        rank: descriptor.rank,
        vision: provider.supportsVision()
      }
    })
  }

  route(
    text: string,
    options: { hasToolResults?: boolean; turnIndex?: number; needsVision?: boolean } = {}
  ): RoutingDecision {
    return routeRequest({
      text,
      mode: settings.get().ai.provider,
      candidates: this.candidates(),
      ...options
    })
  }

  markFailure(id: ProviderId, message: string, retryable: boolean): void {
    // A retryable blip should not take a provider out of rotation permanently.
    this.health.set(id, { ok: retryable, message, lastCheck: Date.now() })
    this.broadcast()
  }

  markSuccess(id: ProviderId): void {
    const current = this.health.get(id)
    if (!current?.ok || current.message) {
      this.health.set(id, { ok: true, lastCheck: Date.now() })
      this.broadcast()
    }
  }

  async test(id: ProviderId): Promise<ProviderTestResult> {
    const result = await this.get(id).test()
    this.health.set(id, { ok: result.ok, message: result.ok ? undefined : result.message, lastCheck: Date.now() })
    this.broadcast()
    return result
  }

  status(activeOverride?: ProviderId | null): ProviderStatus {
    const config = settings.get()
    const providers: Record<string, ProviderHealth> = {}

    for (const provider of this.all()) {
      const health = this.health.get(provider.id)
      providers[provider.id] = {
        id: provider.id,
        name: provider.name,
        configured: provider.isConfigured(),
        ok: health?.ok ?? true,
        model: provider.model(),
        vision: provider.supportsVision(),
        local: !!provider.descriptor.local,
        message: health?.message,
        lastCheck: health?.lastCheck
      }
    }

    return {
      active: activeOverride ?? null,
      mode: config.ai.provider,
      online: this.online,
      // Demo mode is a deliberate choice, not the absence of a key.
      demo: config.general.demoMode,
      providers
    }
  }

  broadcast(active?: ProviderId | null): void {
    bus.emit({ type: 'provider', status: this.status(active) })
  }
}

export const providers = new ProviderManager()
export { routeRequest, scoreComplexity } from './router'
export type { RoutingDecision, RoutingCandidate } from './router'
export { providerDescriptor }
