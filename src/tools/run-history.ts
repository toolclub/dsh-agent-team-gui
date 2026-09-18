import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentTokenUsage, DispatchId, SquadInsightsSummary, SquadRunRecord, UsageAggregateRow } from '../types.ts'
import { throwIfAborted } from './infrastructure/write-coordinator.ts'

const ACTIVE = new Set<SquadRunRecord['status']>(['planning', 'queued', 'running'])

function zeroUsage(): AgentTokenUsage {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, providerReported: false }
}

function addUsage(...samples: readonly (AgentTokenUsage | undefined)[]): AgentTokenUsage {
  const present = samples.filter((sample): sample is AgentTokenUsage => sample !== undefined)
  const value = present.reduce((total, sample) => ({
    uncachedInputTokens: total.uncachedInputTokens + sample.uncachedInputTokens,
    outputTokens: total.outputTokens + sample.outputTokens,
    cacheReadTokens: total.cacheReadTokens + sample.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + sample.cacheWriteTokens,
    totalTokens: total.totalTokens + sample.totalTokens,
    providerReported: total.providerReported || sample.providerReported,
  }), { ...zeroUsage(), providerReported: false })
  return value
}

/**
 * Coverage is independent from token totals: providerReported stays "any
 * official sample", while this value tells the UI whether every expected
 * planner/member/review/repair sample was observed.
 */
export function runMeteringCoverage(run: SquadRunRecord): 'full' | 'partial' | 'none' {
  const expected: Array<AgentTokenUsage | undefined> = []
  const plannerAttempted = run.phase === 'planning'
    || run.liveUsage?.planner !== undefined
    || (run.plan !== undefined && run.plan.planner !== 'lead-continuation' && (run.plan.planner !== 'deterministic-fallback'
      || run.plan.plannerProvider !== undefined || run.plan.plannerModel !== undefined))
  if (plannerAttempted) expected.push(run.plan?.usage ?? run.liveUsage?.planner)
  for (const member of run.members) {
    if (member.recovery?.attempted) expected.push(member.recovery.usage)
    if (member.attemptUsage !== undefined && member.attemptUsage.length > 0) {
      for (const attempt of member.attemptUsage) expected.push(attempt.usage)
    } else if (member.usageSamples !== undefined) {
      for (let index = 0; index < member.usageSamples.metered; index += 1) expected.push(member.usage)
      for (let index = member.usageSamples.metered; index < member.usageSamples.total; index += 1) expected.push(undefined)
    } else if (member.attempts > 0 || member.startedAt !== undefined || member.status === 'running') {
      // Old rows have only an aggregate. A retry-once row cannot prove that
      // every attempt was metered, so never call attempts>1 fully covered.
      expected.push(member.usage)
      if (member.attempts > 1) expected.push(undefined)
    }
  }
  for (const round of run.quality?.rounds ?? []) {
    expected.push(round.reviewer.usage)
    if (round.repair !== undefined) expected.push(round.repair.usage)
  }
  if (run.qualityProgress?.state === 'reviewing'
    && (run.quality?.rounds.length ?? 0) < run.qualityProgress.round) {
    expected.push(run.liveUsage?.review)
  }
  if (run.qualityProgress?.state === 'repairing') {
    const round = run.quality?.rounds.find(item => item.round === run.qualityProgress!.round)
    if (round?.repair === undefined) expected.push(run.liveUsage?.repair)
  }
  if (expected.length === 0) return run.usage.providerReported ? 'full' : 'none'
  const metered = expected.filter(sample => sample?.providerReported === true).length
  if (metered === expected.length) return 'full'
  if (metered > 0 || run.usage.providerReported) return 'partial'
  return 'none'
}

function withMeteringCoverage(run: SquadRunRecord): SquadRunRecord {
  return { ...run, meteringCoverage: runMeteringCoverage(run) }
}

interface Bucket {
  label: string
  runs: Set<DispatchId>
  usage: AgentTokenUsage
  hasUsage: boolean
  meteredSamples: number
  unmeteredSamples: number
}

function addBucket(
  map: Map<string, Bucket>,
  key: string,
  label: string,
  runId: DispatchId,
  usage: AgentTokenUsage | undefined,
  coverage?: { readonly metered: number; readonly total: number },
): void {
  const metered = coverage?.metered ?? (usage?.providerReported === true ? 1 : 0)
  const unmetered = Math.max(0, (coverage?.total ?? 1) - metered)
  const existing = map.get(key)
  const current = existing ?? {
    label, runs: new Set<DispatchId>(), usage: usage ?? zeroUsage(), hasUsage: usage !== undefined,
    meteredSamples: metered,
    unmeteredSamples: unmetered,
  }
  current.runs.add(runId)
  if (existing !== undefined && usage !== undefined) {
    current.usage = current.hasUsage ? addUsage(current.usage, usage) : usage
    current.hasUsage = true
  }
  if (existing !== undefined) {
    current.meteredSamples += metered
    current.unmeteredSamples += unmetered
  }
  map.set(key, current)
}

function rows(map: Map<string, Bucket>): UsageAggregateRow[] {
  return [...map.entries()].map(([key, value]) => ({
    key, label: value.label, runCount: value.runs.size, usage: value.usage,
    meteredSamples: value.meteredSamples, unmeteredSamples: value.unmeteredSamples,
  }))
    .sort((left, right) => right.usage.totalTokens - left.usage.totalTokens || left.label.localeCompare(right.label))
}

/** Persistence-facing lifecycle and aggregation policy, isolated from orchestration. */
export class RunHistoryStore {
  constructor(private readonly table: KvTable<DispatchId, SquadRunRecord>) {}

  async reconcileInterrupted(now = Date.now()): Promise<number> {
    let changed = 0
    for (const [id, run] of this.table.entries()) {
      if (!ACTIVE.has(run.status)) continue
      changed += 1
      await this.table.update(id, current => ({
        ...current,
        status: 'interrupted',
        phase: 'settled',
        endedAt: now,
        error: 'DSH stopped or restarted before this run completed.',
        members: current.members.map(member => ({
          ...member,
          ...(member.status === 'pending' || member.status === 'running' ? { status: 'interrupted' as const, endedAt: now, error: 'Host restarted before this member completed.' } : {}),
          ...(member.recovery?.state === 'diagnosing' ? { recovery: { ...member.recovery, state: 'failed' as const, endedAt: now, error: 'Host restarted during diagnosis. No automatic continuation.' } } : {}),
        })),
      }))
    }
    return changed
  }

  async enforceRetention(maxRuns: number, maxAgeDays: number, now = Date.now()): Promise<number> {
    if (maxRuns === 0 && maxAgeDays === 0) return 0
    const cutoff = maxAgeDays === 0 ? Number.NEGATIVE_INFINITY : now - maxAgeDays * 86_400_000
    const settled = [...this.table.entries()]
      .filter(([, run]) => !ACTIVE.has(run.status))
      .sort((left, right) => right[1].startedAt - left[1].startedAt)
    const toDelete = settled.filter(([, run], index) => (maxRuns > 0 && index >= maxRuns) || run.startedAt < cutoff)
    for (const [id] of toDelete) await this.table.delete(id)
    return toDelete.length
  }

  list(sessionId?: SessionId, limit = 50): SquadRunRecord[] {
    return [...this.table.entries()].map(([, run]) => run)
      .filter(run => sessionId === undefined || run.sessionId === sessionId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map(withMeteringCoverage)
  }

  async clear(filters: {
    readonly id?: DispatchId
    readonly sessionId?: SessionId
    readonly before?: number
    readonly settledOnly?: boolean
  }, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal)
    let cleared = 0
    for (const [id, run] of this.table.entries()) {
      throwIfAborted(signal)
      if (filters.id !== undefined && id !== filters.id) continue
      if (filters.sessionId !== undefined && run.sessionId !== filters.sessionId) continue
      if (filters.before !== undefined && run.startedAt >= filters.before) continue
      // Active rows always retain controller ownership; a clear is never an implicit cancel.
      if (ACTIVE.has(run.status)) continue
      if (filters.settledOnly === false || !ACTIVE.has(run.status)) {
        if (await this.table.delete(id)) cleared += 1
        throwIfAborted(signal)
      }
    }
    return cleared
  }

  insights(filters: {
    readonly sessionId?: SessionId
    readonly projectKey?: string
    readonly squadId?: string
    readonly since?: number
    readonly until?: number
  }): SquadInsightsSummary {
    const runs = [...this.table.entries()].map(([, run]) => run).filter(run =>
      (filters.sessionId === undefined || run.sessionId === filters.sessionId)
      && (filters.projectKey === undefined || run.projectKey === filters.projectKey)
      && (filters.squadId === undefined || run.squadId === filters.squadId)
      && (filters.since === undefined || run.startedAt >= filters.since)
      && (filters.until === undefined || run.startedAt <= filters.until))
    const statuses: Record<string, number> = {}
    const squad = new Map<string, Bucket>()
    const agent = new Map<string, Bucket>()
    const model = new Map<string, Bucket>()
    const project = new Map<string, Bucket>()
    for (const run of runs) {
      statuses[run.status] = (statuses[run.status] ?? 0) + 1
      addBucket(squad, run.squadId, run.squadName, run.id, run.usage)
      const projectKey = run.projectKey ?? '(no project)'
      addBucket(project, projectKey, projectKey, run.id, run.usage)
      if (run.plan !== undefined && run.plan.planner !== 'lead-continuation') {
        const plannerModel = run.plan.plannerProvider !== undefined && run.plan.plannerModel !== undefined
          ? `${run.plan.plannerProvider}/${run.plan.plannerModel}`
          : '(planner route unknown)'
        addBucket(model, plannerModel, plannerModel, run.id, run.plan.usage)
      }
      for (const member of run.members) {
        if (member.recovery?.attempted) {
          addBucket(agent, '(system-recovery)', 'System recovery coordinator', run.id, member.recovery.usage)
          const recoveryModel = `${member.recovery.provider}/${member.recovery.model}`
          addBucket(model, recoveryModel, recoveryModel, run.id, member.recovery.usage)
        }
        if (member.attemptUsage !== undefined && member.attemptUsage.length > 0) {
          for (const attempt of member.attemptUsage) {
            addBucket(agent, member.agentId, member.agentName, run.id, attempt.usage)
            const modelKey = `${attempt.provider}/${attempt.model}`
            addBucket(model, modelKey, modelKey, run.id, attempt.usage)
          }
        } else if (member.attempts > 0) {
          const coverage = member.usageSamples ?? {
            metered: member.usage?.providerReported === true ? 1 : 0,
            total: member.attempts,
          }
          addBucket(agent, member.agentId, member.agentName, run.id, member.usage, coverage)
          const modelKey = member.attempts > 1 ? '(mixed/unknown route)' : `${member.provider}/${member.model}`
          addBucket(model, modelKey, modelKey, run.id, member.usage, coverage)
        }
      }
      for (const round of run.quality?.rounds ?? []) {
        addBucket(agent, round.reviewer.agentId, round.reviewer.agentName, run.id, round.reviewer.usage)
        const reviewerMember = run.members.find(item => item.agentId === round.reviewer.agentId)
        const reviewerModel = round.reviewer.provider !== undefined && round.reviewer.model !== undefined
          ? `${round.reviewer.provider}/${round.reviewer.model}`
          : reviewerMember === undefined ? '(unknown quality route)' : `${reviewerMember.provider}/${reviewerMember.model}`
        addBucket(model, reviewerModel, reviewerModel, run.id, round.reviewer.usage)
        if (round.repair !== undefined) {
          addBucket(agent, round.repair.agentId, round.repair.agentName, run.id, round.repair.usage)
          const repairMember = run.members.find(item => item.agentId === round.repair!.agentId)
          const repairModel = round.repair.provider !== undefined && round.repair.model !== undefined
            ? `${round.repair.provider}/${round.repair.model}`
            : repairMember === undefined ? '(unknown quality route)' : `${repairMember.provider}/${repairMember.model}`
          addBucket(model, repairModel, repairModel, run.id, round.repair.usage)
        }
      }
    }
    const reviewSamples = runs.flatMap(run => run.quality?.rounds.map(round => round.reviewer.usage) ?? [])
    const repairSamples = runs.flatMap(run => run.quality?.rounds.map(round => round.repair?.usage) ?? [])
    const reviewUsage = addUsage(...reviewSamples)
    const repairUsage = addUsage(...repairSamples)
    const qualityUsage = addUsage(...reviewSamples, ...repairSamples)
    const plannerUsage = addUsage(...runs.map(run => run.plan?.usage))
    const memberUsage = addUsage(...runs.flatMap(run => run.members.map(member => member.usage)))
    const coverage = runs.map(runMeteringCoverage)
    const fullyMeteredRuns = coverage.filter(value => value === 'full').length
    const partiallyMeteredRuns = coverage.filter(value => value === 'partial').length
    return {
      runCount: runs.length,
      fullyMeteredRuns,
      partiallyMeteredRuns,
      meteredRuns: fullyMeteredRuns + partiallyMeteredRuns,
      unmeteredRuns: coverage.filter(value => value === 'none').length,
      statuses,
      usage: addUsage(...runs.map(run => run.usage)),
      plannerUsage,
      memberUsage,
      qualityUsage,
      reviewUsage,
      repairUsage,
      bySquad: rows(squad),
      byAgent: rows(agent),
      byModel: rows(model),
      byProject: rows(project),
    }
  }
}
