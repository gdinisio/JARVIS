import type { JSX } from 'react'
import { useStore } from '../store/useStore'

/**
 * Contextual suggestions.
 *
 * Real commands, submitted through the same path as anything typed — never
 * decorative buttons. What is offered depends on the machine's current state,
 * so a nearly-full disk surfaces the question worth asking.
 */
export function Suggestions(): JSX.Element | null {
  const stats = useStore((s) => s.stats)
  const routines = useStore((s) => s.routines)
  const busy = useStore((s) => s.busy)
  const density = useStore((s) => s.settings?.appearance.hudDensity ?? 'standard')

  if (density === 'minimal') return null

  const items: string[] = []
  const disk = stats?.disks[0]

  if (disk && disk.percent >= 85) items.push("What's taking up my storage?")
  if (stats && stats.memory.percent >= 85) items.push("What's slowing my computer down?")
  if (stats?.battery.hasBattery && stats.battery.percent != null && stats.battery.percent < 25 && !stats.battery.charging) {
    items.push('How much battery do I have left?')
  }

  const enabled = routines.filter((routine) => routine.enabled)
  if (enabled[0]) items.push(`Run ${enabled[0].name}`)

  for (const fallback of [
    'How is my system doing?',
    'Find all PDFs in Downloads.',
    'What is using the most CPU?',
    'Open my browser.'
  ]) {
    if (items.length >= 4) break
    if (!items.includes(fallback)) items.push(fallback)
  }

  return (
    <div className="suggestions panel">
      <span className="corner bl" /><span className="corner tr" />
      <div className="label suggestions-title">Try</div>
      <div className="suggestions-list">
        {items.slice(0, 4).map((item) => (
          <button
            key={item}
            className="suggestion"
            disabled={busy}
            onClick={() => void window.jarvis.submit(item, 'text')}
            title="Run this command"
          >
            <span className="suggestion-arrow" aria-hidden="true">→</span>
            <span>{item}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
