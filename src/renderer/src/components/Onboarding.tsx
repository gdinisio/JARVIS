import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { greeting } from '../lib/format'
import { speaker } from '../lib/tts'
import { prepareSpeech } from '@shared/speech'
import { PROVIDERS } from '@shared/providers'
import { listMicrophones } from '../lib/voice'
import type { JSX } from 'react'

/**
 * First run.
 *
 * Five short steps: who is answering, how you talk to it, what it may touch,
 * and what it keeps. No step is mandatory — JARVIS is usable immediately,
 * in demo mode if nothing is configured.
 */
const STEPS = ['Welcome', 'AI provider', 'Voice', 'Permissions', 'Ready'] as const

/** Providers that need a key, in catalogue order. Ollama needs none. */
const KEYED_PROVIDERS = PROVIDERS.filter((provider) => provider.requiresKey && provider.id !== 'custom')

export function Onboarding(): JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const booted = useStore((s) => s.booted)
  const provider = useStore((s) => s.provider)
  const [step, setStep] = useState(0)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [microphones, setMicrophones] = useState<Array<{ deviceId: string; label: string }>>([])
  const [micRequested, setMicRequested] = useState(false)

  useEffect(() => {
    if (step === 2) void speaker.ready()
  }, [step])

  if (!settings || settings.general.onboarded || !booted) return null

  const finish = async (demo: boolean) => {
    setSaving(true)
    for (const [name, value] of Object.entries(keys)) {
      if (value.trim()) await window.jarvis.setApiKey(name, value.trim())
    }

    // With a Groq key available, the neural voice is a large step up on the
    // operating system's, so start there rather than making it a discovery.
    const hasGroq = !!(keys.GROQ_API_KEY?.trim() || provider?.providers.groq?.configured)
    await window.jarvis.updateSettings({
      general: { onboarded: true, demoMode: demo },
      ...(hasGroq && settings.voice.engine === 'system' ? { voice: { engine: 'neural' } } : {})
    })
    setSaving(false)
  }

  const requestMicrophone = async () => {
    setMicRequested(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      setMicrophones(await listMicrophones())
    } catch {
      await window.jarvis.updateSettings({ permissions: { microphoneAccess: false } })
    }
  }

  const hasKey =
    Object.values(provider?.providers ?? {}).some((entry) => entry.configured) ||
    Object.values(keys).some((value) => value.trim())

  return (
    <div className="onboarding">
      <div className="onboarding-card panel">
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />

        <ol className="onboarding-steps" aria-label="Setup progress">
          {STEPS.map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
              <span className="onboarding-step-dot" />
              <span>{label}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="onboarding-body">
            <h1 className="onboarding-title">{greeting()}. I am JARVIS.</h1>
            <p className="onboarding-lead">Just A Really Very Intelligent System.</p>
            <p>
              I sit on top of this computer: I understand what you ask in plain language, plan the work, and carry it out
              through a fixed set of audited tools. I can open applications, find and organise files, read system state,
              run approved commands and remember how you like to work.
            </p>
            <ul className="onboarding-list">
              <li>Anything destructive asks you first — always.</li>
              <li>The microphone is only ever open while the indicator says so.</li>
              <li>Everything I remember is visible, and removable, on the Memory screen.</li>
            </ul>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-body">
            <h1 className="onboarding-title">Which mind should answer?</h1>
            <p>
              Every provider below is free — a key you get with an email address, no payment method. Add one or
              several; with more than one, JARVIS sends each request to whichever suits it.
            </p>

            {KEYED_PROVIDERS.map((entry) => (
              <label className="field-row" key={entry.id}>
                <span className="label">
                  {entry.name}
                  {entry.id === 'groq' && ' — also does speech'}
                  {entry.id === 'gemini' && ' — also reads the screen'}
                </span>
                <input
                  className="field mono"
                  type="password"
                  placeholder={provider?.providers[entry.id]?.configured ? 'Already configured' : `Paste a ${entry.name} key`}
                  value={keys[entry.envVar] ?? ''}
                  onChange={(event) => setKeys((current) => ({ ...current, [entry.envVar]: event.target.value }))}
                  autoComplete="off"
                />
                <span className="onboarding-provider-note">
                  {entry.freeTier}{' '}
                  <button
                    className="link-button"
                    onClick={(event) => {
                      event.preventDefault()
                      void window.jarvis.openExternal(entry.signupUrl)
                    }}
                  >
                    Get a key
                  </button>
                </span>
              </label>
            ))}

            <p className="onboarding-note">
              Prefer nothing to leave this machine? Install <span className="mono">Ollama</span> and JARVIS will use it
              with no key and no network at all. Keys are stored in your operating system's encrypted credential storage
              and never reach the interface layer.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-body">
            <h1 className="onboarding-title">Voice</h1>
            <p>Speak to me, type to me, or both. Nothing is recorded to disk.</p>
            <div className="onboarding-actions-inline">
              <button className="btn" onClick={() => void requestMicrophone()} disabled={micRequested}>
                {micRequested ? 'Microphone requested' : 'Allow microphone'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  const { sentences } = prepareSpeech('Certainly. I am ready when you are.')
                  speaker.speak(sentences, settings.voice)
                }}
              >
                Hear my voice
              </button>
            </div>
            {(keys.GROQ_API_KEY?.trim() || provider?.providers.groq?.configured) && (
              <p className="onboarding-note">
                A Groq key is configured, so JARVIS will use its neural voice — noticeably more natural than the
                operating system's. You can change this in Settings → Voice.
              </p>
            )}
            {microphones.length > 0 && (
              <p className="onboarding-note">{microphones.length} input device{microphones.length === 1 ? '' : 's'} detected.</p>
            )}
            <label className="onboarding-check">
              <input
                type="checkbox"
                checked={settings.wakeWord.enabled}
                onChange={(event) => void window.jarvis.updateSettings({ wakeWord: { enabled: event.target.checked } })}
              />
              <span>
                Listen for “{settings.wakeWord.phrase}”. Short clips of detected speech are transcribed by Groq to recognise
                the phrase; the title bar shows whenever the microphone is open.
              </span>
            </label>
            <label className="onboarding-check">
              <input
                type="checkbox"
                checked={settings.voice.enabled}
                onChange={(event) => void window.jarvis.updateSettings({ voice: { enabled: event.target.checked } })}
              />
              <span>Speak replies aloud.</span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="onboarding-body">
            <h1 className="onboarding-title">What may I touch?</h1>
            <p>These can all be changed later in Settings → Permissions.</p>
            <label className="onboarding-check">
              <input
                type="checkbox"
                checked={settings.permissions.webAccess}
                onChange={(event) => void window.jarvis.updateSettings({ permissions: { webAccess: event.target.checked } })}
              />
              <span>Open links and searches in your browser.</span>
            </label>
            <label className="onboarding-check">
              <input
                type="checkbox"
                checked={settings.permissions.screenAccess}
                onChange={(event) => void window.jarvis.updateSettings({ permissions: { screenAccess: event.target.checked } })}
              />
              <span>Look at the screen when you ask about what is displayed. An indicator appears whenever I do.</span>
            </label>
            <label className="onboarding-check">
              <input
                type="checkbox"
                checked={settings.automation.allowPower}
                onChange={(event) => void window.jarvis.updateSettings({ automation: { allowPower: event.target.checked } })}
              />
              <span>Allow lock, restart and shutdown. Each still asks for confirmation.</span>
            </label>
            <div className="onboarding-fixed">
              <div className="label">Always on</div>
              <p>
                Deletion, shell commands and power actions require explicit confirmation. System folders, credential stores
                and browser profiles are never modified.
              </p>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboarding-body">
            <h1 className="onboarding-title">System initialisation complete.</h1>
            <p>Try one of these:</p>
            <div className="onboarding-examples">
              {[
                'How is my system doing?',
                'Open my browser.',
                'Find all PDFs in Downloads.',
                'Create a folder called Projects.',
                'Remember that my preferred browser is Firefox.'
              ].map((example) => (
                <span className="chip" key={example}>{example}</span>
              ))}
            </div>
            {!hasKey && (
              <p className="onboarding-note">
                No API key configured. JARVIS will start in demo mode — the interface is fully live, but no model answers
                and nothing is executed. Add a key any time in Settings → AI.
              </p>
            )}
          </div>
        )}

        <div className="onboarding-actions">
          <button className="btn ghost" onClick={() => void finish(!hasKey)} disabled={saving}>
            Skip setup
          </button>
          <div className="onboarding-next">
            {step > 0 && (
              <button className="btn" onClick={() => setStep(step - 1)} disabled={saving}>
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button className="btn primary" onClick={() => setStep(step + 1)}>
                Continue
              </button>
            ) : (
              <button className="btn primary" onClick={() => void finish(!hasKey)} disabled={saving}>
                {saving ? 'Initialising…' : 'Begin'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
