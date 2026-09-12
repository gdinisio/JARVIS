import type { Settings } from '@shared/types'
import { audioBus } from './audioBus'

/**
 * Neural speech playback.
 *
 * Audio is synthesised in the main process and played here through Web Audio,
 * which has two advantages over the operating system's voices: it sounds like
 * a person, and because the samples pass through an analyser on the way to the
 * speakers, the core's waveform is driven by the actual speech rather than an
 * approximation of it.
 *
 * Sentences are fetched one ahead of playback, so a long reply plays
 * continuously instead of pausing at every full stop.
 */

export interface NeuralCallbacks {
  onStart?: () => void
  onEnd?: () => void
  /** Called when synthesis fails; the caller should fall back. */
  onError?: (message: string) => void
}

class NeuralVoice {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private source: AudioBufferSourceNode | null = null
  private samples = new Float32Array(2048)
  private raf = 0
  private token = 0
  private speaking = false

  isSpeaking(): boolean {
    return this.speaking
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext()
      this.gain = this.context.createGain()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 2048
      this.analyser.smoothingTimeConstant = 0.55
      this.samples = new Float32Array(this.analyser.fftSize)
      this.gain.connect(this.analyser)
      this.analyser.connect(this.context.destination)
    }
    return this.context
  }

  /**
   * Speaks a reply, one sentence at a time.
   *
   * Resolves true once everything has played, or false when synthesis failed
   * and the caller should use a different engine.
   */
  async speak(sentences: string[], voice: Settings['voice'], callbacks: NeuralCallbacks = {}): Promise<boolean> {
    if (!sentences.length) return true

    this.stop()
    const run = ++this.token
    const context = this.ensureContext()
    if (context.state === 'suspended') await context.resume().catch(() => undefined)
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, voice.volume))

    const fetchSentence = async (text: string): Promise<AudioBuffer | null> => {
      const result = await window.jarvis.synthesise(text, voice.neuralVoice, voice.rate)
      if (!result?.ok || !result.audio) throw new Error(result?.error ?? 'The neural voice did not respond.')
      return context.decodeAudioData(result.audio.slice(0))
    }

    let pending: Promise<AudioBuffer | null>
    try {
      pending = fetchSentence(sentences[0])
      await pending
    } catch (error) {
      // Nothing played, so the caller can still fall back cleanly.
      callbacks.onError?.(error instanceof Error ? error.message : 'The neural voice is unavailable.')
      return false
    }

    this.speaking = true
    callbacks.onStart?.()
    this.startAnalysis()

    try {
      for (let index = 0; index < sentences.length; index++) {
        if (run !== this.token) return true
        const buffer = await pending
        if (run !== this.token) return true

        // Fetch the next sentence while this one plays.
        pending =
          index + 1 < sentences.length
            ? fetchSentence(sentences[index + 1]).catch(() => null)
            : Promise.resolve(null)

        if (buffer) await this.play(buffer, run)
      }
    } finally {
      if (run === this.token) this.finish(callbacks)
    }
    return true
  }

  private play(buffer: AudioBuffer, run: number): Promise<void> {
    return new Promise((resolve) => {
      const context = this.context
      if (!context || !this.gain || run !== this.token) {
        resolve()
        return
      }
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(this.gain)
      source.onended = () => {
        if (this.source === source) this.source = null
        resolve()
      }
      this.source = source
      source.start()
    })
  }

  /** Publishes the real output waveform for the core to render. */
  private startAnalysis(): void {
    const tick = () => {
      if (!this.speaking || !this.analyser) return
      this.analyser.getFloatTimeDomainData(this.samples)
      let sum = 0
      for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i]
      const level = Math.min(1, Math.sqrt(sum / this.samples.length) * 3.6)
      audioBus.publish(this.samples, level, 'speech')
      this.raf = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(tick)
  }

  private finish(callbacks: NeuralCallbacks): void {
    this.speaking = false
    cancelAnimationFrame(this.raf)
    this.raf = 0
    if (audioBus.source === 'speech') audioBus.clear()
    callbacks.onEnd?.()
  }

  stop(): void {
    this.token++
    this.speaking = false
    cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.source) {
      try {
        this.source.onended = null
        this.source.stop()
      } catch {
        /* already finished */
      }
      this.source = null
    }
    if (audioBus.source === 'speech') audioBus.clear()
  }
}

export const neuralVoice = new NeuralVoice()
