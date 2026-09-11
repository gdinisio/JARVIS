import { spawn, type ChildProcess } from 'node:child_process'
import { settings } from './settings'
import { logger } from './logging'

/**
 * Native text-to-speech.
 *
 * The renderer speaks through the Web Speech API by default (it can shape the
 * waveform from the audio it generates). This is the fallback for systems
 * where no speech-synthesis voice is exposed to Chromium, and it is driven
 * through argument arrays and environment variables like every other command.
 */

let current: ChildProcess | null = null

export async function speakNative(text: string): Promise<{ ok: boolean; error?: string }> {
  const clean = text.trim().slice(0, 1200)
  if (!clean) return { ok: true }

  stopNativeSpeech()
  const voice = settings.get().voice

  try {
    if (process.platform === 'darwin') {
      const args = ['-r', String(Math.round(175 * clamp(voice.rate, 0.5, 2)))]
      if (voice.voiceURI) args.push('-v', voice.voiceURI)
      args.push('--', clean)
      current = spawn('say', args, { stdio: 'ignore' })
    } else if (process.platform === 'win32') {
      const script = `
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speaker.Rate = [int]$env:JARVIS_RATE
$speaker.Volume = [int]$env:JARVIS_VOLUME
if ($env:JARVIS_VOICE) { try { $speaker.SelectVoice($env:JARVIS_VOICE) } catch {} }
$speaker.Speak($env:JARVIS_TEXT)
`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      current = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          JARVIS_TEXT: clean,
          JARVIS_RATE: String(Math.round((clamp(voice.rate, 0.5, 2) - 1) * 5)),
          JARVIS_VOLUME: String(Math.round(clamp(voice.volume, 0, 1) * 100)),
          JARVIS_VOICE: voice.voiceURI ?? ''
        }
      })
    } else {
      current = spawn('spd-say', ['-r', String(Math.round((clamp(voice.rate, 0.5, 2) - 1) * 50)), '--', clean], {
        stdio: 'ignore'
      })
    }

    current.on('error', (error) => {
      logger.warn('speech', 'Native speech is unavailable on this system.', { error: error.message })
      current = null
    })
    current.on('close', () => {
      current = null
    })
    return { ok: true }
  } catch (error) {
    logger.warn('speech', 'Native speech failed.', { error: String(error) })
    return { ok: false, error: 'Native speech is not available on this system.' }
  }
}

export function stopNativeSpeech(): void {
  if (!current) return
  try {
    current.kill()
  } catch {
    /* already finished */
  }
  current = null
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}
