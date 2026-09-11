import { useEffect, useRef } from 'react'
import type { JarvisStatus } from '@shared/types'
import { useStore } from '../store/useStore'
import { audioBus, WAVEFORM_SIZE } from '../lib/audioBus'
import { hexToRgb, rgba, lighten, type Rgb } from '../lib/colour'
import type { JSX } from 'react'

/**
 * The JARVIS core.
 *
 * One canvas, one animation loop, no DOM churn. State (idle, listening,
 * thinking, executing, speaking, complete, error) changes the energy of the
 * system rather than swapping between separate visuals, so transitions are
 * continuous — the core always looks alive, never like a spinner.
 *
 * Everything expensive is bounded: the loop stops when the window is hidden,
 * the device pixel ratio is capped, and particle counts scale with the
 * animation-intensity setting.
 */

interface StateProfile {
  /** Rotation multiplier for the outer assembly. */
  spin: number
  /** Overall luminance. */
  glow: number
  /** Radial expansion of the rings. */
  expand: number
  /** Core pulse rate, Hz. */
  pulse: number
  /** Particle energy. */
  energy: number
}

const PROFILES: Record<JarvisStatus, StateProfile> = {
  idle: { spin: 1, glow: 0.82, expand: 0, pulse: 0.32, energy: 0.5 },
  listening: { spin: 1.25, glow: 1.12, expand: 0.035, pulse: 0.85, energy: 0.9 },
  thinking: { spin: 2.9, glow: 1.05, expand: 0.012, pulse: 1.5, energy: 1.5 },
  executing: { spin: 2.1, glow: 1.18, expand: 0.022, pulse: 1.1, energy: 2.1 },
  speaking: { spin: 1.35, glow: 1.14, expand: 0.028, pulse: 0.9, energy: 1.05 },
  complete: { spin: 0.85, glow: 1.28, expand: 0.05, pulse: 0.5, energy: 0.7 },
  error: { spin: 0.6, glow: 0.95, expand: -0.02, pulse: 2.4, energy: 0.6 }
}

interface Particle {
  angle: number
  radius: number
  speed: number
  size: number
  drift: number
  seed: number
}

interface Frame {
  status: JarvisStatus
  accent: Rgb
  intensity: number
  reducedMotion: boolean
  cpu: number
  memory: number
  statusChangedAt: number
}

export function Core({ size = 420 }: { size?: number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<Frame>({
    status: 'idle',
    accent: hexToRgb('#e01f3d'),
    intensity: 1,
    reducedMotion: false,
    cpu: 0,
    memory: 0,
    statusChangedAt: performance.now()
  })

  // State arrives through a subscription rather than props so the canvas never
  // forces a React render.
  useEffect(() => {
    const sync = (state: ReturnType<typeof useStore.getState>) => {
      const current = frameRef.current
      if (state.status !== current.status) current.statusChangedAt = performance.now()
      current.status = state.status
      current.accent = hexToRgb(state.settings?.appearance.accent ?? '#e01f3d')
      current.intensity = state.settings?.appearance.animationIntensity ?? 1
      current.reducedMotion = state.settings?.appearance.reducedMotion ?? false
      current.cpu = state.stats?.cpu.usage ?? 0
      current.memory = state.stats?.memory.percent ?? 0
    }
    sync(useStore.getState())
    return useStore.subscribe(sync)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return

    let raf = 0
    let running = true
    let time = 0
    let spinPhase = 0
    let counterPhase = 0
    let last = performance.now()
    let smoothLevel = 0
    let smoothCpu = 0

    const particles: Particle[] = Array.from({ length: 48 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: 0.32 + Math.random() * 0.58,
      speed: (0.06 + Math.random() * 0.22) * (Math.random() > 0.7 ? -1 : 1),
      size: 0.6 + Math.random() * 1.5,
      drift: (Math.random() - 0.5) * 0.05,
      seed: Math.random() * 100
    }))

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      const width = Math.max(160, rect.width)
      const height = Math.max(160, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const draw = (now: number) => {
      if (!running) return
      const delta = Math.min(0.05, (now - last) / 1000)
      last = now

      const frame = frameRef.current
      const profile = PROFILES[frame.status] ?? PROFILES.idle
      const motion = frame.reducedMotion ? 0.12 : Math.max(0.15, frame.intensity)
      const accent = frame.accent
      const hot = lighten(accent, 0.55)

      time += delta
      spinPhase += delta * profile.spin * 0.22 * motion
      counterPhase -= delta * profile.spin * 0.13 * motion

      audioBus.settle()
      smoothLevel += (audioBus.level - smoothLevel) * Math.min(1, delta * 12)
      smoothCpu += (frame.cpu / 100 - smoothCpu) * Math.min(1, delta * 2)

      const rect = canvas.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      const cx = w / 2
      const cy = h / 2
      const base = (Math.min(w, h) / 2) * 0.94
      const expansion = 1 + profile.expand * motion + smoothLevel * 0.05 * motion
      const R = base * expansion
      const glow = profile.glow * (0.75 + 0.25 * motion)
      const sinceChange = (now - frame.statusChangedAt) / 1000

      context.clearRect(0, 0, w, h)

      /* A dark seat first, so the assembly reads as lit rather than washed. */
      const seat = context.createRadialGradient(cx, cy, R * 0.1, cx, cy, R)
      seat.addColorStop(0, 'rgba(4,4,7,0.92)')
      seat.addColorStop(0.7, 'rgba(4,4,7,0.55)')
      seat.addColorStop(1, 'rgba(0,0,0,0)')
      context.fillStyle = seat
      context.beginPath()
      context.arc(cx, cy, R, 0, Math.PI * 2)
      context.fill()

      /* Ambient bloom, kept tight. */
      const bloom = context.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.1)
      bloom.addColorStop(0, rgba(accent, 0.1 * glow))
      bloom.addColorStop(0.5, rgba(accent, 0.035 * glow))
      bloom.addColorStop(1, 'rgba(0,0,0,0)')
      context.fillStyle = bloom
      context.beginPath()
      context.arc(cx, cy, R * 1.1, 0, Math.PI * 2)
      context.fill()

      /* Outer segmented ring. */
      const segments = 5
      context.lineWidth = 1.8
      context.lineCap = 'round'
      for (let i = 0; i < segments; i++) {
        const span = (Math.PI * 2) / segments
        const start = spinPhase + i * span
        const gap = 0.22 + Math.sin(time * 0.4 + i) * 0.03
        context.strokeStyle = rgba(accent, (0.62 + (i % 2) * 0.3) * glow)
        context.beginPath()
        context.arc(cx, cy, R * 0.97, start, start + span - gap)
        context.stroke()
      }
      context.lineCap = 'butt'

      /* A thin containment circle ties the segments together. */
      context.lineWidth = 0.7
      context.strokeStyle = rgba(accent, 0.16 * glow)
      context.beginPath()
      context.arc(cx, cy, R * 0.92, 0, Math.PI * 2)
      context.stroke()

      /* Fine tick ring, counter-rotating. */
      const ticks = 96
      for (let i = 0; i < ticks; i++) {
        const angle = counterPhase + (i / ticks) * Math.PI * 2
        const major = i % 8 === 0
        const inner = R * (major ? 0.845 : 0.868)
        const outer = R * 0.888
        context.strokeStyle = rgba(accent, (major ? 0.75 : 0.3) * glow)
        context.lineWidth = major ? 1.3 : 0.8
        context.beginPath()
        context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
        context.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
        context.stroke()
      }

      /* Four bracket markers, counter-rotating with the tick ring. */
      for (let i = 0; i < 4; i++) {
        const angle = counterPhase * 0.6 + (i / 4) * Math.PI * 2
        const x = cx + Math.cos(angle) * R * 0.905
        const y = cy + Math.sin(angle) * R * 0.905
        context.save()
        context.translate(x, y)
        context.rotate(angle)
        context.strokeStyle = rgba(hot, 0.65 * glow)
        context.lineWidth = 1.2
        context.beginPath()
        context.moveTo(-3, -3.4)
        context.lineTo(3, 0)
        context.lineTo(-3, 3.4)
        context.stroke()
        context.restore()
      }

      /* Live CPU gauge — real data, drawn as an arc. */
      context.lineWidth = 2.6
      context.lineCap = 'round'
      context.strokeStyle = rgba(accent, 0.16 * glow)
      context.beginPath()
      context.arc(cx, cy, R * 0.8, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5)
      context.stroke()
      context.strokeStyle = rgba(hot, 0.95 * glow)
      context.beginPath()
      context.arc(cx, cy, R * 0.8, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0.01, smoothCpu))
      context.stroke()
      context.lineCap = 'butt'

      /* Dashed inner ring. */
      context.setLineDash([2, 7])
      context.lineWidth = 1
      context.strokeStyle = rgba(accent, 0.42 * glow)
      context.beginPath()
      context.arc(cx, cy, R * 0.72, -spinPhase * 1.7, -spinPhase * 1.7 + Math.PI * 2)
      context.stroke()
      context.setLineDash([])

      /* Waveform ring: microphone input while listening, speech envelope while speaking. */
      const waveActive = audioBus.source !== 'none' || smoothLevel > 0.002
      if (waveActive) {
        const inner = R * 0.5
        const amplitude = R * 0.17 * (0.35 + smoothLevel * 3.2)
        context.lineWidth = 1.5
        context.strokeStyle = rgba(audioBus.source === 'mic' ? hot : accent, 0.85 * glow)
        context.beginPath()
        for (let i = 0; i <= WAVEFORM_SIZE; i++) {
          const index = i % WAVEFORM_SIZE
          const angle = (i / WAVEFORM_SIZE) * Math.PI * 2 - Math.PI / 2
          const radius = inner + Math.abs(audioBus.waveform[index]) * amplitude
          const x = cx + Math.cos(angle) * radius
          const y = cy + Math.sin(angle) * radius
          if (i === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        }
        context.closePath()
        context.stroke()
      }

      /* Orbiting particles. */
      const particleCount = Math.round(particles.length * Math.min(1, motion))
      for (let i = 0; i < particleCount; i++) {
        const p = particles[i]
        p.angle += delta * p.speed * profile.energy * motion
        const wobble = Math.sin(time * 0.6 + p.seed) * p.drift
        const radius = R * (p.radius + wobble)
        const x = cx + Math.cos(p.angle) * radius
        const y = cy + Math.sin(p.angle) * radius
        const twinkle = 0.28 + Math.abs(Math.sin(time * 1.6 + p.seed)) * 0.5
        context.fillStyle = rgba(accent, twinkle * glow * 0.8)
        context.beginPath()
        context.arc(x, y, p.size, 0, Math.PI * 2)
        context.fill()
      }

      /* Thinking: a scanning sweep circulating through the assembly. */
      if (frame.status === 'thinking') {
        const sweep = (time * 1.5 * motion) % (Math.PI * 2)
        const gradient = context.createConicGradient?.(sweep, cx, cy)
        if (gradient) {
          gradient.addColorStop(0, rgba(hot, 0.5 * glow))
          gradient.addColorStop(0.08, rgba(accent, 0.05))
          gradient.addColorStop(1, 'rgba(0,0,0,0)')
          context.strokeStyle = gradient
          context.lineWidth = 3
          context.beginPath()
          context.arc(cx, cy, R * 0.62, 0, Math.PI * 2)
          context.stroke()
        }
      }

      /* Executing: energy travelling outward along spokes. */
      if (frame.status === 'executing') {
        const spokes = 8
        for (let i = 0; i < spokes; i++) {
          const angle = (i / spokes) * Math.PI * 2 + spinPhase * 0.6
          const progress = ((time * 0.85 * motion + i / spokes) % 1)
          const radius = R * (0.34 + progress * 0.58)
          const alpha = Math.sin(progress * Math.PI) * 0.9
          context.fillStyle = rgba(hot, alpha * glow)
          context.beginPath()
          context.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 2.1, 0, Math.PI * 2)
          context.fill()
        }
      }

      /* Complete: one calm confirmation ring. */
      if (frame.status === 'complete' && sinceChange < 1.2) {
        const progress = sinceChange / 1.2
        context.strokeStyle = rgba(hot, (1 - progress) * 0.7)
        context.lineWidth = 2 * (1 - progress) + 0.5
        context.beginPath()
        context.arc(cx, cy, R * (0.55 + progress * 0.45), 0, Math.PI * 2)
        context.stroke()
      }

      /* Error: a contained warning pulse, never a flash. */
      if (frame.status === 'error') {
        const pulse = 0.5 + Math.sin(time * 5) * 0.5
        context.strokeStyle = rgba(accent, 0.22 + pulse * 0.3)
        context.lineWidth = 1.4
        context.beginPath()
        context.arc(cx, cy, R * 0.6, 0, Math.PI * 2)
        context.stroke()
      }

      /* The core itself: a hot centre with a defined rim, not a soft blob. */
      const pulsePhase = Math.sin(time * Math.PI * 2 * profile.pulse) * 0.5 + 0.5
      const coreRadius = R * (0.265 + pulsePhase * 0.014 * motion + smoothLevel * 0.05)

      const halo = context.createRadialGradient(cx, cy, coreRadius * 0.7, cx, cy, coreRadius * 1.7)
      halo.addColorStop(0, rgba(accent, 0.22 * glow))
      halo.addColorStop(1, 'rgba(0,0,0,0)')
      context.fillStyle = halo
      context.beginPath()
      context.arc(cx, cy, coreRadius * 1.7, 0, Math.PI * 2)
      context.fill()

      const coreGradient = context.createRadialGradient(cx, cy, 0, cx, cy, coreRadius)
      coreGradient.addColorStop(0, rgba(lighten(accent, 0.92), (0.95 + pulsePhase * 0.05) * Math.min(1, glow)))
      coreGradient.addColorStop(0.17, rgba(hot, 0.9 * glow))
      coreGradient.addColorStop(0.48, rgba(accent, 0.62 * glow))
      coreGradient.addColorStop(0.86, rgba(accent, 0.2 * glow))
      coreGradient.addColorStop(1, 'rgba(0,0,0,0)')
      context.fillStyle = coreGradient
      context.beginPath()
      context.arc(cx, cy, coreRadius, 0, Math.PI * 2)
      context.fill()

      /* Core containment rim. */
      context.strokeStyle = rgba(hot, 0.75 * glow)
      context.lineWidth = 1.2
      context.beginPath()
      context.arc(cx, cy, R * 0.285, 0, Math.PI * 2)
      context.stroke()
      context.strokeStyle = rgba(accent, 0.3 * glow)
      context.lineWidth = 0.7
      context.beginPath()
      context.arc(cx, cy, R * 0.315, 0, Math.PI * 2)
      context.stroke()

      /* Three inner arcs that counter-rotate around the core. */
      for (let i = 0; i < 3; i++) {
        const offset = (i / 3) * Math.PI * 2 - counterPhase * 2.2
        context.strokeStyle = rgba(accent, (0.55 - i * 0.1) * glow)
        context.lineWidth = 1
        context.beginPath()
        context.arc(cx, cy, R * (0.36 + i * 0.045), offset, offset + Math.PI * 0.5)
        context.stroke()
      }

      raf = requestAnimationFrame(draw)
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running) {
        running = true
        last = performance.now()
        raf = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    raf = requestAnimationFrame(draw)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="core-canvas"
      style={{ width: size, height: size }}
      role="img"
      aria-label="JARVIS core status visualisation"
    />
  )
}
