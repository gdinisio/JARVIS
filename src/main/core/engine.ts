import type {
  ChatMessage, ConfirmRequest, HistoryEntry, HistoryOutcome, PlanStep, ProviderId,
  SubmitRequest, TaskPlan, ToolDescriptor, ToolName, ToolResult
} from '@shared/types'
import type { AiMessage, AiResponse } from './ai/types'
import { ProviderError } from './ai/types'
import { providers } from './ai'
import { buildSystemPrompt } from './ai/prompt'
import { decide, describeAction } from './permissions'
import { TOOL_DESCRIPTORS } from '../tools/descriptors'
import { executeTool } from '../tools/registry'
import type { ToolContext } from '../tools/context'
import { platform } from '../platform'
import { settings } from '../services/settings'
import { bus } from '../services/bus'
import { logger } from '../services/logging'
import { history } from '../services/history'
import { monitoring } from '../services/monitoring'
import { routines } from './routines'
import { isInterrupt, isBareWake, matchLocalIntent } from './intent'
import { demoReply } from '../services/demo'
import { id, now } from '../util/id'

/**
 * A planning tool that touches nothing.
 *
 * The model declares what it is about to do; JARVIS renders it and, when the
 * plan contains anything consequential, waits for the user to approve before
 * the first real tool runs.
 */
const PLAN_TOOL: ToolDescriptor = {
  name: 'present_plan' as ToolName,
  description:
    'Show the user the steps you are about to take, before taking them. Use this whenever a request needs more than two actions, or any action that changes files, settings or power state. Call it once, then carry out the steps.',
  risk: 'low',
  category: 'system',
  offline: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title, e.g. "Preparing work environment".' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered, human-readable steps. One short line each.'
      },
      requires_approval: {
        type: 'boolean',
        description: 'True when the user should confirm before you begin.'
      }
    },
    required: ['title', 'steps'],
    additionalProperties: false
  }
}

const VISION_HINT = /\b(screen|display|what am i looking at|read (?:this|that)|on screen|this error|what'?s (?:this|that)|which button)\b/i
const MAX_CONTEXT_TURNS = 8

export class Engine {
  private conversation: AiMessage[] = []
  private transcript: ChatMessage[] = []
  private pendingConfirms = new Map<string, (approved: boolean) => void>()
  private controller: AbortController | null = null
  private busy = false
  private plan: TaskPlan | null = null
  private planCursor = 0

  isBusy(): boolean {
    return this.busy
  }

  messages(): ChatMessage[] {
    return this.transcript.slice(-60)
  }

  currentPlan(): TaskPlan | null {
    return this.plan
  }

  /** Resolves a pending confirmation dialog. */
  resolveConfirm(confirmId: string, approved: boolean): boolean {
    const resolver = this.pendingConfirms.get(confirmId)
    if (!resolver) return false
    this.pendingConfirms.delete(confirmId)
    bus.emit({ type: 'confirm-closed', id: confirmId })
    resolver(approved)
    return true
  }

  /** Stops the current request and any speech. */
  cancel(reason = 'Cancelled.'): void {
    this.controller?.abort()
    for (const [confirmId, resolver] of this.pendingConfirms) {
      bus.emit({ type: 'confirm-closed', id: confirmId })
      resolver(false)
    }
    this.pendingConfirms.clear()
    bus.emit({ type: 'stop-speaking' })
    if (this.busy) {
      bus.say('SYSTEM', reason, { level: 'warn' })
      this.finish('idle')
    }
  }

  async submit(request: SubmitRequest): Promise<void> {
    const text = request.text.trim()
    if (!text) return

    if (isInterrupt(text)) {
      this.cancel('Stopped.')
      bus.emit({ type: 'stop-speaking' })
      return
    }

    // A new command while busy replaces the old one — the user has moved on.
    if (this.busy) {
      logger.info('engine', 'New request interrupted the previous one.')
      this.cancel('Superseded.')
    }

    const started = now()
    this.busy = true
    this.controller = new AbortController()
    bus.emit({ type: 'busy', busy: true })

    this.pushTranscript({ id: id('msg'), role: 'user', text, ts: started })
    bus.say('USER', text)

    const config = settings.get()
    const actions: string[] = []
    let outcome: HistoryOutcome = 'success'
    let detail: string | undefined
    let provider: HistoryEntry['provider'] = 'local'

    try {
      if (isBareWake(text)) {
        this.reply('Online.', undefined, false)
        this.finish('complete')
        this.record(request, text, [], 'success', started, 'local')
        return
      }

      // A saved routine that matches the whole utterance runs directly: no
      // model round-trip, works offline, and is exactly what the user saved.
      const routine = routines.matchUtterance(text)
      if (routine) {
        bus.emit({ type: 'status', status: 'executing' })
        const result = await this.runRoutine(routine.name)
        actions.push(`run_routine:${routine.name}`)
        outcome = result.ok ? 'success' : 'failed'
        detail = result.summary
        this.reply(result.summary ?? 'Routine complete.')
        this.finish(result.ok ? 'complete' : 'error')
        this.record(request, text, actions, outcome, started, 'local', detail)
        return
      }

      if (config.general.demoMode || !providers.anyConfigured()) {
        const handled = await this.handleWithoutModel(text, request, started, config.general.demoMode)
        if (handled) return
      }

      bus.emit({ type: 'status', status: 'thinking' })
      const result = await this.runModelLoop(text)
      actions.push(...result.actions)
      provider = result.provider ?? 'local'
      outcome = result.outcome
      detail = result.detail
      this.finish(result.outcome === 'success' ? 'complete' : result.outcome === 'blocked' ? 'error' : 'error')
    } catch (error) {
      outcome = 'failed'
      detail = error instanceof Error ? error.message : String(error)
      const spoken = error instanceof ProviderError ? error.spoken() : 'Something went wrong while handling that.'
      logger.error('engine', 'Request failed.', { error: detail })
      bus.say('ERROR', detail, { level: 'error' })
      this.reply(spoken)
      this.finish('error')
    } finally {
      this.record(request, text, actions, outcome, started, provider, detail)
    }
  }

  /* ────────────────────────── model conversation ─────────────────────── */

  private async runModelLoop(text: string): Promise<{
    actions: string[]
    outcome: HistoryOutcome
    detail?: string
    provider?: ProviderId
  }> {
    const config = settings.get()
    const actions: string[] = []
    const tools = [PLAN_TOOL, ...TOOL_DESCRIPTORS.filter((t) => this.toolAvailable(t))]
    const needsVision = VISION_HINT.test(text)

    this.conversation.push({ role: 'user', content: [{ type: 'text', text }] })
    this.trimConversation()

    let usedProvider: ProviderId | undefined
    let blockedAny = false

    for (let turn = 0; turn < config.ai.maxToolCalls; turn++) {
      if (this.controller?.signal.aborted) return { actions, outcome: 'cancelled', provider: usedProvider }

      const decision = providers.route(text, {
        hasToolResults: actions.length > 0,
        turnIndex: turn,
        needsVision: needsVision && turn === 0
      })
      if (!decision.provider) {
        throw new ProviderError('No AI provider is configured. Add a key in Settings → AI.', 'auth', 'claude', false)
      }

      usedProvider = decision.provider
      providers.broadcast(decision.provider)
      if (turn === 0) {
        logger.info('engine', 'Routed request.', { provider: decision.provider, reason: decision.reason, complexity: decision.complexity })
        bus.say('JARVIS', `Analysing request — ${decision.provider === 'claude' ? 'Claude' : 'Groq'} engaged.`, { detail: decision.reason })
      }

      let response: AiResponse
      try {
        response = await this.callProvider(decision.provider, decision.fallback, tools, config)
      } catch (error) {
        throw error instanceof ProviderError ? error : new ProviderError(String(error), 'unknown', decision.provider, false)
      }

      providers.markSuccess(response.provider)
      usedProvider = response.provider

      this.conversation.push({
        role: 'assistant',
        content: [
          ...(response.text ? [{ type: 'text' as const, text: response.text }] : []),
          ...response.toolCalls.map((call) => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.args }))
        ]
      })

      if (!response.toolCalls.length) {
        const finalText = response.text || 'Done.'
        this.reply(finalText, response.provider)
        return { actions, outcome: blockedAny ? 'blocked' : 'success', provider: usedProvider }
      }

      // Speak any narration that came alongside the tool calls.
      if (response.text.trim()) {
        this.reply(response.text.trim(), response.provider, true)
      }

      const results: AiMessage['content'] = []
      for (const toolCall of response.toolCalls) {
        if (this.controller?.signal.aborted) return { actions, outcome: 'cancelled', provider: usedProvider }

        if (toolCall.name === 'present_plan') {
          const approved = await this.handlePlan(toolCall.args)
          results.push({
            type: 'tool_result',
            toolUseId: toolCall.id,
            text: approved
              ? 'The user approved the plan. Carry out the steps now.'
              : 'The user cancelled the plan. Do not carry out the steps; acknowledge briefly.',
            isError: !approved
          })
          if (!approved) {
            this.conversation.push({ role: 'user', content: results })
            this.reply('Cancelled.', response.provider)
            return { actions, outcome: 'cancelled', provider: usedProvider }
          }
          continue
        }

        const outcome = await this.invokeTool(toolCall.name, toolCall.args)
        actions.push(toolCall.name)
        if (outcome.result.blocked) blockedAny = true

        results.push({
          type: 'tool_result',
          toolUseId: toolCall.id,
          text: summariseForModel(outcome.result),
          isError: !outcome.result.ok,
          ...(outcome.imageDataUrl ? { imageDataUrl: outcome.imageDataUrl } : {})
        })
      }

      this.conversation.push({ role: 'user', content: results })
      this.trimConversation()
      bus.emit({ type: 'status', status: 'thinking' })
    }

    this.reply('That is taking more steps than I am allowed in one request. Tell me how you would like to continue.')
    return { actions, outcome: 'failed', detail: 'Tool call limit reached.', provider: usedProvider }
  }

  private async callProvider(
    primary: ProviderId,
    fallback: ProviderId | null,
    tools: ToolDescriptor[],
    config = settings.get()
  ): Promise<AiResponse> {
    const request = {
      system: this.systemPrompt(primary),
      messages: this.conversation,
      tools,
      temperature: config.ai.temperature,
      maxTokens: config.ai.maxTokens,
      signal: this.controller?.signal
    }

    try {
      return await providers.get(primary).complete(request)
    } catch (error) {
      const normalised = error instanceof ProviderError ? error : new ProviderError(String(error), 'unknown', primary, true)
      providers.markFailure(primary, normalised.message, normalised.kind !== 'auth')

      const canFallback = config.ai.autoFallback && fallback && normalised.kind !== 'invalid' && !this.controller?.signal.aborted
      if (!canFallback) throw normalised

      logger.warn('engine', 'Primary provider failed; falling back.', { from: primary, to: fallback, kind: normalised.kind })
      bus.say('SYSTEM', `${primary === 'claude' ? 'Claude' : 'Groq'} is unavailable. Switching to ${fallback === 'claude' ? 'Claude' : 'Groq'}.`, { level: 'warn' })
      providers.broadcast(fallback)
      return providers.get(fallback!).complete({ ...request, system: this.systemPrompt(fallback!) })
    }
  }

  private systemPrompt(provider: ProviderId): string {
    return buildSystemPrompt({
      settings: settings.get(),
      stats: monitoring.latest(),
      platformLabel: platform().label,
      hostname: monitoring.latest()?.os.hostname ?? 'this computer',
      demo: settings.get().general.demoMode,
      hasVision: providers.get(provider).supportsVision()
    })
  }

  /* ────────────────────────────── tool calls ─────────────────────────── */

  private async invokeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ result: ToolResult; imageDataUrl?: string }> {
    const config = settings.get()
    const activityId = id('act')

    const verdict = decide(name, args, config)
    if (verdict.action === 'deny') {
      bus.say('SECURITY', verdict.reason, { level: 'warn' })
      bus.emit({ type: 'tool', activity: { id: activityId, name, status: 'blocked', ts: now(), summary: verdict.reason } })
      this.advancePlan('skipped', verdict.reason)
      return { result: { ok: false, blocked: true, error: verdict.reason, summary: verdict.reason } }
    }

    if (verdict.action === 'confirm' && verdict.confirm) {
      bus.emit({ type: 'status', status: 'idle' })
      const approved = await this.requestConfirmation(verdict.confirm)
      if (!approved) {
        const message = 'Cancelled — you declined that action.'
        bus.say('SECURITY', message, { level: 'warn' })
        bus.emit({ type: 'tool', activity: { id: activityId, name, status: 'blocked', ts: now(), summary: message } })
        this.advancePlan('skipped', 'Declined')
        return { result: { ok: false, blocked: true, error: message, summary: message } }
      }
    }

    bus.emit({ type: 'status', status: 'executing' })
    bus.say('TOOL', describeAction(name, args), { detail: config.privacy.logArguments ? JSON.stringify(args) : undefined })
    bus.emit({ type: 'tool', activity: { id: activityId, name, status: 'running', ts: now() } })
    this.advancePlan('running')

    const result = await executeTool(name, args, this.toolContext())

    bus.emit({
      type: 'tool',
      activity: { id: activityId, name, status: result.ok ? 'ok' : result.blocked ? 'blocked' : 'error', ts: now(), summary: result.summary }
    })
    bus.say(result.ok ? 'SYSTEM' : 'ERROR', result.summary ?? (result.ok ? 'Done.' : 'Failed.'), {
      level: result.ok ? 'success' : 'error'
    })
    this.advancePlan(result.ok ? 'done' : 'failed', result.summary)

    if (settings.get().voice.speakActions && result.summary) this.speak(result.summary)

    // read_screen returns an image for the next model turn; it never goes to disk.
    const data = result.data as { imageDataUrl?: string } | undefined
    if (data?.imageDataUrl) {
      const { imageDataUrl, ...rest } = data
      return { result: { ...result, data: rest }, imageDataUrl }
    }
    return { result }
  }

  private toolContext(): ToolContext {
    const config = settings.get()
    return {
      settings: config,
      pathPolicy: {
        protectedPaths: config.automation.protectedPaths,
        workspaceRoots: config.automation.workspaceRoots,
        platform: process.platform
      },
      signal: this.controller?.signal,
      runRoutine: (name) => this.runRoutine(name),
      onScreenAccess: (active) => bus.emit({ type: 'screen-access', active })
    }
  }

  private toolAvailable(tool: ToolDescriptor): boolean {
    const config = settings.get()
    if (config.permissions.tools[tool.name] === 'deny') return false
    if (tool.category === 'screen' && !config.permissions.screenAccess) return false
    if (tool.category === 'web' && !config.permissions.webAccess) return false
    if (tool.category === 'power' && !config.automation.allowPower) return false
    if (tool.category === 'memory' && !config.memory.enabled) return false
    if (tool.category === 'terminal' && !config.automation.allowShell && !config.automation.allowedCommands.length) return false
    return true
  }

  /* ──────────────────────────────── plans ────────────────────────────── */

  private async handlePlan(args: Record<string, unknown>): Promise<boolean> {
    const title = String(args.title ?? 'Plan').slice(0, 120)
    const rawSteps = Array.isArray(args.steps) ? args.steps : []
    const steps: PlanStep[] = rawSteps.slice(0, 12).map((step, index) => ({
      id: `s${index}`,
      label: String(step).slice(0, 160),
      status: 'pending'
    }))
    if (!steps.length) return true

    const requiresApproval = args.requires_approval === true
    const plan: TaskPlan = { id: id('plan'), title, steps, createdAt: now(), awaitingApproval: requiresApproval }
    this.plan = plan
    this.planCursor = 0
    bus.emit({ type: 'plan', plan })
    bus.say('JARVIS', `Plan: ${title}`, { detail: steps.map((s, i) => `${i + 1}. ${s.label}`).join('\n') })

    if (!requiresApproval) return true

    const approved = await this.requestConfirmation({
      title,
      body: 'Here is what I intend to do. Proceed?',
      risk: 'medium',
      tool: 'present_plan',
      details: steps.map((s) => s.label),
      confirmLabel: 'Execute',
      cancelLabel: 'Cancel'
    })

    this.plan = { ...plan, awaitingApproval: false }
    bus.emit({ type: 'plan', plan: this.plan })
    if (!approved) {
      this.plan = null
      bus.emit({ type: 'plan', plan: null })
    }
    return approved
  }

  /** Advances the visible plan one step per executed tool call. */
  private advancePlan(status: PlanStep['status'], detail?: string): void {
    if (!this.plan) return
    const step = this.plan.steps[this.planCursor]
    if (!step) return

    const steps = [...this.plan.steps]
    steps[this.planCursor] = { ...step, status, ...(detail ? { detail } : {}) }
    this.plan = { ...this.plan, steps }
    bus.emit({ type: 'plan-step', planId: this.plan.id, stepId: step.id, status, detail })

    if (status !== 'running') {
      this.planCursor++
      if (this.planCursor >= steps.length) {
        this.plan = { ...this.plan, done: true }
        bus.emit({ type: 'plan', plan: this.plan })
      }
    }
  }

  /* ────────────────────────────── routines ───────────────────────────── */

  async runRoutine(name: string): Promise<ToolResult> {
    const routine = routines.find(name)
    if (!routine) return { ok: false, error: `No routine called "${name}".`, summary: `No routine called "${name}".` }

    const plan: TaskPlan = {
      id: id('plan'),
      title: routine.name,
      steps: routine.actions.map((action, index) => ({
        id: `s${index}`,
        label: action.label ?? describeAction(action.tool, action.args),
        status: 'pending'
      })),
      createdAt: now()
    }
    this.plan = plan
    this.planCursor = 0
    bus.emit({ type: 'plan', plan })
    bus.say('JARVIS', `Running routine: ${routine.name}.`)

    const config = settings.get()
    let succeeded = 0
    const failures: string[] = []

    for (const action of routine.actions) {
      if (this.controller?.signal.aborted) break
      const verdict = decide(action.tool, action.args, config, { fromRoutine: true })

      if (verdict.action === 'deny') {
        failures.push(`${action.tool}: ${verdict.reason}`)
        this.advancePlan('skipped', verdict.reason)
        bus.say('SECURITY', verdict.reason, { level: 'warn' })
        continue
      }
      if (verdict.action === 'confirm' && verdict.confirm) {
        const approved = await this.requestConfirmation(verdict.confirm)
        if (!approved) {
          failures.push(`${action.tool}: declined`)
          this.advancePlan('skipped', 'Declined')
          continue
        }
      }

      this.advancePlan('running')
      bus.emit({ type: 'status', status: 'executing' })
      const activityId = id('act')
      bus.emit({ type: 'tool', activity: { id: activityId, name: action.tool, status: 'running', ts: now() } })

      const result = await executeTool(action.tool, action.args, this.toolContext())
      bus.emit({
        type: 'tool',
        activity: { id: activityId, name: action.tool, status: result.ok ? 'ok' : 'error', ts: now(), summary: result.summary }
      })
      bus.say(result.ok ? 'SYSTEM' : 'ERROR', result.summary ?? action.tool, { level: result.ok ? 'success' : 'error' })
      this.advancePlan(result.ok ? 'done' : 'failed', result.summary)

      if (result.ok) succeeded++
      else failures.push(`${action.tool}: ${result.error ?? 'failed'}`)
    }

    routines.markRun(routine.id)

    const total = routine.actions.length
    if (!failures.length) {
      return { ok: true, summary: `${routine.name} complete — ${succeeded} step${succeeded === 1 ? '' : 's'} executed.`, data: { routine: routine.name, succeeded } }
    }
    return {
      ok: succeeded > 0,
      summary: `${routine.name} finished with ${failures.length} of ${total} step${total === 1 ? '' : 's'} incomplete.`,
      error: failures.join('; '),
      data: { routine: routine.name, succeeded, failures }
    }
  }

  /* ─────────────────────── no-model and demo paths ───────────────────── */

  private async handleWithoutModel(
    text: string,
    request: SubmitRequest,
    started: number,
    demo: boolean
  ): Promise<boolean> {
    if (demo) {
      const reply = demoReply(text)
      bus.emit({ type: 'status', status: 'thinking' })
      await wait(650)
      for (const line of reply.console) {
        bus.say(line.source, line.text)
        await wait(320)
      }
      this.reply(reply.text)
      this.finish('complete')
      this.record(request, text, reply.actions, 'success', started, 'demo', 'Demo mode — nothing was executed.')
      return true
    }

    const intent = matchLocalIntent(text)
    if (intent) {
      bus.say('SYSTEM', 'No AI provider configured — using offline command matching.', { level: 'warn' })
      bus.emit({ type: 'status', status: 'executing' })
      const outcome = await this.invokeTool(intent.call.name, intent.call.args)
      this.reply(outcome.result.summary ?? intent.reply)
      this.finish(outcome.result.ok ? 'complete' : 'error')
      this.record(request, text, [intent.call.name], outcome.result.ok ? 'success' : 'failed', started, 'local', outcome.result.error)
      return true
    }

    const message =
      'I have no AI provider configured, so I can only handle direct commands. Add an Anthropic or Groq key in Settings → AI.'
    bus.say('ERROR', message, { level: 'error' })
    this.reply(message)
    this.finish('error')
    this.record(request, text, [], 'failed', started, 'local', 'No provider configured.')
    return true
  }

  /* ──────────────────────────── plumbing ─────────────────────────────── */

  private async requestConfirmation(input: Omit<ConfirmRequest, 'id'>): Promise<boolean> {
    const request: ConfirmRequest = { ...input, id: id('cf') }
    bus.emit({ type: 'confirm', request })
    bus.say('SECURITY', `Confirmation required — ${request.title.toLowerCase()}.`, { level: 'warn' })
    this.speak(request.body)

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingConfirms.delete(request.id)) {
          bus.emit({ type: 'confirm-closed', id: request.id })
          bus.say('SECURITY', 'Confirmation timed out. Nothing was changed.', { level: 'warn' })
          resolve(false)
        }
      }, 120_000)
      timer.unref?.()

      this.pendingConfirms.set(request.id, (approved) => {
        clearTimeout(timer)
        resolve(approved)
      })
    })
  }

  private reply(text: string, provider?: ProviderId, interim = false): void {
    const message: ChatMessage = {
      id: id('msg'),
      role: 'assistant',
      text,
      ts: now(),
      ...(provider ? { provider } : {}),
      ...(settings.get().general.demoMode ? { simulated: true } : {})
    }
    this.pushTranscript(message)
    bus.emit({ type: 'message', message })
    bus.say('JARVIS', text)
    this.speak(text)
    if (!interim) bus.emit({ type: 'status', status: 'speaking' })
  }

  private speak(text: string): void {
    if (!settings.get().voice.enabled || settings.get().voice.engine === 'off') return
    bus.emit({ type: 'speak', id: id('sp'), text })
  }

  private finish(status: 'idle' | 'complete' | 'error'): void {
    this.busy = false
    this.controller = null
    bus.emit({ type: 'busy', busy: false })
    bus.emit({ type: 'status', status: status === 'idle' ? 'idle' : status })
    if (status !== 'idle') {
      const timer = setTimeout(() => bus.emit({ type: 'status', status: 'idle' }), status === 'error' ? 2600 : 1600)
      timer.unref?.()
    }
    providers.broadcast(null)
  }

  private record(
    request: SubmitRequest,
    command: string,
    actions: string[],
    outcome: HistoryOutcome,
    started: number,
    provider: HistoryEntry['provider'],
    detail?: string
  ): void {
    if (!settings.get().privacy.storeTranscripts) return
    history.add({
      id: id('h'),
      ts: started,
      command,
      actions,
      outcome,
      durationMs: now() - started,
      provider,
      source: request.source,
      ...(detail ? { detail } : {})
    })
  }

  private pushTranscript(message: ChatMessage): void {
    this.transcript.push(message)
    if (this.transcript.length > 200) this.transcript.splice(0, this.transcript.length - 200)
  }

  /** Keeps the last few user turns, never splitting a tool call from its result. */
  private trimConversation(): void {
    const boundaries: number[] = []
    this.conversation.forEach((message, index) => {
      if (message.role === 'user' && message.content.some((c) => c.type === 'text')) boundaries.push(index)
    })
    if (boundaries.length <= MAX_CONTEXT_TURNS) return
    const cut = boundaries[boundaries.length - MAX_CONTEXT_TURNS]
    this.conversation = this.conversation.slice(cut)
  }

  clearConversation(): void {
    this.conversation = []
    this.transcript = []
    this.plan = null
    bus.emit({ type: 'plan', plan: null })
  }
}

function summariseForModel(result: ToolResult): string {
  const payload: Record<string, unknown> = { ok: result.ok }
  if (result.summary) payload.summary = result.summary
  if (result.error) payload.error = result.error
  if (result.blocked) payload.blocked = true
  if (result.data !== undefined) payload.data = result.data

  let text = JSON.stringify(payload)
  if (text.length > 12_000) {
    text = `${text.slice(0, 12_000)}…"[truncated]"}`
  }
  return text
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export const engine = new Engine()
