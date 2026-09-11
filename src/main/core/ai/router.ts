import type { ProviderId, ProviderSelection } from '@shared/types'

/**
 * AUTO routing.
 *
 * Claude handles reasoning, planning, ambiguity and anything visual. Groq
 * handles the short, obvious exchanges where latency is what the user
 * actually notices. Pure and deterministic so the behaviour is testable.
 */

export interface RoutingInput {
  text: string
  mode: ProviderSelection
  claudeAvailable: boolean
  groqAvailable: boolean
  /** True once the conversation already involves tool results. */
  hasToolResults?: boolean
  /** Index of this turn within the current request loop. */
  turnIndex?: number
  /** The request needs to look at an image. */
  needsVision?: boolean
}

export interface RoutingDecision {
  provider: ProviderId | null
  reason: string
  complexity: number
  /** Provider to try if the first one fails. */
  fallback: ProviderId | null
}

const MULTI_STEP = /\b(then|after that|and also|as well as|followed by|prepare|set ?up|get (?:my|the) .* ready|clean ?up|tidy|organi[sz]e|workflow|routine|batch|for each|everything except|all of my|all my)\b/i
const CONSEQUENTIAL = /\b(delete|remove|uninstall|move|rename|archive|configure|install|restart|shut ?down|kill|free up|reclaim)\b/i
const AMBIGUOUS = /\b(yesterday|last week|recently|the one i|whichever|figure out|work out|what'?s (?:wrong|slowing|using)|why is|should i|best|compare|analy[sz]e|summari[sz]e|explain)\b/i
const SIMPLE = /^(?:hey |hi |hello |ok |okay )?(jarvis)?[,! ]*(hello|hi|hey|thanks|thank you|stop|cancel|status|online|are you there|good (?:morning|evening|afternoon))\b/i
const SIMPLE_COMMAND = /^(open|launch|start|close|quit|play|pause|mute|unmute|lock|volume|set volume|what(?:'s| is) the time|what time)\b/i
const STATUS_QUESTION = /\b(cpu|ram|memory|battery|disk|temperature|uptime|how (?:is|are) (?:my|the) (?:system|computer|pc|mac))\b/i

export function scoreComplexity(text: string, input: Partial<RoutingInput> = {}): number {
  const value = text.trim()
  if (!value) return 0

  let score = 0
  const words = value.split(/\s+/).length

  if (words > 24) score += 3
  else if (words > 14) score += 2
  else if (words > 8) score += 1

  if (MULTI_STEP.test(value)) score += 3
  if (CONSEQUENTIAL.test(value)) score += 2
  if (AMBIGUOUS.test(value)) score += 2
  if ((value.match(/\band\b/gi) ?? []).length >= 2) score += 1
  if (/\?\s*$/.test(value) && words > 12) score += 1

  if (SIMPLE.test(value)) score -= 4
  if (SIMPLE_COMMAND.test(value) && words <= 8 && !MULTI_STEP.test(value)) score -= 2
  if (STATUS_QUESTION.test(value) && words <= 10) score -= 1

  // Depth is added after clamping: several tool rounds into a request, the
  // remaining reasoning is harder than the opening sentence suggested.
  const depth = input.hasToolResults && (input.turnIndex ?? 0) >= 2 ? 2 : 0
  return Math.max(0, score) + depth
}

const CLAUDE_THRESHOLD = 3

export function routeRequest(input: RoutingInput): RoutingDecision {
  const complexity = scoreComplexity(input.text, input)
  const { claudeAvailable, groqAvailable } = input

  const available = (id: ProviderId) => (id === 'claude' ? claudeAvailable : groqAvailable)
  const other = (id: ProviderId): ProviderId => (id === 'claude' ? 'groq' : 'claude')

  const resolve = (preferred: ProviderId, reason: string): RoutingDecision => {
    if (available(preferred)) {
      return { provider: preferred, reason, complexity, fallback: available(other(preferred)) ? other(preferred) : null }
    }
    if (available(other(preferred))) {
      return {
        provider: other(preferred),
        reason: `${preferred === 'claude' ? 'Claude' : 'Groq'} is not configured; using ${other(preferred) === 'claude' ? 'Claude' : 'Groq'}.`,
        complexity,
        fallback: null
      }
    }
    return { provider: null, reason: 'No AI provider is configured.', complexity, fallback: null }
  }

  if (input.mode === 'claude') return resolve('claude', 'Claude selected manually.')
  if (input.mode === 'groq') return resolve('groq', 'Groq selected manually.')

  if (input.needsVision) return resolve('claude', 'The request involves looking at the screen.')
  if (complexity >= CLAUDE_THRESHOLD) {
    return resolve('claude', `Reasoning required (complexity ${complexity}).`)
  }
  return resolve('groq', `Fast path (complexity ${complexity}).`)
}
