import type { ToolCallRequest } from '@shared/types'
import { id } from '../util/id'

/**
 * Offline intent matching.
 *
 * When no model is reachable, JARVIS still understands the common commands.
 * This is a fallback, not the main path: it is deliberately literal, and it
 * returns `null` the moment a request stops being obvious.
 */

export interface LocalIntent {
  call: ToolCallRequest
  /** What JARVIS says when it runs this without a model. */
  reply: string
}

interface Rule {
  pattern: RegExp
  build: (match: RegExpMatchArray) => LocalIntent | null
}

const call = (name: string, args: Record<string, unknown>, reply: string): LocalIntent => ({
  call: { id: id('local'), name, args },
  reply
})

/**
 * Rules are tried in order, so the specific ones come first: "close
 * everything except X" must be reached before the plain "close X" rule,
 * and a storage question before the general metrics rule.
 */
const RULES: Rule[] = [
  {
    // A model file by name: "open bracket.step", "show me part.stl".
    pattern: /^(?:open|show(?:\s+me)?|view|load|display)\s+(?:the\s+|my\s+)?(.+?\.(?:stl|obj|ply|3mf|step|stp|iges|igs|brep))\b(?:\s+in\s+the\s+viewer)?[.!]?$/i,
    build: (m) => call('open_3d_model', { path: m[1].trim() }, `Opening ${m[1].trim()}.`)
  },
  {
    pattern: /^(?:what(?:'s| is)\s+)?(?:open\s+)?in\s+the\s+workshop\??$|^list\s+(?:open\s+)?(?:3d\s+)?models?[.!?]?$/i,
    build: () => call('list_3d_models', {}, 'Checking the workshop.')
  },
  {
    pattern:
      /\b(?:what(?:'s| is)\s+)?(?:taking up|using up|eating|hogging)\s+(?:all\s+)?(?:my|the)?\s*(?:disk|storage|space|disk space)\b/i,
    build: () => call('find_large_files', { folder: '~', minimum_mb: 100 }, 'Measuring what is using your storage.')
  },
  {
    pattern: /^(?:find|show me|list)\s+(?:my\s+)?(?:the\s+)?(?:biggest|largest)\s+files?(?:\s+in\s+(.+?))?[.!]?$/i,
    build: (m) => call('find_large_files', { folder: m[1]?.trim() || '~', minimum_mb: 50 }, 'Finding the largest files.')
  },
  {
    pattern: /^(?:how big is|what(?:'s| is) the size of)\s+(?:my\s+|the\s+)?(.+?)(?:\s+folder)?[.!?]?$/i,
    build: (m) => call('get_folder_size', { path: m[1].trim() }, `Measuring ${m[1].trim()}.`)
  },
  {
    pattern: /^(?:empty|clear|take out)\s+(?:the\s+|my\s+)?(?:trash|bin|recycle bin|rubbish)[.!]?$/i,
    build: () => call('empty_trash', {}, 'Emptying the trash.')
  },
  {
    pattern: /^close\s+(?:everything|all|all apps?|everything else)\s*(?:except|but|apart from)\s+(.+?)[.!]?$/i,
    build: (m) => {
      const keep = m[1]
        .split(/\s*(?:,|and|&)\s*/i)
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 20)
      if (!keep.length) return null
      return call('close_other_applications', { keep }, `Closing everything except ${keep.join(' and ')}.`)
    }
  },
  {
    pattern: /^(?:what(?:'s| is)\s+)?(?:on|in)\s+(?:my\s+)?clipboard[.!?]?$/i,
    build: () => call('read_clipboard', {}, 'Reading the clipboard.')
  },
  {
    pattern: /^copy\s+(?:this\s+)?(?:text\s+)?["“](.+)["”]\s*(?:to\s+(?:the\s+)?clipboard)?[.!]?$/i,
    build: (m) => call('write_clipboard', { text: m[1] }, 'Copied to the clipboard.')
  },
  {
    pattern: /^(?:please\s+)?(?:open|launch|start|run|fire up)\s+(?:my\s+|the\s+)?(.+?)(?:\s+(?:please|now))?[.!]?$/i,
    build: (m) => {
      const target = m[1].trim()
      if (/^https?:\/\//i.test(target) || /^[\w-]+\.(com|net|org|io|dev|ai|co|uk)\b/i.test(target)) {
        return call('open_url', { url: target }, `Opening ${target}.`)
      }
      if (/^(settings|system settings|preferences|control panel)$/i.test(target)) {
        return call('open_settings', {}, 'Opening system settings.')
      }
      return call('open_application', { name: target }, `Opening ${target}.`)
    }
  },
  {
    pattern: /^(?:please\s+)?(?:close|quit|kill|exit)\s+(?:my\s+|the\s+)?(.+?)[.!]?$/i,
    build: (m) => call('close_application', { name: m[1].trim() }, `Closing ${m[1].trim()}.`)
  },
  {
    pattern: /^(?:what(?:'s| is)\s+)?(?:my\s+)?(?:system|computer|pc|mac)?\s*(?:status|stats|health|doing|performance)\b.*$/i,
    build: () => call('get_system_stats', {}, 'Reading system metrics.')
  },
  {
    pattern: /\b(cpu|processor|memory|ram|disk|storage|battery|temperature)\b.*\b(usage|level|status|at|percent)?\b/i,
    build: () => call('get_system_stats', {}, 'Reading system metrics.')
  },
  {
    pattern: /\b(what(?:'s| is) (?:running|using the most|slowing)|running processes|top processes|background)\b/i,
    build: () => call('get_running_processes', { sort_by: 'cpu' }, 'Reading the process list.')
  },
  {
    pattern: /^(?:take|grab|capture)\s+(?:a\s+)?screen\s?shot[.!]?$/i,
    build: () => call('take_screenshot', {}, 'Capturing the screen.')
  },
  {
    pattern: /^(?:set\s+(?:the\s+)?)?volume\s+(?:to\s+)?(\d{1,3})\s*(?:percent|%)?[.!]?$/i,
    build: (m) => {
      const level = Math.max(0, Math.min(100, Number(m[1])))
      return call('set_volume', { level }, `Volume set to ${level} percent.`)
    }
  },
  {
    pattern: /^(?:mute|silence)(?:\s+(?:the\s+)?(?:volume|sound|audio))?[.!]?$/i,
    build: () => call('set_volume', { level: 0 }, 'Muted.')
  },
  {
    pattern: /^lock\s+(?:my\s+|the\s+)?(?:computer|screen|workstation|pc|mac)[.!]?$/i,
    build: () => call('lock_computer', {}, 'Locking the workstation.')
  },
  {
    pattern: /^(?:search|google|look up|find online)\s+(?:the web\s+)?(?:for\s+)?(.+?)[.!]?$/i,
    build: (m) => call('web_search', { query: m[1].trim() }, `Searching for ${m[1].trim()}.`)
  },
  {
    pattern: /^(?:find|search for|show me|list)\s+(?:all\s+)?(?:my\s+)?([a-z0-9]{1,6})\s+files?\s+(?:in|inside|under)\s+(?:my\s+|the\s+)?(.+?)[.!]?$/i,
    build: (m) => call('search_files', { extensions: [m[1].toLowerCase()], folder: m[2].trim(), limit: 25 }, `Searching ${m[2].trim()}.`)
  },
  {
    pattern: /^(?:create|make|new)\s+(?:a\s+)?folder\s+(?:called|named)\s+(.+?)(?:\s+(?:in|inside)\s+(.+?))?[.!]?$/i,
    build: (m) => {
      const name = m[1].trim().replace(/["']/g, '')
      const parent = m[2]?.trim()
      const path = parent ? `${parent.replace(/\/$/, '')}/${name}` : `~/${name}`
      return call('create_folder', { path }, `Creating ${name}.`)
    }
  },
  {
    pattern: /^(?:open|show)\s+(?:my\s+|the\s+)?(downloads|documents|desktop|pictures|music|videos)(?:\s+folder)?[.!]?$/i,
    build: (m) => call('open_path', { path: m[1].toLowerCase() }, `Opening ${m[1]}.`)
  },
  {
    pattern: /^(?:what|which)\s+(?:apps|applications|programs)\s+(?:are\s+)?installed[.!?]?$/i,
    build: () => call('list_applications', {}, 'Reading the installed application list.')
  }
]

export function matchLocalIntent(text: string): LocalIntent | null {
  const value = text.trim().replace(/^(?:hey |ok |okay )?jarvis[,:]?\s*/i, '')
  if (!value) return null
  for (const rule of RULES) {
    const match = value.match(rule.pattern)
    if (match) {
      const intent = rule.build(match)
      if (intent) return intent
    }
  }
  return null
}

/** Recognises "stop"/"cancel" style interrupts without involving a model. */
export function isInterrupt(text: string): boolean {
  return /^(?:jarvis[,\s]+)?(stop|stop it|cancel|abort|never ?mind|quiet|be quiet|shut up|enough)[.!]?$/i.test(text.trim())
}

/** Recognises a bare wake-word activation with no command attached. */
export function isBareWake(text: string): boolean {
  return /^(?:hey |ok |okay )?jarvis[.!?]?$/i.test(text.trim())
}
