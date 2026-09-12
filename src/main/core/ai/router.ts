import type { ProviderId, ProviderRole } from '@shared/providers'

/**
 * AUTO routing.
 *
 * Requests fall into roles: a short obvious command wants the lowest latency
 * available, a multi-step or ambiguous one wants the strongest reasoning, and
 * anything involving the screen needs a model that can see. Providers declare
 * how good a candidate they are for each role in the catalogue; this picks the
 * best one that is actually configured.
 *
 * Pure and deterministic, so the behaviour is testable.
 */

export interface RoutingCandidate {
  id: ProviderId
  /** Configured, healthy and usable right now. */
  available: boolean
  /** Catalogue ranking per role, 0–100. */
  rank: Record<ProviderRole, number>
  /** The selected model on this provider accepts images. */
  vision: boolean
}

export interface RoutingInput {
  text: string
  /** 'auto', or a specific provider the user pinned. */
  mode: ProviderId | 'auto'
  candidates: RoutingCandidate[]
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
  role: ProviderRole
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

const REASONING_THRESHOLD = 3

/** Best available candidate for a role, or null when none is usable. */
function pick(candidates: RoutingCandidate[], role: ProviderRole, exclude?: ProviderId | null): RoutingCandidate | null {
  const usable = candidates
    .filter((candidate) => candidate.available && candidate.id !== exclude)
    .filter((candidate) => (role === 'vision' ? candidate.vision : true))
  if (!usable.length) return null
  return usable.reduce((best, candidate) => (candidate.rank[role] > best.rank[role] ? candidate : best))
}

export function routeRequest(input: RoutingInput): RoutingDecision {
  const complexity = scoreComplexity(input.text, input)
  const { candidates } = input

  const role: ProviderRole = input.needsVision
    ? 'vision'
    : complexity >= REASONING_THRESHOLD
      ? 'reasoning'
      : 'fast'

  // A pinned provider is honoured whenever it can actually serve the request.
  if (input.mode !== 'auto') {
    const pinned = candidates.find((candidate) => candidate.id === input.mode)
    if (pinned?.available && (role !== 'vision' || pinned.vision)) {
      return {
        provider: pinned.id,
        reason: `${input.mode} selected manually.`,
        complexity,
        role,
        fallback: pick(candidates, role, pinned.id)?.id ?? null
      }
    }
    if (pinned?.available && role === 'vision') {
      // Pinned but blind: fall through to a provider that can see, and say so.
      const seeing = pick(candidates, 'vision')
      if (seeing) {
        return {
          provider: seeing.id,
          reason: `${input.mode} cannot read images; using ${seeing.id}.`,
          complexity,
          role,
          fallback: null
        }
      }
    }
  }

  const chosen = pick(candidates, role)
  if (!chosen) {
    // Nothing can see: fall back to a text provider so the user gets an
    // explanation rather than silence.
    if (role === 'vision') {
      const any = pick(candidates, 'reasoning')
      if (any) {
        return {
          provider: any.id,
          reason: 'No configured provider can read images.',
          complexity,
          role,
          fallback: null
        }
      }
    }
    return { provider: null, reason: 'No AI provider is configured.', complexity, role, fallback: null }
  }

  return {
    provider: chosen.id,
    reason:
      role === 'vision'
        ? 'The request involves looking at the screen.'
        : role === 'reasoning'
          ? `Reasoning required (complexity ${complexity}).`
          : `Fast path (complexity ${complexity}).`,
    complexity,
    role,
    fallback: pick(candidates, role, chosen.id)?.id ?? null
  }
}
