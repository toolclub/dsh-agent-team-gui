import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { AgentId, DispatchId, SquadId, type AgentTeamRecipeDocument, type AgentTokenUsage, type SquadRunRecord } from '../src/types.ts'
import { deterministicExecutionPlan, executionWaves, normalizeHandoff, validateExecutionPlan } from '../src/tools/orchestration.ts'
import { RunHistoryStore } from '../src/tools/run-history.ts'
import { StorageUnitOfWork } from '../src/tools/storage-transaction.ts'
import { WriteCoordinator } from '../src/tools/infrastructure/write-coordinator.ts'
import { createDispatchToSquadTool } from '../src/tools/dispatch-to-squad.ts'
import { createAgentTeamRpcHandler } from '../src/rpc.ts'
import { agentRecordReadSchema, agentRecordSchema, squadRecordReadSchema, squadRecordSchema } from '../src/spec.ts'
import AgentTeamService from '../src/index.ts'
import { agent, createService, MemoryTable, researcherId, reviewerId, squadId, writerId } from './helpers.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function usage(total: number): AgentTokenUsage {
  return {
    uncachedInputTokens: total,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: total,
    providerReported: true,
  }
}

function settledRun(id: string, overrides: Partial<SquadRunRecord> = {}): SquadRunRecord {
  return {
    id: DispatchId(id),
    sessionId: SessionId('parent'),
    squadId,
    squadName: 'Delivery',
    task: 'ship',
    executionMode: 'serial',
    contextMode: 'spawn',
    status: 'completed',
    startedAt: 100,
    endedAt: 200,
    members: [],
    usage: usage(0),
    ...overrides,
  }
}

function activeRun(id: string, status: 'planning' | 'queued' | 'running', phase: 'planning' | 'queued' | 'members'): SquadRunRecord {
  const { endedAt: _endedAt, ...run } = settledRun(id)
  return { ...run, status, phase }
}

describe('v0.5 planner and DAG policy (R4-R5, D2)', () => {
  it('preserves the Main Agent memberOrder and honors the effective parallel default', () => {
    const agents = new Map([
      [researcherId, agent('Researcher')],
      [writerId, agent('Writer')],
      [reviewerId, agent('Reviewer')],
    ])
    const squad = { name: 'Delivery', members: [researcherId, writerId, reviewerId] }
    const plan = validateExecutionPlan({
      decision: 'run', reason: 'ordered', summary: 'ordered', planner: 'main-agent',
      memberOrder: [reviewerId, researcherId, writerId],
      assignments: [
        { agentId: researcherId, task: 'research', dependsOn: [] },
        { agentId: writerId, task: 'write', dependsOn: [] },
        { agentId: reviewerId, task: 'review', dependsOn: [] },
      ],
    }, squad, { requireAllMembers: true, allowSkip: false })
    expect(plan.memberOrder).toEqual([reviewerId, researcherId, writerId])
    expect(plan.assignments.map(item => item.agentId)).toEqual(plan.memberOrder)

    const fallback = deterministicExecutionPlan(squad, 'ship', agents, undefined, 'parallel')
    expect(fallback.assignments.every(item => item.dependsOn.length === 0)).toBe(true)
  })

  it('rejects cycles/order violations and emits dependency-ready concurrent waves', () => {
    const squad = { name: 'Delivery', members: [researcherId, writerId, reviewerId] }
    expect(() => validateExecutionPlan({
      decision: 'run', reason: 'bad', summary: 'bad', planner: 'main-agent',
      memberOrder: [researcherId, writerId],
      assignments: [
        { agentId: researcherId, task: 'one', dependsOn: [writerId] },
        { agentId: writerId, task: 'two', dependsOn: [researcherId] },
      ],
    }, squad, { requireAllMembers: false, allowSkip: false })).toThrow(/dependency|cycle/)

    expect(executionWaves([
      { agentId: researcherId, task: 'one', dependsOn: [] },
      { agentId: writerId, task: 'two', dependsOn: [] },
      { agentId: reviewerId, task: 'three', dependsOn: [researcherId, writerId] },
    ])).toEqual([
      [expect.objectContaining({ agentId: researcherId }), expect.objectContaining({ agentId: writerId })],
      [expect.objectContaining({ agentId: reviewerId })],
    ])
  })

  it('bounds every structured handoff while leaving raw output persistence independent', () => {
    const handoff = normalizeHandoff({
      summary: 's'.repeat(40_000),
      deliverables: Array.from({ length: 30 }, (_, index) => `${index}:${'d'.repeat(2_000)}`),
      risks: Array.from({ length: 30 }, () => 'r'.repeat(2_000)),
      changedFiles: Array.from({ length: 80 }, () => 'f'.repeat(2_000)),
    }, 'fallback')
    expect(handoff.summary).toHaveLength(16_000)
    expect(handoff.deliverables).toHaveLength(12)
    expect(handoff.risks).toHaveLength(12)
    expect(handoff.changedFiles).toHaveLength(50)
    expect(Math.max(...handoff.deliverables.map(item => item.length))).toBe(1_000)
    expect(normalizeHandoff(undefined, 'f'.repeat(20_000), 6_000).summary).toHaveLength(6_000)
    expect(() => normalizeHandoff(undefined, 'fallback', 999)).toThrow(/1000-32000/)
    expect(() => normalizeHandoff(undefined, 'fallback', 32_001)).toThrow(/1000-32000/)
  })

  it('smart planning may skip and adaptive planning may select a proper subset', async () => {
    let decision: 'skip' | 'run' = 'skip'
    const starts: string[] = []
    const state = createService({
      start: async (_provider, request) => {
        starts.push(request.label ?? '')
        const isPlanner = request.label?.includes('workflow planner') === true
        return {
          id: SessionId(`child-${starts.length}`),
          localAgent: undefined,
          result: Promise.resolve(isPlanner ? {
            output: [], stopReason: 'completed' as const,
            structured: decision === 'skip' ? {
              decision: 'skip', reason: 'trivial acknowledgement', summary: 'skip', memberOrder: [], assignments: [],
            } : {
              decision: 'run', reason: 'writer only', summary: 'subset', memberOrder: [writerId],
              assignments: [{ agentId: writerId, task: 'write only', dependsOn: [] }],
            },
          } : { output: [{ type: 'text' as const, text: 'done' }], stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId, writerId], activationMode: 'smart', memberSelectionMode: 'adaptive',
    })
    const skipped = await state.service.dispatch({ squadId, task: 'thanks' }, state.parent, new AbortController().signal, { sourceMessageId: 'smart-skip' })
    expect(skipped).toMatchObject({ status: 'skipped', members: [], plan: { decision: 'skip' } })
    expect(starts).toEqual(['Delivery/Main workflow planner'])

    decision = 'run'
    starts.length = 0
    const subset = await state.service.dispatch({ squadId, task: 'write it' }, state.parent, new AbortController().signal, { sourceMessageId: 'smart-run' })
    expect(subset.members.map(item => item.agentId)).toEqual([writerId])
    expect(starts).toEqual(['Delivery/Main workflow planner', 'Delivery/Writer'])
    expect(state.service.getRun(subset.dispatchId)?.members.find(item => item.agentId === researcherId)?.status).toBe('skipped')
  })

  it('starts a DAG wave concurrently and waits before scheduling its dependant', async () => {
    const first = deferred<{ output: never[]; structured: object; stopReason: 'completed' }>()
    const second = deferred<{ output: never[]; structured: object; stopReason: 'completed' }>()
    const labels: string[] = []
    const state = createService({
      start: async (_provider, request) => {
        labels.push(request.label ?? '')
        if (request.label?.includes('workflow planner')) return {
          id: SessionId('planner'), localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' as const, structured: {
            decision: 'run', reason: 'dag', summary: 'dag', memberOrder: [researcherId, writerId, reviewerId],
            assignments: [
              { agentId: researcherId, task: 'research', dependsOn: [] },
              { agentId: writerId, task: 'draft', dependsOn: [] },
              { agentId: reviewerId, task: 'review', dependsOn: [researcherId, writerId] },
            ],
          } }), async dispose() {},
        }
        const result = request.label === 'Delivery/Researcher' ? first.promise
          : request.label === 'Delivery/Writer' ? second.promise
            : Promise.resolve({ output: [], structured: { summary: 'reviewed', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const })
        return { id: SessionId(`member-${labels.length}`), localAgent: undefined, result, async dispose() {} }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId, reviewerId], executionMode: 'parallel', maxConcurrency: 2 })
    const dispatch = state.service.dispatch({ squadId, task: 'ship' }, state.parent, new AbortController().signal, { sourceMessageId: 'dag' })
    await vi.waitFor(() => expect(labels).toEqual(['Delivery/Main workflow planner', 'Delivery/Researcher', 'Delivery/Writer']))
    first.resolve({ output: [], structured: { summary: 'r', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' })
    second.resolve({ output: [], structured: { summary: 'w', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' })
    await expect(dispatch).resolves.toMatchObject({ status: 'completed' })
    expect(labels.at(-1)).toBe('Delivery/Reviewer')
  })
})

describe('v0.5 bounded quality and cancellation (R6, R9)', () => {
  it('persists live quality progress and bounds reject-repair-review to maxRounds', async () => {
    const reviewOne = deferred<{ output: never[]; structured: { approved: boolean; feedback: string }; stopReason: 'completed' }>()
    let reviewCount = 0
    const labels: string[] = []
    const state = createService({
      start: async (_provider, request) => {
        labels.push(request.label ?? '')
        if (request.label?.includes('Quality review')) {
          reviewCount += 1
          const result = reviewCount === 1 ? reviewOne.promise : Promise.resolve({
            output: [], structured: { approved: true, feedback: 'approved' }, stopReason: 'completed' as const,
          })
          return { id: SessionId(`review-${reviewCount}`), localAgent: undefined, result, async dispose() {} }
        }
        return {
          id: SessionId(`member-${labels.length}`), localAgent: undefined,
          result: Promise.resolve({ output: [], structured: { summary: 'done', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    const repairerId = AgentId('repairer')
    await state.agents.put(researcherId, agent('Worker'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.agents.put(repairerId, agent('Repairer'))
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId, reviewerId, repairerId],
      executionOrder: [researcherId, reviewerId, repairerId],
      qualityGate: { reviewerAgentId: reviewerId, repairAgentId: repairerId, maxRounds: 1 },
    })
    const dispatch = state.service.dispatch({ squadId, task: 'quality' }, state.parent, new AbortController().signal)
    await vi.waitFor(() => expect(state.service.listRuns()[0]).toMatchObject({
      phase: 'quality-review', qualityProgress: { round: 1, state: 'reviewing' },
    }))
    reviewOne.resolve({ output: [], structured: { approved: false, feedback: 'fix it' }, stopReason: 'completed' })
    const result = await dispatch
    expect(result.quality).toMatchObject({ approved: true, rounds: [
      { round: 1, approved: false, repair: { agentId: repairerId } },
      { round: 2, approved: true },
    ] })
    expect(labels.filter(label => label.includes('Quality review'))).toHaveLength(2)
    expect(labels.filter(label => label === 'Delivery/Repairer')).toHaveLength(2) // base member + one repair
    expect(state.service.getRun(result.dispatchId)?.phase).toBe('settled')
    expect('qualityProgress' in state.service.getRun(result.dispatchId)!).toBe(false)
  })

  it('normalizes a cancellation race across result, durable run, and member', async () => {
    const state = createService({
      start: async (_provider, request: SubagentStartRequest) => {
        const result = new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason ?? new Error('cancelled')), { once: true })
        })
        return { id: SessionId('slow-child'), localAgent: undefined, result, async dispose() {} }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    const dispatch = state.service.dispatch({ squadId, task: 'slow' }, state.parent, new AbortController().signal)
    await vi.waitFor(() => expect(state.service.listRuns()[0]?.members[0]?.status).toBe('running'))
    const id = state.service.listRuns()[0]!.id
    expect(state.service.cancelRun(id)).toBe(true)
    await expect(dispatch).resolves.toMatchObject({ status: 'cancelled', members: [{ status: 'cancelled' }] })
    expect(state.service.getRun(id)).toMatchObject({ status: 'cancelled', phase: 'settled', members: [{ status: 'cancelled' }] })
    expect(state.service.cancelRun(id)).toBe(false)
  })
})

describe('v0.5 official background and durable lifecycle (R7, R10-R11)', () => {
  it('uses the optional official jobs registry and propagates its cancel hook', async () => {
    let hooks: ReturnType<NonNullable<Parameters<NonNullable<{ start(spec: { run(): unknown }): string }['start']>>[0]['run']>> | any
    let received: Record<string, unknown> | undefined
    const state = createService({
      start: async (_provider, request) => {
        const result = new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('job cancelled')), { once: true })
        })
        return { id: SessionId('background-child'), localAgent: undefined, result, async dispose() {} }
      },
    })
    state.ctx.provide('jobs', {
      start(spec: { kind: string; label: string; outputLimitBytes: number; owner: Agent; run(): unknown }) {
        received = spec as unknown as Record<string, unknown>
        hooks = spec.run()
        return 'agent-team-1'
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], responseMode: 'background' })
    const started = await state.service.startBackgroundDispatch({ squadId, task: 'slow background' }, state.parent)
    expect(started).toEqual({ id: expect.any(String), status: 'queued', jobId: 'agent-team-1' })
    expect(received).toMatchObject({ kind: 'agent-team', outputLimitBytes: 8_192, owner: state.parent })
    expect(state.service.getRun(started.id)).toMatchObject({ responseMode: 'background', backgroundJobId: 'agent-team-1' })
    hooks.cancel('stop')
    await expect(hooks.done).resolves.toMatchObject({ status: 'killed' })
    await vi.waitFor(() => expect(state.service.getRun(started.id)?.status).toBe('cancelled'))
  })

  it('reconciles every orphan active state and preserves settled rows', async () => {
    const table = new MemoryTable<DispatchId, SquadRunRecord>()
    await table.put(DispatchId('planning'), activeRun('planning', 'planning', 'planning'))
    await table.put(DispatchId('queued'), activeRun('queued', 'queued', 'queued'))
    await table.put(DispatchId('running'), {
      ...activeRun('running', 'running', 'members'),
      members: [{ agentId: researcherId, agentName: 'Researcher', provider: 'p', model: 'm', status: 'running', attempts: 1, output: [] }],
    })
    await table.put(DispatchId('done'), settledRun('done'))
    const history = new RunHistoryStore(table)
    await expect(history.reconcileInterrupted(999)).resolves.toBe(3)
    for (const id of ['planning', 'queued', 'running']) expect(table.get(DispatchId(id))).toMatchObject({ status: 'interrupted', phase: 'settled', endedAt: 999 })
    expect(table.get(DispatchId('running'))?.members[0]).toMatchObject({ status: 'interrupted', endedAt: 999 })
    expect(table.get(DispatchId('done'))?.status).toBe('completed')
  })

  it('links retry history, scopes member retry to one start, summarizes output, and clears immutably', async () => {
    const state = createService()
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId, writerId, reviewerId],
      qualityGate: { reviewerAgentId: reviewerId, repairAgentId: writerId, maxRounds: 2 },
    })
    const source = settledRun('source', {
      status: 'interrupted',
      startedAt: Date.now(),
      members: [{ agentId: researcherId, agentName: 'Researcher', provider: 'configured', model: 'researcher', status: 'interrupted', attempts: 1, output: [{ type: 'text', text: 'large raw output' }] }],
      plan: {
        decision: 'run', reason: 'persisted', summary: 'persisted', planner: 'deterministic-fallback',
        memberOrder: [researcherId], assignments: [{ agentId: researcherId, task: 'retry only this assignment', dependsOn: [] }],
      },
    })
    await state.runs.put(source.id, source)
    const retried = await state.service.retryRun(source.id, state.parent, researcherId)
    await vi.waitFor(() => expect(state.service.getRun(retried.id)?.status).toBe('completed'))
    expect(state.starts).toHaveLength(1)
    expect(state.service.getRun(retried.id)).toMatchObject({ retryOf: source.id })
    expect(state.service.listRuns(undefined, 50, false).find(run => run.id === source.id)?.members[0]?.output).toEqual([])
    await expect(state.service.clearRuns({ id: source.id })).resolves.toBe(1)
    expect(state.service.getRun(source.id)).toBeUndefined()
    expect(state.service.getRun(retried.id)?.retryOf).toBe(source.id)
  })

  it('applies count/age retention without deleting active ownership', async () => {
    const table = new MemoryTable<DispatchId, SquadRunRecord>()
    await table.put(DispatchId('active'), { ...activeRun('active', 'running', 'members'), startedAt: 1 })
    for (let index = 0; index < 5; index += 1) await table.put(DispatchId(`done-${index}`), settledRun(`done-${index}`, { startedAt: 100 + index }))
    const history = new RunHistoryStore(table)
    await expect(history.enforceRetention(2, 0, 1_000)).resolves.toBe(3)
    expect(table.get(DispatchId('active'))?.status).toBe('running')
    expect([...table.keys()].filter(id => String(id).startsWith('done-'))).toHaveLength(2)
    await expect(history.enforceRetention(0, 1, 2 * 86_400_000)).resolves.toBe(2)
    expect(table.get(DispatchId('active'))?.status).toBe('running')
    expect([...table.keys()].filter(id => String(id).startsWith('done-'))).toHaveLength(0)
  })

  it('keeps upgrade-sized run and version history when retention is not explicitly enabled', async () => {
    const baseConfig = {
      defaultProvider: 'spawn',
      defaultExecutionMode: 'serial' as const,
      defaultContextMode: 'spawn' as const,
    }
    expect(AgentTeamService.Config(baseConfig)).toMatchObject({
      historyMaxRuns: 0,
      historyMaxAgeDays: 0,
      versionMaxPerSquad: 0,
    })
    expect(AgentTeamService.Config({ ...baseConfig, historyMaxRuns: 0, historyMaxAgeDays: 0, versionMaxPerSquad: 0 })).toMatchObject({
      historyMaxRuns: 0,
      historyMaxAgeDays: 0,
      versionMaxPerSquad: 0,
    })
    expect(AgentTeamService.Config({ ...baseConfig, historyMaxRuns: 100, historyMaxAgeDays: 30, versionMaxPerSquad: 100 })).toMatchObject({
      historyMaxRuns: 100,
      historyMaxAgeDays: 30,
      versionMaxPerSquad: 100,
    })
    expect(() => AgentTeamService.Config({ ...baseConfig, historyMaxRuns: 5_001 })).toThrow()
    expect(() => AgentTeamService.Config({ ...baseConfig, historyMaxAgeDays: 3_651 })).toThrow()
    expect(() => AgentTeamService.Config({ ...baseConfig, versionMaxPerSquad: 1_001 })).toThrow()

    const state = createService()
    for (let index = 0; index < 313; index += 1) {
      await state.runs.put(DispatchId(`upgrade-run-${index}`), settledRun(`upgrade-run-${index}`, { startedAt: index }))
    }
    const recovered = await (state.service as unknown as {
      recoverRunHistory(): Promise<{ reconciled: number; pruned: number }>
    }).recoverRunHistory()
    expect(recovered).toEqual({ reconciled: 0, pruned: 0 })
    expect(state.runs.size).toBe(313)

    await state.service.createAgent(agent('Researcher'), researcherId)
    await state.service.createSquad({ name: 'v0', members: [researcherId] }, squadId)
    for (let index = 1; index <= 125; index += 1) {
      await state.service.updateSquad(squadId, { name: `v${index}`, members: [researcherId] })
    }
    expect(state.service.listSquadVersions(squadId)).toHaveLength(126)
    expect(state.service.listSquadVersions(squadId)[0]?.version).toBe(126)
  })
})

describe('v0.5 usage, versions, recipes, and transactions (D1, D3-D5)', () => {
  it('attributes planner/member/review/repair usage and includes the planner model bucket', async () => {
    const table = new MemoryTable<DispatchId, SquadRunRecord>()
    await table.put(DispatchId('usage-run'), settledRun('usage-run', {
      usage: usage(100),
      plan: {
        decision: 'run', reason: 'x', summary: 'x', memberOrder: [researcherId], assignments: [{ agentId: researcherId, task: 'x', dependsOn: [] }],
        planner: 'main-agent', plannerProvider: 'planner-provider', plannerModel: 'planner-model', usage: usage(10),
      },
      members: [
        { agentId: researcherId, agentName: 'Researcher', provider: 'member-provider', model: 'member-model', status: 'completed', attempts: 1, output: [], usage: usage(20) },
        { agentId: reviewerId, agentName: 'Reviewer', provider: 'quality-provider', model: 'review-model', status: 'completed', attempts: 1, output: [] },
        { agentId: writerId, agentName: 'Repairer', provider: 'quality-provider', model: 'repair-model', status: 'completed', attempts: 1, output: [] },
      ],
      quality: { approved: true, rounds: [{
        round: 1, approved: true, feedback: 'ok',
        reviewer: { agentId: reviewerId, agentName: 'Reviewer', provider: 'actual-review', model: 'review-v2', status: 'completed', attempts: 1, output: [], usage: usage(30) },
        repair: { agentId: writerId, agentName: 'Repairer', provider: 'actual-repair', model: 'repair-v2', status: 'completed', attempts: 1, output: [], usage: usage(40) },
      }] },
    }))
    const insight = new RunHistoryStore(table).insights({})
    expect(insight).toMatchObject({
      usage: { totalTokens: 100 }, plannerUsage: { totalTokens: 10 }, memberUsage: { totalTokens: 20 },
      reviewUsage: { totalTokens: 30 }, repairUsage: { totalTokens: 40 }, qualityUsage: { totalTokens: 70 },
    })
    expect(insight.byModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'planner-provider/planner-model', usage: expect.objectContaining({ totalTokens: 10, providerReported: true }) }),
      expect.objectContaining({ key: 'actual-review/review-v2', usage: expect.objectContaining({ totalTokens: 30, providerReported: true }) }),
      expect.objectContaining({ key: 'actual-repair/repair-v2', usage: expect.objectContaining({ totalTokens: 40, providerReported: true }) }),
    ]))
  })

  it('previews an exact historical version, restores member snapshots, and versions other affected squads', async () => {
    const state = createService()
    await state.service.createAgent(agent('Original'), researcherId)
    await state.service.createAgent(agent('Writer'), writerId)
    await state.service.createSquad({ name: 'Primary', members: [researcherId] }, squadId)
    const sharedId = SquadId('shared')
    await state.service.createSquad({ name: 'Shared', members: [researcherId, writerId] }, sharedId)
    await state.service.updateAgent(researcherId, { ...agent('Changed'), model: 'changed-model' })
    const sharedVersionsBefore = state.service.listSquadVersions(sharedId).length
    const preview = await state.service.previewSquadRestore(squadId, 1)
    expect(preview).toMatchObject({ squadId, version: 1, memberSnapshots: [{ record: { name: 'Original' } }] })
    expect(preview.affectedSquads).toEqual([{ squadId: sharedId, squadName: 'Shared', agentIds: [researcherId] }])
    await state.service.restoreSquadVersion(squadId, 1)
    expect(state.service.getAgent(researcherId)?.name).toBe('Original')
    expect(state.service.listSquadVersions(sharedId)).toHaveLength(sharedVersionsBefore + 1)
  })

  it('retains only the configured version cap while version numbers remain monotonic', async () => {
    const state = createService()
    Object.assign(state.service, { config: { defaultProvider: 'spawn', defaultExecutionMode: 'serial', defaultContextMode: 'spawn', versionMaxPerSquad: 10 } })
    await state.service.createAgent(agent('Researcher'), researcherId)
    await state.service.createSquad({ name: 'v0', members: [researcherId] }, squadId)
    for (let index = 1; index <= 15; index += 1) await state.service.updateSquad(squadId, { name: `v${index}`, members: [researcherId] })
    const versions = state.service.listSquadVersions(squadId)
    expect(versions).toHaveLength(10)
    expect(versions[0]?.version).toBe(16)
    expect(versions.at(-1)?.version).toBe(7)
  })

  it('previews full replace impact without writes and rejects credential-like extra fields', async () => {
    const state = createService()
    await state.service.createAgent(agent('Researcher'), researcherId)
    await state.service.createSquad({ name: 'Delivery', members: [researcherId] }, squadId)
    await state.service.setSessionSquadMode(SessionId('chat'), squadId)
    const before = await state.service.exportDefinitions()
    const preview = await state.service.previewDefinitionsImport({
      format: 'agent-team-gui/definitions', version: 2,
      agents: [{ id: writerId, ...agent('Writer') }], squads: [],
    }, 'replace')
    expect(preview).toMatchObject({ incoming: { agents: 1, squads: 0 }, deletions: { agents: 1, squads: 1, sessionModes: 1 } })
    expect(await state.service.exportDefinitions()).toMatchObject({ agents: before.agents, squads: before.squads })
    await expect(state.service.previewDefinitionsImport({
      format: 'agent-team-gui/definitions', version: 2,
      agents: [{ id: writerId, ...agent('Writer'), apiKey: 'must-not-enter-backup' }], squads: [],
    })).rejects.toThrow()
    expect(JSON.stringify(before)).not.toMatch(/apiKey|token|credential/i)
  })

  it('keeps recipe preview read-only, applies route remaps, and rolls back ghost versions on failure', async () => {
    const source = createService()
    await source.service.createAgent(agent('Researcher'), researcherId)
    await source.service.createSquad({ name: 'Delivery', members: [researcherId] }, squadId)
    const recipe = await source.service.exportRecipe(squadId)
    const target = createService({
      resolveModelInfo: vi.fn(async (provider: string, model: string) => {
        if (`${provider}/${model}` !== 'available/remapped') throw new Error('missing route')
        return { provider, id: model, name: model }
      }),
    })
    const preview = await target.service.previewRecipe(recipe, {
      [researcherId]: { provider: 'available', model: 'remapped' },
    })
    expect(preview).toMatchObject({ valid: true, agents: [{ provider: 'available', model: 'remapped' }] })
    expect(target.service.listAgents()).toEqual([])

    const remapped: AgentTeamRecipeDocument = {
      ...recipe,
      agents: recipe.agents.map(item => ({ ...item, provider: 'available', model: 'remapped' })),
    }
    const originalPut = target.versions.put.bind(target.versions)
    let fail = true
    target.versions.put = async (key, value) => {
      await originalPut(key, value)
      if (fail) { fail = false; throw new Error('version backend failed after write') }
    }
    await expect(target.service.importRecipe(remapped, 'merge')).rejects.toThrow('version backend failed')
    expect(target.service.listAgents()).toEqual([])
    expect(target.service.listSquads()).toEqual([])
    expect([...target.versions.entries()]).toEqual([])
  })

  it('aggregates operation and rollback failures instead of hiding either error', async () => {
    const table = new MemoryTable<'row', string>()
    await table.put('row', 'before')
    const originalPut = table.put.bind(table)
    let puts = 0
    table.put = async (key, value) => {
      puts += 1
      if (puts >= 2) throw new Error('rollback failed')
      await originalPut(key, value)
    }
    const unit = new StorageUnitOfWork()
    unit.capture(table)
    await expect(unit.run(async () => {
      await table.put('row', 'during')
      throw new Error('operation failed')
    })).rejects.toMatchObject({ name: 'AggregateError', errors: [expect.any(Error), expect.any(Error)] })
  })
})

describe('v0.5 one-shot and policy hardening (R2, R8)', () => {
  it('atomically gives two concurrent messages at most one one-shot claim and hides a claimed override', async () => {
    const state = createService()
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    await state.service.setNextSessionSquadMode(state.parent.id, 'team', squadId)
    const claim = (messageId: string) => (state.service as unknown as {
      claimNextSessionSquadMode(sessionId: SessionId, messageId: string): Promise<unknown>
    }).claimNextSessionSquadMode(state.parent.id, messageId)
    const claims = await Promise.all([claim('message-a'), claim('message-b')])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(state.service.getNextSessionSquadMode(state.parent.id)).toBeUndefined()

    const claimMessage = (agentValue: Agent) => (state.service as unknown as {
      claimGuaranteedMessage(agent: Agent, id: string, kind: 'solo' | 'team'): Promise<boolean>
    }).claimGuaranteedMessage(agentValue, 'same-message', 'team')
    const restoredAgent = { id: state.parent.id, session: state.parent.session } as Agent
    const messageClaims = await Promise.all([claimMessage(state.parent), claimMessage(restoredAgent)])
    expect(messageClaims.filter(Boolean)).toHaveLength(1)
  })

  it.each([undefined, { outputSchema: true, toolFilter: false, depthLimit: true, persona: true }])(
    'fails closed when a provider cannot enforce recursion denial (%s)',
    async (capabilities) => {
      const state = createService({
        toolSchemas: () => [
          { name: 'dispatch_to_squad', description: 'team' },
          { name: 'subagent', description: 'delegate' },
          { name: 'read_file', description: 'read' },
        ],
      })
      ;(state.ctx.subagents as unknown as { getProvider(): unknown }).getProvider = () => capabilities === undefined ? undefined : { capabilities }
      await state.agents.put(researcherId, agent('Researcher'))
      await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
      await expect(state.service.dispatch({ squadId, task: 'must not recurse' }, state.parent, new AbortController().signal))
        .rejects.toMatchObject({ code: 'INVALID_DISPATCH', message: expect.stringContaining('cannot enforce') })
      expect(state.service.listRuns()[0]).toMatchObject({ status: 'failed', members: [{ status: 'failed', error: expect.stringContaining('cannot enforce') }] })
      expect(state.starts).toEqual([])
    },
  )

  it('stores preset-scoped tool names and validates allow-lists against the dispatching session', async () => {
    const state = createService({ toolSchemas: () => [{ name: 'read_file', description: 'read' }] })
    await expect(state.service.createAgent({ ...agent('Scoped'), toolScope: { allow: ['missing_tool'] } }, researcherId))
      .resolves.toBe(researcherId)
    await state.service.createSquad({ name: 'Scoped', members: [researcherId] }, squadId)
    await expect(state.service.dispatch({ squadId, task: 'validate scoped tools' }, state.parent, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH', message: expect.stringContaining('unavailable in this session') })
    expect(state.starts).toEqual([])
  })
})

describe('v0.5 release-hardening regressions', () => {
  it('serializes a failing compensated import before a later successful definition write', async () => {
    const state = createService()
    const blocked = deferred<void>()
    const originalPut = state.agents.put.bind(state.agents)
    let failImport = true
    state.agents.put = async (key, value) => {
      if (key === researcherId && failImport) {
        failImport = false
        await originalPut(key, value)
        await blocked.promise
        throw new Error('import write failed after mutation')
      }
      await originalPut(key, value)
    }
    const importing = state.service.importDefinitions({
      format: 'agent-team-gui/definitions', version: 2,
      agents: [{ id: researcherId, ...agent('Researcher') }], squads: [],
    })
    await vi.waitFor(() => expect(state.agents.get(researcherId)).toBeDefined())
    const later = state.service.createAgent(agent('Writer'), writerId)
    await Promise.resolve()
    expect(state.service.getAgent(writerId)).toBeUndefined()
    blocked.resolve()
    await expect(importing).rejects.toThrow('import write failed')
    await expect(later).resolves.toBe(writerId)
    expect(state.service.getAgent(researcherId)).toBeUndefined()
    expect(state.service.getAgent(writerId)?.name).toBe('Writer')
  })

  it('versions existing squads whose shared agent is changed by full or recipe merge', async () => {
    const state = createService()
    await state.service.createAgent(agent('Original'), researcherId)
    await state.service.createAgent(agent('Writer'), writerId)
    await state.service.createSquad({ name: 'Imported', members: [researcherId] }, squadId)
    const sharedId = SquadId('shared-import')
    await state.service.createSquad({ name: 'Shared', members: [researcherId, writerId] }, sharedId)
    const beforeFull = state.service.listSquadVersions(sharedId).length
    const full = {
      format: 'agent-team-gui/definitions' as const, version: 2 as const,
      agents: [{ id: researcherId, ...agent('Changed', 'changed') }],
      squads: [{ id: squadId, name: 'Imported', members: [researcherId] }],
    }
    const preview = await state.service.previewDefinitionsImport(full)
    expect(preview.affectedSquads).toEqual(expect.arrayContaining([
      { squadId: sharedId, squadName: 'Shared', agentIds: [researcherId] },
    ]))
    await state.service.importDefinitions(full)
    expect(state.service.listSquadVersions(sharedId)).toHaveLength(beforeFull + 1)

    const recipe: AgentTeamRecipeDocument = {
      format: 'agent-team-gui/recipe', version: 1, exportedAt: Date.now(),
      squad: { id: squadId, name: 'Imported', members: [researcherId] },
      agents: [{ id: researcherId, ...agent('Changed Again', 'changed-again') }],
    }
    const beforeRecipe = state.service.listSquadVersions(sharedId).length
    expect((await state.service.previewRecipe(recipe)).affectedSquads).toEqual(expect.arrayContaining([
      { squadId: sharedId, squadName: 'Shared', agentIds: [researcherId] },
    ]))
    await state.service.importRecipe(recipe, 'merge')
    expect(state.service.listSquadVersions(sharedId)).toHaveLength(beforeRecipe + 1)
    await expect(state.service.importRecipe(recipe, 'overwrite' as never)).rejects.toMatchObject({ code: 'INVALID_IMPORT' })
  })

  it('renders bounded tool handoffs without feeding a huge raw-output sentinel to the lead model', () => {
    const state = createService()
    const tool = createDispatchToSquadTool(state.service)
    const sentinel = `RAW-TAIL-${'x'.repeat(200_000)}`
    const rendered = tool.output.render({}, {
      dispatchId: 'dispatch', squadId: 'delivery', squadName: 'Delivery', task: 'ship',
      executionMode: 'serial', contextMode: 'spawn', status: 'completed', startedAt: 1, endedAt: 2,
      usage: usage(10) as never,
      members: [{
        agentId: 'researcher', agentName: 'Researcher', status: 'completed', attempts: 1,
        output: [{ type: 'text', text: sentinel }],
        handoff: { summary: 'bounded', deliverables: [], risks: [], changedFiles: [] } as never,
      }],
    })
    const text = (rendered[0] as { text: string }).text
    expect(text).not.toContain('RAW-TAIL')
    expect(text).toContain('Full member outputs are persisted in Run Center')
    expect(text.length).toBeLessThan(20_000)
    expect(tool.isConcurrencySafe?.({})).toBe(false)
  })

  it('rejects an identical active dispatch in one session but never blocks another session', async () => {
    const slow = deferred<{ output: never[]; stopReason: 'completed' }>()
    let calls = 0
    const state = createService({
      start: async () => {
        calls += 1
        return { id: SessionId(`slow-${calls}`), localAgent: undefined, result: calls === 1 ? slow.promise : Promise.resolve({ output: [], stopReason: 'completed' as const }), async dispose() {} }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    const first = state.service.dispatch({ squadId, task: 'same' }, state.parent, new AbortController().signal)
    await vi.waitFor(() => expect(calls).toBe(1))
    await expect(state.service.dispatch({ squadId, task: 'same' }, state.parent, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH', message: expect.stringContaining('already active') })
    const otherParent = { ...state.parent, id: SessionId('other'), session: { header: { cwd: '/workspace/project' } } } as Agent
    await expect(state.service.dispatch({ squadId, task: 'same' }, otherParent, new AbortController().signal)).resolves.toMatchObject({ status: 'completed' })
    slow.resolve({ output: [], stopReason: 'completed' })
    await expect(first).resolves.toMatchObject({ status: 'completed' })
  })

  it.each([0, 1, 2] as const)('quality maxRepairRounds=%i never exceeds its fixed review/repair bound', async (maxRounds) => {
    const labels: string[] = []
    const state = createService({
      start: async (_provider, request) => {
        labels.push(request.label ?? '')
        const isReview = request.label?.includes('Quality review') === true
        return {
          id: SessionId(`q-${labels.length}`), localAgent: undefined,
          result: Promise.resolve(isReview
            ? { output: [], structured: { approved: false, feedback: 'still failing' }, stopReason: 'completed' as const }
            : { output: [], structured: { summary: 'attempt', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    const repairerId = AgentId('bounded-repairer')
    await state.agents.put(researcherId, agent('Worker'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.agents.put(repairerId, agent('Repairer'))
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId, reviewerId, repairerId], executionOrder: [researcherId, reviewerId, repairerId],
      qualityGate: { reviewerAgentId: reviewerId, repairAgentId: repairerId, maxRounds },
    })
    const result = await state.service.dispatch({ squadId, task: 'bounded quality' }, state.parent, new AbortController().signal)
    expect(result.quality?.rounds).toHaveLength(maxRounds + 1)
    expect(labels.filter(label => label.includes('Quality review'))).toHaveLength(maxRounds + 1)
    expect(labels.filter(label => label === 'Delivery/Repairer')).toHaveLength(1 + maxRounds)
  })

  it('streams live official planner and review usage, then removes transient buckets at settlement', async () => {
    const planner = deferred<{ output: never[]; structured: object; stopReason: 'completed' }>()
    const review = deferred<{ output: never[]; structured: object; stopReason: 'completed' }>()
    let listener: ((session: Agent['session'], key: string, value: unknown, seq: number) => void) | undefined
    let current = usage(0)
    let plannerAgent: Agent | undefined
    let reviewAgent: Agent | undefined
    const state = createService({
      start: async (_provider, request) => {
        if (request.label?.includes('workflow planner')) {
          plannerAgent = { id: SessionId('live-planner'), session: { header: {} } } as unknown as Agent
          return { id: plannerAgent.id, localAgent: plannerAgent, result: planner.promise, async dispose() {} }
        }
        if (request.label?.includes('Quality review')) {
          reviewAgent = { id: SessionId('live-review'), session: { header: {} } } as unknown as Agent
          return { id: reviewAgent.id, localAgent: reviewAgent, result: review.promise, async dispose() {} }
        }
        return { id: SessionId('member'), localAgent: undefined, result: Promise.resolve({ output: [], structured: { summary: 'done', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }), async dispose() {} }
      },
    })
    state.ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { tokenUsage: current } }),
      onChanged: (next: typeof listener) => { listener = next; return () => { listener = undefined } },
    })
    await state.agents.put(researcherId, agent('Worker'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.agents.put(writerId, agent('Repairer'))
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId, reviewerId, writerId],
      qualityGate: { reviewerAgentId: reviewerId, repairAgentId: writerId, maxRounds: 0 },
    })
    const dispatch = state.service.dispatch({ squadId, task: 'meter auxiliary' }, state.parent, new AbortController().signal, { sourceMessageId: 'meter-plan' })
    await vi.waitFor(() => expect(plannerAgent).toBeDefined())
    current = usage(11)
    listener?.(plannerAgent!.session, 'tokenUsage', current, 1)
    await vi.waitFor(() => expect(state.service.listRuns()[0]?.liveUsage?.planner?.totalTokens).toBe(11))
    planner.resolve({ output: [], stopReason: 'completed', structured: {
      decision: 'run', reason: 'all', summary: 'all', memberOrder: [researcherId, reviewerId, writerId],
      assignments: [
        { agentId: researcherId, task: 'work', dependsOn: [] },
        { agentId: reviewerId, task: 'prepare', dependsOn: [researcherId] },
        { agentId: writerId, task: 'stand by', dependsOn: [reviewerId] },
      ],
    } })
    await vi.waitFor(() => expect(reviewAgent).toBeDefined())
    current = usage(23)
    listener?.(reviewAgent!.session, 'tokenUsage', current, 2)
    await vi.waitFor(() => expect(state.service.listRuns()[0]?.liveUsage?.review?.totalTokens).toBe(23))
    review.resolve({ output: [], structured: { approved: true, feedback: 'ok' }, stopReason: 'completed' })
    const result = await dispatch
    expect(result.plan?.usage?.totalTokens).toBe(11)
    expect(result.quality?.rounds[0]?.reviewer.usage?.totalTokens).toBe(23)
    expect(state.service.getRun(result.dispatchId)?.liveUsage).toBeUndefined()
  })

  it('reports mixed metered/unmetered samples without hiding known token totals', async () => {
    const table = new MemoryTable<DispatchId, SquadRunRecord>()
    const member = (reported: boolean) => ({
      agentId: researcherId, agentName: 'Researcher', provider: 'p', model: 'm', status: 'completed' as const,
      attempts: 1, output: [], ...(reported ? { usage: usage(9) } : {}),
    })
    await table.put(DispatchId('metered'), settledRun('metered', { usage: usage(9), members: [member(true)] }))
    await table.put(DispatchId('unmetered'), settledRun('unmetered', { usage: { ...usage(0), providerReported: false }, members: [member(false)] }))
    const insight = new RunHistoryStore(table).insights({})
    expect(insight).toMatchObject({ meteredRuns: 1, unmeteredRuns: 1 })
    expect(insight.byAgent[0]).toMatchObject({
      usage: { totalTokens: 9, providerReported: true }, meteredSamples: 1, unmeteredSamples: 1,
    })
  })

  it('enforces durable numeric limits and cold-start cleanup for a claimed one-shot', async () => {
    const state = createService()
    await expect(state.service.createAgent({ ...agent('Huge'), maxTokens: 1_000_001 }, AgentId('huge'))).rejects.toThrow()
    await state.agents.put(researcherId, agent('Researcher'))
    await expect(state.service.createSquad({ name: 'Huge', members: [researcherId], tokenBudget: 100_000_001 }, SquadId('huge'))).rejects.toThrow()
    await expect(state.service.createSquad({ name: 'Tiny handoff', members: [researcherId], handoffSummaryMaxChars: 999 }, SquadId('tiny-handoff'))).rejects.toThrow()
    await expect(state.service.createSquad({ name: 'Huge handoff', members: [researcherId], handoffSummaryMaxChars: 32_001 }, SquadId('huge-handoff'))).rejects.toThrow()
    await expect(state.service.createSquad({ name: 'Bounded handoff', members: [researcherId], handoffSummaryMaxChars: 32_000 }, SquadId('bounded-handoff'))).resolves.toBeDefined()
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    await state.service.setNextSessionSquadMode(state.parent.id, 'team', squadId)
    await (state.service as unknown as { claimNextSessionSquadMode(id: SessionId, message: string): Promise<unknown> })
      .claimNextSessionSquadMode(state.parent.id, 'old-message')
    expect(state.service.getNextSessionSquadMode(state.parent.id)).toBeUndefined()
    await (state.service as unknown as { pruneMessageClaims(): Promise<number> }).pruneMessageClaims()
    expect(state.nextModes.get(state.parent.id)).toBeUndefined()
  })
})

describe('v0.5 P1 compatibility and mutation certainty', () => {
  it('reopens v0 rows and imports v1 limits without weakening v2 or materializing inherited fields', async () => {
    const ids = Array.from({ length: 33 }, (_, index) => AgentId(`legacy-${index}`))
    const legacyAgent = { ...agent('N'.repeat(121)), maxTokens: 2_000_000 }
    const legacySquad = { name: 'Legacy 33', members: ids }
    expect(agentRecordReadSchema.parse(legacyAgent)).toEqual(legacyAgent)
    expect(squadRecordReadSchema.parse(legacySquad)).toEqual(legacySquad)
    expect(() => agentRecordSchema.parse(legacyAgent)).toThrow()
    expect(() => squadRecordSchema.parse(legacySquad)).toThrow()

    const state = createService()
    const v1 = {
      format: 'agent-team-gui/definitions' as const,
      version: 1 as const,
      agents: ids.map((id, index) => ({ id, ...(index === 0 ? legacyAgent : agent(`Legacy ${index}`)) })),
      squads: [{ id: squadId, ...legacySquad }],
    }
    await expect(state.service.importDefinitions(v1, 'replace')).resolves.toEqual({ agents: 33, squads: 1 })
    expect(state.service.getAgent(ids[0]!)?.name).toHaveLength(121)
    const stored = state.service.getSquad(squadId)!
    expect(stored.members).toHaveLength(33)
    expect('executionMode' in stored).toBe(false)
    expect('contextMode' in stored).toBe(false)
    expect('planningContext' in stored).toBe(false)
    expect(state.service.definitionDefaults()).toEqual({
      executionMode: 'serial', fixedOrderExecutionMode: 'serial', contextMode: 'spawn', planningContext: 'full', plannerMaxTokens: 2_048,
    })
    expect((await state.service.exportDefinitions()).version).toBe(1)

    const legacyRecipe = await state.service.exportRecipe(squadId)
    expect(legacyRecipe.agents).toHaveLength(33)
    const recipeTarget = createService()
    const recipePreview = await recipeTarget.service.previewRecipe(legacyRecipe)
    expect(recipePreview).toMatchObject({ valid: true, agents: expect.any(Array) })
    await expect(recipeTarget.service.importRecipe(
      legacyRecipe,
      'merge',
      {},
      undefined,
      recipePreview.definitionRevision,
    )).resolves.toMatchObject({ agents: 33 })
    expect(recipeTarget.service.getSquad(squadId)?.members).toHaveLength(33)

    // RPC accepts one remap per legacy member; the ceiling intentionally
    // matches the 256-member recipe compatibility envelope rather than v2's 32.
    const remaps = Object.fromEntries(ids.map(id => [id, { provider: 'configured', model: 'remapped' }]))
    const rpcTarget = createService()
    const rpcPreview = await createAgentTeamRpcHandler(rpcTarget.ctx, rpcTarget.service)(
      'recipe/preview', { doc: legacyRecipe, routeRemap: remaps }, new AbortController().signal,
    )
    expect(rpcPreview).toMatchObject({ ok: true, value: { valid: true, agents: expect.any(Array) } })

    const fresh = createService()
    await expect(fresh.service.importDefinitions({ ...v1, version: 2 }, 'replace')).rejects.toThrow()
    expect(fresh.service.listAgents()).toEqual([])

    const emptyLegacy = {
      format: 'agent-team-gui/definitions' as const,
      version: 1 as const,
      agents: [],
      squads: [{ id: SquadId('legacy-empty'), name: 'Legacy empty squad', members: [] }],
    }
    const reopened = createService()
    await reopened.squads.put(SquadId('cold-empty'), squadRecordReadSchema.parse({ name: 'Cold empty', members: [] }))
    expect(reopened.service.getSquad(SquadId('cold-empty'))?.members).toEqual([])
    await expect(reopened.service.importDefinitions(emptyLegacy, 'replace')).resolves.toEqual({ agents: 0, squads: 1 })
    expect(reopened.service.getSquad(SquadId('legacy-empty'))?.members).toEqual([])
    await expect(reopened.service.importDefinitions({ ...emptyLegacy, version: 2 }, 'replace')).rejects.toThrow()
  })

  it('maps an invalid imported route to the stable INVALID_IMPORT bad-request contract', async () => {
    const state = createService({
      resolveModelInfo: vi.fn(async () => { throw new Error('route is unavailable') }),
    })
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)
    const result = await handler('import/preview', {
      mode: 'merge',
      doc: {
        format: 'agent-team-gui/definitions', version: 2,
        agents: [{ id: researcherId, ...agent('Unavailable', 'missing-model') }],
        squads: [{ id: squadId, name: 'Unavailable', members: [researcherId] }],
      },
    }, new AbortController().signal)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: expect.stringContaining('INVALID_IMPORT: invalid import agent "researcher" route configured/missing-model') },
    })
  })

  it('rolls back uncertain create and import commits when their RPC signal aborts', async () => {
    const createState = createService()
    const createHandler = createAgentTeamRpcHandler(createState.ctx, createState.service)
    const createController = new AbortController()
    const originalAgentPut = createState.agents.put.bind(createState.agents)
    let abortCreate = true
    createState.agents.put = async (key, value) => {
      await originalAgentPut(key, value)
      if (abortCreate) { abortCreate = false; createController.abort(new Error('create timeout')) }
    }
    const cancelledCreate = await createHandler('agent/create', { record: agent('Timed Create') }, createController.signal)
    expect(cancelledCreate).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(createState.service.listAgents()).toEqual([])
    const retriedCreate = await createHandler('agent/create', { record: agent('Timed Create') }, new AbortController().signal)
    expect(retriedCreate.ok).toBe(true)
    expect(createState.service.listAgents()).toHaveLength(1)

    const importState = createService()
    await importState.service.createAgent(agent('Existing'), writerId)
    const importHandler = createAgentTeamRpcHandler(importState.ctx, importState.service)
    const importController = new AbortController()
    const originalSquadPut = importState.squads.put.bind(importState.squads)
    let abortImport = true
    importState.squads.put = async (key, value) => {
      await originalSquadPut(key, value)
      if (abortImport) { abortImport = false; importController.abort(new Error('import timeout')) }
    }
    const document = {
      format: 'agent-team-gui/definitions' as const, version: 2 as const,
      agents: [{ id: researcherId, ...agent('Imported') }],
      squads: [{ id: squadId, name: 'Imported team', members: [researcherId] }],
    }
    const importPreview = await importState.service.previewDefinitionsImport(document, 'replace')
    const cancelledImport = await importHandler('import', {
      doc: document, mode: 'replace', expectedRevision: importPreview.definitionRevision,
    }, importController.signal)
    expect(cancelledImport).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(importState.service.listAgents()).toEqual([[writerId, agent('Existing')]])
    expect(importState.service.listSquads()).toEqual([])
    expect(importState.service.listSquadVersions(squadId)).toEqual([])
    await expect(importState.service.importDefinitions(document, 'replace')).resolves.toEqual({ agents: 1, squads: 1 })
  })

  it('does not retry or clear durable runs after the RPC mutation signal is already aborted', async () => {
    let liveParent: Agent | undefined
    const state = createService({ agentsGet: () => liveParent })
    liveParent = state.parent
    await state.runs.put(DispatchId('abort-source'), settledRun('abort-source', {
      startedAt: Date.now() - 1_000,
      endedAt: Date.now() - 500,
    }))
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)
    const retrySignal = new AbortController()
    retrySignal.abort(new Error('retry request expired'))
    await expect(handler('run/retry', { id: 'abort-source' }, retrySignal.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(state.service.listRuns()).toHaveLength(1)

    const clearSignal = new AbortController()
    clearSignal.abort(new Error('clear request expired'))
    await expect(handler('run/clear', {
      id: 'abort-source', settledOnly: true,
    }, clearSignal.signal)).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(state.service.getRun(DispatchId('abort-source'))).toBeDefined()
  })

  it('keeps cross-table reads behind replace and freezes one run definition graph against edits', async () => {
    const state = createService()
    await state.service.createAgent(agent('Old Member', 'old-model'), researcherId)
    await state.service.createSquad({ name: 'Old Delivery', members: [researcherId] }, squadId)
    const blocked = deferred<void>()
    const originalPut = state.agents.put.bind(state.agents)
    state.agents.put = async (key, value) => {
      await originalPut(key, value)
      if (key === researcherId && value.name === 'New Member') await blocked.promise
    }
    const replacement = {
      format: 'agent-team-gui/definitions' as const, version: 2 as const,
      agents: [{ id: researcherId, ...agent('New Member', 'new-model') }],
      squads: [{ id: squadId, name: 'New Delivery', members: [researcherId] }],
    }
    const importing = state.service.importDefinitions(replacement, 'replace')
    await vi.waitFor(() => {
      expect(state.agents.get(researcherId)?.name).toBe('New Member')
      expect(state.squads.get(squadId)).toBeUndefined()
    })
    const recipeDocument: AgentTeamRecipeDocument = {
      format: 'agent-team-gui/recipe', version: 1, exportedAt: 1,
      agents: [{ id: researcherId, ...agent('New Member', 'new-model') }],
      squad: { id: squadId, name: 'New Delivery', members: [researcherId] },
    }
    let settledReads = 0
    const observed = <T>(promise: Promise<T>): Promise<T> => promise.finally(() => { settledReads += 1 })
    const reads = [
      observed(state.service.readDefinitionSnapshot()),
      observed(state.service.exportRecipe(squadId)),
      observed(state.service.previewRecipe(recipeDocument)),
      observed(state.service.diagnoseSquad(squadId)),
      observed(state.service.dispatch({ squadId, task: 'use one coherent graph' }, state.parent, new AbortController().signal)),
    ] as const
    await Promise.resolve()
    expect(settledReads).toBe(0)
    blocked.resolve()
    await importing
    const [snapshot, exported, preview, diagnosed, dispatched] = await Promise.all(reads)
    expect([...snapshot.agents.values()][0]?.name).toBe('New Member')
    expect([...snapshot.squads.values()][0]?.name).toBe('New Delivery')
    expect(exported).toMatchObject({ squad: { name: 'New Delivery' }, agents: [{ name: 'New Member' }] })
    expect(preview).toMatchObject({ valid: true })
    expect(diagnosed).toMatchObject({ ok: true })
    expect(dispatched).toMatchObject({ squadName: 'New Delivery', members: [{ agentName: 'New Member' }] })

    const first = deferred<{ output: never[]; structured: object; stopReason: 'completed' }>()
    const labels: string[] = []
    const frozen = createService({
      start: async (_provider, request) => {
        labels.push(request.label ?? '')
        return {
          id: SessionId(`frozen-${labels.length}`), localAgent: undefined,
          result: labels.length === 1 ? first.promise : Promise.resolve({ output: [], structured: { summary: 'second', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await frozen.service.createAgent(agent('Researcher V1'), researcherId)
    await frozen.service.createAgent(agent('Writer V1'), writerId)
    await frozen.service.createSquad({ name: 'Frozen', members: [researcherId, writerId], executionOrder: [researcherId, writerId] }, squadId)
    const running = frozen.service.dispatch({ squadId, task: 'freeze definitions' }, frozen.parent, new AbortController().signal)
    await vi.waitFor(() => expect(labels).toEqual(['Frozen/Researcher V1']))
    await frozen.service.updateAgent(writerId, agent('Writer V2', 'writer-v2'))
    first.resolve({ output: [], structured: { summary: 'first', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' })
    await expect(running).resolves.toMatchObject({ status: 'completed' })
    expect(labels).toEqual(['Frozen/Researcher V1', 'Frozen/Writer V1'])
  })

  it('replays the immutable DAG for whole retry and the exact original assignment for member retry', async () => {
    const requests: SubagentStartRequest[] = []
    const state = createService({
      start: async (_provider, request) => {
        requests.push(request)
        return {
          id: SessionId(`retry-child-${requests.length}`), localAgent: undefined,
          result: Promise.resolve({ output: [], structured: { summary: 'done', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId], executionMode: 'parallel' })
    const source = settledRun('retry-source', {
      startedAt: Date.now() - 1_000,
      endedAt: Date.now() - 500,
      executionMode: 'parallel',
      members: [
        { agentId: researcherId, agentName: 'Researcher', provider: 'configured', model: 'researcher', status: 'completed', attempts: 1, output: [] },
        { agentId: writerId, agentName: 'Writer', provider: 'configured', model: 'writer', status: 'completed', attempts: 1, output: [] },
      ],
      plan: {
        decision: 'run', reason: 'source', summary: 'source DAG', planner: 'main-agent',
        memberOrder: [writerId, researcherId],
        assignments: [
          { agentId: writerId, task: 'implement only the module', dependsOn: [] },
          { agentId: researcherId, task: 'audit the implemented module', dependsOn: [writerId] },
        ],
      },
    })
    await state.runs.put(source.id, source)
    const whole = await state.service.retryRun(source.id, state.parent)
    await vi.waitFor(() => expect(state.service.getRun(whole.id)?.status).toBe('completed'))
    expect(requests.map(request => request.label)).toEqual(['Delivery/Writer', 'Delivery/Researcher'])
    expect(state.service.getRun(whole.id)?.plan).toMatchObject({
      memberOrder: [writerId, researcherId],
      assignments: [
        { agentId: writerId, task: 'implement only the module', dependsOn: [] },
        { agentId: researcherId, task: 'audit the implemented module', dependsOn: [writerId] },
      ],
    })

    requests.length = 0
    const member = await state.service.retryRun(source.id, state.parent, writerId)
    await vi.waitFor(() => expect(state.service.getRun(member.id)?.status).toBe('completed'))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.label).toBe('Delivery/Writer')
    const prompt = requests[0]?.prompt.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
    expect(prompt).toContain('Your exclusive assignment:\nimplement only the module')
    expect(state.service.getRun(member.id)?.quality).toBeUndefined()
  })

  it('persists normalized fixed and explicit plans so whole retries cannot drift', async () => {
    const starts: SubagentStartRequest[] = []
    const state = createService({
      start: async (_provider, request) => {
        starts.push(request)
        return {
          id: SessionId(`normalized-${starts.length}`), localAgent: undefined,
          result: Promise.resolve({ output: [], structured: { summary: 'done', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.squads.put(squadId, {
      name: 'Fixed', members: [researcherId, writerId], executionOrder: [writerId, researcherId],
    })
    const fixed = await state.service.dispatch({ squadId, task: 'fixed task' }, state.parent, new AbortController().signal)
    expect(fixed.plan).toMatchObject({
      memberOrder: [writerId, researcherId],
      assignments: [
        { agentId: writerId, task: expect.stringContaining('Exclusive role boundary for Writer'), dependsOn: [] },
        { agentId: researcherId, task: expect.stringContaining('Exclusive role boundary for Researcher'), dependsOn: [writerId] },
      ],
    })
    const fixedRetry = await state.service.retryRun(fixed.dispatchId, state.parent)
    await vi.waitFor(() => expect(state.service.getRun(fixedRetry.id)?.status).toBe('completed'))
    expect(state.service.getRun(fixedRetry.id)?.plan?.memberOrder).toEqual([writerId, researcherId])

    const explicitId = SquadId('explicit-plan')
    const longExplicitAssignment = `write-only-${'z'.repeat(60_000)}`
    await state.squads.put(explicitId, { name: 'Explicit', members: [researcherId, writerId], executionMode: 'parallel' })
    const explicit = await state.service.dispatch({
      squadId: explicitId,
      task: 'explicit task',
      memberOrder: [writerId, researcherId],
      assignments: [
        { agentId: writerId, task: longExplicitAssignment },
        { agentId: researcherId, task: 'research only' },
      ],
    }, state.parent, new AbortController().signal)
    expect(explicit.plan).toMatchObject({
      memberOrder: [writerId, researcherId],
      assignments: [
        { agentId: writerId, task: longExplicitAssignment, dependsOn: [] },
        { agentId: researcherId, task: 'research only', dependsOn: [] },
      ],
    })
    const explicitRetry = await state.service.retryRun(explicit.dispatchId, state.parent)
    await vi.waitFor(() => expect(state.service.getRun(explicitRetry.id)?.status).toBe('completed'))
    expect(state.service.getRun(explicitRetry.id)?.plan?.assignments).toEqual(explicit.plan?.assignments)
  })

  it('keeps role and planning contracts ahead of bounded excerpts for a maximum-size request', async () => {
    const requests: SubagentStartRequest[] = []
    const task = `HEAD-SENTINEL-${'x'.repeat(99_960)}-TAIL-SENTINEL`
    const state = createService({
      start: async (_provider, request) => {
        requests.push(request)
        const planner = request.label?.includes('workflow planner') === true
        return {
          id: SessionId(`bounded-prompt-${requests.length}`), localAgent: undefined,
          result: Promise.resolve(planner
            ? { output: [], structured: {
                decision: 'run', reason: 'bounded', summary: 'bounded', memberOrder: [researcherId],
                assignments: [{ agentId: researcherId, task: 'exclusive bounded assignment', dependsOn: [] }],
              }, stopReason: 'completed' as const }
            : { output: [], structured: { summary: 'done', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, { ...agent('Researcher'), systemPrompt: `ROLE-SENTINEL ${'r'.repeat(20_000)}` })
    await state.squads.put(squadId, { name: 'Bounded', members: [researcherId] })
    const result = await state.service.dispatch({ squadId, task }, state.parent, new AbortController().signal, { sourceMessageId: 'bounded-prompt' })
    const plannerPrompt = requests[0]?.prompt[0]?.type === 'text' ? requests[0].prompt[0].text : ''
    const memberPrompt = requests[1]?.prompt[0]?.type === 'text' ? requests[1].prompt[0].text : ''
    expect(plannerPrompt.indexOf('Planning contract (must follow)')).toBeLessThan(plannerPrompt.indexOf('User request (bounded'))
    expect(plannerPrompt).toContain('HEAD-SENTINEL')
    expect(plannerPrompt).toContain('TAIL-SENTINEL')
    expect(plannerPrompt.length).toBeLessThan(90_000)
    expect(memberPrompt.indexOf('Execution boundary')).toBeLessThan(memberPrompt.indexOf('Overall squad goal'))
    expect(memberPrompt).toContain('Your exclusive assignment:\nexclusive bounded assignment')
    expect(memberPrompt).toContain('ROLE-SENTINEL')
    expect(memberPrompt).toContain('HEAD-SENTINEL')
    expect(memberPrompt).toContain('TAIL-SENTINEL')
    expect(memberPrompt.length).toBeLessThan(80_000)
    expect(state.service.getRun(result.dispatchId)?.task).toBe(task)

    const fallback = deterministicExecutionPlan(
      { name: 'Bounded', members: [researcherId] },
      task,
      new Map([[researcherId, { ...agent('Researcher'), systemPrompt: `ROLE-SENTINEL ${'r'.repeat(20_000)}` }]]),
      'w'.repeat(20_000),
      'serial',
    )
    expect(fallback.assignments[0]?.task.startsWith('Exclusive role boundary for Researcher:')).toBe(true)
    expect(fallback.assignments[0]?.task).toContain('ROLE-SENTINEL')
    expect(fallback.assignments[0]?.task).toContain('HEAD-SENTINEL')
    expect(fallback.assignments[0]?.task).toContain('TAIL-SENTINEL')
    expect(fallback.assignments[0]?.task.length).toBeLessThanOrEqual(50_000)
    expect(fallback.warning?.length).toBeLessThanOrEqual(8_000)
  })

  it('reports full, partial, and none run-level metering without changing any-sample semantics', async () => {
    const table = new MemoryTable<DispatchId, SquadRunRecord>()
    const runMember = (reported: boolean) => ({
      agentId: researcherId, agentName: 'Researcher', provider: 'p', model: 'm', status: 'completed' as const,
      attempts: 1, output: [], ...(reported ? { usage: usage(5) } : {}),
    })
    const plan = (reported: boolean) => ({
      decision: 'run' as const, reason: 'planned', summary: 'planned', planner: 'main-agent' as const,
      plannerProvider: 'planner', plannerModel: 'model', memberOrder: [researcherId],
      assignments: [{ agentId: researcherId, task: 'work', dependsOn: [] }],
      ...(reported ? { usage: usage(2) } : {}),
    })
    const quality = {
      approved: true,
      rounds: [{
        round: 1, approved: true, feedback: 'ok',
        reviewer: { agentId: reviewerId, agentName: 'Reviewer', status: 'completed' as const, output: [], attempts: 1, usage: usage(3) },
        repair: { agentId: writerId, agentName: 'Writer', status: 'completed' as const, output: [], attempts: 1, usage: usage(4) },
      }],
    }
    await table.put(DispatchId('coverage-full'), settledRun('coverage-full', { usage: usage(14), plan: plan(true), members: [runMember(true)], quality }))
    await table.put(DispatchId('coverage-partial'), settledRun('coverage-partial', { usage: usage(2), plan: plan(true), members: [runMember(false)] }))
    await table.put(DispatchId('coverage-none'), settledRun('coverage-none', { usage: { ...usage(0), providerReported: false }, plan: plan(false), members: [runMember(false)] }))
    const history = new RunHistoryStore(table)
    expect(Object.fromEntries(history.list().map(run => [run.id, run.meteringCoverage]))).toEqual({
      'coverage-full': 'full', 'coverage-partial': 'partial', 'coverage-none': 'none',
    })
    expect(history.insights({})).toMatchObject({
      runCount: 3, fullyMeteredRuns: 1, partiallyMeteredRuns: 1, meteredRuns: 2, unmeteredRuns: 1,
      usage: { providerReported: true },
    })

    await table.put(DispatchId('coverage-retry-partial'), settledRun('coverage-retry-partial', {
      usage: usage(5),
      members: [{ ...runMember(true), attempts: 2, usageSamples: { metered: 1, total: 2 } }],
    }))
    expect(history.list().find(run => run.id === 'coverage-retry-partial')?.meteringCoverage).toBe('partial')
  })

  it('keeps retry-once live usage monotonic and persists attempt-level coverage', async () => {
    const first = deferred<{ output: never[]; stopReason: 'error' }>()
    const second = deferred<{ output: never[]; structured: object; stopReason: 'completed' }>()
    const projections = new Map<Agent['session'], AgentTokenUsage>()
    let listener: ((session: Agent['session'], key: string, value: unknown, seq: number) => void) | undefined
    let attempts = 0
    let activeSession: Agent['session'] | undefined
    const state = createService({
      start: async () => {
        attempts += 1
        const session = { header: { seedLength: 1 } } as Agent['session']
        activeSession = session
        projections.set(session, usage(0))
        const localAgent = { id: SessionId(`retry-usage-${attempts}`), session } as unknown as Agent
        return {
          id: localAgent.id,
          localAgent,
          result: attempts === 1 ? first.promise : second.promise,
          async dispose() {},
        }
      },
    })
    state.ctx.provide('sessionProjections', {
      snapshot: (session: Agent['session']) => ({ values: { tokenUsage: projections.get(session) ?? usage(0) } }),
      onChanged: (next: typeof listener) => { listener = next; return () => { listener = undefined } },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, {
      name: 'Retry usage', members: [researcherId], executionOrder: [researcherId], failurePolicy: 'retry-once',
    })
    const running = state.service.dispatch({ squadId, task: 'retry once' }, state.parent, new AbortController().signal)
    await vi.waitFor(() => expect(attempts).toBe(1))
    projections.set(activeSession!, usage(4)); listener?.(activeSession!, 'tokenUsage', usage(4), 1)
    await vi.waitFor(() => expect(state.service.listRuns()[0]?.members[0]?.usage?.totalTokens).toBe(4))
    first.resolve({ output: [], stopReason: 'error' })
    await vi.waitFor(() => expect(attempts).toBe(2))
    expect(state.service.listRuns()[0]?.members[0]?.usage?.totalTokens).toBe(4)
    projections.set(activeSession!, usage(2)); listener?.(activeSession!, 'tokenUsage', usage(2), 2)
    await vi.waitFor(() => expect(state.service.listRuns()[0]?.members[0]?.usage?.totalTokens).toBe(6))
    second.resolve({ output: [], structured: { summary: 'recovered', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' })
    const result = await running
    expect(result.usage.totalTokens).toBe(6)
    expect(state.service.getRun(result.dispatchId)?.members[0]).toMatchObject({
      attempts: 2, usage: { totalTokens: 6 }, usageSamples: { metered: 2, total: 2 },
    })
    expect(state.service.getRun(result.dispatchId)?.meteringCoverage).toBe('full')
  })

  it('captures a final provider projection published only during run disposal', async () => {
    let listener: ((session: Agent['session'], key: string, value: unknown, seq: number) => void) | undefined
    let current = usage(0)
    const childSession = { header: { seedLength: 1 } } as Agent['session']
    const state = createService({
      start: async () => {
        const localAgent = { id: SessionId('late-usage-child'), session: childSession } as unknown as Agent
        return {
          id: localAgent.id,
          localAgent,
          result: Promise.resolve({ output: [], structured: { summary: 'done', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {
            current = usage(9)
            listener?.(childSession, 'tokenUsage', current, 1)
          },
        }
      },
    })
    state.ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { tokenUsage: current } }),
      onChanged: (next: typeof listener) => { listener = next; return () => { listener = undefined } },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Late usage', members: [researcherId], executionOrder: [researcherId] })
    const result = await state.service.dispatch({ squadId, task: 'capture late usage' }, state.parent, new AbortController().signal)
    expect(result.usage).toMatchObject({ totalTokens: 9, providerReported: true })
    expect(state.service.getRun(result.dispatchId)?.members[0]).toMatchObject({
      usage: { totalTokens: 9 }, usageSamples: { metered: 1, total: 1 },
    })
  })

  it('claims model-tool dispatch once per durable human message, even after the first call settles', async () => {
    let starts = 0
    const state = createService({
      start: async () => {
        starts += 1
        return {
          id: SessionId(`tool-once-${starts}`), localAgent: undefined,
          result: Promise.resolve({ output: [], structured: { summary: 'done', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], triggerMode: 'model-tool' })
    const parent = {
      ...state.parent,
      session: {
        header: { cwd: '/workspace/project' },
        events: [{
          type: 'user/message', seq: 1, time: 1,
          data: { id: 'durable-human-message', content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } },
        }],
      },
    } as unknown as Agent
    const tool = createDispatchToSquadTool(state.service) as unknown as {
      execute(args: { squadId: string; task: string }, exec: { agent: Agent; signal: AbortSignal }): Promise<unknown>
    }
    await expect(tool.execute({ squadId, task: 'do it' }, { agent: parent, signal: new AbortController().signal })).resolves.toBeDefined()
    const callsAfterFirstDispatch = starts
    await expect(tool.execute({ squadId, task: 'do it' }, { agent: parent, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH', message: expect.stringContaining('already dispatched') })
    expect(callsAfterFirstDispatch).toBe(2) // one planner + one selected member
    expect(starts).toBe(callsAfterFirstDispatch)
    expect(state.service.listRuns()).toHaveLength(1)
    expect(state.service.listRuns()[0]).toMatchObject({ sourceMessageId: 'durable-human-message' })
  })

  it('updates durable cumulative usage after each quality review and repair settles', async () => {
    const reviewOne = deferred<{ output: never[]; structured: { approved: boolean; feedback: string }; stopReason: 'completed' }>()
    const repair = deferred<{ output: never[]; structured: object; stopReason: 'completed' }>()
    const reviewTwo = deferred<{ output: never[]; structured: { approved: boolean; feedback: string }; stopReason: 'completed' }>()
    let listener: ((session: Agent['session'], key: string, value: unknown, seq: number) => void) | undefined
    let current = usage(0)
    let activeAgent: Agent | undefined
    let reviews = 0
    let repairs = 0
    const state = createService({
      start: async (_provider, request) => {
        const qualityReview = request.label?.includes('Quality review') === true
        const qualityRepair = request.label === 'Delivery/Repairer' && repairs > 0
        if (qualityReview) {
          reviews += 1
          activeAgent = { id: SessionId(`quality-review-${reviews}`), session: { header: { seedLength: 1 } } } as unknown as Agent
          return { id: activeAgent.id, localAgent: activeAgent, result: reviews === 1 ? reviewOne.promise : reviewTwo.promise, async dispose() {} }
        }
        if (request.label === 'Delivery/Repairer') repairs += 1
        if (qualityRepair || repairs === 2) {
          activeAgent = { id: SessionId('quality-repair'), session: { header: { seedLength: 1 } } } as unknown as Agent
          return { id: activeAgent.id, localAgent: activeAgent, result: repair.promise, async dispose() {} }
        }
        return {
          id: SessionId(`base-${request.label}`), localAgent: undefined,
          result: Promise.resolve({ output: [], structured: { summary: 'base', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    state.ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { tokenUsage: current } }),
      onChanged: (next: typeof listener) => { listener = next; return () => { listener = undefined } },
    })
    const repairerId = AgentId('quality-repairer')
    await state.agents.put(researcherId, agent('Worker'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.agents.put(repairerId, agent('Repairer'))
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId, reviewerId, repairerId], executionOrder: [researcherId, reviewerId, repairerId],
      qualityGate: { reviewerAgentId: reviewerId, repairAgentId: repairerId, maxRounds: 1 },
    })
    const running = state.service.dispatch({ squadId, task: 'meter quality cumulatively' }, state.parent, new AbortController().signal)
    await vi.waitFor(() => expect(reviews).toBe(1))
    current = usage(5); listener?.(activeAgent!.session, 'tokenUsage', current, 1)
    reviewOne.resolve({ output: [], structured: { approved: false, feedback: 'repair' }, stopReason: 'completed' })
    await vi.waitFor(() => expect(repairs).toBe(2))
    current = usage(12); listener?.(activeAgent!.session, 'tokenUsage', current, 2)
    repair.resolve({ output: [], structured: { summary: 'repaired', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' })
    await vi.waitFor(() => expect(reviews).toBe(2))
    expect(state.service.listRuns()[0]).toMatchObject({
      phase: 'quality-review', qualityProgress: { round: 2, state: 'reviewing' }, usage: { totalTokens: 12 },
    })
    reviewTwo.resolve({ output: [], structured: { approved: true, feedback: 'ok' }, stopReason: 'completed' })
    await expect(running).resolves.toMatchObject({ status: 'completed', usage: { totalTokens: 12 } })
  })

  it('hard-denies scoped default/renamed subagent and workflow tools using real compiled schemas', async () => {
    let childFilter: unknown
    let observedScope: unknown
    const state = createService({
      toolSchemas: (scope) => {
        observedScope = scope
        if (scope === undefined) return [{ name: 'read_file', description: 'global read' }]
        return [
          { name: 'read_file', description: 'scoped read' },
          { name: 'dispatch_to_squad', description: 'Dispatch to a persistent squad.' },
          { name: 'subagent', description: 'Delegate work to a subagent.' },
          { name: 'workflow', description: 'Orchestrate subagents at scale.' },
          { name: 'optional_tool', description: 'Preset-specific optional tool.' },
          {
            name: 'delegate', description: 'Delegate work to a subagent.',
            parameters: {
              type: 'object',
              properties: { description: { type: 'string' }, prompt: { type: 'string' }, run_in_background: { type: 'boolean' } },
              required: ['description', 'prompt'],
            },
          },
          {
            name: 'swarm_script', description: 'Run a JavaScript workflow that orchestrates subagents at scale.',
            parameters: {
              type: 'object',
              properties: { script: { type: 'string' }, meta: { type: 'object' }, args: { type: 'object' } },
              required: ['script', 'meta'],
            },
          },
        ]
      },
      start: async (_provider, request) => {
        childFilter = request.toolFilter
        return { id: SessionId('delegate-safe'), localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' as const }), async dispose() {} }
      },
    })
    await state.agents.put(researcherId, {
      ...agent('Researcher'),
      toolScope: { allow: ['read_file'], deny: ['optional_tool'] },
    })
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    await state.service.dispatch({ squadId, task: 'do not delegate' }, state.parent, new AbortController().signal)
    expect(observedScope).toBe(state.parent)
    expect(childFilter).toMatchObject({
      allow: ['read_file'],
      deny: expect.arrayContaining(['optional_tool', 'dispatch_to_squad', 'subagent', 'workflow', 'delegate', 'swarm_script']),
    })

    const handler = createAgentTeamRpcHandler(state.ctx, state.service)
    await expect(handler('run/get', { id: 'definitely-missing' }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { run: null } })
  })

  it('only denies recursive fixed names present in a minimal parent tool scope', async () => {
    let childFilter: unknown
    const state = createService({
      toolSchemas: (scope) => scope === undefined
        ? [{ name: 'read_file', description: 'global read' }]
        : [
            { name: 'read_file', description: 'scoped read' },
            { name: 'dispatch_to_squad', description: 'Dispatch to a persistent squad.' },
          ],
      start: async (_provider, request) => {
        childFilter = request.toolFilter
        return {
          id: SessionId('minimal-safe'),
          localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, {
      ...agent('Researcher'),
      toolScope: { allow: ['read_file'], deny: ['optional_tool'] },
    })
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })

    await state.service.dispatch({ squadId, task: 'minimal preset' }, state.parent, new AbortController().signal)

    expect(childFilter).toEqual({ allow: ['read_file'], deny: ['dispatch_to_squad'] })
  })
})

describe('v0.5 final Host safety gates', () => {
  it('returns definitions when one model catalog hangs and aborts the snapshot promptly on request cancellation', async () => {
    vi.useFakeTimers()
    try {
      const listModels = vi.fn(async (provider: string) => provider === 'healthy'
        ? [{ provider, id: 'ready', name: 'Ready' }]
        : await new Promise<never>(() => {}))
      const state = createService({
        listProviders: () => [{ id: 'healthy', name: 'Healthy' }, { id: 'hung', name: 'Hung' }],
        listModels,
      })
      await state.agents.put(researcherId, agent('Researcher'))
      const handler = createAgentTeamRpcHandler(state.ctx, state.service)
      const pending = handler('snapshot', {}, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(1_501)
      await expect(pending).resolves.toMatchObject({
        ok: true,
        value: {
          agents: [{ id: researcherId, name: 'Researcher' }],
          models: [
            { provider: 'healthy', models: [{ id: 'ready', name: 'Ready' }] },
            { provider: 'hung', models: [] },
          ],
        },
      })

      const controller = new AbortController()
      const cancelled = handler('snapshot', {}, controller.signal)
      await Promise.resolve()
      controller.abort(new Error('snapshot closed'))
      await expect(cancelled).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps provider IO outside the definition writer and makes FIFO queue waits abortable', async () => {
    const route = deferred<void>()
    let blockRoute = false
    const resolveModelInfo = vi.fn(async (provider: string, model: string, signal?: AbortSignal) => {
      if (blockRoute) {
        await Promise.race([
          route.promise,
          new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
        ])
      }
      return { provider, id: model, name: model }
    })
    const state = createService({ resolveModelInfo })
    await state.service.createAgent(agent('Researcher'), researcherId)
    await state.service.createSquad({ name: 'Delivery', members: [researcherId] }, squadId)
    blockRoute = true
    const routeController = new AbortController()
    const updating = state.service.updateAgent(researcherId, agent('Researcher v2'), routeController.signal)
    await vi.waitFor(() => expect(resolveModelInfo).toHaveBeenCalledTimes(2))
    await expect(state.service.setSessionSquadMode(SessionId('unblocked-mode'), squadId)).resolves.toMatchObject({ squadId })
    await expect(state.service.readDefinitionSnapshot()).resolves.toMatchObject({
      agents: expect.any(Map), squads: expect.any(Map),
    })
    expect(resolveModelInfo.mock.calls[1]?.[2]).toBeInstanceOf(AbortSignal)
    route.resolve()
    await expect(updating).resolves.toBeUndefined()

    const coordinator = new WriteCoordinator()
    const writerGate = deferred<void>()
    const writer = coordinator.run(async () => { await writerGate.promise })
    await Promise.resolve()
    const controller = new AbortController()
    const waiting = coordinator.read(() => 'unreachable', controller.signal)
    controller.abort(new Error('queue wait cancelled'))
    await expect(waiting).rejects.toThrow('queue wait cancelled')
    writerGate.resolve()
    await writer
    await expect(coordinator.read(() => 'healthy')).resolves.toBe('healthy')
  })

  it('rejects oversized legacy envelopes before any provider route IO', async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({ provider, id: model, name: model }))
    const state = createService({ resolveModelInfo })
    const tooManyAgents = Array.from({ length: 2_001 }, (_, index) => ({
      id: `legacy-${index}`,
      ...agent(`Legacy ${index}`),
    }))
    await expect(state.service.previewDefinitionsImport({
      format: 'agent-team-gui/definitions', version: 1, agents: tooManyAgents, squads: [],
    })).rejects.toMatchObject({ code: 'INVALID_IMPORT', message: expect.stringContaining('2000 agents') })
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })

  it('rejects stale full-backup and recipe previews without writing any row', async () => {
    const state = createService()
    await state.service.createAgent(agent('Original'), researcherId)
    await state.service.createSquad({ name: 'Original', members: [researcherId] }, squadId)
    const replacement = {
      format: 'agent-team-gui/definitions' as const, version: 2 as const,
      agents: [{ id: writerId, ...agent('Incoming') }],
      squads: [{ id: SquadId('incoming'), name: 'Incoming', members: [writerId] }],
    }
    const fullPreview = await state.service.previewDefinitionsImport(replacement, 'replace')
    await state.service.updateAgent(researcherId, agent('Concurrent edit'))
    const beforeFull = await state.service.exportDefinitions()
    await expect(state.service.importDefinitions(
      replacement, 'replace', undefined, fullPreview.definitionRevision,
    )).rejects.toMatchObject({ code: 'INVALID_IMPORT', message: expect.stringContaining('stale import preview') })
    const afterFull = await state.service.exportDefinitions()
    expect({ agents: afterFull.agents, squads: afterFull.squads }).toEqual({ agents: beforeFull.agents, squads: beforeFull.squads })

    const recipe = await state.service.exportRecipe(squadId)
    const recipePreview = await state.service.previewRecipe(recipe)
    await state.service.createAgent(agent('Concurrent writer'), writerId)
    const beforeRecipe = await state.service.exportDefinitions()
    await expect(state.service.importRecipe(
      recipe, 'merge', {}, undefined, recipePreview.definitionRevision,
    )).rejects.toMatchObject({ code: 'INVALID_IMPORT', message: expect.stringContaining('stale recipe preview') })
    const afterRecipe = await state.service.exportDefinitions()
    expect({ agents: afterRecipe.agents, squads: afterRecipe.squads }).toEqual({ agents: beforeRecipe.agents, squads: beforeRecipe.squads })

    const restorePreview = await state.service.previewSquadRestore(squadId, 1)
    await state.service.updateAgent(researcherId, agent('Later concurrent edit'))
    await expect(state.service.restoreSquadVersion(
      squadId, 1, undefined, restorePreview.definitionRevision,
    )).rejects.toMatchObject({ code: 'INVALID_IMPORT', message: expect.stringContaining('stale restore preview') })
    expect(state.service.getAgent(researcherId)?.name).toBe('Later concurrent edit')
  })

  it('durably acknowledges a delayed background job and deduplicates direct and retry acceptance', async () => {
    let directStarts = 0
    const direct = createService()
    direct.ctx.provide('jobs', {
      start() { directStarts += 1; return 'agent-team-delayed' },
    })
    await direct.agents.put(researcherId, agent('Researcher'))
    await direct.squads.put(squadId, { name: 'Delivery', members: [researcherId], responseMode: 'background' })
    const durablePut = direct.runs.put.bind(direct.runs)
    let uncertainAcceptance = true
    direct.runs.put = async (id, value) => {
      await durablePut(id, value)
      if (uncertainAcceptance) { uncertainAcceptance = false; throw new Error('ack lost after durable write') }
    }
    const first = await direct.service.startBackgroundDispatch({ squadId, task: 'queued longer than the caller timeout' }, direct.parent)
    const duplicate = await direct.service.startBackgroundDispatch({ squadId, task: 'queued longer than the caller timeout' }, direct.parent)
    expect(duplicate.id).toBe(first.id)
    expect(directStarts).toBe(1)
    expect(direct.service.getRun(first.id)).toMatchObject({ status: 'queued', phase: 'queued', backgroundRequestKey: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(direct.service.cancelRun(first.id)).toBe(true)
    await vi.waitFor(() => expect(direct.service.getRun(first.id)).toMatchObject({ status: 'cancelled', phase: 'settled' }))

    let delayedSpec: { run(): { done: Promise<unknown> } } | undefined
    const frozen = createService()
    frozen.ctx.provide('jobs', {
      start(spec: { run(): { done: Promise<unknown> } }) { delayedSpec = spec; return 'agent-team-frozen' },
    })
    await frozen.agents.put(researcherId, agent('Accepted Name'))
    await frozen.squads.put(squadId, { name: 'Frozen Delivery', members: [researcherId] })
    const frozenRun = await frozen.service.startBackgroundDispatch({ squadId, task: 'freeze on acceptance' }, frozen.parent)
    await frozen.agents.put(researcherId, agent('Edited Too Late'))
    const hooks = delayedSpec!.run()
    await hooks.done
    expect(frozen.service.getRun(frozenRun.id)).toMatchObject({ status: 'completed', members: [{ agentName: 'Accepted Name' }] })

    let retryStarts = 0
    const retry = createService()
    retry.ctx.provide('jobs', { start() { retryStarts += 1; return 'agent-team-retry-delayed' } })
    await retry.agents.put(researcherId, agent('Researcher'))
    await retry.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    const source = settledRun('background-source', {
      plan: {
        decision: 'run', reason: 'persisted', summary: 'persisted', planner: 'deterministic-fallback',
        memberOrder: [researcherId], assignments: [{ agentId: researcherId, task: 'exact retry', dependsOn: [] }],
      },
      members: [{ agentId: researcherId, agentName: 'Researcher', provider: 'configured', model: 'researcher', status: 'completed', attempts: 1, output: [] }],
    })
    await retry.runs.put(source.id, source)
    const retryOne = await retry.service.retryRun(source.id, retry.parent)
    const retryTwo = await retry.service.retryRun(source.id, retry.parent)
    expect(retryTwo.id).toBe(retryOne.id)
    expect(retryStarts).toBe(1)
  })

  it('does not let retention cleanup failure replace a completed dispatch', async () => {
    const state = createService()
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], executionOrder: [researcherId] })
    for (let index = 0; index < 100; index += 1) {
      await state.runs.put(DispatchId(`old-${index}`), settledRun(`old-${index}`, { startedAt: index, endedAt: index + 1 }))
    }
    state.runs.delete = async () => { throw new Error('retention backend unavailable') }
    const result = await state.service.dispatch({ squadId, task: 'must still succeed' }, state.parent, new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(state.service.getRun(result.dispatchId)?.status).toBe('completed')
  })

  it('attributes primary/fallback attempts and partial metering to their real routes', async () => {
    let attempt = 0
    const fallbackSession = { header: {} } as Agent['session']
    const state = createService({
      start: async () => {
        attempt += 1
        if (attempt === 1) return {
          id: SessionId('primary-attempt'), localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'error' as const }), async dispose() {},
        }
        const localAgent = { id: SessionId('fallback-attempt'), session: fallbackSession } as unknown as Agent
        return {
          id: localAgent.id, localAgent,
          result: Promise.resolve({ output: [], structured: { summary: 'fallback', deliverables: [], risks: [], changedFiles: [] }, stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    state.ctx.provide('sessionProjections', { snapshot: () => ({ values: { tokenUsage: usage(7) } }) })
    await state.agents.put(researcherId, {
      ...agent('Researcher', 'primary-model'), provider: 'primary-provider',
      fallbackProvider: 'fallback-provider', fallbackModel: 'fallback-model',
    })
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId], executionOrder: [researcherId], failurePolicy: 'retry-once',
    })
    const result = await state.service.dispatch({ squadId, task: 'retry route' }, state.parent, new AbortController().signal)
    expect(state.service.getRun(result.dispatchId)).toMatchObject({
      meteringCoverage: 'partial',
      members: [{
        usageSamples: { metered: 1, total: 2 },
        attemptUsage: [
          { attempt: 1, provider: 'primary-provider', model: 'primary-model' },
          { attempt: 2, provider: 'fallback-provider', model: 'fallback-model', usage: { totalTokens: 7 } },
        ],
      }],
    })
    const insights = state.service.insights({})
    expect(insights.byModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'primary-provider/primary-model', meteredSamples: 0, unmeteredSamples: 1 }),
      expect.objectContaining({ key: 'fallback-provider/fallback-model', meteredSamples: 1, unmeteredSamples: 0, usage: expect.objectContaining({ totalTokens: 7 }) }),
    ]))
    expect(insights.byAgent).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: researcherId, meteredSamples: 1, unmeteredSamples: 1 }),
    ]))
  })

  it('does not poison the in-process message receipt when durable claim storage fails once', async () => {
    const state = createService()
    const originalPut = state.messageClaims.put.bind(state.messageClaims)
    let fail = true
    state.messageClaims.put = async (key, value) => {
      if (fail) { fail = false; throw new Error('temporary claim write failure') }
      await originalPut(key, value)
    }
    const claim = () => (state.service as unknown as {
      claimGuaranteedMessage(agent: Agent, messageId: string, kind: 'solo' | 'team'): Promise<boolean>
    }).claimGuaranteedMessage(state.parent, 'retryable-message', 'team')
    await expect(claim()).rejects.toThrow('temporary claim write failure')
    await expect(claim()).resolves.toBe(true)
  })
})
