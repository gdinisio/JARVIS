import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { playCue } from '../lib/sound'
import { greeting } from '../lib/format'
import type { JSX } from 'react'

/**
 * Startup sequence.
 *
 * A point of light, rings forming, subsystems reporting in, then the
 * interface. Short by design — roughly three seconds — skippable with any
 * key, and switched off entirely from Settings → Appearance.
 */

interface Subsystem {
  label: string
  value: string
  at: number
  /** False when the subsystem is not actually available. */
  ok: boolean
}

const TOTAL_MS = 3050

export function Boot(): JSX.Element | null {
  const booted = useStore((s) => s.booted)
  const setBooted = useStore((s) => s.setBooted)
  const settings = useStore((s) => s.settings)
  const provider = useStore((s) => s.provider)
  const ready = useStore((s) => s.ready)

  const [elapsed, setElapsed] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const startRef = useRef(0)
  const cuePlayed = useRef(false)

  const enabled = settings?.appearance.bootAnimation !== false && !settings?.appearance.reducedMotion

  useEffect(() => {
    if (!ready) return
    if (!enabled) {
      setBooted(true)
      return
    }
    startRef.current = performance.now()
    let raf = 0
    const tick = () => {
      const value = performance.now() - startRef.current
      setElapsed(value)
      if (value >= TOTAL_MS) {
        finish()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const finish = () => {
      cancelAnimationFrame(raf)
      setLeaving(true)
      setTimeout(() => setBooted(true), 520)
    }

    const skip = () => finish()
    window.addEventListener('keydown', skip, { once: true })
    window.addEventListener('pointerdown', skip, { once: true })

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', skip)
      window.removeEventListener('pointerdown', skip)
    }
  }, [ready, enabled, setBooted])

  useEffect(() => {
    if (!enabled || cuePlayed.current || !settings) return
    if (elapsed > 60 && settings.sound.enabled) {
      cuePlayed.current = true
      playCue('boot', settings.sound.volume)
    }
  }, [elapsed, enabled, settings])

  /*
   * The diagnostics report what is actually true of this installation. A boot
   * sequence that always says READY would be set dressing.
   */
  const subsystems = useMemo<Subsystem[]>(() => {
    const engineReady = !!(provider?.claude.configured || provider?.groq.configured)
    const voiceReady = settings?.voice.enabled !== false && settings?.voice.engine !== 'off'
    const network = provider?.online !== false
    return [
      { label: 'SYSTEM', value: 'ONLINE', at: 900, ok: true },
      {
        label: 'AI ENGINE',
        value: provider?.demo ? 'DEMO' : engineReady ? 'READY' : 'NO KEY',
        at: 1250,
        ok: engineReady || !!provider?.demo
      },
      { label: 'VOICE', value: voiceReady ? 'READY' : 'MUTED', at: 1560, ok: voiceReady },
      { label: 'AUTOMATION', value: 'READY', at: 1850, ok: true },
      { label: 'NETWORK', value: network ? 'CONNECTED' : 'OFFLINE', at: 2120, ok: network }
    ]
  }, [provider, settings])

  const visible = useMemo(() => subsystems.filter((item) => elapsed >= item.at), [subsystems, elapsed])

  if (booted || !enabled) return null

  const progress = Math.min(1, elapsed / TOTAL_MS)
  const ignition = Math.min(1, elapsed / 620)
  const ringScale = 0.15 + ignition * 0.85

  return (
    <div className={`boot ${leaving ? 'leaving' : ''}`} aria-hidden="true">
      <div className="boot-core">
        <div className="boot-point" style={{ opacity: Math.min(1, elapsed / 220), transform: `scale(${0.4 + ignition * 0.6})` }} />
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="boot-ring"
            style={{
              transform: `scale(${ringScale * (1 + index * 0.28)})`,
              opacity: elapsed > 260 + index * 150 ? 0.14 + (1 - index * 0.28) * 0.5 : 0,
              animationDuration: `${9 + index * 5}s`,
              animationDirection: index % 2 ? 'reverse' : 'normal'
            }}
          />
        ))}
        <div className="boot-sweep" style={{ opacity: elapsed > 700 ? 0.5 : 0 }} />
      </div>

      <div className="boot-readout">
        {visible.map((subsystem) => (
          <div className={`boot-row ${subsystem.ok ? '' : 'degraded'}`} key={subsystem.label}>
            <span className="boot-row-label">{subsystem.label}</span>
            <span className="boot-row-rule" />
            <span className="boot-row-value">{subsystem.value}</span>
          </div>
        ))}
      </div>

      {elapsed > 2400 && (
        <div className="boot-title">
          <span className="boot-wordmark">JARVIS</span>
          <span className="boot-sub">
            {provider?.demo ? 'DEMO MODE — ONLINE' : 'ONLINE'}
          </span>
          <span className="boot-greeting">{greeting()}.</span>
        </div>
      )}

      <div className="boot-progress">
        <div className="boot-progress-fill" style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="boot-skip label">Press any key to skip</div>
    </div>
  )
}
