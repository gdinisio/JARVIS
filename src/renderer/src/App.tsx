import { Suspense, lazy, useEffect } from 'react'
import { useStore } from './store/useStore'
import { useVoice } from './lib/useVoice'
import { hexToRgb, rgba } from './lib/colour'
import { matchesAccelerator } from './lib/hotkey'
import { Boot } from './components/Boot'
import { TitleBar } from './components/TitleBar'
import { Hud } from './components/Hud'
import { Suggestions } from './components/Suggestions'
import { Console } from './components/Console'
import { Stage } from './components/Stage'
import { CommandBar } from './components/CommandBar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Notifications } from './components/Notifications'
import { Onboarding } from './components/Onboarding'
import { HistoryView } from './views/HistoryView'

/** three.js is a large dependency and most sessions never open the Workshop. */
const WorkshopView = lazy(() => import('./views/WorkshopView').then((m) => ({ default: m.WorkshopView })))
import { RoutinesView } from './views/RoutinesView'
import { MemoryView } from './views/MemoryView'
import { SettingsView } from './views/SettingsView'
import type { JSX } from 'react'

export function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const booted = useStore((s) => s.booted)
  const view = useStore((s) => s.view)
  const status = useStore((s) => s.status)
  const settings = useStore((s) => s.settings)
  const setView = useStore((s) => s.setView)
  const platform = useStore((s) => s.platform)
  const voice = useVoice()

  /* Snapshot + event subscription. */
  useEffect(() => {
    let disposed = false
    const unsubscribe = window.jarvis.onEvent((event) => useStore.getState().applyEvent(event))

    void window.jarvis.snapshot().then((snapshot) => {
      if (!disposed && snapshot) useStore.getState().applySnapshot(snapshot)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  /* Theme variables follow the appearance settings. */
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    const accent = hexToRgb(settings.appearance.accent)
    const intensity = settings.appearance.redIntensity

    root.style.setProperty('--accent', settings.appearance.accent)
    root.style.setProperty('--accent-soft', rgba(accent, 0.18 * intensity))
    root.style.setProperty('--accent-line', rgba(accent, 0.5 * intensity))
    root.style.setProperty('--accent-glow', rgba(accent, 0.4 * intensity))
    root.dataset.reducedMotion = String(settings.appearance.reducedMotion)
    root.dataset.density = settings.appearance.hudDensity
    root.dataset.compact = String(settings.appearance.compact)
    root.dataset.scanlines = String(settings.appearance.scanlines)
  }, [settings])

  /* The platform drives window-control chrome and shortcut labels. */
  useEffect(() => {
    document.documentElement.dataset.platform = platform
  }, [platform])

  /*
   * Hold-to-talk.
   *
   * The global shortcut can only tell us about the press, so genuine
   * push-to-talk is handled here, where the release is observable.
   */
  useEffect(() => {
    const accelerator = settings?.hotkeys.pushToTalk
    if (!accelerator) return
    let held = false

    const down = (event: KeyboardEvent) => {
      if (held || event.repeat || !matchesAccelerator(event, accelerator)) return
      held = true
      event.preventDefault()
      void voice.startListening()
    }
    const up = (event: KeyboardEvent) => {
      if (!held) return
      // Releasing any modifier in the chord ends the utterance.
      if (matchesAccelerator(event, accelerator) || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
        held = false
        voice.stopListening()
      }
    }
    const blur = () => {
      if (!held) return
      held = false
      voice.stopListening()
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [settings?.hotkeys.pushToTalk, voice])

  /* In-app keyboard shortcuts. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey
      const typing = event.target instanceof HTMLElement && /input|textarea/i.test(event.target.tagName)

      if (modifier && event.key === 'k') {
        event.preventDefault()
        setView('command')
        document.querySelector<HTMLTextAreaElement>('.command-input')?.focus()
        return
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        void voice.startListening()
        return
      }
      if (modifier && !event.shiftKey && ['1', '2', '3', '4', '5', '6'].includes(event.key)) {
        event.preventDefault()
        setView((['command', 'workshop', 'routines', 'memory', 'history', 'settings'] as const)[Number(event.key) - 1])
        return
      }
      if (event.key === 'Escape' && !typing) {
        if (useStore.getState().speaking) voice.stopSpeaking()
        else if (useStore.getState().busy) void window.jarvis.cancel()
        else if (useStore.getState().view !== 'command') setView('command')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView, voice])

  if (!ready) {
    return (
      <div className="app booting">
        <div className="boot-fallback label">Initialising…</div>
      </div>
    )
  }

  return (
    <div className={`app status-${status} ${booted ? 'booted' : 'pre-boot'}`} data-view={view}>
      <div className="backdrop" aria-hidden="true">
        <div className="backdrop-grid" />
        <div className="backdrop-glow" />
        {settings?.appearance.scanlines && <div className="backdrop-scan" />}
      </div>

      <Boot />
      <TitleBar />

      <main className="workspace">
        {view === 'command' ? (
          <div className="command-layout">
            <aside className="rail rail-left">
              <Hud />
              <Suggestions />
            </aside>
            <Stage />
            <aside className="rail rail-right">
              <Console />
            </aside>
          </div>
        ) : view === 'workshop' ? (
          <Suspense fallback={<div className="view-layout"><div className="label">Preparing the workshop…</div></div>}>
            <WorkshopView />
          </Suspense>
        ) : (
          <div className="view-layout">
            {view === 'history' && <HistoryView />}
            {view === 'routines' && <RoutinesView />}
            {view === 'memory' && <MemoryView />}
            {view === 'settings' && <SettingsView />}
          </div>
        )}
      </main>

      <CommandBar voice={voice} />

      <Notifications />
      <ConfirmDialog />
      <Onboarding />
    </div>
  )
}
