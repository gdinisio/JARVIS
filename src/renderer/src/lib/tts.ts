import type { Settings } from '@shared/types'
import { audioBus } from './audioBus'

/**
 * Speech output.
 *
 * The Web Speech API gives us the OS voices on both Windows and macOS and,
 * importantly, `boundary` events — so the core's waveform is driven by the
 * actual progress of the speech rather than an unrelated animation.
 */

export interface SpeakCallbacks {
  onStart?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
}

class Speaker {
  private failureReported = false
  /** Invalidates the queue when speech is stopped or replaced. */
  private token = 0
  private envelopeRaf = 0
  private amplitude = 0
  private speaking = false
  private voicesCache: SpeechSynthesisVoice[] = []

  supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  voices(): SpeechSynthesisVoice[] {
    if (!this.supported()) return []
    const voices = window.speechSynthesis.getVoices()
    if (voices.length) this.voicesCache = voices
    return this.voicesCache
  }

  /** Voices load asynchronously on first run; this resolves once they exist. */
  async ready(): Promise<SpeechSynthesisVoice[]> {
    if (!this.supported()) return []
    const existing = this.voices()
    if (existing.length) return existing
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(this.voices()), 1200)
      window.speechSynthesis.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timeout)
          resolve(this.voices())
        },
        { once: true }
      )
    })
  }

  /**
   * Picks the least synthetic voice available.
   *
   * Windows 11 ships "Natural" / "Online" neural voices alongside the legacy
   * SAPI ones, and macOS ships "Premium" and "Enhanced" variants. The gap
   * between those and the defaults is far larger than any rate or pitch
   * tuning, so they are ranked first.
   */
  pickDefaultVoice(voices: SpeechSynthesisVoice[], language = 'en'): SpeechSynthesisVoice | null {
    if (!voices.length) return null

    const english = voices.filter((v) => v.lang?.toLowerCase().startsWith(language.slice(0, 2).toLowerCase()))
    const pool = english.length ? english : voices

    const tiers: RegExp[][] = [
      // Neural voices, whatever the platform calls them.
      [/\bNatural\b/i, /\bNeural\b/i, /\bPremium\b/i, /\bEnhanced\b/i, /\bOnline\b/i],
      // Known-good named voices, calm and unhurried.
      [/Daniel/i, /Arthur/i, /Oliver/i, /Serena/i, /Alex/i, /Samantha/i, /Google UK English/i],
      [/Microsoft (Ryan|Guy|Christopher|Sonia|Libby|Aria|Jenny)/i]
    ]

    for (const tier of tiers) {
      for (const pattern of tier) {
        const hit = pool.find((voice) => pattern.test(voice.name))
        if (hit) return hit
      }
    }
    return pool.find((voice) => voice.localService) ?? pool[0]
  }

  /** Voices ranked for the settings list, best first. */
  ranked(language = 'en'): SpeechSynthesisVoice[] {
    const voices = this.voices()
    const score = (voice: SpeechSynthesisVoice): number => {
      let value = 0
      if (/\b(Natural|Neural|Premium|Enhanced|Online)\b/i.test(voice.name)) value += 100
      if (voice.lang?.toLowerCase().startsWith(language.slice(0, 2).toLowerCase())) value += 50
      if (voice.default) value += 5
      return value
    }
    return [...voices].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
  }

  /**
   * Speaks a reply.
   *
   * `sentences` are queued as separate utterances: the engine shapes intonation
   * per utterance, so a three-sentence reply delivered as three utterances
   * sounds spoken, while the same text as one utterance sounds read.
   */
  speak(sentences: string[] | string, settings: Settings['voice'], callbacks: SpeakCallbacks = {}): boolean {
    if (!this.supported()) {
      callbacks.onError?.('This system exposes no speech voices to the application.')
      return false
    }
    const parts = (Array.isArray(sentences) ? sentences : [sentences])
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    if (!parts.length) return false

    this.stop()
    const run = ++this.token

    let index = 0
    const speakNext = (): void => {
      if (run !== this.token) return
      if (index >= parts.length) {
        this.finish()
        callbacks.onEnd?.()
        return
      }
      const part = parts[index++]
      this.speakOne(part, settings, {
        onStart: index === 1 ? callbacks.onStart : undefined,
        onEnd: speakNext,
        onError: callbacks.onError
      })
    }
    speakNext()
    return true
  }

  private speakOne(text: string, settings: Settings['voice'], callbacks: SpeakCallbacks): void {
    const clean = text.slice(0, 600)
    const utterance = new SpeechSynthesisUtterance(clean)
    utterance.rate = clamp(settings.rate, 0.5, 2)
    utterance.pitch = clamp(settings.pitch, 0, 2)
    utterance.volume = clamp(settings.volume, 0, 1)

    const voice = this.voices().find((v) => v.voiceURI === settings.voiceURI)
    if (voice) utterance.voice = voice

    utterance.onstart = () => {
      this.speaking = true
      this.amplitude = 0.5
      this.runEnvelope()
      callbacks.onStart?.()
    }
    // Each word boundary gives the envelope a real kick.
    utterance.onboundary = () => {
      this.amplitude = Math.min(1, 0.55 + Math.random() * 0.45)
    }
    utterance.onend = () => {
      this.amplitude = 0.16
      callbacks.onEnd?.()
    }
    utterance.onerror = (event) => {
      this.finish()
      // "interrupted" and "canceled" are what stop() produces; they are not failures.
      if (event.error === 'interrupted' || event.error === 'canceled') {
        callbacks.onEnd?.()
        return
      }
      // A system with no installed voices fails every utterance. Say so once,
      // with the fix, rather than on every reply.
      this.token++
      const noVoices = event.error === 'synthesis-failed' || event.error === 'synthesis-unavailable' || !this.voices().length
      if (noVoices) {
        if (!this.failureReported) {
          this.failureReported = true
          callbacks.onError?.(
            'No speech voice is available on this system. Choose Native in Settings \u2192 Voice, or switch speech off.'
          )
        }
        callbacks.onEnd?.()
        return
      }
      callbacks.onError?.(`Speech failed: ${event.error}`)
      callbacks.onEnd?.()
    }

    window.speechSynthesis.speak(utterance)
  }

  stop(): void {
    this.token++
    if (!this.supported()) return
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* nothing was speaking */
    }
    this.finish()
  }

  isSpeaking(): boolean {
    return this.speaking
  }

  private finish(): void {
    this.speaking = false
    cancelAnimationFrame(this.envelopeRaf)
    this.envelopeRaf = 0
    this.amplitude = 0
    if (audioBus.source === 'speech') audioBus.clear()
  }

  private runEnvelope(): void {
    const tick = () => {
      if (!this.speaking) return
      // Decay between word boundaries produces natural-looking speech motion.
      this.amplitude = Math.max(0.12, this.amplitude * 0.93)
      audioBus.publishEnvelope(this.amplitude, performance.now() / 1000)
      this.envelopeRaf = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(this.envelopeRaf)
    this.envelopeRaf = requestAnimationFrame(tick)
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return (min + max) / 2
  return Math.max(min, Math.min(max, value))
}

export const speaker = new Speaker()
