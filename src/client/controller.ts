import type {
  AgentTeamRpc, InsightsView, ModeResponse, RecipePreview, RunView, TeamSnapshot,
} from './contracts.ts'
import { AGENT_TEAM_RPC_API_VERSION, EMPTY_DATA } from './contracts.ts'
import { ClientI18n, type LocaleService, type Translate } from './i18n.ts'

export interface ControllerSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: TeamSnapshot
  error: string
  revision: number
}

interface ConnectionGenerationSource {
  getSnapshot(): unknown | undefined
  subscribe(listener: () => void): () => void
}

/** Catalog state and reconnect ownership. Feature-specific RPCs live in small gateways below. */
export class AgentTeamController {
  private state: ControllerSnapshot = { status: 'idle', data: EMPTY_DATA, error: '', revision: 0 }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<TeamSnapshot> | undefined
  private queuedRefresh: Promise<TeamSnapshot> | undefined
  readonly i18n: ClientI18n
  readonly modes: ModeGateway
  readonly runs: RunGateway
  readonly recipes: RecipeGateway
  readonly call: AgentTeamRpc

  constructor(call: AgentTeamRpc, locale?: LocaleService) {
    this.i18n = new ClientI18n(locale)
    this.call = async <T,>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> => withRpcTimeout(
      requestSignal => call<T>(endpoint, payload, requestSignal), timeoutForEndpoint(endpoint), this.i18n.t('requestTimeout'), signal,
    )
    this.modes = new ModeGateway(this.call, this.i18n.t)
    this.runs = new RunGateway(this.call, this.i18n.t)
    this.recipes = new RecipeGateway(this.call, this.i18n.t)
  }

  readonly getSnapshot = (): ControllerSnapshot => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  load(force = false): Promise<TeamSnapshot> {
    if (!force && this.state.status === 'ready') return Promise.resolve(this.state.data)
    if (this.pending !== undefined) {
      if (!force) return this.pending
      if (this.queuedRefresh !== undefined) return this.queuedRefresh
      const active = this.pending
      const refresh = active.then(
        () => { this.queuedRefresh = undefined; return this.load(true) },
        () => { this.queuedRefresh = undefined; return this.load(true) },
      )
      this.queuedRefresh = refresh
      return refresh
    }
    this.publish({ ...this.state, status: 'loading', error: '' })
    const pending = this.call<unknown>('snapshot', {})
      .then((value) => {
        if (!isTeamSnapshot(value)) throw new Error(incompatibleHostMessage(this.i18n.t))
        const data = value
        if (data.apiVersion !== AGENT_TEAM_RPC_API_VERSION) throw new Error(incompatibleHostMessage(this.i18n.t))
        this.publish({ status: 'ready', data, error: '', revision: this.state.revision + 1 })
        return data
      })
      .catch((reason: unknown) => {
        this.publish({ ...this.state, status: 'error', error: errorText(reason, this.i18n.t) })
        throw reason
      })
      .finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  async mutate(endpoint: string, payload: unknown): Promise<void> {
    await this.call(endpoint, payload)
    await this.load(true)
  }

  private publish(state: ControllerSnapshot): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

export function isTeamSnapshot(value: unknown): value is TeamSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.apiVersion !== 'number' || !Array.isArray(record.agents) || !Array.isArray(record.squads)
    || !Array.isArray(record.models) || !Array.isArray(record.tools)) return false
  if (!isTeamCapabilities(record.capabilities) || !isTeamDefaults(record.defaults)) return false
  return record.agents.every(value => isAgentSummary(value))
    && record.squads.every(value => isSquadSummary(value))
    && record.models.every(value => isModelGroup(value))
    && record.tools.every(value => isRecordWithStrings(value, ['name', 'description']))
}

function isAgentSummary(value: unknown): boolean {
  if (!isRecordWithStrings(value, ['id', 'name', 'systemPrompt', 'provider', 'model'])) return false
  const record = value as Record<string, unknown>
  if (!isOptionalNumber(record.maxTokens) || !isOptionalString(record.fallbackProvider) || !isOptionalString(record.fallbackModel)) return false
  if (record.toolScope === undefined) return true
  if (typeof record.toolScope !== 'object' || record.toolScope === null || Array.isArray(record.toolScope)) return false
  const scope = record.toolScope as Record<string, unknown>
  return isOptionalStringArray(scope.allow) && isOptionalStringArray(scope.deny)
}

function isRecordWithStrings(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return keys.every(key => typeof record[key] === 'string')
}

function isSquadSummary(value: unknown): boolean {
  if (!isRecordWithStrings(value, ['id', 'name', 'collabNote'])) return false
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.members) || !record.members.every(member => typeof member === 'string')) return false
  if (!isOptionalStringArray(record.executionOrder)
    || !isOptionalEnum(record.executionMode, ['serial', 'parallel'])
    || !isOptionalEnum(record.contextMode, ['spawn', 'fork', 'chain'])
    || !isOptionalString(record.leaderAgentId)
    || !isOptionalEnum(record.triggerMode, ['guaranteed', 'model-tool'])
    || !isOptionalEnum(record.failurePolicy, ['continue', 'stop', 'retry-once'])
    || !isOptionalNumber(record.maxConcurrency)
    || !isOptionalNumber(record.memberTimeoutMs)
    || !isOptionalNumber(record.tokenBudget)
    || !isOptionalNumber(record.handoffSummaryMaxChars)
    || !isOptionalEnum(record.activationMode, ['always', 'smart', 'manual'])
    || !isOptionalEnum(record.memberSelectionMode, ['all', 'adaptive'])
    || !isOptionalEnum(record.responseMode, ['foreground', 'background'])
    || !isOptionalEnum(record.planningContext, ['current', 'recent', 'full'])
    || !isOptionalNumber(record.plannerMaxTokens)) return false
  if (record.qualityGate === undefined) return true
  if (!isRecordWithStrings(record.qualityGate, ['reviewerAgentId', 'repairAgentId'])) return false
  const quality = record.qualityGate as Record<string, unknown>
  return [0, 1, 2].includes(quality.maxRounds as number) && isOptionalString(quality.criteria)
}

function isModelGroup(value: unknown): boolean {
  if (!isRecordWithStrings(value, ['provider', 'name'])) return false
  return Array.isArray(value.models) && value.models.every(model => isRecordWithStrings(model, ['id', 'name']))
}

function isTeamCapabilities(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = ['smartActivation', 'dags', 'qualityGate', 'backgroundRuns', 'recipes', 'remoteRecipeFetch', 'insights', 'reproducibleVersions'] as const
  return Object.keys(record).length === keys.length && keys.every(key => typeof record[key] === 'boolean')
}

function isTeamDefaults(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 5
    && ['serial', 'parallel'].includes(String(record.executionMode))
    && record.fixedOrderExecutionMode === 'serial'
    && ['spawn', 'fork', 'chain'].includes(String(record.contextMode))
    && record.planningContext === 'full'
    && record.plannerMaxTokens === 2_048
}

function isOptionalEnum(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (typeof value === 'string' && allowed.includes(value))
}

function isOptionalString(value: unknown): boolean { return value === undefined || typeof value === 'string' }
function isOptionalNumber(value: unknown): boolean { return value === undefined || (typeof value === 'number' && Number.isFinite(value)) }
function isOptionalStringArray(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string')) }

/** Every foreground browser RPC is bounded so one broken connection cannot permanently lock UI controls. */
export function withRpcTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string, parentSignal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onParentAbort)
      action()
    }
    const onParentAbort = (): void => {
      controller.abort()
      finish(() => { reject(new Error(message)) })
    }
    const timer = setTimeout(() => {
      controller.abort()
      finish(() => { reject(new Error(message)) })
    }, timeoutMs)
    if (parentSignal?.aborted === true) { onParentAbort(); return }
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    let promise: Promise<T>
    try { promise = operation(controller.signal) }
    catch (reason) { finish(() => { reject(reason) }); return }
    promise.then(
      value => { finish(() => { resolve(value) }) },
      reason => { finish(() => { reject(reason) }) },
    )
  })
}

function timeoutForEndpoint(endpoint: string): number {
  if (endpoint.startsWith('mode/') || endpoint === 'project/default-set') return 5_000
  if (endpoint === 'plan/preview') return 120_000
  if (endpoint === 'insights/summary' || endpoint === 'recipe/import' || endpoint === 'import' || endpoint === 'import/preview') return 30_000
  return 15_000
}

/** Durable and one-shot conversation mode operations. */
export class ModeGateway {
  constructor(private readonly call: AgentTeamRpc, private readonly t?: Translate) {}
  get(sessionId: string): Promise<ModeResponse> { return this.request('mode/get', { sessionId }) }
  set(sessionId: string, state: 'enabled' | 'disabled', squadId?: string): Promise<ModeResponse> {
    return this.request('mode/set', { sessionId, state, ...(squadId === undefined ? {} : { squadId }) })
  }
  inherit(sessionId: string): Promise<ModeResponse> { return this.request('mode/inherit', { sessionId }) }
  setNext(sessionId: string, state: 'inherit' | 'solo' | 'team', squadId?: string): Promise<ModeResponse> {
    return this.request('mode/next-set', { sessionId, state, ...(squadId === undefined ? {} : { squadId }) })
  }
  setProjectDefault(sessionId: string, squadId: string | null): Promise<ModeResponse> {
    return this.request('project/default-set', { sessionId, squadId })
  }

  private async request(endpoint: string, payload: unknown): Promise<ModeResponse> {
    const value = await this.call<unknown>(endpoint, payload)
    if (!isModeResponse(value)) throw new Error(this.t === undefined
      ? 'Agent Team GUI client/host versions do not match. Restart DeepSeek Harness, then refresh the page.'
      : incompatibleHostMessage(this.t))
    return value
  }
}

/** Run history, usage, retry, export, and preview operations. */
export class RunGateway {
  constructor(private readonly call: AgentTeamRpc, private readonly t?: Translate) {}
  async list(sessionId: string, limit = 30, detail = false): Promise<{ runs: RunView[] }> {
    const value = await this.call<unknown>('run/list', { sessionId, limit, detail })
    if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>).runs)
      || !(value as { runs: unknown[] }).runs.every(isRunView)) throw this.invalidResponse()
    return value as { runs: RunView[] }
  }
  async get(id: string): Promise<{ run: RunView | null }> {
    const value = await this.call<unknown>('run/get', { id })
    if (typeof value === 'object' && value !== null && 'run' in value) {
      const run = (value as { run: unknown }).run
      if (run === null || isRunView(run)) return { run }
    }
    throw this.invalidResponse()
  }
  cancel(id: string): Promise<unknown> { return this.call('run/cancel', { id }) }
  retry(id: string, agentId?: string): Promise<{ id: string; status: string; retryOf: string }> {
    return this.call('run/retry', { id, ...(agentId === undefined ? {} : { agentId }) })
  }
  clear(sessionId: string): Promise<{ cleared: number }> {
    return this.call('run/clear', { sessionId, settledOnly: true })
  }
  export(id: string): Promise<unknown> { return this.call('run/export', { id }) }
  preview(sessionId: string, squadId: string, task: string): Promise<{ plan: RunView['plan'] }> {
    return this.call('plan/preview', { sessionId, squadId, task })
  }
  insights(sessionId: string, since?: number): Promise<InsightsView> {
    return this.call('insights/summary', { sessionId, ...(since === undefined ? {} : { since }) })
  }

  private invalidResponse(): Error {
    return new Error(this.t === undefined ? 'Invalid run response.' : incompatibleHostMessage(this.t))
  }
}

export function isRunView(value: unknown): value is RunView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const run = value as Record<string, unknown>
  if (!isStringFields(run, ['id', 'sessionId', 'squadName', 'task', 'status', 'executionMode', 'contextMode'])
    || typeof run.startedAt !== 'number' || !Array.isArray(run.members) || !isUsage(run.usage)) return false
  if (!['planning', 'queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(String(run.status))
    || !['serial', 'parallel'].includes(String(run.executionMode))
    || !['spawn', 'fork', 'chain'].includes(String(run.contextMode))
    || !isOptionalString(run.squadId) || !isOptionalString(run.projectKey) || !isOptionalString(run.retryOf) || !isOptionalString(run.error)
    || !isOptionalNumber(run.endedAt)
    || !isOptionalEnum(run.phase, ['queued', 'planning', 'members', 'quality-review', 'quality-repair', 'synthesis', 'settled'])
    || !isOptionalEnum(run.meteringCoverage, ['full', 'partial', 'none'])) return false
  if (!run.members.every(isRunMember)) return false
  if (run.plan !== undefined && !isRunPlan(run.plan)) return false
  if (run.quality !== undefined && !isRunQuality(run.quality)) return false
  if (run.qualityProgress !== undefined && !isQualityProgress(run.qualityProgress)) return false
  if (run.liveUsage !== undefined && !isLiveUsage(run.liveUsage)) return false
  if (run.chain !== undefined) {
    const chain = run.chain as Record<string, unknown> | null
    if (chain === null || typeof chain !== 'object' || typeof chain.id !== 'string'
      || !Number.isInteger(chain.revision) || Number(chain.revision) < 0
      || !Number.isInteger(chain.maxContinuations) || Number(chain.maxContinuations) < 0
      || !isUsage(chain.usageBeforeRun) || !isOptionalNumber(chain.tokenBudget)
      || !isOptionalString(chain.continuationOf) || !isOptionalString(chain.reason) || !isOptionalString(chain.progressReview)) return false
  }
  return true
}

function isRunMember(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const member = value as Record<string, unknown>
  return isStringFields(member, ['agentId', 'agentName', 'provider', 'model', 'status'])
    && ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'timed-out', 'skipped'].includes(String(member.status))
    && typeof member.attempts === 'number' && isOutput(member.output)
    && isOptionalNumber(member.startedAt) && isOptionalNumber(member.endedAt)
    && isOptionalString(member.runId) && isOptionalString(member.childId) && isOptionalString(member.stopReason) && isOptionalString(member.error)
    && isOptionalEnum(member.phase, ['member', 'quality', 'repair'])
    && (member.usage === undefined || isUsage(member.usage))
    && (member.usageSamples === undefined || isUsageSamples(member.usageSamples))
    && (member.recovery === undefined || isRecovery(member.recovery))
    && isOptionalString(member.reusedFrom)
}

function isRecovery(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const recovery = value as Record<string, unknown>
  if (!isStringFields(recovery, ['state', 'provider', 'model', 'originalTask'])
    || !['diagnosing', 'completed', 'failed', 'skipped'].includes(String(recovery.state))
    || typeof recovery.attempted !== 'boolean' || !isOptionalString(recovery.error) || !isOptionalString(recovery.retryTask)
    || (recovery.usage !== undefined && !isUsage(recovery.usage))) return false
  const first = recovery.firstAttempt as Record<string, unknown> | undefined
  if (first === undefined || first === null || typeof first.status !== 'string' || !isOptionalString(first.error) || !isOutput(first.output)) return false
  if (recovery.decision === undefined) return true
  const decision = recovery.decision as Record<string, unknown> | null
  return decision !== null && isStringFields(decision, ['action', 'cause', 'confidence', 'reason', 'progress', 'nextTask', 'uncertainty'])
    && ['retry', 'revise', 'stop'].includes(String(decision.action))
    && ['transient', 'task-scope', 'assignment', 'missing-context', 'tooling', 'unknown'].includes(String(decision.cause))
    && ['supported', 'limited', 'insufficient'].includes(String(decision.confidence))
    && Array.isArray(decision.evidence) && decision.evidence.every(item => typeof item === 'string')
}

function isUsageSamples(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const samples = value as Record<string, unknown>
  return Number.isInteger(samples.metered) && Number.isInteger(samples.total)
    && Number(samples.metered) >= 0 && Number(samples.total) >= 0
    && Number(samples.metered) <= Number(samples.total)
}

function isRunPlan(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  return typeof plan.summary === 'string' && ['main-agent', 'squad-leader', 'deterministic-fallback', 'lead-continuation'].includes(String(plan.planner))
    && isOptionalEnum(plan.decision, ['run', 'skip']) && isOptionalString(plan.reason)
    && isOptionalString(plan.plannerProvider) && isOptionalString(plan.plannerModel)
    && isOptionalString(plan.warning)
    && Array.isArray(plan.memberOrder) && plan.memberOrder.every(id => typeof id === 'string')
    && Array.isArray(plan.assignments) && plan.assignments.every(assignment => {
      if (typeof assignment !== 'object' || assignment === null) return false
      const record = assignment as Record<string, unknown>
      return typeof record.agentId === 'string' && typeof record.task === 'string'
        && (record.dependsOn === undefined || (Array.isArray(record.dependsOn) && record.dependsOn.every(id => typeof id === 'string')))
    }) && (plan.usage === undefined || isUsage(plan.usage))
}

function isRunQuality(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const quality = value as Record<string, unknown>
  return typeof quality.approved === 'boolean' && Array.isArray(quality.rounds) && quality.rounds.every(round => {
    if (typeof round !== 'object' || round === null) return false
    const record = round as Record<string, unknown>
    return typeof record.round === 'number' && typeof record.approved === 'boolean' && typeof record.feedback === 'string'
      && isQualityMember(record.reviewer) && (record.repair === undefined || isQualityMember(record.repair))
  })
}

function isQualityMember(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const member = value as Record<string, unknown>
  return isStringFields(member, ['agentId', 'agentName', 'status'])
    && ['completed', 'failed', 'cancelled', 'timed-out'].includes(String(member.status))
    && typeof member.attempts === 'number' && isOutput(member.output)
    && isOptionalString(member.error) && isOptionalNumber(member.startedAt) && isOptionalNumber(member.endedAt)
    && (member.usage === undefined || isUsage(member.usage))
}

function isQualityProgress(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const progress = value as Record<string, unknown>
  return typeof progress.round === 'number' && [0, 1, 2].includes(progress.maxRepairRounds as number)
    && [1, 2, 3].includes(progress.totalReviews as number)
    && progress.round >= 1 && progress.round <= (progress.totalReviews as number)
    && isStringFields(progress, ['reviewerAgentId', 'repairAgentId'])
    && ['reviewing', 'repairing'].includes(String(progress.state))
}

function isLiveUsage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const live = value as Record<string, unknown>
  return (live.planner === undefined || isUsage(live.planner))
    && (live.review === undefined || isUsage(live.review))
    && (live.repair === undefined || isUsage(live.repair))
}

function isOutput(value: unknown): boolean {
  return Array.isArray(value) && value.every(block => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return false
    const record = block as Record<string, unknown>
    return isOptionalString(record.type) && isOptionalString(record.text)
  })
}

function isUsage(value: unknown): value is RunView['usage'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  return ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && (usage[key] as number) >= 0)
    && typeof usage.providerReported === 'boolean'
}

function isStringFields(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => typeof record[key] === 'string')
}

/** Two-phase portable recipe workflow. */
export class RecipeGateway {
  constructor(private readonly call: AgentTeamRpc, private readonly t?: Translate) {}
  export(squadId: string): Promise<unknown> { return this.call('recipe/export', { id: squadId }) }
  async preview(doc: unknown, routeRemap: Record<string, unknown> = {}): Promise<RecipePreview> {
    const value = await this.call<unknown>('recipe/preview', { doc, routeRemap })
    if (!isRecipePreview(value)) throw new Error(this.t === undefined ? 'Invalid recipe preview response.' : incompatibleHostMessage(this.t))
    return value
  }
  async fetchPreview(url: string): Promise<RecipePreview & { doc?: unknown }> {
    const value = await this.call<unknown>('recipe/fetch-preview', { url })
    if (!isRecipePreview(value)) throw new Error(this.t === undefined ? 'Invalid recipe preview response.' : incompatibleHostMessage(this.t))
    return value
  }
  import(doc: unknown, policy: 'merge' | 'copy', routeRemap: Record<string, unknown>, expectedRevision: number): Promise<unknown> {
    return this.call('recipe/import', { doc, policy, routeRemap, expectedRevision })
  }
}

function isRecipePreview(value: unknown): value is RecipePreview & { doc?: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.valid === 'boolean' && isDefinitionRevision(record.definitionRevision)
    && Array.isArray(record.conflicts) && record.conflicts.every(item => {
      if (!isRecordWithStrings(item, ['id', 'existingName', 'incomingName'])) return false
      return item.kind === 'agent' || item.kind === 'squad'
    })
    && Array.isArray(record.missingRoutes) && record.missingRoutes.every(item => {
      if (!isRecordWithStrings(item, ['agentId', 'provider', 'model', 'message'])) return false
      return item.kind === 'primary' || item.kind === 'fallback'
    })
    && (record.squad === undefined || isSquadSummary(record.squad))
    && (record.agents === undefined || (Array.isArray(record.agents) && record.agents.every(isAgentSummary)))
    && isAffectedSquads(record.affectedSquads)
}

function isDefinitionRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isAffectedSquads(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(item => {
    if (!isRecordWithStrings(item, ['squadId', 'squadName'])) return false
    return Array.isArray(item.agentIds) && item.agentIds.every(id => typeof id === 'string')
  }))
}

/** Whether a mode response is final without waiting for Session/project hydration. */
export function isAuthoritativeModeResponse(response: Pick<ModeResponse, 'mode' | 'sessionOverride' | 'sessionReady'>): boolean {
  return response.sessionReady !== false
    || response.sessionOverride === 'enabled'
    || response.sessionOverride === 'disabled'
    || response.mode !== null
}

/** Reject partial legacy mutation responses before they corrupt the visible mode state. */
export function isModeResponse(value: unknown): value is ModeResponse {
  if (typeof value !== 'object' || value === null) return false
  const response = value as Record<string, unknown>
  if (!('mode' in response) || !('sessionOverride' in response) || !('sessionReady' in response)
    || !('projectKey' in response) || !('projectDefault' in response) || !('nextOverride' in response)) return false
  if (!['enabled', 'disabled', 'inherit'].includes(String(response.sessionOverride))) return false
  if (typeof response.sessionReady !== 'boolean') return false
  if (response.projectKey !== null && typeof response.projectKey !== 'string') return false
  if (!isModeValue(response.mode, true) || !isProjectDefault(response.projectDefault) || !isNextOverride(response.nextOverride)) return false
  if (response.sessionOverride === 'enabled' && response.mode === null) return false
  if (response.sessionOverride === 'disabled' && response.mode !== null) return false
  return true
}

function isModeValue(value: unknown, nullable: boolean): boolean {
  if (value === null) return nullable
  if (typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.sessionId === 'string' && typeof record.squadId === 'string' && typeof record.squadName === 'string'
}

function isProjectDefault(value: unknown): boolean {
  if (value === null) return true
  if (typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.projectKey === 'string' && typeof record.squadId === 'string' && typeof record.enabled === 'boolean'
}

function isNextOverride(value: unknown): boolean {
  return value === null || value === 'inherit' || value === 'solo'
    || (typeof value === 'object' && isStringPair(value as Record<string, unknown>, 'squadId', 'squadName'))
}

function isStringPair(value: Record<string, unknown>, first: string, second: string): boolean {
  return typeof value[first] === 'string' && typeof value[second] === 'string'
}

/** Refresh the durable catalog after every completed DSH connection handshake. */
export function refreshAgentTeamsOnReconnect(controller: AgentTeamController, source: ConnectionGenerationSource): () => void {
  const retryDelays = [100, 300, 1_000, 2_000, 5_000, 10_000, 30_000] as const
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = (): void => {
    generation += 1
    const current = generation
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (source.getSnapshot() === undefined) return
    const attempt = (index: number): void => {
      void controller.load(true).catch(() => {
        if (current !== generation || source.getSnapshot() === undefined) return
        const delayIndex = Math.min(index, retryDelays.length - 1)
        timer = setTimeout(() => { attempt(Math.min(index + 1, retryDelays.length - 1)) }, retryDelays[delayIndex])
      })
    }
    attempt(0)
  }
  const unsubscribe = source.subscribe(refresh)
  refresh()
  return () => {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
  }
}

export function errorText(reason: unknown, t?: Translate): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (message.includes('unknown agent team endpoint')) return t === undefined
    ? 'Agent Team GUI client/host versions do not match. Restart DeepSeek Harness, then refresh the page.'
    : incompatibleHostMessage(t)
  return message
}

function incompatibleHostMessage(t: Translate): string {
  return t('incompatibleHost')
}
