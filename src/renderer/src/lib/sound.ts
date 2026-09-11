/**
 * Interface sounds, synthesised rather than shipped as files.
 *
 * Short, quiet, tuned to a minor triad so cues sit together rather than
 * competing. Nothing plays unless sound is enabled in Settings.
 */

type Cue = 'boot' | 'wake' | 'listen' | 'complete' | 'error' | 'confirm' | 'tick'

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!context) {
    try {
      context = new AudioContext()
    } catch {
      return null
    }
  }
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  return context
}

interface Tone {
  frequency: number
  duration: number
  delay: number
  type?: OscillatorType
  gain?: number
}

const CUES: Record<Cue, Tone[]> = {
  boot: [
    { frequency: 196, duration: 0.5, delay: 0, type: 'sine', gain: 0.5 },
    { frequency: 294, duration: 0.45, delay: 0.16, type: 'sine', gain: 0.4 },
    { frequency: 392, duration: 0.6, delay: 0.32, type: 'sine', gain: 0.35 }
  ],
  wake: [
    { frequency: 523, duration: 0.09, delay: 0 },
    { frequency: 784, duration: 0.14, delay: 0.07 }
  ],
  listen: [{ frequency: 660, duration: 0.09, delay: 0, gain: 0.5 }],
  complete: [
    { frequency: 659, duration: 0.1, delay: 0 },
    { frequency: 880, duration: 0.18, delay: 0.08 }
  ],
  error: [
    { frequency: 233, duration: 0.16, delay: 0, type: 'triangle' },
    { frequency: 175, duration: 0.24, delay: 0.11, type: 'triangle' }
  ],
  confirm: [
    { frequency: 440, duration: 0.1, delay: 0 },
    { frequency: 330, duration: 0.16, delay: 0.09 }
  ],
  tick: [{ frequency: 1200, duration: 0.03, delay: 0, gain: 0.22 }]
}

export function playCue(cue: Cue, volume = 0.35): void {
  const ctx = audio()
  if (!ctx || volume <= 0) return

  for (const tone of CUES[cue]) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = tone.type ?? 'sine'
    oscillator.frequency.value = tone.frequency

    const start = ctx.currentTime + tone.delay
    const peak = Math.max(0.0001, volume * (tone.gain ?? 0.6) * 0.25)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration)

    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(start)
    oscillator.stop(start + tone.duration + 0.04)
  }
}
