import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { deterministicExecutionPlan, executionWaves, normalizeHandoff, validateExecutionPlan } from '../orchestration.ts'
import { boundedHandoffChain } from '../handoff-chain.ts'
import { isDelegationTool } from '../delegation-policy.ts'
import { exhaustedQuota, RETRY_DIAGNOSIS_CONTRACT, retryDecisionSchema, retryDiagnosisOutputSchema } from '../retry-diagnosis.ts'
import { continuationRequestSchema, prepareContinuation } from '../continuation.ts'
import { DEFAULT_HANDOFF_SUMMARY_MAX_CHARS } from '../../limits.ts'
import { runMeteringCoverage, RunHistoryStore } from '../run-history.ts'
import { AgentTeamError } from '../domain/host.ts'
import { DefinitionApplicationService } from './definition-service.ts'
import { OfficialUsageMeter, type TokenUsageProjection } from '../infrastructure/official-usage-meter.ts'
import { throwIfAborted } from '../infrastructure/write-coordinator.ts'
import {
  AgentId,
  DispatchId,
  SquadId,
  type AgentRecord,
  type AgentTokenUsage,
  type MemberRecovery,
  type ExecutionChain,
  type SquadContinuationRequest,
  type ContinuationAvailability,
  type AgentTeamRunExportDocument,
  type SquadAssignment,
  type SquadDispatchRequest,
  type SquadDispatchResult,
  type SquadExecutionPlan,
  type SquadInsightsSummary,
  type SquadMemberResult,
  type SquadPlanAssignment,
  type SquadQualityResult,
  type SquadQualityRound,
  type SquadRecord,
  type SquadRunMember,
  type SquadRunRecord,
} from '../../types.ts'

interface ResolvedMember {
  readonly id: AgentId
  readonly record: AgentRecord
  readonly task: string
}

export interface DispatchTrace {
  readonly chain?: ExecutionChain
  readonly reusedMembers?: ReadonlyMap<AgentId, SquadRunMember>
  readonly previousMembers?: ReadonlyMap<AgentId, SquadRunMember>
  /** Model-tool admission: claim only after caller input and definitions validate. */
  readonly claimSourceMessage?: boolean
  readonly sessionId?: SessionId
  readonly sourceMessageId?: string
  readonly dispatchId?: DispatchId
  readonly retryOf?: DispatchId
  readonly responseMode?: 'foreground' | 'background'
  readonly selectedAgentIds?: readonly AgentId[]
  /** Immutable source plan replayed by a whole-run retry without replanning. */
  readonly replayPlan?: SquadExecutionPlan
  readonly onStored?: (error?: unknown) => void
  /** Internal durable acceptance metadata for a background job. */
  readonly backgroundJobId?: string
  readonly backgroundRequestKey?: string
  /** Definition graph frozen at durable background acceptance. */
  readonly frozenDefinition?: {
    readonly squad: SquadRecord
    readonly agents: ReadonlyMap<AgentId, AgentRecord>
  }
}

const ZERO_USAGE: AgentTokenUsage = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  providerReported: false,
}

/**
 * Runtime orchestration application service. It depends on the definition
 * layer and official Harness adapters, while keeping the Cordis facade thin.
 */
export class ExecutionApplicationService extends DefinitionApplicationService {
  private runHistory?: RunHistoryStore
  private readonly activeRunControllers = new Map<DispatchId, AbortController>()
  private readonly activeDispatchKeys = new Set<string>()
  private readonly backgroundAcceptances = new Map<string, Promise<{ id: DispatchId; status: 'queued'; jobId?: string }>>()
  private readonly pendingBackgroundRuns = new Set<DispatchId>()
  private readonly usageMeter = new OfficialUsageMeter(this.ctx)
  private readonly continuationCalls = new Map<DispatchId, { key: string; result: Promise<SquadDispatchResult> }>()

  protected history(): RunHistoryStore {
    this.runHistory ??= new RunHistoryStore(this.runs())
    return this.runHistory
  }

  protected async recoverRunHistory(): Promise<{ reconciled: number; pruned: number }> {
    const reconciled = await this.history().reconcileInterrupted()
    const pruned = await this.history().enforceRetention(
      this.config.historyMaxRuns ?? 0,
      this.config.historyMaxAgeDays ?? 0,
    )
    return { reconciled, pruned }
  }

  /** Whether the optional official jobs adapter is currently composed. */
  backgroundJobsAvailable(): boolean {
    return this.ctx.get('jobs') !== undefined
  }

  private resolveMembers(
    squad: SquadRecord,
    assignments: readonly SquadAssignment[] | undefined,
    memberOrder: readonly AgentId[] | undefined,
    agents: ReadonlyMap<AgentId, AgentRecord>,
  ): ResolvedMember[] {
    const assignmentByAgent = new Map<AgentId, string>()
    if (assignments !== undefined) {
      if (assignments.length === 0) {
        throw new AgentTeamError('assignments must be omitted instead of empty', 'INVALID_ASSIGNMENTS')
      }
      for (const assignment of assignments) {
        if (assignment.task.trim().length === 0) {
          throw new AgentTeamError(`assignment for "${assignment.agentId}" has an empty task`, 'INVALID_ASSIGNMENTS')
        }
        if (!squad.members.includes(assignment.agentId)) {
          throw new AgentTeamError(`assignment agent "${assignment.agentId}" is not a squad member`, 'INVALID_ASSIGNMENTS')
        }
        if (assignmentByAgent.has(assignment.agentId)) {
          throw new AgentTeamError(`assignment agent "${assignment.agentId}" appears more than once`, 'INVALID_ASSIGNMENTS')
        }
        assignmentByAgent.set(assignment.agentId, assignment.task)
      }
    }
    if (squad.executionOrder !== undefined && memberOrder !== undefined) {
      throw new AgentTeamError('memberOrder cannot override a squad executionOrder', 'INVALID_DISPATCH')
    }
    if (memberOrder !== undefined) {
      const orderSet = new Set(memberOrder)
      const isCompletePermutation = memberOrder.length === squad.members.length
        && orderSet.size === memberOrder.length
        && squad.members.every(id => orderSet.has(id))
      if (!isCompletePermutation) {
        throw new AgentTeamError('memberOrder must contain every squad member exactly once', 'INVALID_DISPATCH')
      }
    }
    const orderedIds = squad.executionOrder ?? memberOrder ?? squad.members
    return orderedIds.map((id) => {
      const record = agents.get(id)
      if (record === undefined) {
        throw new AgentTeamError(`squad references missing agent "${id}"`, 'AGENT_NOT_FOUND')
      }
      return { id, record, task: assignmentByAgent.get(id) ?? '' }
    })
  }

  private promptFor(squad: SquadRecord, member: ResolvedMember, sharedTask: string, chainText: string): string {
    const parts = [
      'Execution boundary: complete only this member assignment. Do not perform or replace another member\'s assignment. Never dispatch a team; do not create or delegate to subagents.',
      member.task.length === 0
        ? 'Your exclusive assignment: contribute only through your configured role; do not take ownership of another member\'s work.'
        : `Your exclusive assignment:\n${this.boundedExcerpt(member.task, 16_000)}`,
      `Configured member role (authoritative):\n${this.boundedExcerpt(member.record.systemPrompt, 8_000)}`,
      'Return a concrete bounded handoff for the main Agent to synthesize.',
      ...(squad.collabNote ?? '').length === 0 ? [] : [`Squad collaboration note:\n${this.boundedExcerpt(squad.collabNote!, 8_000)}`],
      ...chainText.length === 0 ? [] : [`Dependency handoffs (bounded JSON; full outputs in Run Center):\n${chainText}`],
      `Overall squad goal (context only; bounded excerpt):\n${this.boundedExcerpt(sharedTask, 24_000)}`,
    ]
    return parts.join('\n\n---\n\n')
  }

  /** Preserve both ends of large user text while bounding every model-facing prompt. */
  private boundedExcerpt(value: string, max: number): string {
    if (value.length <= max) return value
    const marker = '\n… [bounded excerpt: middle omitted] …\n'
    const available = Math.max(0, max - marker.length)
    const head = Math.ceil(available * 0.6)
    return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`
  }

  private resultText(output: readonly ContentBlock[]): string {
    return output
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
  }

  protected messageText(message: UserMessage): string {
    return message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  /**
   * Model tools may be emitted more than once in one model step. Bind a tool
   * dispatch to the latest durable human message, rather than to the tool-call
   * id, so sequential duplicate calls cannot start a second squad after the
   * first one settles.
   */
  private latestHumanMessageId(parent: Agent): string | undefined {
    const events = parent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'user/message' && event.data.source.kind === 'user') return event.data.id
    }
    return undefined
  }

  async dispatchFromTool(
    request: SquadDispatchRequest,
    parent: Agent,
    signal: AbortSignal,
  ): Promise<SquadDispatchResult> {
    const sourceMessageId = this.latestHumanMessageId(parent)
    if (sourceMessageId === undefined) {
      throw new AgentTeamError(
        'dispatch_to_squad could not establish the current human message identity; refusing an unsafe non-idempotent dispatch',
        'INVALID_DISPATCH',
      )
    }
    this.assertModelTeamPolicy(parent, request.squadId, sourceMessageId)
    return this.dispatch(request, parent, signal, { sessionId: parent.id, sourceMessageId, claimSourceMessage: true })
  }

  private assertModelTeamPolicy(parent: Agent, squadId: SquadId, messageId: string, continuing = false): void {
    const receipt = this.messageClaims().get(`${parent.id}:${messageId}`)
    if (receipt?.kind === 'solo' || (this.getSessionSquadOverride(parent.id) === 'disabled' && receipt?.kind !== 'team')) {
      throw new AgentTeamError('Solo is selected for this message/conversation; model-driven squad execution is disabled.', 'INVALID_DISPATCH')
    }
    if (!continuing && this.squads().get(squadId)?.activationMode === 'manual') {
      throw new AgentTeamError('This squad is Manual-only. Use the explicit Force Team next control instead of model-driven dispatch.', 'INVALID_DISPATCH')
    }
    const selected = this.getEffectiveSessionSquadMode(parent)
    if (!continuing && selected !== undefined && selected.squadId !== squadId) {
      throw new AgentTeamError('Dispatch must use the selected squad; change the conversation team selection before using another squad.', 'INVALID_DISPATCH')
    }
  }

  private chainUsage(run: SquadRunRecord | undefined): AgentTokenUsage {
    return this.addUsage(run?.chain?.usageBeforeRun, run?.usage, run?.liveUsage?.planner, run?.liveUsage?.review, run?.liveUsage?.repair)
  }

  private continuationAvailability(run: SquadRunRecord): ContinuationAvailability {
    const base = { sourceRunId: run.id, expectedRevision: run.chain?.revision ?? 0 }
    const reject = (reason: string) => ({ ...base, allowed: false, reason })
    if (run.sourceMessageId === undefined) return reject('No durable user message is linked to this run; use an explicit user replay.')
    if (run.chain === undefined || run.definitionSnapshot === undefined || run.plan?.decision !== 'run') return reject('This run has no resumable execution-chain snapshot.')
    if (run.status !== 'failed' && run.status !== 'partial') return reject('Only settled failed or partial runs may continue; cancellation and interruption require user review.')
    if (run.chain.revision >= run.chain.maxContinuations) return reject('Execution-chain continuation limit reached.')
    if (run.continuationReceipt !== undefined) return reject('A continuation has already been accepted for this plan version.')
    if (run.chain.tokenBudget !== undefined && this.chainUsage(run).totalTokens >= run.chain.tokenBudget) return reject('Execution-chain Token budget exhausted.')
    if (run.members.some(member => member.status !== 'completed' && (exhaustedQuota(member.error) || exhaustedQuota(member.recovery?.error)))) return reject('Provider billing quota or balance is exhausted; user action is required.')
    if (!run.plan.assignments.some(node => run.members.find(member => member.agentId === node.agentId)?.status !== 'completed')) return reject('No unfinished member task; quality-only failures require user review.')
    return { ...base, allowed: true, reason: 'The lead may submit one reviewed continuation of unfinished tasks with continue_squad_run. Preserve the original goal and verified work.' }
  }

  private storedResult(run: SquadRunRecord): SquadDispatchResult {
    if (run.status === 'planning' || run.status === 'queued' || run.status === 'running') throw new AgentTeamError(`Continuation ${run.id} is already active; inspect Run Center instead of dispatching again.`, 'INVALID_DISPATCH')
    return {
      dispatchId: run.id, squadId: run.squadId, squadName: run.squadName, task: run.task,
      executionMode: run.executionMode, contextMode: run.contextMode, status: run.status,
      startedAt: run.startedAt, endedAt: run.endedAt ?? run.startedAt, usage: run.usage,
      members: run.members.filter(member => ['completed', 'failed', 'timed-out', 'cancelled'].includes(member.status)).map(member => ({
        ...member, status: member.status as SquadMemberResult['status'],
      })),
      ...(run.plan === undefined ? {} : { plan: run.plan }), ...(run.quality === undefined ? {} : { quality: run.quality }),
      ...(run.chain === undefined ? {} : { chain: run.chain }), continuation: this.continuationAvailability(run),
    }
  }

  async continueFromTool(input: SquadContinuationRequest, parent: Agent, signal: AbortSignal): Promise<SquadDispatchResult> {
    throwIfAborted(signal)
    if (this.isDelegatedAgent(parent)) throw new AgentTeamError('Only the lead may continue an execution chain.', 'INVALID_DISPATCH')
    const parsed = continuationRequestSchema.parse(input)
    const request: SquadContinuationRequest = { ...parsed, assignments: parsed.assignments.map(({ dependsOn, ...node }) => ({
      ...node, ...(dependsOn === undefined ? {} : { dependsOn }),
    })) }
    const source = this.runs().get(request.sourceRunId)
    if (source === undefined || source.sessionId !== parent.id || source.sourceMessageId === undefined
      || source.sourceMessageId !== this.latestHumanMessageId(parent)) {
      throw new AgentTeamError('Continuation must belong to the calling session and its current user message.', 'INVALID_DISPATCH')
    }
    this.assertModelTeamPolicy(parent, source.squadId, source.sourceMessageId, true)
    if (source.chain?.revision !== request.expectedRevision) throw new AgentTeamError('Stale execution-chain plan revision.', 'INVALID_DISPATCH')
    // The system assigns the successor id. Model-supplied fresh ids cannot bypass this receipt.
    const key = createHash('sha256').update(JSON.stringify({
      sourceRunId: source.id, revision: request.expectedRevision,
      assignments: [...request.assignments].sort((a, b) => a.agentId.localeCompare(b.agentId)).map(node => ({
        ...node, dependsOn: [...(node.dependsOn ?? source.plan?.assignments.find(old => old.agentId === node.agentId)?.dependsOn ?? [])].sort(),
      })),
    })).digest('hex')
    const existing = this.continuationCalls.get(source.id)
    if (existing !== undefined) {
      if (existing.key !== key) throw new AgentTeamError('A different continuation is already being admitted for this plan.', 'INVALID_DISPATCH')
      return existing.result
    }
    if (source.continuationReceipt !== undefined) {
      if (source.continuationReceipt.requestKey !== key) throw new AgentTeamError('This plan already has an accepted continuation; inspect that run.', 'INVALID_DISPATCH')
      const accepted = this.runs().get(source.continuationReceipt.runId)
      if (accepted === undefined) throw new AgentTeamError('Continuation was accepted but its run is unavailable. Do not replay side effects; user review is required.', 'INVALID_DISPATCH')
      return this.storedResult(accepted)
    }
    const work = this.admitContinuation(source, request, key, parent, signal)
    this.continuationCalls.set(source.id, { key, result: work })
    try { return await work } finally { this.continuationCalls.delete(source.id) }
  }

  private async admitContinuation(source: SquadRunRecord, request: SquadContinuationRequest, key: string, parent: Agent, signal: AbortSignal): Promise<SquadDispatchResult> {
    const eligibility = this.continuationAvailability(source)
    if (!eligibility.allowed) throw new AgentTeamError(eligibility.reason, 'INVALID_DISPATCH')
    const { plan, affected } = prepareContinuation(source, request)
    const snapshot = source.definitionSnapshot!
    const current = await this.readSquadExecutionSnapshot(source.squadId, signal)
    if (JSON.stringify(current.squad) !== JSON.stringify(snapshot.squad)
      || snapshot.agents.some(item => JSON.stringify(current.agents.get(item.id)) !== JSON.stringify(item.record))) {
      throw new AgentTeamError('Team definitions changed after this run. Review the new permissions and configuration before a new user request.', 'INVALID_DISPATCH')
    }
    throwIfAborted(signal)
    const successor = DispatchId(randomUUID())
    const receipt = { requestKey: key, runId: successor }
    // Commit the receipt before launching work. Even a crash cannot silently reopen admission.
    try { await this.runs().update(source.id, latest => {
      if (latest.continuationReceipt !== undefined || latest.chain?.revision !== request.expectedRevision) {
        throw new AgentTeamError('The source plan already advanced.', 'INVALID_DISPATCH')
      }
      return { ...latest, continuationReceipt: receipt }
    }) } catch (error: unknown) {
      const committed = this.runs().get(source.id)?.continuationReceipt
      if (committed?.runId !== successor || committed.requestKey !== key) throw error
    }
    const chain: ExecutionChain = {
      ...source.chain!, revision: source.chain!.revision + 1, continuationOf: source.id,
      usageBeforeRun: this.chainUsage(source), reason: request.reason, progressReview: request.progressReview,
    }
    return this.dispatch({ squadId: source.squadId, task: source.task, executionMode: source.executionMode, contextMode: source.contextMode }, parent, signal, {
      dispatchId: successor, sessionId: source.sessionId, sourceMessageId: source.sourceMessageId!,
      chain, replayPlan: plan, frozenDefinition: { squad: snapshot.squad, agents: new Map(snapshot.agents.map(item => [item.id, item.record])) },
      reusedMembers: new Map(source.members.filter(member => plan.memberOrder.includes(member.agentId) && !affected.has(member.agentId)).map(member => [member.agentId, member])),
      previousMembers: new Map(source.members.map(member => [member.agentId, member])),
    })
  }

  protected renderSquadContext(result: SquadDispatchResult): string {
    if (result.status === 'skipped') {
      return `The selected squad evaluated this request and intentionally skipped execution: ${result.plan?.reason ?? 'the task does not need the configured team'}. Answer the user directly; do not dispatch the squad again for this message.`
    }
    const bounded = {
      dispatchId: result.dispatchId,
      chain: result.chain,
      continuation: result.continuation,
      squadName: result.squadName,
      status: result.status,
      plan: result.plan === undefined ? undefined : {
        decision: result.plan.decision,
        reason: result.plan.reason,
        summary: result.plan.summary,
        memberOrder: result.plan.memberOrder,
        assignments: result.plan.assignments.map(node => ({ ...node, task: this.boundedExcerpt(node.task, 2_000) })),
      },
      members: result.members.map(member => ({
        agentId: member.agentId,
        agentName: member.agentName,
        status: member.status,
        handoff: member.handoff,
        error: member.error,
        reusedFrom: member.reusedFrom,
        recovery: member.recovery === undefined ? undefined : {
          state: member.recovery.state, decision: member.recovery.decision, error: member.recovery.error,
        },
      })),
      quality: result.quality === undefined ? undefined : {
        approved: result.quality.approved,
        rounds: result.quality.rounds.map(round => ({ round: round.round, approved: round.approved, feedback: round.feedback.slice(0, 2_000) })),
      },
      usage: result.usage,
    }
    return [
      `The selected squad attempt has settled with status "${result.status}". Do not dispatch it again for this user message.`,
      ...(result.status === 'completed' ? [] : [
        'Report the failed or incomplete assignments and their evidence. When continuation.allowed is true, review prior progress and use continue_squad_run with sourceRunId, expectedRevision, reason, progressReview, and revised assignments. Wait until this run has settled. Preserve the original goal and independent successful work; do not silently replace failed members yourself. If blocked or information is missing, explain the blocker and ask the user. Run Center manual retry is a separate explicit replay.',
      ]),
      `Bounded structured squad handoff (full raw output remains in Run Center):`,
      JSON.stringify(bounded),
      '',
      `=== RETROSPECTIVE SYNTHESIS ===`,
      `Produce a structured retrospective for the user. Do not merely repeat the handoffs — analyze what happened and extract actionable lessons.`,
      '',
      `1. SQUAD EXECUTION SUMMARY (回溯执行总结)`,
      `   - What was the original task and what did the squad actually accomplish?`,
      `   - List each member, its assignment, status, and key deliverable in one sentence.`,
      `   - Highlight any member that failed, skipped, or timed out, and explain the impact on the overall result.`,
      '',
      `2. WHAT WENT WELL (做得好的)`,
      `   - Which members delivered high-quality, concrete, or actionable results?`,
      `   - What specific outputs, decisions, or insights were especially valuable?`,
      `   - Were there any unexpected positive outcomes or synergies between members?`,
      '',
      `3. WHAT DID NOT GO WELL (做得不好的)`,
      `   - Which members produced vague, incomplete, or irrelevant handoffs?`,
      `   - Where did the plan assign too much or too little scope to a member?`,
      `   - Were there dependency chains that caused cascading delays or failures?`,
      `   - Did the quality gate catch issues that the original members should have addressed?`,
      '',
      `4. KNOWLEDGE GAP ANALYSIS (知识缺口分析)`,
      `   - For any member that underperformed, classify the likely root cause:`,
      `     a) MISSING REPOSITORY KNOWLEDGE: The member lacked context about the codebase, conventions, architecture, or existing patterns. It could not discover the necessary information because it was not in the prompt, the task context, or accessible files.`,
      `     b) MISSING USER KNOWLEDGE SUPPLEMENT: The user did not provide critical domain knowledge, requirements, constraints, or preferences that the member needed to produce a correct result.`,
      `     c) SCOPE / PLANNING ISSUE: The assignment was too broad, too narrow, or poorly scoped for that member's role and capabilities.`,
      `     d) TOOL / EXECUTION LIMITATION: The member had the right knowledge but could not execute effectively due to tool constraints, model limits, or environment issues.`,
      `   - For each gap found, state it explicitly and name the affected member.`,
      '',
      `5. IMPROVEMENT RECOMMENDATIONS (改进建议)`,
      `   - For each knowledge gap classified as (a) or (b) above, suggest exactly where the missing knowledge should live:`,
      `     * PROGRESSIVE DISCLOSURE (渐进式披露): Should this be added to a project-level context file, an agent preset, a squad collabNote, a member role prompt, or a \`.cursor/rules\` / \`.dsh/rules\` file that gets loaded automatically?`,
      `     * DIRECT DOCUMENTATION: Should the user write a dedicated README, ARCHITECTURE.md, CONTRIBUTING.md, or inline code comments / docstrings?`,
      `     * CONVERSATION CONTEXT: Can the user simply mention this in the next request, or does it need to be persisted?`,
      `   - For scope/planning issues, suggest how the squad's activation policy, member selection, or quality gate could be adjusted.`,
      `   - Be specific: name the exact file, preset, or setting that would close each gap.`,
      '',
      `6. FINAL RETROSPECTIVE SUMMARY (回溯总结)`,
      `   - In 2-3 concise paragraphs, summarize the squad run: what was achieved, the main lessons learned, and the top 1-2 actionable improvements the user should make before the next run.`,
      `   - End with a clear, single-sentence verdict on whether the squad was effective for this task.`,
      '',
      `IMPORTANT: This is a general retrospective format. Apply it to every squad run, regardless of the domain. Even when the run was fully successful, identify what could be sharper next time. The knowledge gap analysis is always relevant — when a member succeeded, note what knowledge it relied on and whether that knowledge is durable.`,
    ].join('\n')
  }

  private addUsage(...samples: Array<AgentTokenUsage | undefined>): AgentTokenUsage {
    return this.usageMeter.add(...samples)
  }

  /** Provider-reported usage for this run only, excluding a fork seed baseline. */
  private usageFor(run: SubagentRun, baseline?: TokenUsageProjection): AgentTokenUsage | undefined {
    return this.usageMeter.usageFor(run, baseline)
  }

  /** Fork children begin with parent history; spawn children have no seed to subtract. */
  private usageBaselineFor(run: SubagentRun): TokenUsageProjection | undefined {
    return this.usageMeter.baselineFor(run)
  }

  private async updateRun(id: DispatchId, update: (record: SquadRunRecord) => SquadRunRecord): Promise<void> {
    if (this.runs().get(id) !== undefined) await this.runs().update(id, update)
  }

  private async updateRunMember(
    dispatchId: DispatchId,
    agentId: AgentId,
    update: (record: SquadRunMember) => SquadRunMember,
  ): Promise<void> {
    await this.updateRun(dispatchId, run => {
      const members = run.members.map(member => member.agentId === agentId ? update(member) : member)
      return {
        ...run,
        members,
        usage: this.addUsage(run.plan?.usage, ...members.map(member => member.usage)),
      }
    })
  }

  /** Stream official token projection changes into the durable live run row. */
  private trackRunUsage(
    dispatchId: DispatchId,
    agentId: AgentId,
    run: SubagentRun,
    baseline: TokenUsageProjection | undefined,
    previousUsage?: AgentTokenUsage,
  ): () => Promise<AgentTokenUsage | undefined> {
    return this.usageMeter.track(
      run,
      baseline,
      usage => this.updateRunMember(dispatchId, agentId, member => ({
        ...member,
        usage: previousUsage === undefined ? usage : this.addUsage(previousUsage, usage),
      })),
      'member',
    )
  }

  /** Stream official projection samples for planner/reviewer/repair work. */
  private trackAuxiliaryUsage(
    dispatchId: DispatchId,
    channel: 'planner' | 'review' | 'repair',
    run: SubagentRun,
    baseline: TokenUsageProjection | undefined,
  ): () => Promise<AgentTokenUsage | undefined> {
    return this.usageMeter.track(
      run,
      baseline,
      usage => this.updateRun(dispatchId, current => ({
          ...current,
          liveUsage: { ...current.liveUsage, [channel]: usage },
      })),
      channel,
    )
  }

  private withoutLiveUsage(run: SquadRunRecord, channel: 'planner' | 'review' | 'repair'): SquadRunRecord {
    if (run.liveUsage === undefined) return run
    const { [channel]: _removed, ...remaining } = run.liveUsage
    if (Object.keys(remaining).length === 0) {
      const { liveUsage: _liveUsage, ...without } = run
      return without
    }
    return { ...run, liveUsage: remaining }
  }

  private async settleRun(
    member: ResolvedMember,
    run: SubagentRun,
    attempts: number,
    startedAt: number,
    handoffSummaryMaxChars: number,
    baseline?: TokenUsageProjection,
  ): Promise<SquadMemberResult> {
    let result: SubagentResult | undefined
    let executionError: unknown
    try {
      result = await run.result
    } catch (error: unknown) {
      executionError = error
    }
    let disposalError: unknown
    try {
      await run.dispose()
    } catch (error: unknown) {
      disposalError = error
    }
    // Some providers publish their final token projection while resolving or
    // disposing the run. Read after both boundaries so the settled attempt
    // does not lose that last sample.
    const usage = this.usageFor(run, baseline)
    const errors: string[] = []
    if (executionError !== undefined) errors.push(`run failed: ${this.errorText(executionError)}`)
    const deliveredText = result === undefined ? '' : this.resultText(result.output).trim()
    const deliveredDespiteProtocolError = result?.stopReason === 'error' && deliveredText !== ''
    if (result !== undefined && result.stopReason !== 'completed' && !deliveredDespiteProtocolError) {
      errors.push(`run ended with stop reason ${result.stopReason}`)
    }
    if (disposalError !== undefined) errors.push(`run cleanup failed: ${this.errorText(disposalError)}`)
    const executionEvidence = this.executionEvidence(run)
    return {
      agentId: member.id,
      agentName: member.record.name,
      status: errors.length === 0 ? 'completed' : 'failed',
      runId: run.id,
      ...run.localAgent === undefined ? {} : { childId: run.localAgent.id },
      ...result === undefined ? {} : { stopReason: result.stopReason },
      output: result?.output ?? [],
      attempts,
      startedAt,
      endedAt: Date.now(),
      ...usage === undefined ? {} : { usage },
      ...errors.length === 0 ? {} : { error: errors.join('; ') },
      ...(executionEvidence === undefined ? {} : { executionEvidence }),
      ...result === undefined ? {} : { handoff: normalizeHandoff(result.structured, deliveredText, handoffSummaryMaxChars) },
    }
  }

  private executionEvidence(run: SubagentRun): string | undefined {
    try {
      const events = run.localAgent?.session.snapshotEvents().filter(event =>
        event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result').slice(-16)
      if (events === undefined || events.length === 0) return undefined
      return this.boundedExcerpt(events.map(event => this.boundedExcerpt(JSON.stringify(event), 1_000)).join('\n'), 12_000)
    } catch { return undefined }
  }

  private async runMember(
    provider: string,
    squad: SquadRecord,
    member: ResolvedMember,
    sharedTask: string,
    chainText: string,
    parent: Agent,
    signal: AbortSignal,
    dispatchId: DispatchId,
    attempt: number,
    route?: { readonly provider: string; readonly model: string },
    persist = true,
    auxiliaryUsage?: 'repair',
  ): Promise<SquadMemberResult> {
    const prompt = this.promptFor(squad, member, sharedTask, chainText)
    const childToolScope = this.childToolScope(member.record, provider, parent)
    const startedAt = Date.now()
    const selectedRoute = route ?? { provider: member.record.provider, model: member.record.model }
    if (persist) await this.updateRunMember(dispatchId, member.id, current => ({
      ...current,
      provider: selectedRoute.provider,
      model: selectedRoute.model,
      status: 'running',
      attempts: attempt,
      startedAt,
    }))
    this.ctx.logger.info(`[agent-team-gui] starting ${squad.name}/${member.record.name}`)
    const timeout = new AbortController()
    const timer = squad.memberTimeoutMs === undefined
      ? undefined
      : setTimeout(() => timeout.abort(new Error(`member timed out after ${squad.memberTimeoutMs}ms`)), squad.memberTimeoutMs)
    const memberSignal = squad.memberTimeoutMs === undefined ? signal : AbortSignal.any([signal, timeout.signal])
    const capabilities = (this.ctx.subagents as unknown as {
      getProvider?(name: string): { readonly capabilities: { readonly outputSchema: boolean; readonly depthLimit: boolean } } | undefined
    }).getProvider?.(provider)?.capabilities
    const handoffSchema = {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        summary: { type: 'string' as const },
        deliverables: { type: 'array' as const, items: { type: 'string' as const } },
        risks: { type: 'array' as const, items: { type: 'string' as const } },
        changedFiles: { type: 'array' as const, items: { type: 'string' as const } },
      },
      required: ['summary', 'deliverables', 'risks', 'changedFiles'],
    }
    try {
      const run = await this.ctx.subagents.start(provider, {
        label: `${squad.name}/${member.record.name}`,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: memberSignal,
        agentOptions: {
          agentTeamGuiChild: true,
          ...(member.record.toolScope?.deny === undefined ? {} : { agentTeamGuiDeniedTools: [...member.record.toolScope.deny] }),
          provider: selectedRoute.provider,
          model: selectedRoute.model,
          ...member.record.maxTokens === undefined ? {} : { maxTokens: member.record.maxTokens },
        },
        ...childToolScope === undefined ? {} : { toolFilter: childToolScope },
        ...member.record.systemPrompt.length === 0 ? {} : { persona: member.record.systemPrompt },
        ...capabilities?.outputSchema === true ? { outputSchema: handoffSchema } : {},
        ...capabilities?.depthLimit === true ? { maxDepth: 1 } : {},
      })
      const baseline = this.usageBaselineFor(run)
      const previousUsage = persist
        ? this.runs().get(dispatchId)?.members.find(item => item.agentId === member.id)?.usage
        : undefined
      const stopUsageTracking = persist
        ? this.trackRunUsage(dispatchId, member.id, run, baseline, previousUsage)
        : auxiliaryUsage === undefined ? async () => undefined : this.trackAuxiliaryUsage(dispatchId, auxiliaryUsage, run, baseline)
      let settled: SquadMemberResult
      let finalAttemptUsage: AgentTokenUsage | undefined
      try {
        settled = await this.settleRun(
          member,
          run,
          attempt,
          startedAt,
          squad.handoffSummaryMaxChars ?? DEFAULT_HANDOFF_SUMMARY_MAX_CHARS,
          baseline,
        )
      } finally {
        finalAttemptUsage = await stopUsageTracking()
      }
      settled = {
        ...settled,
        provider: selectedRoute.provider,
        model: selectedRoute.model,
        ...(finalAttemptUsage === undefined ? {} : { usage: finalAttemptUsage }),
      }
      if (timeout.signal.aborted) settled = { ...settled, status: 'timed-out', error: `member timed out after ${squad.memberTimeoutMs}ms` }
      else if (signal.aborted) settled = { ...settled, status: 'cancelled', error: 'run cancelled' }
      if (persist) await this.updateRunMember(dispatchId, member.id, current => ({
        ...current,
        status: settled.status,
        attempts: settled.attempts,
        ...(settled.endedAt === undefined ? {} : { endedAt: settled.endedAt }),
        ...(settled.runId === undefined ? {} : { runId: settled.runId }),
        ...(settled.childId === undefined ? {} : { childId: settled.childId }),
        ...(settled.stopReason === undefined ? {} : { stopReason: settled.stopReason }),
        output: settled.output,
        ...(settled.error === undefined ? {} : { error: settled.error }),
        ...settled.usage === undefined && previousUsage === undefined
          ? {}
          : { usage: this.addUsage(previousUsage, settled.usage) },
        usageSamples: {
          metered: (current.usageSamples?.metered ?? 0) + (settled.usage?.providerReported === true ? 1 : 0),
          total: (current.usageSamples?.total ?? 0) + 1,
        },
        attemptUsage: [...(current.attemptUsage ?? []), {
          attempt,
          provider: selectedRoute.provider,
          model: selectedRoute.model,
          ...(settled.usage === undefined ? {} : { usage: settled.usage }),
        }],
        ...(settled.handoff === undefined ? {} : { handoff: settled.handoff }),
      }))
      this.ctx.logger.info(`[agent-team-gui] finished ${squad.name}/${member.record.name}: ${settled.status}`)
      return settled
    } catch (error: unknown) {
      const message = this.errorText(error)
      this.ctx.logger.warn(`[agent-team-gui] failed ${squad.name}/${member.record.name}: ${message}`)
      const failed: SquadMemberResult = {
        agentId: member.id,
        agentName: member.record.name,
        status: timeout.signal.aborted ? 'timed-out' : signal.aborted ? 'cancelled' : 'failed',
        output: [],
        attempts: attempt,
        provider: selectedRoute.provider,
        model: selectedRoute.model,
        startedAt,
        endedAt: Date.now(),
        error: `start failed: ${message}`,
      }
      if (persist) await this.updateRunMember(dispatchId, member.id, current => ({
        ...current,
        status: timeout.signal.aborted ? 'timed-out' : signal.aborted ? 'cancelled' : 'failed',
        attempts: attempt,
        ...(failed.endedAt === undefined ? {} : { endedAt: failed.endedAt }),
        ...(failed.error === undefined ? {} : { error: failed.error }),
        usageSamples: {
          metered: current.usageSamples?.metered ?? 0,
          total: (current.usageSamples?.total ?? 0) + 1,
        },
        attemptUsage: [...(current.attemptUsage ?? []), {
          attempt,
          provider: selectedRoute.provider,
          model: selectedRoute.model,
        }],
      }))
      return failed
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Preserve configured restrictions while hard-denying recursive team/delegation tools when present. */
  private childToolScope(record: AgentRecord, provider: string, parent: Agent): AgentRecord['toolScope'] | undefined {
    const runtime = this.ctx.subagents as unknown as {
      getProvider?(name: string): { readonly capabilities: { readonly toolFilter: boolean; readonly depthLimit: boolean } } | undefined
    }
    const capabilities = runtime.getProvider?.(provider)?.capabilities
    if (capabilities === undefined || capabilities.toolFilter === false || capabilities.depthLimit === false) {
      throw new AgentTeamError(`subagent provider "${provider}" cannot enforce the recursive-tool deny list and depth limit`, 'INVALID_DISPATCH')
    }
    const schemas = this.ctx.tools.schemas(parent)
    const globalSchemas = this.ctx.tools.schemas()
    const restrictable = new Set(globalSchemas.map(tool => tool.name).filter(name => name !== 'run_code'))
    const known = new Set(schemas.map(tool => tool.name))
    const unknownAllowed = (record.toolScope?.allow ?? []).filter(name => !known.has(name))
    if (unknownAllowed.length > 0) {
      throw new AgentTeamError(`member tool allow-list is unavailable in this session: ${unknownAllowed.join(', ')}`, 'INVALID_DISPATCH')
    }
    const recursiveTools = new Set([...globalSchemas, ...schemas].filter(isDelegationTool).map(tool => tool.name))
    // DSH validates deny entries against its global registry. A parent's
    // scope-local alias is not necessarily restrictable by a child. Preserve
    // scoped allows, and enforce recursive aliases with the execution guard.
    const deny = new Set([...record.toolScope?.deny ?? [], ...recursiveTools].filter(name => restrictable.has(name)))
    const allow = record.toolScope?.allow
    const recursiveAllowed = allow?.filter(name => recursiveTools.has(name) || deny.has(name)) ?? []
    if (recursiveAllowed.length > 0) {
      throw new AgentTeamError(`member tool allow-list cannot expose recursive delegation tools: ${recursiveAllowed.join(', ')}`, 'INVALID_DISPATCH')
    }
    if (allow === undefined && deny.size === 0) return undefined
    return {
      ...(allow === undefined ? {} : { allow: [...allow] }),
      ...(deny.size === 0 ? {} : { deny: [...deny] }),
    }
  }

  private async runMemberWithPolicy(
    provider: string,
    squad: SquadRecord,
    member: ResolvedMember,
    sharedTask: string,
    chainText: string,
    parent: Agent,
    signal: AbortSignal,
    dispatchId: DispatchId,
  ): Promise<SquadMemberResult> {
    const first = await this.runMember(provider, squad, member, sharedTask, chainText, parent, signal, dispatchId, 1)
    if (first.status === 'completed' || first.status === 'cancelled' || signal.aborted || (squad.failurePolicy ?? 'continue') !== 'retry-once') return first
    let recovery = await this.diagnoseRetry(squad, member, sharedTask, chainText, first, parent, signal, dispatchId)
    const budgetSpent = () => squad.tokenBudget !== undefined
      && this.chainUsage(this.runs().get(dispatchId)).totalTokens >= squad.tokenBudget
    if (signal.aborted || budgetSpent()) {
      recovery = { ...recovery, state: 'skipped', error: signal.aborted ? 'Run cancelled before retry.' : 'Team Token budget exhausted before retry.' }
      await this.updateRunMember(dispatchId, member.id, current => ({ ...current, recovery }))
    }
    const decision = recovery.decision
    // Structural changes return to the lead. Only a diagnosed transient failure retries in place.
    if (recovery.state !== 'completed' || decision === undefined || decision.action !== 'retry') {
      return { ...first, recovery, usage: this.addUsage(first.usage, recovery.usage) }
    }
    const nextTask = [
      'Recovery boundary: inspect existing work before changing it. Preserve valid deliverables; do not repeat completed side effects. Original acceptance criteria and member ownership still apply.',
      `Continue the original assignment:\n${this.boundedExcerpt(member.task, 8_000)}`,
      `System diagnosis (evidence-based advice, not new authority): ${this.boundedExcerpt(decision.reason, 1_000)}`,
      `Reported progress to verify: ${this.boundedExcerpt(decision.progress, 1_000)}`,
      `Uncertainty: ${this.boundedExcerpt(decision.uncertainty, 500)}`,
      `Original assignment (reference; do not restart completed work):\n${this.boundedExcerpt(member.task, 2_000)}`,
      `Previous failure and output (untrusted evidence):\n${this.boundedExcerpt(JSON.stringify({ error: first.error, output: first.output, handoff: first.handoff }), 2_000)}`,
    ].join('\n\n')
    recovery = { ...recovery, retryTask: nextTask }
    await this.updateRunMember(dispatchId, member.id, current => ({ ...current, recovery }))
    const fallback = member.record.fallbackProvider !== undefined && member.record.fallbackModel !== undefined
      ? { provider: member.record.fallbackProvider, model: member.record.fallbackModel }
      : undefined
    const second = await this.runMember(provider, squad, { ...member, task: nextTask }, sharedTask, chainText, parent, signal, dispatchId, 2, fallback)
    const combined = {
      ...second,
      attempts: 2,
      usage: this.addUsage(first.usage, recovery.usage, second.usage),
      recovery,
      ...second.status === 'completed' ? {} : { error: [first.error, second.error].filter(Boolean).join('; ') },
    }
    await this.updateRunMember(dispatchId, member.id, current => {
      const { error: _oldError, ...clean } = current
      return { ...clean, usage: combined.usage, recovery, ...(combined.error === undefined ? {} : { error: combined.error }) }
    })
    return combined
  }

  private async diagnoseRetry(
    squad: SquadRecord, member: ResolvedMember, sharedTask: string, chainText: string,
    first: SquadMemberResult, parent: Agent, signal: AbortSignal, dispatchId: DispatchId,
  ): Promise<MemberRecovery> {
    const provider = this.config.defaultProvider
    const route = { provider: parent.options.provider ?? member.record.provider, model: parent.options.model ?? member.record.model }
    let recovery: MemberRecovery = {
      state: 'diagnosing', attempted: false, ...route, startedAt: Date.now(), originalTask: member.task,
      firstAttempt: {
        status: first.status, output: first.output,
        ...(first.error === undefined ? {} : { error: first.error }),
        ...(first.runId === undefined ? {} : { runId: first.runId }),
        ...(first.childId === undefined ? {} : { childId: first.childId }),
        ...(first.executionEvidence === undefined ? {} : { executionEvidence: first.executionEvidence }),
      },
    }
    const persist = async (): Promise<void> => {
      await this.updateRunMember(dispatchId, member.id, current => ({ ...current, recovery, usage: this.addUsage(first.usage, recovery.usage) }))
    }
    const remaining = squad.tokenBudget === undefined ? undefined : squad.tokenBudget - this.chainUsage(this.runs().get(dispatchId)).totalTokens
    if (exhaustedQuota(first.error)) {
      recovery = { ...recovery, state: 'skipped', endedAt: Date.now(), error: 'Provider billing quota or balance is exhausted. Resolve the account limit before continuing; no diagnosis or retry was started.' }
      await persist()
      return recovery
    }
    if (signal.aborted || (remaining !== undefined && remaining <= 0)) {
      recovery = { ...recovery, state: 'skipped', endedAt: Date.now(), error: signal.aborted ? 'Run cancelled.' : 'Team Token budget exhausted before diagnosis.' }
      await persist()
      return recovery
    }
    // Only explicit startup refusal/DNS failures with no returned execution evidence are
    // classified directly. Mid-run disconnects can have side effects and need diagnosis.
    if (first.runId === undefined && first.childId === undefined && first.output.length === 0
      && first.executionEvidence === undefined && /^start failed:.*\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/s.test(first.error ?? '')) {
      recovery = { ...recovery, state: 'completed', endedAt: Date.now(), decision: {
        action: 'retry', cause: 'transient', confidence: 'supported', reason: 'Explicit startup connection/DNS failure before a child run was returned.',
        evidence: [first.error!.slice(0, 1_000)], progress: 'No child execution result was returned. Check existing artifacts before making changes.', nextTask: '',
        uncertainty: 'Startup failure does not prove that every external provider is free of side effects.',
      } }
      await persist()
      return recovery
    }
    await persist()
    const timeout = new AbortController()
    const timeoutMs = Math.min(squad.memberTimeoutMs ?? 60_000, 60_000)
    const timer = setTimeout(() => timeout.abort(new Error('Recovery diagnosis timed out.')), timeoutMs)
    const diagnosisSignal = AbortSignal.any([signal, timeout.signal])
    let run: SubagentRun | undefined
    let baseline: TokenUsageProjection | undefined
    let stopTracking: (() => Promise<AgentTokenUsage | undefined>) | undefined
    let finished = false
    const finish = async (): Promise<void> => {
      if (finished) return
      finished = true
      try { await run?.dispose() } finally {
        const usage = await stopTracking?.() ?? (run === undefined ? undefined : this.usageFor(run, baseline))
        if (usage !== undefined) recovery = { ...recovery, usage }
      }
    }
    try {
      const capabilities = this.ctx.subagents.getProvider(provider)?.capabilities
      if (!capabilities?.outputSchema || !capabilities.toolFilter || !capabilities.depthLimit) {
        throw new Error(`Recovery provider "${provider}" cannot enforce structured, tool-free diagnosis.`)
      }
      recovery = { ...recovery, attempted: true }
      await persist()
      throwIfAborted(diagnosisSignal)
      run = await this.ctx.subagents.start(provider, {
        label: `${squad.name}/System retry diagnosis/${member.record.name}`,
        parent, signal: diagnosisSignal,
        agentOptions: { ...route, agentTeamGuiChild: true, agentTeamGuiDiagnosis: true, maxTokens: Math.min(2_048, remaining ?? 2_048) },
        toolFilter: { allow: [] }, maxDepth: 1, outputSchema: retryDiagnosisOutputSchema,
        ...(capabilities.persona ? { persona: RETRY_DIAGNOSIS_CONTRACT } : {}),
        prompt: [{ type: 'text', text: [
          RETRY_DIAGNOSIS_CONTRACT,
          `Original goal:\n${this.boundedExcerpt(sharedTask, 12_000)}`,
          `Member role:\n${this.boundedExcerpt(member.record.systemPrompt, 4_000)}`,
          `Original assignment:\n${this.boundedExcerpt(member.task, 12_000)}`,
          `Dependency handoffs:\n${this.boundedExcerpt(chainText, 8_000)}`,
          `Failed attempt evidence:\n${this.boundedExcerpt(JSON.stringify({
            status: first.status, error: first.error, stopReason: first.stopReason, output: first.output,
            handoff: first.handoff, startedAt: first.startedAt, endedAt: first.endedAt, usage: first.usage,
            executionEvidence: first.executionEvidence,
          }), 16_000)}`,
          `Limits: memberTimeoutMs=${squad.memberTimeoutMs ?? 'unset'}, memberMaxTokens=${member.record.maxTokens ?? 'provider default'}, remainingReportedTeamTokens=${remaining ?? 'unset'}. Unreported usage is unknown, not zero.`,
        ].join('\n\n') }],
      })
      recovery = { ...recovery, runId: run.id, ...(run.localAgent === undefined ? {} : { childId: run.localAgent.id }) }
      baseline = this.usageBaselineFor(run)
      stopTracking = this.usageMeter.track(run, baseline, async usage => {
        recovery = { ...recovery, usage }
        await persist()
      }, 'retry diagnosis')
      const result = await run.result
      await finish()
      throwIfAborted(diagnosisSignal)
      if (result.stopReason !== 'completed') throw new Error(`Recovery diagnosis ended with ${result.stopReason}.`)
      const decision = retryDecisionSchema.parse(result.structured)
      if (decision.action === 'revise' && decision.nextTask.trim() === member.task.trim()) throw new Error('Diagnosis returned an unchanged assignment as a revision.')
      recovery = { ...recovery, state: 'completed', decision, endedAt: Date.now() }
    } catch (error: unknown) {
      await finish().catch(() => undefined)
      recovery = { ...recovery, state: 'failed', endedAt: Date.now(), error: this.errorText(error) }
    } finally {
      clearTimeout(timer)
      await finish().catch(() => undefined)
    }
    await persist()
    return recovery
  }

  private async createAutomaticPlan(
    squad: SquadRecord,
    agents: ReadonlyMap<AgentId, AgentRecord>,
    task: string,
    parent: Agent,
    signal: AbortSignal,
    useMainAgent: boolean,
    effectiveExecutionMode: 'serial' | 'parallel',
    dispatchId?: DispatchId,
  ): Promise<SquadExecutionPlan | undefined> {
    if (squad.executionOrder !== undefined) return undefined
    const leader = squad.leaderAgentId === undefined ? undefined : agents.get(squad.leaderAgentId)
    if (!useMainAgent && leader === undefined) return undefined
    const planningContext = squad.planningContext ?? 'full'
    // `fork` is the official full-history seam. Current/recent use a fresh
    // one-shot child on the same model route and receive only bounded text.
    const provider = planningContext === 'full' ? 'fork' : this.config.defaultProvider
    const planner = useMainAgent ? 'main-agent' as const : 'squad-leader' as const
    const plannerProvider = useMainAgent ? parent.options.provider : leader?.provider
    const plannerModel = useMainAgent ? parent.options.model : leader?.model
    const plannerAgentOptions = {
      agentTeamGuiChild: true,
      ...(plannerProvider === undefined ? {} : { provider: plannerProvider }),
      ...(plannerModel === undefined ? {} : { model: plannerModel }),
      maxTokens: squad.plannerMaxTokens ?? 2_048,
    }
    const memberIds = squad.members.map(String)
    const outputSchema = {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        decision: { type: 'string' as const, enum: ['run', 'skip'] },
        reason: { type: 'string' as const },
        summary: { type: 'string' as const },
        memberOrder: { type: 'array' as const, items: { type: 'string' as const, enum: memberIds } },
        assignments: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              agentId: { type: 'string' as const, enum: memberIds },
              task: { type: 'string' as const },
              dependsOn: { type: 'array' as const, items: { type: 'string' as const, enum: memberIds } },
            },
            required: ['agentId', 'task', 'dependsOn'],
          },
        },
      },
      required: ['decision', 'reason', 'summary', 'memberOrder', 'assignments'],
    }
    let run: SubagentRun | undefined
    let baseline: TokenUsageProjection | undefined
    let stopUsageTracking: (() => Promise<AgentTokenUsage | undefined>) | undefined
    let trackingStopped = false
    let runDisposed = false
    const finishPlannerUsage = async (): Promise<AgentTokenUsage | undefined> => {
      if (run !== undefined && !runDisposed) {
        runDisposed = true
        await run.dispose()
      }
      let tracked: AgentTokenUsage | undefined
      if (stopUsageTracking !== undefined && !trackingStopped) {
        trackingStopped = true
        tracked = await stopUsageTracking()
      }
      return tracked ?? (run === undefined ? undefined : this.usageFor(run, baseline))
    }
    const runtime = this.ctx.subagents as unknown as {
      getProvider?(name: string): { readonly capabilities: { readonly outputSchema: boolean; readonly toolFilter: boolean; readonly depthLimit: boolean; readonly persona: boolean } } | undefined
    }
    const capabilities = runtime.getProvider?.(provider)?.capabilities
    const plannerToolScope = capabilities?.toolFilter === false
      ? undefined
      : { allow: [] as string[] }
    const recentContext = planningContext !== 'recent' ? '' : parent.session.snapshotEvents().slice(-80).flatMap((event) => {
      if (event.type === 'user/message') return [`USER: ${this.resultText(event.data.content).slice(0, 2_000)}`]
      if (event.type === 'assistant/message') return [`ASSISTANT: ${this.resultText(event.data.message.content).slice(0, 2_000)}`]
      return []
    }).slice(-6).join('\n')
    const memberCatalog = this.boundedExcerpt(squad.members.map((id) => {
      const record = agents.get(id)
      const allow = this.boundedExcerpt(record?.toolScope?.allow?.join(', ') ?? 'all tools except denied tools', 2_000)
      const deny = this.boundedExcerpt(record?.toolScope?.deny?.join(', ') ?? 'none configured', 2_000)
      return [
        `- id=${id}; name=${record?.name ?? 'missing'}; model=${record?.provider ?? 'missing'}/${record?.model ?? 'missing'}`,
        `  role=${this.boundedExcerpt(record?.systemPrompt?.trim() || 'No role description configured.', 2_000)}`,
        `  tools: allow=${allow}; deny=${deny}`,
      ].join('\n')
    }).join('\n'), 40_000)
    const planningContract = [
      'Planning contract (must follow): create a plan only; never execute work, call tools, dispatch teams, or create subagents.',
      `${(squad.activationMode ?? 'always') === 'smart' ? 'You may return decision="skip" only for a trivial acknowledgement/format-only request or work clearly outside this team; explain why.' : 'Return decision="run".'}`,
      `${(squad.memberSelectionMode ?? 'all') === 'all' ? `Use all ${squad.members.length} configured members exactly once.` : 'Select the smallest non-empty subset of members needed.'}`,
      'For a run decision, return one concrete role-specific assignment per selected member and dependencies only on other selected members.',
      'Split ownership so members do not all solve the entire request. Dependencies must form an acyclic graph and memberOrder must be a valid stable topological order.',
      'The main Agent synthesizes bounded handoffs; name each expected deliverable and boundary.',
    ].join(' ')
    const plannerPrompt = [
      planningContract,
      `Configured member identities and capabilities (bounded):\n${memberCatalog}`,
      ...(squad.collabNote ?? '').trim().length === 0 ? [] : [`Team collaboration rule (bounded):\n${this.boundedExcerpt(squad.collabNote!, 8_000)}`],
      ...(recentContext === '' ? [] : [`Recent bounded conversation context (reference only):\n${this.boundedExcerpt(recentContext, 12_000)}`]),
      `User request (bounded head/tail excerpt; plan against this request):\n${this.boundedExcerpt(task, 24_000)}`,
    ].join('\n\n')
    try {
      if (capabilities === undefined || !capabilities.outputSchema || !capabilities.toolFilter || !capabilities.depthLimit) {
        throw new Error(`planner provider "${provider}" cannot enforce structured, tool-filtered, depth-bounded planning`)
      }
      run = await this.ctx.subagents.start(provider, {
        label: `${squad.name}/${useMainAgent ? 'Main workflow planner' : 'Squad leader planner'}`,
        parent,
        signal,
        prompt: [{ type: 'text', text: plannerPrompt }],
        outputSchema,
        ...Object.keys(plannerAgentOptions).length === 0 ? {} : { agentOptions: plannerAgentOptions },
        ...plannerToolScope === undefined ? {} : { toolFilter: plannerToolScope },
        maxDepth: 1,
        ...capabilities?.persona === false ? {} : { persona: useMainAgent
          ? 'You are the main Agent\'s workflow planner. Produce only a concise, executable division of work. Do not execute the task, call tools, dispatch teams, or create subagents.'
          : `${leader?.systemPrompt ?? ''}\nYou are the fallback squad leader planner. Produce only a concise executable division of work. Do not execute the task, call tools, dispatch teams, or create subagents.` },
      })
      baseline = this.usageBaselineFor(run)
      if (dispatchId !== undefined) stopUsageTracking = this.trackAuxiliaryUsage(dispatchId, 'planner', run, baseline)
      const result = await run.result
      const usage = await finishPlannerUsage()
      const structured = result.structured as { decision?: unknown; reason?: unknown; summary?: unknown; memberOrder?: unknown; assignments?: unknown } | undefined
      if (result.stopReason !== 'completed' || structured === undefined
        || (structured.decision !== 'run' && structured.decision !== 'skip')
        || typeof structured.reason !== 'string' || typeof structured.summary !== 'string' || !Array.isArray(structured.memberOrder)
        || !Array.isArray(structured.assignments)) throw new Error(`planner ended without a valid plan (${result.stopReason})`)
      const order = structured.memberOrder.map(String).map(AgentId)
      const assignments = structured.assignments.map((raw) => {
        const value = raw as { agentId?: unknown; task?: unknown; dependsOn?: unknown }
        if (typeof value.agentId !== 'string' || typeof value.task !== 'string' || value.task.trim().length === 0 || !Array.isArray(value.dependsOn)) {
          throw new Error('planner assignment is invalid or empty')
        }
        return { agentId: AgentId(value.agentId), task: value.task.trim(), dependsOn: value.dependsOn.map(String).map(AgentId) }
      })
      return validateExecutionPlan({
        decision: structured.decision,
        reason: structured.reason,
        summary: structured.summary,
        memberOrder: order,
        assignments,
        planner,
        ...(plannerProvider === undefined ? {} : { plannerProvider }),
        ...(plannerModel === undefined ? {} : { plannerModel }),
        ...planner === 'squad-leader' && squad.leaderAgentId !== undefined
          ? { leaderAgentId: squad.leaderAgentId }
          : {},
        ...usage === undefined ? {} : { usage },
      }, squad, {
        requireAllMembers: (squad.memberSelectionMode ?? 'all') === 'all',
        allowSkip: (squad.activationMode ?? 'always') === 'smart',
      })
    } catch (error: unknown) {
      const usage = await finishPlannerUsage().catch(() => run === undefined ? undefined : this.usageFor(run, baseline))
      const fallback = deterministicExecutionPlan(squad, task, agents, this.errorText(error), effectiveExecutionMode)
      return {
        ...fallback,
        ...(plannerProvider === undefined ? {} : { plannerProvider }),
        ...(plannerModel === undefined ? {} : { plannerModel }),
        ...usage === undefined ? {} : { usage },
      }
    } finally {
      await finishPlannerUsage().catch(() => undefined)
    }
  }

  private async runQualityReview(
    squad: SquadRecord,
    reviewer: ResolvedMember,
    sharedTask: string,
    memberResults: readonly SquadMemberResult[],
    parent: Agent,
    signal: AbortSignal,
    round: number,
    dispatchId: DispatchId,
  ): Promise<{ readonly result: SquadMemberResult; readonly approved: boolean; readonly feedback: string }> {
    const startedAt = Date.now()
    const provider = squad.contextMode === 'fork' ? 'fork' : this.config.defaultProvider
    const runtime = this.ctx.subagents as unknown as {
      getProvider?(name: string): { readonly capabilities: { readonly outputSchema: boolean; readonly toolFilter: boolean; readonly depthLimit: boolean; readonly persona: boolean } } | undefined
    }
    const capabilities = runtime.getProvider?.(provider)?.capabilities
    if (capabilities === undefined || !capabilities.outputSchema || !capabilities.toolFilter || !capabilities.depthLimit) {
      const error = `quality reviewer provider "${provider}" cannot enforce structured, tool-filtered, depth-bounded review`
      return {
        approved: false, feedback: error,
        result: {
          agentId: reviewer.id, agentName: reviewer.record.name, status: 'failed', output: [], attempts: round,
          provider: reviewer.record.provider, model: reviewer.record.model, startedAt, endedAt: Date.now(), error,
        },
      }
    }
    const timeout = new AbortController()
    const timer = squad.memberTimeoutMs === undefined ? undefined : setTimeout(
      () => timeout.abort(new Error(`quality review timed out after ${squad.memberTimeoutMs}ms`)),
      squad.memberTimeoutMs,
    )
    const reviewSignal = squad.memberTimeoutMs === undefined ? signal : AbortSignal.any([signal, timeout.signal])
    let run: SubagentRun | undefined
    let baseline: TokenUsageProjection | undefined
    let stopUsageTracking: (() => Promise<AgentTokenUsage | undefined>) | undefined
    let trackingStopped = false
    let runDisposed = false
    const finishReviewUsage = async (): Promise<AgentTokenUsage | undefined> => {
      if (run !== undefined && !runDisposed) {
        runDisposed = true
        await run.dispose()
      }
      let tracked: AgentTokenUsage | undefined
      if (stopUsageTracking !== undefined && !trackingStopped) {
        trackingStopped = true
        tracked = await stopUsageTracking()
      }
      return tracked ?? (run === undefined ? undefined : this.usageFor(run, baseline))
    }
    try {
      run = await this.ctx.subagents.start(provider, {
        label: `${squad.name}/Quality review ${round}`,
        parent,
        signal: reviewSignal,
        prompt: [{ type: 'text', text: [
          'Review contract: return only a bounded verdict. Do not repair, call tools, dispatch teams, or create subagents.',
          `Quality criteria:\n${squad.qualityGate?.criteria?.trim() || 'Correct, complete, internally consistent, and supported by the reported deliverables.'}`,
          `Bounded handoffs:\n${boundedHandoffChain(memberResults, 32_000)}`,
          'Return approved=true only if no repair is required. Feedback must be concrete and bounded. Do not do the repair, call tools, dispatch teams, or create subagents.',
          `Original goal (bounded head/tail excerpt):\n${this.boundedExcerpt(sharedTask, 24_000)}`,
        ].join('\n\n') }],
        agentOptions: {
          provider: reviewer.record.provider,
          agentTeamGuiChild: true,
          model: reviewer.record.model,
          maxTokens: reviewer.record.maxTokens ?? 2_048,
        },
        outputSchema: {
          type: 'object', additionalProperties: false,
          properties: { approved: { type: 'boolean' }, feedback: { type: 'string' } },
          required: ['approved', 'feedback'],
        },
        toolFilter: { allow: [] as string[] },
        maxDepth: 1,
        ...capabilities?.persona === false ? {} : { persona: reviewer.record.systemPrompt },
      })
      baseline = this.usageBaselineFor(run)
      stopUsageTracking = this.trackAuxiliaryUsage(dispatchId, 'review', run, baseline)
      const settled = await run.result
      const usage = await finishReviewUsage()
      const structured = settled.structured as { approved?: unknown; feedback?: unknown } | undefined
      if (settled.stopReason !== 'completed' || typeof structured?.approved !== 'boolean' || typeof structured.feedback !== 'string') {
        throw new Error(`quality reviewer ended without a valid verdict (${settled.stopReason})`)
      }
      const status = timeout.signal.aborted ? 'timed-out' : signal.aborted ? 'cancelled' : 'completed'
      const feedback = structured.feedback.slice(0, 8_000)
      return {
        approved: status === 'completed' && structured.approved,
        feedback,
        result: {
          agentId: reviewer.id, agentName: reviewer.record.name, status,
          provider: reviewer.record.provider,
          model: reviewer.record.model,
          runId: run.id,
          ...run.localAgent === undefined ? {} : { childId: run.localAgent.id },
          stopReason: settled.stopReason,
          output: settled.output,
          attempts: round,
          startedAt,
          endedAt: Date.now(),
          ...usage === undefined ? {} : { usage },
          handoff: { summary: feedback || 'Quality review completed.', deliverables: [], risks: structured.approved ? [] : [feedback], changedFiles: [] },
        },
      }
    } catch (error: unknown) {
      const status = timeout.signal.aborted ? 'timed-out' : signal.aborted ? 'cancelled' : 'failed'
      const feedback = this.errorText(error)
      const usage = await finishReviewUsage().catch(() => run === undefined ? undefined : this.usageFor(run, baseline))
      return {
        approved: false, feedback,
        result: {
          agentId: reviewer.id, agentName: reviewer.record.name, status, output: [], attempts: round,
          provider: reviewer.record.provider, model: reviewer.record.model,
          startedAt, endedAt: Date.now(), error: feedback,
          ...usage === undefined ? {} : { usage },
        },
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      await finishReviewUsage().catch(() => undefined)
    }
  }

  private async runQualityLoop(
    squad: SquadRecord,
    agents: ReadonlyMap<AgentId, AgentRecord>,
    sharedTask: string,
    memberResults: SquadMemberResult[],
    parent: Agent,
    signal: AbortSignal,
    dispatchId: DispatchId,
    usageBeforeQuality: AgentTokenUsage,
  ): Promise<SquadQualityResult | undefined> {
    const gate = squad.qualityGate
    if (gate === undefined || signal.aborted || memberResults.length === 0) return undefined
    const reviewerRecord = agents.get(gate.reviewerAgentId)
    const repairRecord = agents.get(gate.repairAgentId)
    if (reviewerRecord === undefined || repairRecord === undefined) return undefined
    const reviewer: ResolvedMember = { id: gate.reviewerAgentId, record: reviewerRecord, task: '' }
    const repair: ResolvedMember = { id: gate.repairAgentId, record: repairRecord, task: '' }
    const rounds: SquadQualityRound[] = []
    let current = memberResults
    let consumed = usageBeforeQuality
    for (let index = 0; index <= gate.maxRounds; index += 1) {
      if (signal.aborted || (squad.tokenBudget !== undefined && consumed.totalTokens >= squad.tokenBudget)) break
      await this.updateRun(dispatchId, run => ({
        ...run,
        phase: 'quality-review',
        usage: consumed,
        quality: { approved: false, rounds: [...rounds] },
        qualityProgress: {
          round: index + 1,
          maxRepairRounds: gate.maxRounds,
          totalReviews: gate.maxRounds + 1,
          reviewerAgentId: gate.reviewerAgentId,
          repairAgentId: gate.repairAgentId,
          state: 'reviewing',
        },
      }))
      const reviewed = await this.runQualityReview(squad, reviewer, sharedTask, current, parent, signal, index + 1, dispatchId)
      await this.updateRun(dispatchId, run => this.withoutLiveUsage(run, 'review'))
      consumed = this.addUsage(consumed, reviewed.result.usage)
      const entry: SquadQualityRound = { round: index + 1, approved: reviewed.approved, feedback: reviewed.feedback, reviewer: reviewed.result }
      if (reviewed.approved || reviewed.result.status !== 'completed' || index === gate.maxRounds
        || signal.aborted || (squad.tokenBudget !== undefined && consumed.totalTokens >= squad.tokenBudget)) {
        rounds.push(entry)
        await this.updateRun(dispatchId, run => ({ ...run, usage: consumed, quality: { approved: reviewed.approved, rounds: [...rounds] } }))
        break
      }
      await this.updateRun(dispatchId, run => ({
        ...run,
        phase: 'quality-repair',
        usage: consumed,
        quality: { approved: false, rounds: [...rounds, entry] },
        qualityProgress: {
          round: index + 1,
          maxRepairRounds: gate.maxRounds,
          totalReviews: gate.maxRounds + 1,
          reviewerAgentId: gate.reviewerAgentId,
          repairAgentId: gate.repairAgentId,
          state: 'repairing',
        },
      }))
      const repairTask = `Repair only the quality issues below. Preserve valid work and return a bounded handoff.\n\n${reviewed.feedback}`
      const repaired = await this.runMember(
        squad.contextMode === 'fork' ? 'fork' : this.config.defaultProvider,
        squad,
        { ...repair, task: repairTask },
        sharedTask,
        boundedHandoffChain(current),
        parent,
        signal,
        dispatchId,
        index + 1,
        undefined,
        false,
        'repair',
      )
      await this.updateRun(dispatchId, run => this.withoutLiveUsage(run, 'repair'))
      rounds.push({ ...entry, repair: repaired })
      await this.updateRun(dispatchId, run => ({ ...run, quality: { approved: false, rounds: [...rounds] } }))
      consumed = this.addUsage(consumed, repaired.usage)
      await this.updateRun(dispatchId, run => ({ ...run, usage: consumed }))
      if (repaired.status !== 'completed') break
      current = [...current, repaired]
    }
    return { approved: rounds.at(-1)?.approved ?? false, rounds }
  }

  /**
   * Dispatch through the existing subagent providers. Parent `tool/call` and
   * `tool/result` records contain this complete result, while each returned
   * child id points to the provider-owned child Session and its descriptor.
   */
  async dispatch(
    request: SquadDispatchRequest,
    parent: Agent,
    signal: AbortSignal,
    trace: DispatchTrace = {},
  ): Promise<SquadDispatchResult> {
    if (this.isDelegatedAgent(parent)) {
      throw new AgentTeamError('nested squad dispatch is blocked for delegated child sessions', 'INVALID_DISPATCH')
    }
    if (request.task.trim().length === 0) {
      throw new AgentTeamError('dispatch task must not be empty', 'INVALID_DISPATCH')
    }
    if (request.task.length > 100_000 || (request.assignments?.length ?? 0) > 32 || (request.memberOrder?.length ?? 0) > 32
      || request.assignments?.some(item => item.task.length > 100_000) === true) {
      throw new AgentTeamError('dispatch input exceeds the bounded task/member limits', 'INVALID_DISPATCH')
    }
    const definitionSnapshot = trace.frozenDefinition
      ?? await this.readSquadExecutionSnapshot(request.squadId, signal)
    const squad = definitionSnapshot.squad
    const agents = definitionSnapshot.agents
    if (squad === undefined) {
      throw new AgentTeamError(`squad "${request.squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    if (squad.members.length === 0) {
      throw new AgentTeamError(`squad "${request.squadId}" has no members`, 'INVALID_DISPATCH')
    }
    const executionMode = request.executionMode
      ?? squad.executionMode
      ?? (squad.executionOrder === undefined ? this.config.defaultExecutionMode : 'serial')
    const contextMode = request.contextMode ?? squad.contextMode ?? this.config.defaultContextMode
    if (squad.executionOrder !== undefined && executionMode === 'parallel') {
      throw new AgentTeamError('a squad with executionOrder requires serial execution', 'INVALID_DISPATCH')
    }
    if (executionMode === 'parallel' && contextMode === 'chain') {
      throw new AgentTeamError('contextMode "chain" requires serial execution', 'INVALID_DISPATCH')
    }
    // Reject malformed caller overrides before creating a durable run record.
    this.resolveMembers(squad, request.assignments, request.memberOrder, agents)
    if (trace.selectedAgentIds !== undefined && trace.selectedAgentIds.some(id => !squad.members.includes(id))) {
      throw new AgentTeamError('retry selection contains a non-member agent', 'INVALID_DISPATCH')
    }
    const replayPlan = trace.replayPlan === undefined ? undefined : validateExecutionPlan(
      structuredClone(trace.replayPlan),
      squad,
      { requireAllMembers: false, allowSkip: true },
    )
    const activeKey = `${parent.id}\u0000${request.squadId}\u0000${request.task.trim()}`
    if (this.activeDispatchKeys.has(activeKey)) {
      throw new AgentTeamError('an identical squad task is already active for this session', 'INVALID_DISPATCH')
    }
    this.activeDispatchKeys.add(activeKey)
    try {
      throwIfAborted(signal)
      if (trace.claimSourceMessage) {
        if (trace.sourceMessageId === undefined) throw new AgentTeamError('model-tool dispatch requires a source message', 'INVALID_DISPATCH')
        const claimed = await this.claimGuaranteedMessage(parent, trace.sourceMessageId, 'team')
        if (!claimed) throw new AgentTeamError(
          'this user message has already dispatched a squad; reuse the existing result instead of starting another team',
          'INVALID_DISPATCH',
        )
      }
    } catch (error) {
      this.activeDispatchKeys.delete(activeKey)
      throw error
    }
    const dispatchId = trace.dispatchId ?? DispatchId(randomUUID())
    const chain: ExecutionChain = trace.chain ?? {
      id: dispatchId, revision: 0, maxContinuations: 1, usageBeforeRun: { ...ZERO_USAGE },
      ...(squad.tokenBudget === undefined ? {} : { tokenBudget: squad.tokenBudget }),
    }
    const startedAt = Date.now()
    const controller = new AbortController()
    this.activeRunControllers.set(dispatchId, controller)
    const runSignal = AbortSignal.any([signal, controller.signal])
    const shouldPlan = squad.executionOrder === undefined
      && request.memberOrder === undefined
      && request.assignments === undefined
      && trace.selectedAgentIds === undefined
      && replayPlan === undefined
      && (trace.sourceMessageId !== undefined || squad.leaderAgentId !== undefined)
    const initial: SquadRunRecord = {
      chain,
      definitionSnapshot: { squad: structuredClone(squad), agents: [...agents].map(([id, record]) => ({ id, record: structuredClone(record) })) },
      id: dispatchId,
      sessionId: trace.sessionId ?? parent.id,
      ...trace.sourceMessageId === undefined ? {} : { sourceMessageId: trace.sourceMessageId },
      ...parent.session.header.cwd === undefined ? {} : { projectKey: parent.session.header.cwd },
      squadId: request.squadId,
      squadName: squad.name,
      task: request.task,
      executionMode,
      contextMode,
      status: trace.responseMode === 'background' ? 'queued' : shouldPlan ? 'planning' : 'running',
      phase: trace.responseMode === 'background' ? 'queued' : shouldPlan ? 'planning' : 'members',
      startedAt,
      members: squad.members.map((id) => {
        const record = agents.get(id)
        return {
          agentId: id,
          agentName: record?.name ?? String(id),
          provider: record?.provider ?? '',
          model: record?.model ?? '',
          status: 'pending' as const,
          attempts: 0,
          output: [],
        }
      }),
      usage: { ...ZERO_USAGE },
      ...(trace.retryOf === undefined ? {} : { retryOf: trace.retryOf }),
      responseMode: trace.responseMode ?? 'foreground',
      ...(trace.backgroundJobId === undefined ? {} : { backgroundJobId: trace.backgroundJobId }),
      ...(trace.backgroundRequestKey === undefined ? {} : { backgroundRequestKey: trace.backgroundRequestKey }),
    }
    try {
      await this.runs().put(dispatchId, initial)
      trace.onStored?.()
      await this.updateRun(dispatchId, run => ({ ...run, status: shouldPlan ? 'planning' : 'running', phase: shouldPlan ? 'planning' : 'members' }))
      const plan = replayPlan ?? (shouldPlan
        ? await this.createAutomaticPlan(squad, agents, request.task, parent, runSignal, trace.sourceMessageId !== undefined, executionMode, dispatchId)
        : undefined)
      await this.updateRun(dispatchId, run => ({
        ...this.withoutLiveUsage(run, 'planner'),
        status: 'running',
        phase: 'members',
        ...plan === undefined ? {} : { plan, usage: this.addUsage(plan.usage) },
      }))
      if (plan?.decision === 'skip') {
        const endedAt = Date.now()
        await this.updateRun(dispatchId, run => ({
          ...run, status: 'skipped', phase: 'settled', endedAt, usage: this.addUsage(plan.usage), plan,
          members: run.members.map(member => ({ ...member, status: 'skipped', endedAt, error: plan.reason })),
        }))
        return {
          dispatchId, squadId: request.squadId, squadName: squad.name, task: request.task,
          executionMode, contextMode, status: 'skipped', members: [], usage: this.addUsage(plan.usage),
          startedAt, endedAt, plan, chain,
        }
      }

      const baseMembers = trace.selectedAgentIds === undefined
        ? this.resolveMembers(
            squad,
            request.assignments,
            request.memberOrder,
            agents,
          )
        : trace.selectedAgentIds.map((id) => {
            const record = agents.get(id)
            if (record === undefined) throw new AgentTeamError(`squad references missing agent "${id}"`, 'AGENT_NOT_FOUND')
            return { id, record, task: request.assignments?.find(item => item.agentId === id)?.task ?? '' }
          })
      const byId = new Map(baseMembers.map(member => [member.id, member]))
      const fallbackAssignments = deterministicExecutionPlan(
        squad.executionOrder === undefined && request.memberOrder !== undefined
          ? { ...squad, executionOrder: [...request.memberOrder] }
          : squad,
        request.task,
        agents,
        undefined,
        executionMode,
      ).assignments
      const fallbackById = new Map(fallbackAssignments.map(node => [node.agentId, node.task]))
      const nodes: SquadPlanAssignment[] = plan?.assignments ?? baseMembers.map((member, index) => ({
        agentId: member.id,
        task: member.task.trim().length === 0 ? fallbackById.get(member.id)! : member.task,
        dependsOn: executionMode === 'parallel' || index === 0 ? [] : [baseMembers[index - 1]!.id],
      }))
      const executionPlan: SquadExecutionPlan = plan ?? {
        decision: 'run',
        reason: trace.selectedAgentIds !== undefined
          ? 'Member-only retry of the persisted assignment.'
          : request.assignments !== undefined || request.memberOrder !== undefined
            ? 'Explicit dispatch workflow.'
            : squad.executionOrder !== undefined
              ? 'Configured fixed workflow.'
              : 'Configured deterministic workflow.',
        summary: trace.selectedAgentIds !== undefined
          ? 'One persisted member assignment.'
          : 'Normalized executable member workflow.',
        memberOrder: nodes.map(node => node.agentId),
        assignments: nodes.map(node => ({ ...node, dependsOn: [...node.dependsOn] })),
        planner: 'deterministic-fallback',
      }
      await this.updateRun(dispatchId, run => ({ ...run, plan: executionPlan }))
      const selectedMembers = nodes.map(node => {
        const existing = byId.get(node.agentId)
        const record = existing?.record ?? agents.get(node.agentId)
        if (record === undefined) throw new AgentTeamError(`squad references missing agent "${node.agentId}"`, 'AGENT_NOT_FOUND')
        return { id: node.agentId, record, task: node.task }
      })
      const selectedIds = new Set(selectedMembers.map(member => member.id))
      for (const id of squad.members.filter(id => !selectedIds.has(id))) {
        await this.updateRunMember(dispatchId, id, current => ({ ...current, status: 'skipped', endedAt: Date.now(), error: 'not selected by the adaptive plan' }))
      }
      const memberById = new Map(selectedMembers.map(member => [member.id, member]))
      const provider = contextMode === 'fork' ? 'fork' : this.config.defaultProvider
      const results: SquadMemberResult[] = []
      const resultById = new Map<AgentId, SquadMemberResult>()
      for (const [id, previous] of trace.reusedMembers ?? []) {
        const reused: SquadMemberResult = {
          agentId: id, agentName: previous.agentName, status: 'completed', attempts: 0,
          output: previous.output, reusedFrom: chain.continuationOf!,
          ...(previous.handoff === undefined ? {} : { handoff: previous.handoff }),
          ...(previous.childId === undefined ? {} : { childId: previous.childId }),
          ...(previous.runId === undefined ? {} : { runId: previous.runId }),
        }
        results.push(reused); resultById.set(id, reused)
        await this.updateRunMember(dispatchId, id, current => ({ ...current, ...reused }))
      }
      let haltReason: 'cancelled' | 'failure' | 'budget' | undefined
      const concurrency = executionMode === 'parallel'
        ? Math.max(1, Math.min(squad.maxConcurrency ?? selectedMembers.length, selectedMembers.length))
        : 1
      outer: for (const wave of executionWaves(nodes)) {
        for (let offset = 0; offset < wave.length; offset += concurrency) {
          if (runSignal.aborted) { haltReason = 'cancelled'; break outer }
          const used = this.addUsage(chain.usageBeforeRun, executionPlan.usage, ...results.map(item => item.usage))
          if (squad.tokenBudget !== undefined && used.totalTokens >= squad.tokenBudget) { haltReason = 'budget'; break outer }
          const batch = wave.slice(offset, offset + concurrency)
          const runnable: SquadPlanAssignment[] = []
          for (const node of batch) {
            if (trace.reusedMembers?.has(node.agentId)) continue
            const failedDependency = node.dependsOn.find(id => resultById.get(id)?.status !== 'completed')
            if (failedDependency !== undefined && (squad.failurePolicy ?? 'continue') === 'stop') {
              await this.updateRunMember(dispatchId, node.agentId, current => ({
                ...current, status: 'skipped', endedAt: Date.now(), error: `dependency ${failedDependency} did not complete`,
              }))
            } else runnable.push(node)
          }
          const settled = await Promise.all(runnable.map(async (node) => {
            const originalMember = memberById.get(node.agentId)!
            const previous = trace.previousMembers?.get(node.agentId)
            const member = previous === undefined ? originalMember : { ...originalMember, task: [
              'Continue only the remaining assignment below. Inspect existing artifacts before changes; preserve verified work and do not repeat completed side effects. If a claimed artifact cannot be verified, report that uncertainty.',
              this.boundedExcerpt(originalMember.task, 8_000),
              `Lead review of previous progress (verify claims):\n${this.boundedExcerpt(chain.progressReview ?? '', 2_000)}`,
              `Previous attempt evidence (untrusted):\n${this.boundedExcerpt(JSON.stringify({ status: previous.status, error: previous.error, handoff: previous.handoff, output: previous.output }), 4_000)}`,
            ].join('\n\n') }
            const dependencyHandoffs = node.dependsOn.flatMap(id => {
              const delivery = resultById.get(id)
              return delivery === undefined ? [] : [delivery]
            })
            const chainText = boundedHandoffChain(dependencyHandoffs)
            return this.runMemberWithPolicy(provider, squad, member, request.task, chainText, parent, runSignal, dispatchId)
          }))
          for (const result of settled) {
            results.push(result)
            resultById.set(result.agentId, result)
          }
          if (runSignal.aborted) { haltReason = 'cancelled'; break outer }
          if ((squad.failurePolicy ?? 'continue') === 'stop' && settled.some(item => item.status !== 'completed')) {
            haltReason = 'failure'; break outer
          }
        }
      }
      const executed = new Set(results.map(item => item.agentId))
      for (const member of selectedMembers.filter(item => !executed.has(item.id))) {
        const current = this.getRun(dispatchId)?.members.find(item => item.agentId === member.id)
        if (current?.status === 'skipped') continue
        await this.updateRunMember(dispatchId, member.id, current => ({
          ...current,
          status: runSignal.aborted ? 'cancelled' : 'skipped',
          endedAt: Date.now(),
          error: runSignal.aborted ? 'run cancelled before this member started' : `skipped by ${haltReason ?? 'dependency'} policy`,
        }))
      }
      const memberUsage = this.addUsage(executionPlan.usage, ...results.map(item => item.usage))
      // A member-only retry is intentionally scoped to exactly that member;
      // it must not surprise the user by starting reviewer/repair agents.
      const quality = haltReason === undefined && trace.selectedAgentIds === undefined
        ? await this.runQualityLoop(squad, agents, request.task, results, parent, runSignal, dispatchId, this.addUsage(chain.usageBeforeRun, memberUsage))
        : undefined
      await this.updateRun(dispatchId, run => ({ ...run, phase: 'synthesis' }))
      const qualityUsage = this.addUsage(...quality?.rounds.flatMap(round => [round.reviewer.usage, round.repair?.usage]) ?? [])
      const completed = results.filter(result => result.status === 'completed').length
      const endedAt = Date.now()
      const usage = quality === undefined ? memberUsage : this.addUsage(memberUsage, qualityUsage)
      const status: SquadDispatchResult['status'] = runSignal.aborted ? 'cancelled'
        : completed === selectedMembers.length && (quality === undefined || quality.approved) ? 'completed'
          : completed === 0 ? 'failed' : 'partial'
      const result: SquadDispatchResult = {
        chain,
        dispatchId,
        squadId: request.squadId,
        squadName: squad.name,
        task: request.task,
        executionMode,
        contextMode,
        status,
        members: results,
        usage,
        startedAt,
        endedAt,
        plan: executionPlan,
        ...quality === undefined ? {} : { quality },
      }
      await this.updateRun(dispatchId, (run) => {
        const { qualityProgress: _qualityProgress, liveUsage: _liveUsage, ...settledRun } = run
        return {
        ...settledRun,
        status,
        phase: 'settled',
        endedAt,
        usage,
        plan: executionPlan,
        ...quality === undefined ? {} : { quality },
        ...quality !== undefined && !quality.approved ? { error: 'quality gate did not approve the final handoff' } : {},
        }
      })
      return { ...result, continuation: this.continuationAvailability(this.runs().get(dispatchId)!) }
    } catch (error: unknown) {
      trace.onStored?.(error)
      const endedAt = Date.now()
      await this.updateRun(dispatchId, (run) => {
        const { qualityProgress: _qualityProgress, liveUsage: _liveUsage, ...settledRun } = run
        return {
        ...settledRun,
        status: runSignal.aborted ? 'cancelled' : 'failed',
        phase: 'settled',
        endedAt,
        error: this.errorText(error),
        members: run.members.map(member => member.status === 'pending' || member.status === 'running'
          ? { ...member, status: runSignal.aborted ? 'cancelled' : 'failed', endedAt, error: this.errorText(error) }
          : member),
        }
      })
      throw error
    } finally {
      this.activeRunControllers.delete(dispatchId)
      this.activeDispatchKeys.delete(activeKey)
      try {
        await this.history().enforceRetention(this.config.historyMaxRuns ?? 0, this.config.historyMaxAgeDays ?? 0)
      } catch (error: unknown) {
        // Retention is maintenance, never part of the dispatch outcome. A
        // backend cleanup failure must not replace a successful result or the
        // original execution error already recorded in Run Center.
        this.ctx.logger.warn(`[agent-team-gui] run retention failed: ${this.errorText(error)}`)
      }
    }
  }

  /** Start a detached run through the official jobs seam when available. */
  async startBackgroundDispatch(
    request: SquadDispatchRequest,
    parent: Agent,
    trace: DispatchTrace = {},
    signal?: AbortSignal,
  ): Promise<{ id: DispatchId; status: 'queued'; jobId?: string }> {
    throwIfAborted(signal)
    const requestKey = createHash('sha256').update(JSON.stringify({
      sessionId: trace.sessionId ?? parent.id,
      sourceMessageId: trace.sourceMessageId ?? null,
      retryOf: trace.retryOf ?? null,
      selectedAgentIds: trace.selectedAgentIds ?? null,
      request,
    })).digest('hex')
    const accepted = [...this.runs().entries()].map(([, run]) => run).find(run =>
      run.backgroundRequestKey === requestKey
      && run.responseMode === 'background'
      && (run.status === 'queued' || run.status === 'planning' || run.status === 'running'))
    if (accepted !== undefined) {
      return {
        id: accepted.id,
        status: 'queued',
        ...(accepted.backgroundJobId === undefined ? {} : { jobId: accepted.backgroundJobId }),
      }
    }
    const inFlight = this.backgroundAcceptances.get(requestKey)
    if (inFlight !== undefined) return await inFlight
    const acceptance = this.acceptBackgroundDispatch(request, parent, trace, requestKey, signal)
    this.backgroundAcceptances.set(requestKey, acceptance)
    try {
      return await acceptance
    } finally {
      if (this.backgroundAcceptances.get(requestKey) === acceptance) this.backgroundAcceptances.delete(requestKey)
    }
  }

  /**
   * Persist acceptance before registering any process-local work. Once the
   * queued row exists, cancellation of the caller no longer turns a committed
   * mutation into an apparent failure; a repeated request finds the same row.
   */
  private async acceptBackgroundDispatch(
    request: SquadDispatchRequest,
    parent: Agent,
    trace: DispatchTrace,
    requestKey: string,
    signal?: AbortSignal,
  ): Promise<{ id: DispatchId; status: 'queued'; jobId?: string }> {
    if (this.isDelegatedAgent(parent)) {
      throw new AgentTeamError('nested squad dispatch is blocked for delegated child sessions', 'INVALID_DISPATCH')
    }
    if (request.task.trim().length === 0 || request.task.length > 100_000
      || (request.assignments?.length ?? 0) > 32 || (request.memberOrder?.length ?? 0) > 32
      || request.assignments?.some(item => item.task.length > 100_000) === true) {
      throw new AgentTeamError('dispatch input exceeds the bounded task/member limits', 'INVALID_DISPATCH')
    }
    const definitionSnapshot = await this.readSquadExecutionSnapshot(request.squadId, signal)
    const squad = definitionSnapshot.squad
    if (squad === undefined) throw new AgentTeamError(`squad "${request.squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    if (squad.members.length === 0) throw new AgentTeamError(`squad "${request.squadId}" has no members`, 'INVALID_DISPATCH')
    const executionMode = request.executionMode
      ?? squad.executionMode
      ?? (squad.executionOrder === undefined ? this.config.defaultExecutionMode : 'serial')
    const contextMode = request.contextMode ?? squad.contextMode ?? this.config.defaultContextMode
    if (squad.executionOrder !== undefined && executionMode === 'parallel') {
      throw new AgentTeamError('a squad with executionOrder requires serial execution', 'INVALID_DISPATCH')
    }
    if (executionMode === 'parallel' && contextMode === 'chain') {
      throw new AgentTeamError('contextMode "chain" requires serial execution', 'INVALID_DISPATCH')
    }
    if (request.assignments !== undefined || request.memberOrder !== undefined) {
      this.resolveMembers(squad, request.assignments, request.memberOrder, definitionSnapshot.agents)
    }
    if (trace.selectedAgentIds !== undefined && trace.selectedAgentIds.some(id => !squad.members.includes(id))) {
      throw new AgentTeamError('retry selection contains a non-member agent', 'INVALID_DISPATCH')
    }
    throwIfAborted(signal)
    const id = trace.dispatchId ?? DispatchId(randomUUID())
    const startedAt = Date.now()
    const queued: SquadRunRecord = {
      id,
      sessionId: trace.sessionId ?? parent.id,
      ...(trace.sourceMessageId === undefined ? {} : { sourceMessageId: trace.sourceMessageId }),
      ...(parent.session.header.cwd === undefined ? {} : { projectKey: parent.session.header.cwd }),
      squadId: request.squadId,
      squadName: squad.name,
      task: request.task,
      executionMode,
      contextMode,
      status: 'queued',
      phase: 'queued',
      startedAt,
      members: squad.members.map((agentId) => {
        const member = definitionSnapshot.agents.get(agentId)
        return {
          agentId,
          agentName: member?.name ?? String(agentId),
          provider: member?.provider ?? '',
          model: member?.model ?? '',
          status: 'pending' as const,
          attempts: 0,
          output: [],
        }
      }),
      usage: { ...ZERO_USAGE },
      ...(trace.replayPlan === undefined ? {} : { plan: structuredClone(trace.replayPlan) }),
      ...(trace.retryOf === undefined ? {} : { retryOf: trace.retryOf }),
      responseMode: 'background',
      backgroundRequestKey: requestKey,
    }
    // This write is the acceptance boundary. Do not check the caller signal
    // after it commits: a transport timeout must not make a durable job look
    // rejected and encourage a duplicate retry.
    try {
      await this.runs().put(id, queued)
    } catch (error: unknown) {
      // Some KV adapters can report an error after the durable write reached
      // storage. Treat an exactly matching row as accepted and continue to
      // register its work; otherwise this queued receipt would be orphaned and
      // a retry would falsely appear successful without ever running.
      const committed = this.runs().get(id)
      if (committed?.backgroundRequestKey !== requestKey || committed.status !== 'queued') throw error
      this.ctx.logger.warn(`[agent-team-gui] background acceptance write reported an error after commit for ${id}: ${this.errorText(error)}`)
    }
    const controller = new AbortController()
    this.activeRunControllers.set(id, controller)
    this.pendingBackgroundRuns.add(id)
    let releaseStart!: () => void
    let startFailure: unknown
    const mayStart = new Promise<void>((resolve) => { releaseStart = resolve })
    let jobId: string | undefined
    const starter = () => {
      const done = mayStart.then(async () => {
        this.pendingBackgroundRuns.delete(id)
        if (startFailure !== undefined) throw startFailure
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('background squad run cancelled before start')
        return await this.dispatch(request, parent, controller.signal, {
          ...trace,
          dispatchId: id,
          responseMode: 'background',
          backgroundRequestKey: requestKey,
          frozenDefinition: { squad, agents: definitionSnapshot.agents },
          ...(jobId === undefined ? {} : { backgroundJobId: jobId }),
        })
      }).then(result => ({
          status: result.status === 'cancelled' ? 'killed' as const : result.status === 'failed' ? 'failed' as const : 'completed' as const,
          detail: result.status,
          output: `${result.squadName}: ${result.status}; ${result.usage.totalTokens} provider-reported tokens`,
        }), async (error: unknown) => {
          const endedAt = Date.now()
          try {
            await this.updateRun(id, (run) => ({
              ...run,
              status: controller.signal.aborted ? 'cancelled' : 'failed',
              phase: 'settled',
              endedAt,
              error: this.errorText(error),
              members: run.members.map(member => member.status === 'pending' || member.status === 'running'
                ? { ...member, status: controller.signal.aborted ? 'cancelled' : 'failed', endedAt, error: this.errorText(error) }
                : member),
            }))
          } catch (storageError: unknown) {
            this.ctx.logger.warn(`[agent-team-gui] could not settle failed background run ${id}: ${this.errorText(storageError)}`)
          }
          this.activeRunControllers.delete(id)
          return { status: controller.signal.aborted ? 'killed' as const : 'failed' as const, detail: this.errorText(error) }
        })
      return { cancel: (reason?: string) => controller.abort(reason ?? 'background squad run cancelled'), done }
    }
    const jobs = this.ctx.get('jobs')
    try {
      if (jobs === undefined) {
        const hooks = starter()
        void hooks.done
        this.ctx.logger.warn('[agent-team-gui] official jobs service unavailable; background run remains observable only in the plugin Run Center')
      } else {
        jobId = jobs.start({
          kind: 'agent-team',
          label: `${squad.name}: ${request.task.slice(0, 80)}`,
          outputLimitBytes: 8_192,
          owner: parent,
          run: starter,
        })
      }
    } catch (error: unknown) {
      startFailure = error
      controller.abort(error)
      releaseStart()
      this.activeRunControllers.delete(id)
      this.pendingBackgroundRuns.delete(id)
      const endedAt = Date.now()
      try {
        await this.updateRun(id, run => ({ ...run, status: 'failed', phase: 'settled', endedAt, error: this.errorText(error) }))
      } catch (storageError: unknown) {
        this.ctx.logger.warn(`[agent-team-gui] could not persist rejected background job ${id}: ${this.errorText(storageError)}`)
      }
      throw error
    }
    releaseStart()
    if (jobId !== undefined) {
      void this.updateRun(id, run => ({ ...run, backgroundJobId: jobId! })).catch((error: unknown) => {
        this.ctx.logger.warn(`[agent-team-gui] could not attach official job id to run ${id}: ${this.errorText(error)}`)
      })
    }
    return { id, status: 'queued', ...(jobId === undefined ? {} : { jobId }) }
  }

  /** Non-executing plan preview. A fixed workflow returns a deterministic graph without a planner call. */
  async previewPlan(squadId: SquadId, task: string, parent: Agent, signal: AbortSignal): Promise<SquadExecutionPlan> {
    const definitionSnapshot = await this.readSquadExecutionSnapshot(squadId, signal)
    const squad = definitionSnapshot.squad
    if (squad === undefined) throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    if (task.trim() === '') throw new AgentTeamError('preview task must not be empty', 'INVALID_DISPATCH')
    const executionMode = squad.executionMode
      ?? (squad.executionOrder === undefined ? this.config.defaultExecutionMode : 'serial')
    return await this.createAutomaticPlan(squad, definitionSnapshot.agents, task, parent, signal, true, executionMode)
      ?? deterministicExecutionPlan(squad, task, definitionSnapshot.agents, undefined, executionMode)
  }

  /** Newest-first durable run history; summary mode never returns raw member/quality output. */
  listRuns(sessionId?: SessionId, limit = 50, detail = false): SquadRunRecord[] {
    const rows = this.history().list(sessionId, limit)
    if (detail) return rows
    return rows.map(({ definitionSnapshot: _definitionSnapshot, ...run }) => ({
      ...run,
      task: run.task.slice(0, 1_000),
      ...(run.error === undefined ? {} : { error: run.error.slice(0, 1_000) }),
      ...(run.plan === undefined ? {} : {
        plan: { ...run.plan, assignments: run.plan.assignments.map(item => ({ ...item, task: item.task.slice(0, 500) })) },
      }),
      members: run.members.map(member => ({
        ...member,
        output: [],
        ...(member.recovery === undefined ? {} : { recovery: {
          ...member.recovery, originalTask: member.recovery.originalTask.slice(0, 500),
          ...(member.recovery.retryTask === undefined ? {} : { retryTask: member.recovery.retryTask.slice(0, 500) }),
          firstAttempt: { ...member.recovery.firstAttempt, output: [], executionEvidence: '' },
        } }),
        ...(member.error === undefined ? {} : { error: member.error.slice(0, 1_000) }),
        ...(member.handoff === undefined ? {} : { handoff: { ...member.handoff, summary: member.handoff.summary.slice(0, 1_000) } }),
      })),
      ...run.quality === undefined ? {} : {
        quality: {
          ...run.quality,
          rounds: run.quality.rounds.map(round => ({
            ...round,
            feedback: round.feedback.slice(0, 1_000),
            reviewer: { ...round.reviewer, output: [] },
            ...(round.repair === undefined ? {} : { repair: { ...round.repair, output: [] } }),
          })),
        },
      },
    }))
  }

  getRun(id: DispatchId): SquadRunRecord | undefined {
    const run = this.runs().get(id)
    return run === undefined ? undefined : { ...run, meteringCoverage: runMeteringCoverage(run) }
  }

  cancelRun(id: DispatchId): boolean {
    const controller = this.activeRunControllers.get(id)
    if (controller === undefined) return false
    controller.abort(new Error('cancelled from Agent Team GUI'))
    if (this.pendingBackgroundRuns.delete(id)) {
      this.activeRunControllers.delete(id)
      const endedAt = Date.now()
      void this.updateRun(id, run => ({
        ...run,
        status: 'cancelled',
        phase: 'settled',
        endedAt,
        error: 'cancelled before background execution started',
        members: run.members.map(member => ({
          ...member,
          status: member.status === 'pending' ? 'cancelled' : member.status,
          ...(member.status === 'pending' ? { endedAt, error: 'cancelled before background execution started' } : {}),
        })),
      })).catch((error: unknown) => {
        this.ctx.logger.warn(`[agent-team-gui] could not persist queued cancellation for ${id}: ${this.errorText(error)}`)
      })
    }
    return true
  }

  async retryRun(id: DispatchId, parent: Agent, agentId?: AgentId, signal?: AbortSignal): Promise<{ id: DispatchId; status: 'queued'; retryOf: DispatchId }> {
    throwIfAborted(signal)
    const source = this.runs().get(id)
    if (source === undefined) throw new AgentTeamError(`run "${id}" does not exist`, 'INVALID_DISPATCH')
    if (['planning', 'queued', 'running'].includes(source.status)) throw new AgentTeamError('an active run cannot be retried', 'INVALID_DISPATCH')
    if (source.plan === undefined) {
      throw new AgentTeamError('the source run predates persisted execution plans and cannot be retried faithfully', 'INVALID_DISPATCH')
    }
    const selected = agentId === undefined ? undefined : [agentId]
    const sourceAssignment = agentId === undefined
      ? undefined
      : source.plan?.assignments.find(item => item.agentId === agentId)
    if (agentId !== undefined && !source.members.some(member => member.agentId === agentId)) {
      throw new AgentTeamError(`agent "${agentId}" did not participate in source run "${id}"`, 'INVALID_DISPATCH')
    }
    if (agentId !== undefined && sourceAssignment === undefined) {
      throw new AgentTeamError(`source run "${id}" has no persisted assignment for agent "${agentId}"`, 'INVALID_DISPATCH')
    }
    const replayPlan = agentId !== undefined
      ? undefined
      : (() => {
          const { usage: _usage, ...withoutUsage } = structuredClone(source.plan)
          return {
            ...withoutUsage,
            warning: [withoutUsage.warning, `Replayed immutable execution plan from run ${id}.`].filter(Boolean).join(' ').slice(0, 8_000),
          }
        })()
    throwIfAborted(signal)
    const started = await this.startBackgroundDispatch({
      squadId: source.squadId,
      task: source.task,
      executionMode: source.executionMode,
      contextMode: source.contextMode,
      ...(agentId === undefined ? {} : {
        assignments: [{ agentId, task: sourceAssignment!.task }],
      }),
    }, parent, {
      sessionId: source.sessionId,
      retryOf: id,
      ...(selected === undefined ? {} : { selectedAgentIds: selected }),
      ...(replayPlan === undefined ? {} : { replayPlan }),
    }, signal)
    return { id: started.id, status: started.status, retryOf: id }
  }

  clearRuns(
    filters: { readonly id?: DispatchId; readonly sessionId?: SessionId; readonly before?: number; readonly settledOnly?: boolean },
    signal?: AbortSignal,
  ): Promise<number> {
    return this.history().clear(filters, signal)
  }

  exportRun(id: DispatchId): AgentTeamRunExportDocument {
    const run = this.getRun(id)
    if (run === undefined) throw new AgentTeamError(`run "${id}" does not exist`, 'INVALID_DISPATCH')
    return { format: 'agent-team-gui/run', version: 1, exportedAt: Date.now(), run }
  }

  insights(filters: { readonly sessionId?: SessionId; readonly projectKey?: string; readonly squadId?: SquadId; readonly since?: number; readonly until?: number }): SquadInsightsSummary {
    return this.history().insights(filters)
  }
}
