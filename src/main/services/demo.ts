import type { ConsoleSource } from '@shared/types'

export interface DemoReply {
  text: string
  console: Array<{ source: ConsoleSource; text: string }>
  actions: string[]
}

/**
 * Demo mode.
 *
 * Shows the full interface — routing, console, plan, core animation — with no
 * API key and no side effects. It never claims an action happened: every
 * response is phrased as a simulation, and the UI is labelled DEMO MODE.
 */
export function demoReply(text: string): DemoReply {
  const value = text.toLowerCase()

  if (/\b(cpu|memory|ram|system|status|performance|how is)\b/.test(value)) {
    return {
      text: 'In demo mode I am not reading live metrics. On a configured system I would report CPU, memory, disk and network here.',
      console: [
        { source: 'JARVIS', text: 'Simulating system query…' },
        { source: 'SYSTEM', text: 'Demo mode — metrics not read.' }
      ],
      actions: []
    }
  }

  if (/\b(open|launch|start)\b/.test(value)) {
    const matched = /\b(?:open|launch|start)\s+((?:my |the |your )?[a-z0-9 .+-]{2,40})/.exec(value)?.[1]?.trim()
    // "open my browser" reads back as "your browser", the way JARVIS would say it.
    const target = matched ? matched.replace(/^my /, 'your ') : 'that application'
    return {
      text: `Demo mode is active, so I have not opened ${target}. Add an API key in Settings to let me act for real.`,
      console: [
        { source: 'JARVIS', text: 'Planning actions…' },
        { source: 'SYSTEM', text: `Simulated: open ${target}` }
      ],
      actions: []
    }
  }

  if (/\b(clean|tidy|organi|delete|remove)\b/.test(value)) {
    return {
      text: 'In demo mode I will describe but never perform file operations. A real run would show you the plan and ask for confirmation first.',
      console: [
        { source: 'JARVIS', text: 'Building plan…' },
        { source: 'SECURITY', text: 'Demo mode — destructive actions disabled.' }
      ],
      actions: []
    }
  }

  if (/\b(hello|hi|hey|good (morning|evening|afternoon))\b/.test(value)) {
    return {
      text: 'Online, in demo mode. Add a free Groq or Gemini key in Settings and I can start working for real.',
      console: [{ source: 'JARVIS', text: 'Voice input detected.' }],
      actions: []
    }
  }

  return {
    text: 'Demo mode is active: the interface is live but no model is answering and nothing is executed. Add an API key in Settings → AI.',
    console: [
      { source: 'JARVIS', text: 'Analysing request…' },
      { source: 'SYSTEM', text: 'Demo mode — no provider engaged.' }
    ],
    actions: []
  }
}
