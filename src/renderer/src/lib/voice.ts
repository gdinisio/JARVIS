import { audioBus } from './audioBus'

/**
 * Microphone capture, level metering and voice activity detection.
 *
 * The microphone stream is opened only when JARVIS is actually listening, and
 * the UI always shows when it is open. Audio is buffered locally and only sent
 * for transcription when an utterance completes.
 */

export interface VoiceOptions {
  deviceId?: string
  gain: number
  /** RMS level above which speech is considered present. */
  threshold: number
  /** Silence, in milliseconds, that ends an utterance. */
  silenceMs: number
}

export interface UtteranceResult {
  blob: Blob
  mimeType: string
  durationMs: number
}

type State = 'off' | 'open' | 'recording'

export class VoiceInput {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private samples = new Float32Array(1024)
  private raf = 0
  private state: State = 'off'

  private speechStartedAt = 0
  private lastVoiceAt = 0
  private recordingStartedAt = 0

  onLevel: ((level: number) => void) | null = null
  /** Fired when an utterance ends after speech was detected. */
  onUtterance: ((result: UtteranceResult) => void) | null = null
  onSpeechStart: (() => void) | null = null
  onError: ((message: string) => void) | null = null

  constructor(private options: VoiceOptions) {}

  update(options: Partial<VoiceOptions>): void {
    this.options = { ...this.options, ...options }
  }

  isOpen(): boolean {
    return this.state !== 'off'
  }

  isRecording(): boolean {
    return this.state === 'recording'
  }

  /** Opens the microphone and starts metering. */
  async open(): Promise<boolean> {
    if (this.state !== 'off') return true
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.options.deviceId && this.options.deviceId !== 'default' ? { deviceId: { exact: this.options.deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    } catch (error) {
      const name = (error as DOMException)?.name
      this.onError?.(
        name === 'NotAllowedError'
          ? 'Microphone access was denied. Grant it in your system privacy settings.'
          : name === 'NotFoundError'
            ? 'No microphone was found.'
            : 'The microphone could not be opened.'
      )
      return false
    }

    this.context = new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.6
    this.samples = new Float32Array(this.analyser.fftSize)
    this.source = this.context.createMediaStreamSource(this.stream)
    this.source.connect(this.analyser)

    this.state = 'open'
    this.meter()
    return true
  }

  close(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop() } catch { /* already stopped */ }
    }
    this.recorder = null
    this.chunks = []
    this.source?.disconnect()
    this.analyser?.disconnect()
    void this.context?.close().catch(() => undefined)
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.context = null
    this.analyser = null
    this.source = null
    this.state = 'off'
    audioBus.clear()
    this.onLevel?.(0)
  }

  /** Begins buffering audio. Voice activity detection decides when to stop. */
  startRecording(): boolean {
    if (this.state === 'off' || !this.stream) return false
    if (this.state === 'recording') return true

    const mimeType = pickMimeType()
    try {
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    } catch {
      this.onError?.('This system cannot record audio in a supported format.')
      return false
    }

    this.chunks = []
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.onstop = () => {
      const type = this.recorder?.mimeType || mimeType || 'audio/webm'
      const blob = new Blob(this.chunks, { type })
      const durationMs = performance.now() - this.recordingStartedAt
      this.chunks = []
      this.state = this.stream ? 'open' : 'off'
      // Discard clips too short to contain anything useful.
      if (blob.size > 1200 && durationMs > 320) {
        this.onUtterance?.({ blob, mimeType: type, durationMs })
      }
    }

    this.recordingStartedAt = performance.now()
    this.speechStartedAt = 0
    this.lastVoiceAt = 0
    this.recorder.start(120)
    this.state = 'recording'
    return true
  }

  stopRecording(): void {
    if (this.state !== 'recording' || !this.recorder) return
    try {
      this.recorder.stop()
    } catch {
      this.state = 'open'
    }
  }

  /** Level metering plus voice-activity detection, one rAF loop. */
  private meter(): void {
    const tick = () => {
      if (!this.analyser) return
      this.analyser.getFloatTimeDomainData(this.samples)

      let sum = 0
      for (let i = 0; i < this.samples.length; i++) {
        const value = this.samples[i] * this.options.gain
        sum += value * value
      }
      const rms = Math.sqrt(sum / this.samples.length)
      const level = Math.min(1, rms * 3.2)

      audioBus.publish(this.samples, level, 'mic')
      this.onLevel?.(level)

      if (this.state === 'recording') {
        const now = performance.now()
        const speaking = rms > this.options.threshold
        if (speaking) {
          if (!this.speechStartedAt) {
            this.speechStartedAt = now
            this.onSpeechStart?.()
          }
          this.lastVoiceAt = now
        }
        const elapsed = now - this.recordingStartedAt
        const silentFor = this.lastVoiceAt ? now - this.lastVoiceAt : elapsed

        // End on trailing silence once speech has been heard, on silence with
        // no speech at all, or at a hard ceiling.
        if (
          (this.speechStartedAt && silentFor > this.options.silenceMs) ||
          (!this.speechStartedAt && elapsed > 2600) ||
          elapsed > 20_000
        ) {
          this.stopRecording()
        }
      }

      this.raf = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(tick)
  }
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type))
}

/** Enumerates input devices. Labels only appear after permission is granted. */
export async function listMicrophones(): Promise<Array<{ deviceId: string; label: string }>> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId || 'default',
        label: device.label || `Microphone ${index + 1}`
      }))
  } catch {
    return []
  }
}
