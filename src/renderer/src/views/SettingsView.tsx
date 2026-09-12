import { useCallback, useEffect, useState } from 'react'
import type { ProviderId, Settings } from '@shared/types'
import { useStore } from '../store/useStore'
import { Row, Toggle, Slider, Select, TextField, HotkeyField } from '../components/fields'
import { speaker } from '../lib/tts'
import { neuralVoice } from '../lib/neuralVoice'
import { prepareSpeech } from '@shared/speech'
import { listMicrophones } from '../lib/voice'
import { playCue } from '../lib/sound'
import type { JSX } from 'react'

type SectionId =
  | 'general' | 'ai' | 'voice' | 'microphone' | 'wake' | 'automation'
  | 'permissions' | 'memory' | 'appearance' | 'sound' | 'hotkeys' | 'privacy' | 'logs' | 'about'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'voice', label: 'Voice' },
  { id: 'microphone', label: 'Microphone' },
  { id: 'wake', label: 'Wake word' },
  { id: 'automation', label: 'Automation' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'memory', label: 'Memory' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'sound', label: 'Sound' },
  { id: 'hotkeys', label: 'Hotkeys' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'logs', label: 'Logs' },
  { id: 'about', label: 'About' }
]

const CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']
/** PlayAI voices, grouped so the list reads as a choice rather than a dump. */
const NEURAL_VOICES = [
  { value: 'Fritz-PlayAI', label: 'Fritz — measured, neutral' },
  { value: 'Atlas-PlayAI', label: 'Atlas — low and calm' },
  { value: 'Basil-PlayAI', label: 'Basil — British, dry' },
  { value: 'Briggs-PlayAI', label: 'Briggs — warm, deliberate' },
  { value: 'Calum-PlayAI', label: 'Calum — light, quick' },
  { value: 'Cillian-PlayAI', label: 'Cillian — Irish, soft' },
  { value: 'Celeste-PlayAI', label: 'Celeste — clear, even' },
  { value: 'Quinn-PlayAI', label: 'Quinn — bright, precise' },
  { value: 'Arista-PlayAI', label: 'Arista — crisp, formal' },
  { value: 'Indigo-PlayAI', label: 'Indigo — relaxed' }
]

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-120b'
]

export function SettingsView(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const provider = useStore((s) => s.provider)
  const tools = useStore((s) => s.tools)
  const appVersion = useStore((s) => s.appVersion)
  const platform = useStore((s) => s.platform)

  const [section, setSection] = useState<SectionId>('general')
  const [keyStatus, setKeyStatus] = useState<Array<{ name: string; configured: boolean; source: string; hint: string; insecureStorage: boolean }>>([])
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [microphones, setMicrophones] = useState<Array<{ deviceId: string; label: string }>>([])
  const [logs, setLogs] = useState<Array<{ id: string; ts: number; level: string; scope: string; message: string }>>([])
  const [warning, setWarning] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const patch = useCallback(async (value: unknown) => {
    const result = await window.jarvis.updateSettings(value)
    setWarning(result?.warning ?? null)
  }, [])

  useEffect(() => {
    void window.jarvis.keyStatus().then((status) => Array.isArray(status) && setKeyStatus(status))
  }, [provider])

  useEffect(() => {
    if (section === 'voice') void speaker.ready().then(() => setVoices(speaker.ranked(settings?.general.language ?? 'en')))
    if (section === 'microphone') void listMicrophones().then(setMicrophones)
    if (section === 'logs') void window.jarvis.logs().then((entries) => Array.isArray(entries) && setLogs(entries.slice().reverse()))
  }, [section])

  if (!settings) return <div className="view"><div className="empty">Loading settings…</div></div>

  /** Previews through whichever engine is selected, so it is a real sample. */
  const preview = async () => {
    const sample = 'Certainly. System diagnostics are nominal, and I am ready when you are.'
    const { sentences } = prepareSpeech(sample)
    setPreviewError(null)
    setPreviewing(true)
    try {
      if (settings.voice.engine === 'native') {
        await window.jarvis.speakNative(sample)
      } else if (settings.voice.engine === 'neural') {
        const spoke = await neuralVoice.speak(sentences, settings.voice, {
          onError: (message) => setPreviewError(message)
        })
        if (!spoke) speaker.speak(sentences, settings.voice, { onError: setPreviewError })
      } else {
        speaker.speak(sentences, settings.voice, { onError: setPreviewError })
      }
    } finally {
      setPreviewing(false)
    }
  }

  const saveKey = async (name: 'ANTHROPIC_API_KEY' | 'GROQ_API_KEY') => {
    const value = keyDraft[name] ?? ''
    await window.jarvis.setApiKey(name, value)
    setKeyDraft((draft) => ({ ...draft, [name]: '' }))
    const status = await window.jarvis.keyStatus()
    if (Array.isArray(status)) setKeyStatus(status)
  }

  const test = async (id: ProviderId) => {
    setTesting(id)
    const result = await window.jarvis.testProvider(id)
    setTestResult((current) => ({ ...current, [id]: result?.message ?? 'No response.' }))
    setTesting(null)
  }

  const status = (name: string) => keyStatus.find((entry) => entry.name === name)

  return (
    <div className="view settings">
      <header className="view-head">
        <div>
          <h1 className="view-title">Settings</h1>
          <p className="view-sub">JARVIS {appVersion} · {platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}</p>
        </div>
      </header>

      {warning && <div className="settings-warning">{warning}</div>}

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              className={`settings-nav-item ${section === entry.id ? 'active' : ''}`}
              onClick={() => setSection(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="settings-panel scroll">
          {section === 'general' && (
            <Section title="General" description="How JARVIS behaves at startup.">
              <Row label="Demo mode" hint="Run the full interface with no model and no side effects. Clearly labelled, and nothing is executed.">
                <Toggle checked={settings.general.demoMode} onChange={(v) => patch({ general: { demoMode: v } })} label="Demo mode" />
              </Row>
              <Row
                label="Launch at login"
                hint={
                  platform === 'linux'
                    ? 'Not supported on this platform; add JARVIS to your desktop environment’s startup applications.'
                    : 'Start JARVIS automatically when you sign in.'
                }
              >
                <Toggle
                  checked={settings.general.launchOnStartup}
                  onChange={(v) => patch({ general: { launchOnStartup: v } })}
                  label="Launch at login"
                  disabled={platform === 'linux'}
                />
              </Row>
              <Row label="Start minimised" hint="Launch into the tray instead of opening the window.">
                <Toggle checked={settings.general.startMinimised} onChange={(v) => patch({ general: { startMinimised: v } })} label="Start minimised" />
              </Row>
              <Row label="Language" hint="Used for speech recognition and voice selection.">
                <Select
                  label="Language"
                  value={settings.general.language}
                  onChange={(v) => patch({ general: { language: v } })}
                  options={[
                    { value: 'en-US', label: 'English (US)' },
                    { value: 'en-GB', label: 'English (UK)' },
                    { value: 'de-DE', label: 'German' },
                    { value: 'es-ES', label: 'Spanish' },
                    { value: 'fr-FR', label: 'French' },
                    { value: 'it-IT', label: 'Italian' },
                    { value: 'pt-BR', label: 'Portuguese (Brazil)' },
                    { value: 'ja-JP', label: 'Japanese' }
                  ]}
                />
              </Row>
              <Row label="Reset everything" hint="Restores all settings to their defaults. Memory, routines and history are kept.">
                <button
                  className="btn danger"
                  onClick={() => confirm('Reset all settings to defaults?') && void window.jarvis.resetSettings()}
                >
                  Reset settings
                </button>
              </Row>
            </Section>
          )}

          {section === 'ai' && (
            <Section title="AI" description="Which model answers, and how.">
              <Row label="Provider" hint="AUTO sends reasoning and planning to Claude, and short exchanges to Groq.">
                <Select
                  label="Provider"
                  value={settings.ai.provider}
                  onChange={(v) => patch({ ai: { provider: v } })}
                  options={[
                    { value: 'auto', label: 'Auto — route by request' },
                    { value: 'claude', label: 'Claude only' },
                    { value: 'groq', label: 'Groq only' }
                  ]}
                />
              </Row>

              <div className="key-card panel">
                <span className="corner tl" /><span className="corner br" />
                <div className="key-head">
                  <div>
                    <div className="key-title">Anthropic Claude</div>
                    <div className="key-sub label">
                      {status('ANTHROPIC_API_KEY')?.configured
                        ? `Configured ${status('ANTHROPIC_API_KEY')?.hint} · from ${sourceLabel(status('ANTHROPIC_API_KEY')?.source)}`
                        : 'Not configured'}
                    </div>
                  </div>
                  <span className={`dot ${provider?.claude.ok && provider.claude.configured ? 'ok' : provider?.claude.configured ? 'warn' : ''}`} />
                </div>
                <div className="key-entry">
                  <TextField
                    label="Anthropic API key"
                    type="password"
                    mono
                    value={keyDraft.ANTHROPIC_API_KEY ?? ''}
                    onChange={(v) => setKeyDraft((draft) => ({ ...draft, ANTHROPIC_API_KEY: v }))}
                    placeholder={status('ANTHROPIC_API_KEY')?.configured ? 'Replace key…' : 'sk-ant-…'}
                  />
                  <button className="btn" onClick={() => void saveKey('ANTHROPIC_API_KEY')} disabled={!keyDraft.ANTHROPIC_API_KEY?.trim()}>Save</button>
                  <button className="btn" onClick={() => void test('claude')} disabled={testing === 'claude' || !status('ANTHROPIC_API_KEY')?.configured}>
                    {testing === 'claude' ? 'Testing…' : 'Test'}
                  </button>
                </div>
                {testResult.claude && <div className="key-result">{testResult.claude}</div>}
                <Row label="Model">
                  <Select
                    label="Claude model"
                    value={settings.ai.claudeModel}
                    onChange={(v) => patch({ ai: { claudeModel: v } })}
                    options={CLAUDE_MODELS.map((model) => ({ value: model, label: model }))}
                  />
                </Row>
              </div>

              <div className="key-card panel">
                <span className="corner tl" /><span className="corner br" />
                <div className="key-head">
                  <div>
                    <div className="key-title">Groq</div>
                    <div className="key-sub label">
                      {status('GROQ_API_KEY')?.configured
                        ? `Configured ${status('GROQ_API_KEY')?.hint} · from ${sourceLabel(status('GROQ_API_KEY')?.source)}`
                        : 'Not configured — also required for speech recognition'}
                    </div>
                  </div>
                  <span className={`dot ${provider?.groq.ok && provider.groq.configured ? 'ok' : provider?.groq.configured ? 'warn' : ''}`} />
                </div>
                <div className="key-entry">
                  <TextField
                    label="Groq API key"
                    type="password"
                    mono
                    value={keyDraft.GROQ_API_KEY ?? ''}
                    onChange={(v) => setKeyDraft((draft) => ({ ...draft, GROQ_API_KEY: v }))}
                    placeholder={status('GROQ_API_KEY')?.configured ? 'Replace key…' : 'gsk_…'}
                  />
                  <button className="btn" onClick={() => void saveKey('GROQ_API_KEY')} disabled={!keyDraft.GROQ_API_KEY?.trim()}>Save</button>
                  <button className="btn" onClick={() => void test('groq')} disabled={testing === 'groq' || !status('GROQ_API_KEY')?.configured}>
                    {testing === 'groq' ? 'Testing…' : 'Test'}
                  </button>
                </div>
                {testResult.groq && <div className="key-result">{testResult.groq}</div>}
                <Row label="Model">
                  <Select
                    label="Groq model"
                    value={settings.ai.groqModel}
                    onChange={(v) => patch({ ai: { groqModel: v } })}
                    options={GROQ_MODELS.map((model) => ({ value: model, label: model }))}
                  />
                </Row>
              </div>

              {keyStatus.some((entry) => entry.insecureStorage) && (
                <div className="notice warn">
                  This system provides no encrypted credential storage, so keys entered here are kept for this session only.
                  Put them in a <span className="mono">.env</span> file or your environment to persist them.
                </div>
              )}

              <Row label="Temperature" hint="Lower is more literal and repeatable.">
                <Slider label="Temperature" value={settings.ai.temperature} min={0} max={1} step={0.05} onChange={(v) => patch({ ai: { temperature: v } })} />
              </Row>
              <Row label="Maximum response length" hint="Upper bound on tokens per reply.">
                <Slider label="Max tokens" value={settings.ai.maxTokens} min={256} max={8192} step={128} onChange={(v) => patch({ ai: { maxTokens: v } })} format={(v) => String(v)} />
              </Row>
              <Row label="Tool calls per request" hint="A runaway-loop guard for multi-step tasks.">
                <Slider label="Max tool calls" value={settings.ai.maxToolCalls} min={1} max={30} step={1} onChange={(v) => patch({ ai: { maxToolCalls: v } })} format={(v) => String(v)} />
              </Row>
              <Row label="Automatic fallback" hint="If the chosen provider fails, try the other one.">
                <Toggle checked={settings.ai.autoFallback} onChange={(v) => patch({ ai: { autoFallback: v } })} label="Automatic fallback" />
              </Row>
            </Section>
          )}

          {section === 'voice' && (
            <Section title="Voice" description="How JARVIS speaks.">
              <Row label="Speak replies">
                <Toggle checked={settings.voice.enabled} onChange={(v) => patch({ voice: { enabled: v } })} label="Speak replies" />
              </Row>
              <Row
                label="Engine"
                hint={
                  settings.voice.engine === 'neural'
                    ? 'Synthesised through Groq. Markedly more natural than the system voices, and needs a Groq key and a connection.'
                    : 'System voices come from the operating system. Native shells out to say / SAPI for systems that expose none.'
                }
              >
                <Select
                  label="Speech engine"
                  value={settings.voice.engine}
                  onChange={(v) => patch({ voice: { engine: v } })}
                  options={[
                    { value: 'neural', label: 'Neural — most natural' },
                    { value: 'system', label: 'System voices' },
                    { value: 'native', label: `Native (${platform === 'win32' ? 'SAPI' : platform === 'darwin' ? 'say' : 'speech-dispatcher'})` },
                    { value: 'off', label: 'Silent' }
                  ]}
                />
              </Row>

              {settings.voice.engine === 'neural' ? (
                <Row label="Voice" hint={provider?.groq.configured ? undefined : 'Needs a Groq API key — Settings → AI.'}>
                  <Select
                    label="Neural voice"
                    value={settings.voice.neuralVoice}
                    onChange={(v) => patch({ voice: { neuralVoice: v } })}
                    options={NEURAL_VOICES}
                  />
                </Row>
              ) : (
                <Row
                  label="Voice"
                  hint={
                    voices.length
                      ? `${voices.length} available${voices.some((v) => /natural|neural|premium|enhanced/i.test(v.name)) ? '. Names containing Natural or Neural sound far better than the rest.' : ''}`
                      : 'No system voices were found.'
                  }
                >
                  <Select
                    label="Voice"
                    value={settings.voice.voiceURI}
                    onChange={(v) => patch({ voice: { voiceURI: v } })}
                    options={[
                      { value: '', label: 'Automatic — best available' },
                      ...voices.map((voice) => ({
                        value: voice.voiceURI,
                        label: `${voice.name}${/natural|neural|premium|enhanced/i.test(voice.name) ? ' ★' : ''} (${voice.lang})`
                      }))
                    ]}
                  />
                </Row>
              )}
              <Row label="Rate">
                <Slider label="Rate" value={settings.voice.rate} min={0.6} max={1.6} step={0.02} onChange={(v) => patch({ voice: { rate: v } })} format={(v) => `${v.toFixed(2)}×`} />
              </Row>
              {settings.voice.engine !== 'neural' && (
                <Row label="Pitch" hint="1.00 is the voice as recorded. Moving away from it is what makes speech sound synthetic.">
                  <Slider label="Pitch" value={settings.voice.pitch} min={0.5} max={1.5} step={0.02} onChange={(v) => patch({ voice: { pitch: v } })} format={(v) => v.toFixed(2)} />
                </Row>
              )}
              <Row label="Sentence delivery" hint="Speak one sentence at a time. Engines shape intonation per sentence, so this sounds spoken rather than read.">
                <Toggle checked={settings.voice.chunked} onChange={(v) => patch({ voice: { chunked: v } })} label="Sentence delivery" />
              </Row>
              <Row label="Volume">
                <Slider label="Volume" value={settings.voice.volume} min={0} max={1} step={0.05} onChange={(v) => patch({ voice: { volume: v } })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Speak action results" hint="Say each tool result aloud, not just the reply.">
                <Toggle checked={settings.voice.speakActions} onChange={(v) => patch({ voice: { speakActions: v } })} label="Speak action results" />
              </Row>
              <Row label="Preview" hint={previewError ?? undefined} warn={!!previewError}>
                <button className="btn" disabled={previewing} onClick={() => void preview()}>
                  {previewing ? 'Speaking…' : 'Speak a sample'}
                </button>
              </Row>
            </Section>
          )}

          {section === 'microphone' && (
            <Section title="Microphone" description="JARVIS opens the microphone only while listening, and the title bar always shows when it is open.">
              <Row label="Input device">
                <Select
                  label="Microphone"
                  value={settings.microphone.deviceId}
                  onChange={(v) => patch({ microphone: { deviceId: v } })}
                  options={[{ value: 'default', label: 'System default' }, ...microphones.map((mic) => ({ value: mic.deviceId, label: mic.label }))]}
                />
              </Row>
              <Row label="Input gain" hint="Raise for a quiet microphone.">
                <Slider label="Gain" value={settings.microphone.gain} min={0.5} max={3} step={0.1} onChange={(v) => patch({ microphone: { gain: v } })} format={(v) => `${v.toFixed(1)}×`} />
              </Row>
              <Row label="Speech threshold" hint="How loud counts as speech. Lower is more sensitive.">
                <Slider label="Threshold" value={settings.microphone.threshold} min={0.004} max={0.08} step={0.002} onChange={(v) => patch({ microphone: { threshold: v } })} format={(v) => v.toFixed(3)} />
              </Row>
              <Row label="End of speech" hint="How much silence ends an utterance.">
                <Slider label="Silence" value={settings.microphone.silenceMs} min={400} max={2500} step={50} onChange={(v) => patch({ microphone: { silenceMs: v } })} format={(v) => `${(v / 1000).toFixed(2)}s`} />
              </Row>
              <Row label="Push to talk only" hint="Never listen continuously; require the hotkey or the microphone button.">
                <Toggle checked={settings.microphone.pushToTalkOnly} onChange={(v) => patch({ microphone: { pushToTalkOnly: v } })} label="Push to talk only" />
              </Row>
              <Row label="Live input level">
                <MicMeter />
              </Row>
            </Section>
          )}

          {section === 'wake' && (
            <Section
              title="Wake word"
              description="When armed, JARVIS listens for the wake phrase. Short clips of detected speech are sent to Groq for transcription to recognise it — nothing is recorded to disk, and the title bar shows WAKE whenever the microphone is open."
            >
              <Row label="Enable wake word">
                <Toggle
                  checked={settings.wakeWord.enabled}
                  onChange={(v) => patch({ wakeWord: { enabled: v } })}
                  label="Enable wake word"
                  disabled={!settings.permissions.microphoneAccess}
                />
              </Row>
              <Row label="Phrase">
                <TextField label="Wake phrase" value={settings.wakeWord.phrase} onChange={(v) => patch({ wakeWord: { phrase: v } })} placeholder="hey jarvis" />
              </Row>
              <Row label="Sensitivity" hint="Higher accepts looser transcriptions of the phrase.">
                <Slider label="Sensitivity" value={settings.wakeWord.sensitivity} min={0} max={1} step={0.05} onChange={(v) => patch({ wakeWord: { sensitivity: v } })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Chime on wake">
                <Toggle checked={settings.wakeWord.chime} onChange={(v) => patch({ wakeWord: { chime: v } })} label="Chime on wake" />
              </Row>
              {!settings.permissions.microphoneAccess && (
                <div className="notice warn">Microphone access is switched off in Settings → Permissions.</div>
              )}
            </Section>
          )}

          {section === 'automation' && (
            <Section title="Automation" description="What JARVIS may do without asking.">
              <Row label="Run low-risk actions automatically" hint="Opening applications, reading metrics, searching files.">
                <Toggle checked={settings.automation.autoRunLowRisk} onChange={(v) => patch({ automation: { autoRunLowRisk: v } })} label="Auto-run low risk" />
              </Row>
              <Row label="Confirm medium-risk actions" hint="Moving, renaming and creating files; changing settings.">
                <Toggle checked={settings.automation.confirmMediumRisk} onChange={(v) => patch({ automation: { confirmMediumRisk: v } })} label="Confirm medium risk" />
              </Row>
              <Row label="Confirm high-risk actions" hint="Deletion, shell commands and power control always require confirmation.">
                <Toggle checked onChange={() => undefined} label="Confirm high risk" disabled />
              </Row>
              <Row label="Power controls" hint="Allow lock, restart and shutdown. Each still asks first.">
                <Toggle checked={settings.automation.allowPower} onChange={(v) => patch({ automation: { allowPower: v } })} label="Allow power controls" />
              </Row>
              <Row
                label="Unrestricted commands"
                warn={settings.automation.allowShell}
                hint="Allow any program, not just the approved list. Every call still requires explicit confirmation."
              >
                <Toggle checked={settings.automation.allowShell} onChange={(v) => patch({ automation: { allowShell: v } })} label="Unrestricted commands" />
              </Row>
              <Row label="Approved commands" hint="Comma-separated program names JARVIS may run.">
                <TextField
                  label="Approved commands"
                  mono
                  value={settings.automation.allowedCommands.join(', ')}
                  onChange={(v) => patch({ automation: { allowedCommands: v.split(',').map((s) => s.trim()).filter(Boolean) } })}
                />
              </Row>
              <Row label="Extra workspace folders" hint="Folders outside your home directory that JARVIS may modify.">
                <TextField
                  label="Workspace roots"
                  mono
                  value={settings.automation.workspaceRoots.join(', ')}
                  onChange={(v) => patch({ automation: { workspaceRoots: v.split(',').map((s) => s.trim()).filter(Boolean) } })}
                  placeholder="D:\\Projects, /Volumes/Work"
                />
              </Row>
              <Row label="Protected locations" hint="Never modified, whatever is asked.">
                <div className="path-list mono">
                  {settings.automation.protectedPaths.map((path) => (
                    <span className="chip" key={path}>{path}</span>
                  ))}
                </div>
              </Row>
            </Section>
          )}

          {section === 'permissions' && (
            <Section title="Permissions" description="Capability switches, and a per-tool override for everything JARVIS can do.">
              <Row label="Microphone">
                <Toggle checked={settings.permissions.microphoneAccess} onChange={(v) => patch({ permissions: { microphoneAccess: v } })} label="Microphone access" />
              </Row>
              <Row label="Screen access" hint="Required before JARVIS can look at or capture the screen. An indicator appears whenever it does.">
                <Toggle checked={settings.permissions.screenAccess} onChange={(v) => patch({ permissions: { screenAccess: v } })} label="Screen access" />
              </Row>
              <Row label="Web access" hint="Allows opening links and search pages in your browser.">
                <Toggle checked={settings.permissions.webAccess} onChange={(v) => patch({ permissions: { webAccess: v } })} label="Web access" />
              </Row>
              <Row label="Clipboard" hint="Lets JARVIS read and write the clipboard. Whatever you last copied — including a password — would be readable.">
                <Toggle checked={settings.permissions.clipboardAccess} onChange={(v) => patch({ permissions: { clipboardAccess: v } })} label="Clipboard access" />
              </Row>

              <div className="tool-table">
                <div className="tool-head label">
                  <span>Tool</span><span>Risk</span><span>Policy</span>
                </div>
                {tools.map((tool) => (
                  <div className="tool-row" key={tool.name}>
                    <span className="tool-name">
                      <span className="mono">{tool.name}</span>
                      <span className="tool-desc">{tool.description}</span>
                    </span>
                    <span className={`risk-badge risk-${tool.risk}`}>{tool.risk}</span>
                    <Select
                      label={`Policy for ${tool.name}`}
                      value={(settings.permissions.tools[tool.name] ?? 'default') as 'default' | 'allow' | 'confirm' | 'deny'}
                      onChange={(value) => {
                        const next = { ...settings.permissions.tools }
                        if (value === 'default') delete next[tool.name]
                        else next[tool.name] = value as 'allow' | 'confirm' | 'deny'
                        void window.jarvis.updateSettings({ permissions: { tools: next } })
                      }}
                      options={[
                        { value: 'default', label: 'Default' },
                        { value: 'allow', label: 'Always allow' },
                        { value: 'confirm', label: 'Always confirm' },
                        { value: 'deny', label: 'Never' }
                      ]}
                    />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {section === 'memory' && (
            <Section title="Memory" description="What JARVIS keeps between sessions. Everything stored is visible on the Memory screen.">
              <Row label="Enable memory">
                <Toggle checked={settings.memory.enabled} onChange={(v) => patch({ memory: { enabled: v } })} label="Enable memory" />
              </Row>
              <Row label="Keep a command history" hint="Records what was asked and what happened.">
                <Toggle checked={settings.privacy.storeTranscripts} onChange={(v) => patch({ privacy: { storeTranscripts: v } })} label="Keep command history" />
              </Row>
              <Row label="Maximum stored items">
                <Slider label="Max entries" value={settings.memory.maxEntries} min={20} max={500} step={10} onChange={(v) => patch({ memory: { maxEntries: v } })} format={(v) => String(v)} />
              </Row>
            </Section>
          )}

          {section === 'appearance' && (
            <Section title="Appearance" description="Black and crimson by default.">
              <Row label="Accent colour">
                <div className="swatches">
                  {['#e01f3d', '#c8102e', '#ff3b5c', '#a3122b', '#e0452f'].map((colour) => (
                    <button
                      key={colour}
                      className={`swatch ${settings.appearance.accent === colour ? 'active' : ''}`}
                      style={{ background: colour }}
                      onClick={() => patch({ appearance: { accent: colour } })}
                      aria-label={`Accent ${colour}`}
                    />
                  ))}
                </div>
              </Row>
              <Row label="Red intensity" hint="How strongly the accent reads across the interface.">
                <Slider label="Red intensity" value={settings.appearance.redIntensity} min={0.3} max={1} step={0.05} onChange={(v) => patch({ appearance: { redIntensity: v } })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Animation intensity">
                <Slider label="Animation intensity" value={settings.appearance.animationIntensity} min={0} max={1.5} step={0.05} onChange={(v) => patch({ appearance: { animationIntensity: v } })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="HUD density">
                <Select
                  label="HUD density"
                  value={settings.appearance.hudDensity}
                  onChange={(v) => patch({ appearance: { hudDensity: v } })}
                  options={[
                    { value: 'minimal', label: 'Minimal' },
                    { value: 'standard', label: 'Standard' },
                    { value: 'dense', label: 'Dense' }
                  ]}
                />
              </Row>
              <Row label="Reduced motion" hint="Holds the core still and removes non-essential animation.">
                <Toggle checked={settings.appearance.reducedMotion} onChange={(v) => patch({ appearance: { reducedMotion: v } })} label="Reduced motion" />
              </Row>
              <Row label="Scanlines">
                <Toggle checked={settings.appearance.scanlines} onChange={(v) => patch({ appearance: { scanlines: v } })} label="Scanlines" />
              </Row>
              <Row label="Startup animation">
                <Toggle checked={settings.appearance.bootAnimation} onChange={(v) => patch({ appearance: { bootAnimation: v } })} label="Startup animation" />
              </Row>
              <Row label="Compact mode">
                <Toggle checked={settings.appearance.compact} onChange={(v) => patch({ appearance: { compact: v } })} label="Compact mode" />
              </Row>
              <Row label="Always on top">
                <Toggle checked={settings.appearance.alwaysOnTop} onChange={(v) => patch({ appearance: { alwaysOnTop: v } })} label="Always on top" />
              </Row>
              <Row label="Fullscreen command centre">
                <Toggle checked={settings.appearance.fullscreen} onChange={(v) => patch({ appearance: { fullscreen: v } })} label="Fullscreen" />
              </Row>
            </Section>
          )}

          {section === 'sound' && (
            <Section title="Sound" description="Short interface cues, synthesised locally.">
              <Row label="Interface sounds">
                <Toggle checked={settings.sound.enabled} onChange={(v) => patch({ sound: { enabled: v } })} label="Interface sounds" />
              </Row>
              <Row label="Volume">
                <Slider label="Sound volume" value={settings.sound.volume} min={0} max={1} step={0.05} onChange={(v) => patch({ sound: { volume: v } })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Preview">
                <div className="button-row">
                  <button className="btn" onClick={() => playCue('wake', settings.sound.volume)}>Wake</button>
                  <button className="btn" onClick={() => playCue('complete', settings.sound.volume)}>Complete</button>
                  <button className="btn" onClick={() => playCue('error', settings.sound.volume)}>Error</button>
                </div>
              </Row>
            </Section>
          )}

          {section === 'hotkeys' && (
            <Section title="Hotkeys" description="Global shortcuts work from any application.">
              <Row label="Activate JARVIS" hint={platform === 'darwin' ? 'Command+Space belongs to Spotlight until you free it in macOS keyboard settings.' : undefined}>
                <HotkeyField label="Activate" value={settings.hotkeys.activate} onChange={(v) => patch({ hotkeys: { activate: v } })} />
              </Row>
              <Row label="Push to talk">
                <HotkeyField label="Push to talk" value={settings.hotkeys.pushToTalk} onChange={(v) => patch({ hotkeys: { pushToTalk: v } })} />
              </Row>
              <Row label="Stop speaking">
                <HotkeyField label="Stop speaking" value={settings.hotkeys.stopSpeaking} onChange={(v) => patch({ hotkeys: { stopSpeaking: v } })} />
              </Row>
              <div className="notice">
                In-app: <span className="mono">Ctrl+1…5</span> switches sections, <span className="mono">Ctrl+K</span> focuses the command bar,
                <span className="mono"> Ctrl+Shift+L</span> starts listening, <span className="mono">Esc</span> stops.
              </div>
            </Section>
          )}

          {section === 'privacy' && (
            <Section title="Privacy" description="What leaves this computer, and what is written down.">
              <div className="notice">
                Requests you make are sent to the provider you configure — Anthropic or Groq — along with system metrics and
                tool results needed to answer them. Voice audio is sent to Groq for transcription. Nothing else is transmitted,
                and JARVIS has no telemetry of its own.
              </div>
              <Row label="Log tool arguments" hint="Include paths and URLs in the activity log. API keys are never logged.">
                <Toggle checked={settings.privacy.logArguments} onChange={(v) => patch({ privacy: { logArguments: v } })} label="Log arguments" />
              </Row>
              <Row label="Store command history">
                <Toggle checked={settings.privacy.storeTranscripts} onChange={(v) => patch({ privacy: { storeTranscripts: v } })} label="Store history" />
              </Row>
              <Row label="Proactive suggestions" hint="Occasional notices about battery, disk and memory pressure.">
                <Toggle checked={settings.privacy.proactiveSuggestions} onChange={(v) => patch({ privacy: { proactiveSuggestions: v } })} label="Proactive suggestions" />
              </Row>
              <Row label="Telemetry">
                <span className="setting-static">None. JARVIS collects no analytics.</span>
              </Row>
            </Section>
          )}

          {section === 'logs' && (
            <Section title="Logs" description="Structured records of every tool call and decision. Credentials are redacted before anything is written.">
              <div className="button-row">
                <button className="btn" onClick={() => void window.jarvis.logs().then((entries) => Array.isArray(entries) && setLogs(entries.slice().reverse()))}>Refresh</button>
                <button className="btn" onClick={() => void window.jarvis.openLogFolder()}>Open log folder</button>
                <button className="btn danger" onClick={() => void window.jarvis.clearLogs().then(() => setLogs([]))}>Clear logs</button>
              </div>
              <div className="log-list panel scroll mono">
                {logs.length === 0 ? (
                  <div className="empty">No log entries.</div>
                ) : (
                  logs.map((entry) => (
                    <div className={`log-row level-${entry.level}`} key={entry.id}>
                      <span className="log-time">{new Date(entry.ts).toLocaleTimeString([], { hour12: false })}</span>
                      <span className="log-scope">{entry.scope}</span>
                      <span className="log-message">{entry.message}</span>
                    </div>
                  ))
                )}
              </div>
            </Section>
          )}

          {section === 'about' && (
            <Section title="About" description="">
              <div className="about">
                <div className="about-mark" aria-hidden="true" />
                <h2 className="about-title">JARVIS</h2>
                <p className="about-full">Just A Really Very Intelligent System</p>
                <p className="about-version mono">Version {appVersion}</p>
                <p className="about-text">
                  An intelligent layer on top of your computer. JARVIS understands natural language, plans multi-step work,
                  and acts through a fixed set of audited tools — never by executing model-generated code.
                </p>
                <dl className="about-facts">
                  <div><dt>Platform</dt><dd>{platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}</dd></div>
                  <div><dt>Tools available</dt><dd>{tools.length}</dd></div>
                  <div><dt>Providers</dt><dd>Anthropic Claude · Groq</dd></div>
                  <div><dt>Telemetry</dt><dd>None</dd></div>
                </dl>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">{title}</h2>
      {description && <p className="settings-section-desc">{description}</p>}
      {children}
    </section>
  )
}

function MicMeter(): JSX.Element {
  const level = useStore((s) => s.micLevel)
  const listening = useStore((s) => s.listening)
  return (
    <div className="mic-meter">
      <div className="mic-meter-track">
        <div className="mic-meter-fill" style={{ transform: `scaleX(${Math.min(1, level * 1.6)})` }} />
      </div>
      <span className="label">{listening ? 'Open' : 'Closed'}</span>
    </div>
  )
}

function sourceLabel(source?: string): string {
  switch (source) {
    case 'env': return 'the environment'
    case 'encrypted': return 'encrypted storage'
    case 'session': return 'this session'
    default: return 'nowhere'
  }
}

export type { Settings }
