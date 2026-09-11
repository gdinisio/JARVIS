import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { VoiceControls } from '../lib/useVoice'
import type { JSX } from 'react'

/**
 * The command bar.
 *
 * Text and voice are the same input: whatever arrives goes to the engine
 * through one path. Enter submits, Shift+Enter adds a line, Up and Down walk
 * the history of what you have said.
 */
export function CommandBar({ voice }: { voice: VoiceControls }): JSX.Element {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const busy = useStore((s) => s.busy)
  const listening = useStore((s) => s.listening)
  const speaking = useStore((s) => s.speaking)
  const transcribing = useStore((s) => s.transcribing)
  const voiceError = useStore((s) => s.voiceError)
  const history = useStore((s) => s.history)
  const activationSignal = useStore((s) => s.activationSignal)
  const settings = useStore((s) => s.settings)

  useEffect(() => {
    if (activationSignal > 0) textareaRef.current?.focus()
  }, [activationSignal])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(132, textarea.scrollHeight)}px`
  }, [value])

  const submit = () => {
    const text = value.trim()
    if (!text) return
    void window.jarvis.submit(text, 'text')
    setValue('')
    setHistoryIndex(-1)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'Escape') {
      if (busy) void window.jarvis.cancel()
      else if (speaking) voice.stopSpeaking()
      else setValue('')
      return
    }
    // Arrow history only when the caret is at the edge, so multiline still works.
    if (event.key === 'ArrowUp' && textareaRef.current?.selectionStart === 0) {
      const next = Math.min(history.length - 1, historyIndex + 1)
      if (history[next]) {
        event.preventDefault()
        setHistoryIndex(next)
        setValue(history[next].command)
      }
      return
    }
    if (event.key === 'ArrowDown' && historyIndex >= 0) {
      event.preventDefault()
      const next = historyIndex - 1
      setHistoryIndex(next)
      setValue(next >= 0 ? history[next]?.command ?? '' : '')
    }
  }

  const micTitle = listening
    ? 'Stop listening'
    : settings?.permissions.microphoneAccess === false
      ? 'Microphone access is switched off in Settings'
      : `Speak a command${settings?.hotkeys.pushToTalk ? ` (${settings.hotkeys.pushToTalk})` : ''}`

  return (
    <div className="commandbar">
      {voiceError && (
        <div className="command-error" role="status">
          {voiceError}
          <button className="btn ghost tiny" onClick={() => useStore.getState().setVoiceError(null)}>Dismiss</button>
        </div>
      )}

      <div className={`command-shell panel ${listening ? 'listening' : ''} ${busy ? 'busy' : ''}`}>
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />

        <button
          className={`mic-button ${listening ? 'live' : ''}`}
          onClick={() => voice.toggleListening()}
          title={micTitle}
          aria-label={micTitle}
          aria-pressed={listening}
        >
          <MicIcon active={listening} />
          {listening && <span className="mic-ripple" aria-hidden="true" />}
        </button>

        <textarea
          ref={textareaRef}
          className="command-input"
          rows={1}
          value={value}
          placeholder={
            transcribing
              ? 'Transcribing…'
              : listening
                ? 'Listening…'
                : 'Speak or type a command…'
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          aria-label="Command input"
        />

        <div className="command-actions">
          {(busy || speaking) && (
            <button
              className="btn ghost"
              onClick={() => {
                if (speaking) voice.stopSpeaking()
                if (busy) void window.jarvis.cancel()
              }}
              title="Stop (Esc)"
            >
              <span className="stop-square" aria-hidden="true" /> Stop
            </button>
          )}
          <button className="btn primary" onClick={submit} disabled={!value.trim()} title="Send (Enter)">
            Execute
          </button>
        </div>
      </div>

      <div className="command-hint label">
        {busy ? 'Working on it' : listening ? 'Listening — pause when you are done' : 'Enter to send · Shift+Enter for a new line · ↑ for history'}
      </div>
    </div>
  )
}

function MicIcon({ active }: { active: boolean }): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round">
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
    </svg>
  )
}
