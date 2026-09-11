/**
 * A 60 Hz side-channel between the audio code and the canvas.
 *
 * Waveform data changes every frame; pushing it through React state would
 * re-render the whole tree sixty times a second for no reason. The canvas
 * reads from here directly instead.
 */
const SIZE = 128

class AudioBus {
  readonly waveform = new Float32Array(SIZE)
  level = 0
  source: 'none' | 'mic' | 'speech' = 'none'
  private lastUpdate = 0

  /** Called by the microphone analyser with real time-domain samples. */
  publish(samples: Float32Array, level: number, source: 'mic' | 'speech'): void {
    const step = samples.length / SIZE
    for (let i = 0; i < SIZE; i++) {
      this.waveform[i] = samples[Math.floor(i * step)] ?? 0
    }
    this.level = level
    this.source = source
    this.lastUpdate = performance.now()
  }

  /**
   * Speech synthesis gives us progress events, not audio. This shapes a
   * plausible envelope from the real speaking amplitude so the core moves
   * with the voice rather than independently of it.
   */
  publishEnvelope(amplitude: number, time: number): void {
    for (let i = 0; i < SIZE; i++) {
      const phase = (i / SIZE) * Math.PI * 2
      const carrier = Math.sin(phase * 3 + time * 6) * 0.6 + Math.sin(phase * 7 - time * 3.4) * 0.3
      const detail = Math.sin(phase * 17 + time * 11) * 0.12
      this.waveform[i] = (carrier + detail) * amplitude
    }
    this.level = amplitude
    this.source = 'speech'
    this.lastUpdate = performance.now()
  }

  /** Fades the ring out when nothing is feeding it. */
  settle(): void {
    if (performance.now() - this.lastUpdate < 90) return
    this.level *= 0.86
    for (let i = 0; i < SIZE; i++) this.waveform[i] *= 0.86
    if (this.level < 0.001) {
      this.level = 0
      this.source = 'none'
    }
  }

  clear(): void {
    this.waveform.fill(0)
    this.level = 0
    this.source = 'none'
  }
}

export const audioBus = new AudioBus()
export const WAVEFORM_SIZE = SIZE
