import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { VoiceInput, type UtteranceResult } from './voice'
import { speaker } from './tts'
import { neuralVoice } from './neuralVoice'
import { prepareSpeech } from '@shared/speech'
import { audioBus } from './audioBus'
import { playCue } from './sound'
import { matchWakePhrase } from './wake'

/**
 * The voice pipeline.
 *
 * Owns the microphone, the wake-word scan, push-to-talk and speech output,
 * and keeps all of it in step with the engine: JARVIS never listens to itself
 * speak, and the microphone indicator always reflects reality.
 */

type Mode = 'off' | 'wake' | 'command'

export interface VoiceControls {
  startListening: () => Promise<void>
  stopListening: () => void
  toggleListening: () => void
  stopSpeaking: () => void
}

const WAKE_COOLDOWN_MS = 1500

export function useVoice(): VoiceControls {
  const inputRef = useRef<VoiceInput | null>(null)
  const modeRef = useRef<Mode>('off')
  const lastWakeRef = useRef(0)
  const resumeWakeRef = useRef(false)

  const settings = useStore((s) => s.settings)
  const speakRequest = useStore((s) => s.speakRequest)
  const stopSignal = useStore((s) => s.stopSpeakingSignal)
  const listenSignal = useStore((s) => s.listenSignal)
  const busy = useStore((s) => s.busy)

  /* ── microphone lifecycle ─────────────────────────────────────────────── */

  const ensureInput = useCallback((): VoiceInput => {
    if (!inputRef.current) {
      const config = useStore.getState().settings
      inputRef.current = new VoiceInput({
        deviceId: config?.microphone.deviceId ?? 'default',
        gain: config?.microphone.gain ?? 1,
        threshold: config?.microphone.threshold ?? 0.018,
        silenceMs: config?.microphone.silenceMs ?? 900
      })
      inputRef.current.onLevel = (level) => useStore.getState().setMicLevel(level)
      inputRef.current.onError = (message) => {
        useStore.getState().setVoiceError(message)
        useStore.getState().setListening(false)
        modeRef.current = 'off'
      }
      inputRef.current.onUtterance = (utterance) => void handleUtterance(utterance)
    }
    return inputRef.current
  }, [])

  const handleUtterance = useCallback(async (utterance: UtteranceResult) => {
    const state = useStore.getState()
    const mode = modeRef.current
    const config = state.settings
    if (!config) return

    // A wake scan only ever looks at short clips.
    if (mode === 'wake' && utterance.durationMs > 4200) {
      restartScan()
      return
    }

    state.setTranscribing(true)
    try {
      const buffer = await utterance.blob.arrayBuffer()
      const result = await window.jarvis.transcribe(buffer, utterance.mimeType, config.general.language)
      if (!result?.ok) {
        if (mode === 'command') {
          state.setVoiceError(result?.error ?? 'Speech could not be transcribed.')
          state.setListening(false)
          modeRef.current = 'off'
        } else {
          restartScan()
        }
        return
      }

      const text = String(result.text ?? '').trim()
      if (!text) {
        if (mode === 'command') {
          state.setListening(false)
          modeRef.current = 'off'
        } else {
          restartScan()
        }
        return
      }

      if (mode === 'wake') {
        const remainder = matchWakePhrase(text, config.wakeWord.phrase, config.wakeWord.sensitivity)
        if (remainder === null) {
          restartScan()
          return
        }
        if (Date.now() - lastWakeRef.current < WAKE_COOLDOWN_MS) {
          restartScan()
          return
        }
        lastWakeRef.current = Date.now()
        if (config.wakeWord.chime && config.sound.enabled) playCue('wake', config.sound.volume)

        if (remainder.trim()) {
          // "Hey JARVIS, open Chrome" — the command came with the wake word.
          modeRef.current = 'off'
          state.setListening(false)
          void window.jarvis.submit(remainder.trim(), 'voice')
        } else {
          // Bare wake word: acknowledge and listen for the command.
          void window.jarvis.submit('Hey JARVIS', 'voice')
          modeRef.current = 'command'
          state.setListening(true)
          ensureInput().startRecording()
        }
        return
      }

      state.setListening(false)
      modeRef.current = 'off'
      void window.jarvis.submit(text, 'voice')
    } catch (error) {
      state.setVoiceError(error instanceof Error ? error.message : 'Transcription failed.')
      if (mode === 'wake') restartScan()
    } finally {
      useStore.getState().setTranscribing(false)
    }
  }, [ensureInput])

  /** Re-arms the wake scan after an utterance that was not the wake word. */
  const restartScan = useCallback(() => {
    if (modeRef.current !== 'wake') return
    const input = inputRef.current
    if (!input || !input.isOpen()) return
    // A short gap keeps the recorder from restarting inside its own stop handler.
    setTimeout(() => {
      if (modeRef.current === 'wake' && input.isOpen() && !input.isRecording()) input.startRecording()
    }, 140)
  }, [])

  const startListening = useCallback(async () => {
    const state = useStore.getState()
    if (!state.settings?.permissions.microphoneAccess) {
      state.setVoiceError('Microphone access is switched off in Settings → Permissions.')
      return
    }
    speaker.stop()
    state.setSpeaking(false)
    state.setVoiceError(null)

    const input = ensureInput()
    const opened = await input.open()
    if (!opened) return

    modeRef.current = 'command'
    state.setListening(true)
    void window.jarvis.setListening(true)
    if (state.settings.sound.enabled) playCue('listen', state.settings.sound.volume)
    input.startRecording()
  }, [ensureInput])

  const stopListening = useCallback(() => {
    const input = inputRef.current
    const state = useStore.getState()
    if (input?.isRecording()) input.stopRecording()
    modeRef.current = 'off'
    state.setListening(false)
    void window.jarvis.setListening(false)
    if (!state.settings?.wakeWord.enabled) input?.close()
  }, [])

  const toggleListening = useCallback(() => {
    if (useStore.getState().listening) stopListening()
    else void startListening()
  }, [startListening, stopListening])

  /* ── wake word arming ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (!settings) return
    inputRef.current?.update({
      deviceId: settings.microphone.deviceId,
      gain: settings.microphone.gain,
      threshold: settings.microphone.threshold,
      silenceMs: settings.microphone.silenceMs
    })

    const wantWake =
      settings.wakeWord.enabled &&
      settings.permissions.microphoneAccess &&
      !settings.microphone.pushToTalkOnly

    let cancelled = false
    const arm = async () => {
      const input = ensureInput()
      if (!input.isOpen()) {
        const opened = await input.open()
        if (!opened || cancelled) return
      }
      if (cancelled) return
      useStore.getState().setWakeArmed(true)
      if (modeRef.current === 'off') {
        modeRef.current = 'wake'
        if (!input.isRecording()) input.startRecording()
      }
    }

    if (wantWake) {
      void arm()
    } else {
      useStore.getState().setWakeArmed(false)
      if (modeRef.current === 'wake') {
        modeRef.current = 'off'
        inputRef.current?.stopRecording()
        inputRef.current?.close()
      }
    }

    return () => {
      cancelled = true
    }
  }, [
    settings?.wakeWord.enabled,
    settings?.permissions.microphoneAccess,
    settings?.microphone.pushToTalkOnly,
    settings?.microphone.deviceId,
    settings?.microphone.gain,
    settings?.microphone.threshold,
    settings?.microphone.silenceMs,
    ensureInput
  ])

  // JARVIS must not hear itself. Pause the wake scan while it is working or
  // talking, and resume afterwards.
  useEffect(() => {
    const state = useStore.getState()
    const shouldPause = busy || state.speaking
    if (shouldPause && modeRef.current === 'wake') {
      resumeWakeRef.current = true
      modeRef.current = 'off'
      inputRef.current?.stopRecording()
    } else if (!shouldPause && resumeWakeRef.current && settings?.wakeWord.enabled) {
      resumeWakeRef.current = false
      modeRef.current = 'wake'
      const input = inputRef.current
      if (input?.isOpen() && !input.isRecording()) setTimeout(() => input.startRecording(), 220)
    }
  }, [busy, settings?.wakeWord.enabled])

  /* ── speech output ────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!speakRequest || !settings) return
    const state = useStore.getState()
    state.clearSpeakRequest()
    if (!settings.voice.enabled || settings.voice.engine === 'off') return

    // Written text read literally is most of what makes speech sound robotic:
    // clean it, then deliver it a sentence at a time.
    const { text, sentences } = prepareSpeech(
      speakRequest.text,
      settings.voice.chunked === false ? 100_000 : 220
    )
    if (!sentences.length) return

    const finished = () => {
      useStore.getState().setSpeaking(false)
      useStore.getState().applyEvent({ type: 'status', status: 'idle' })
    }

    const speakWithSystem = () => {
      const started = speaker.speak(sentences, settings.voice, {
        onStart: () => useStore.getState().setSpeaking(true),
        onEnd: finished,
        onError: (message) => {
          useStore.getState().setVoiceError(message)
          useStore.getState().setSpeaking(false)
        }
      })
      if (!started) useStore.getState().setSpeaking(false)
    }

    if (settings.voice.engine === 'native') {
      state.setSpeaking(true)
      audioBus.publishEnvelope(0.5, performance.now() / 1000)
      void window.jarvis.speakNative(text).finally(() => {
        // Native speech reports no end event; estimate from length so the core
        // returns to idle at roughly the right moment.
        const estimate = Math.min(16_000, 900 + text.length * 62)
        setTimeout(() => {
          useStore.getState().setSpeaking(false)
          audioBus.clear()
        }, estimate)
      })
      return
    }

    if (settings.voice.engine === 'neural') {
      void neuralVoice
        .speak(sentences, settings.voice, {
          onStart: () => useStore.getState().setSpeaking(true),
          onEnd: finished,
          onError: (message) => useStore.getState().setVoiceError(message)
        })
        .then((spoke) => {
          // Synthesis never started; use the operating system's voices so the
          // reply is still heard, and say once why.
          if (!spoke) speakWithSystem()
        })
      return
    }

    speakWithSystem()
  }, [speakRequest, settings])

  const stopSpeaking = useCallback(() => {
    speaker.stop()
    neuralVoice.stop()
    void window.jarvis.stopNativeSpeech()
    useStore.getState().setSpeaking(false)
    audioBus.clear()
  }, [])

  useEffect(() => {
    if (stopSignal > 0) stopSpeaking()
  }, [stopSignal, stopSpeaking])

  useEffect(() => {
    if (listenSignal > 0) void startListening()
  }, [listenSignal, startListening])

  // Release the microphone when the window goes away.
  useEffect(() => {
    return () => {
      inputRef.current?.close()
      speaker.stop()
      neuralVoice.stop()
    }
  }, [])

  return { startListening, stopListening, toggleListening, stopSpeaking }
}

export { matchWakePhrase } from './wake'
