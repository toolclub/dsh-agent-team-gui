import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_USAGE, type RunView } from '../src/client/contracts.ts'
import { AgentTeamController, isModeResponse, isTeamSnapshot } from '../src/client/controller.ts'
import { EMPTY_AGENT, EMPTY_SQUAD, squadDraftOf, toSquadRecord, validateAgent, validateSquad } from '../src/client/forms.ts'
import { completionRate, planStages } from '../src/client/view-models.ts'
import { CLIENT_STYLES } from '../src/client/styles.ts'

const VALID_SNAPSHOT = {
  apiVersion: 4,
  agents: [], squads: [], models: [], tools: [],
  capabilities: { smartActivation: true, dags: true, qualityGate: true, backgroundRuns: true, recipes: true, remoteRecipeFetch: false, insights: true, reproducibleVersions: true },
  defaults: { executionMode: 'serial', fixedOrderExecutionMode: 'serial', contextMode: 'fork', planningContext: 'full', plannerMaxTokens: 2_048 },
} as const

describe('client domain validation and view models', () => {
  afterEach(() => { vi.useRealTimers() })
  it('rejects partial fallback routes and tool conflicts but only warns for preset-scoped tools', () => {
    const base = { ...EMPTY_AGENT, name: 'Builder', systemPrompt: 'Build', provider: 'p', model: 'm' }

    expect(validateAgent({ ...base, fallbackProvider: 'p2' }, [{ name: 'read' }]).errors.fallback).toBe('fallbackPairError')
    expect(validateAgent({ ...base, allow: 'read', deny: 'read' }, [{ name: 'read' }]).errors.tools).toBe('toolConflictError')
    const scopedTool = validateAgent({ ...base, allow: 'shell' }, [{ name: 'read' }])
    expect(scopedTool.valid).toBe(true)
    expect(scopedTool.warnings.tools).toBe('unknownToolWarning')
  })

  it('enforces planner, concurrency, context, and quality combinations', () => {
    const agents = [
      { id: 'a', name: 'A', systemPrompt: 'A', provider: 'p', model: 'm' },
      { id: 'b', name: 'B', systemPrompt: 'B', provider: 'p', model: 'm' },
    ]
    const invalid = {
      ...EMPTY_SQUAD,
      name: 'Team',
      members: ['a', 'b'],
      plannerMaxTokens: '128',
      maxConcurrency: '33',
      contextMode: 'chain' as const,
      executionMode: 'parallel' as const,
      qualityEnabled: true,
      reviewerAgentId: 'a',
      repairAgentId: 'a',
    }
    expect(validateSquad(invalid, agents).errors).toMatchObject({
      plannerMaxTokens: 'plannerRange',
      maxConcurrency: 'concurrencyRange',
      contextMode: 'chainParallelConflict',
      qualityDistinct: 'qualityDistinctError',
    })
  })

  it('matches durable Host token bounds exactly', () => {
    const agent = { ...EMPTY_AGENT, name: 'A', systemPrompt: 'A', provider: 'p', model: 'm' }
    expect(validateAgent({ ...agent, maxTokens: '1000000' }).valid).toBe(true)
    expect(validateAgent({ ...agent, maxTokens: '1000001' }).errors.maxTokens).toBe('agentTokenRange')
    const squad = { ...EMPTY_SQUAD, name: 'T', members: ['a'] }
    expect(validateSquad({ ...squad, tokenBudget: '100000000' }, []).valid).toBe(true)
    expect(validateSquad({ ...squad, tokenBudget: '100000001' }, []).errors.tokenBudget).toBe('budgetRange')
    expect(validateSquad({ ...squad, memberTimeoutMs: '3600000' }, []).valid).toBe(true)
    expect(validateSquad({ ...squad, memberTimeoutMs: '3600001' }, []).errors.memberTimeoutMs).toBe('timeoutRange')
    expect(validateSquad({ ...squad, handoffSummaryMaxChars: '1000' }, []).valid).toBe(true)
    expect(validateSquad({ ...squad, handoffSummaryMaxChars: '32000' }, []).valid).toBe(true)
    expect(validateSquad({ ...squad, handoffSummaryMaxChars: '999' }, []).errors.handoffSummaryMaxChars).toBe('handoffSummaryRange')
    expect(validateSquad({ ...squad, handoffSummaryMaxChars: '32001' }, []).errors.handoffSummaryMaxChars).toBe('handoffSummaryRange')
  })

  it('matches Host definition size ceilings before Save', () => {
    const agent = { ...EMPTY_AGENT, name: 'A', systemPrompt: 'A', provider: 'p', model: 'm' }
    expect(validateAgent({ ...agent, name: 'n'.repeat(121) }).errors.name).toBe('nameLength')
    expect(validateAgent({ ...agent, systemPrompt: 'p'.repeat(50_001) }).errors.systemPrompt).toBe('promptLength')
    expect(validateAgent({ ...agent, allow: Array.from({ length: 257 }, (_, index) => `tool-${index}`).join(',') }).errors.tools).toBe('toolCountError')
    expect(validateAgent({ ...agent, allow: 't'.repeat(201) }).errors.tools).toBe('toolNameLengthError')
    const squad = { ...EMPTY_SQUAD, name: 'Team', members: Array.from({ length: 33 }, (_, index) => `a-${index}`) }
    expect(validateSquad(squad, []).errors.members).toBe('memberCountError')
    expect(validateSquad({ ...squad, members: ['a'], collabNote: 'x'.repeat(20_001) }, []).errors.collabNote).toBe('longTextLength')
    expect(validateSquad({ ...squad, members: ['a'], qualityEnabled: true, reviewerAgentId: 'a', repairAgentId: 'b', qualityCriteria: 'x'.repeat(20_001) }, []).errors.qualityCriteria).toBe('longTextLength')
  })

  it('aborts the underlying RPC at the same timeout boundary and ignores a late result', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    let resolveHost: ((value: unknown) => void) | undefined
    const controller = new AgentTeamController(async <T,>(_endpoint: string, _payload: unknown, requestSignal?: AbortSignal): Promise<T> => {
      signal = requestSignal
      return await new Promise<T>(resolve => { resolveHost = resolve as (value: unknown) => void })
    })
    const pending = controller.load().catch(reason => reason as Error)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(signal?.aborted).toBe(true)
    const failure = await pending
    expect(failure).toBeInstanceOf(Error)
    if (failure instanceof Error) expect(failure.message).toContain('请求超时')
    expect(controller.getSnapshot().status).toBe('error')
    resolveHost?.(VALID_SNAPSHOT)
    await Promise.resolve()
    expect(controller.getSnapshot().status).toBe('error')
  })

  it('preserves a review-only quality gate with zero repair rounds', () => {
    expect(squadDraftOf({
      id: 'team', name: 'Team', members: ['a', 'b'], collabNote: '',
      qualityGate: { reviewerAgentId: 'a', repairAgentId: 'b', maxRounds: 0 },
    }).qualityEnabled).toBe(true)
  })

  it('preserves omitted legacy orchestration defaults during unrelated edits', () => {
    const legacy = squadDraftOf({ id: 'team', name: 'Legacy', members: ['a'], collabNote: '' })
    expect(legacy).toMatchObject({ executionMode: 'inherit', contextMode: 'inherit', planningContext: 'inherit' })
    const record = toSquadRecord({ ...legacy, name: 'Renamed legacy' })
    expect(record).not.toHaveProperty('executionMode')
    expect(record).not.toHaveProperty('contextMode')
    expect(record).not.toHaveProperty('planningContext')
    expect(record).not.toHaveProperty('handoffSummaryMaxChars')
    expect(EMPTY_SQUAD).toMatchObject({ executionMode: 'serial', contextMode: 'fork', planningContext: 'current' })
  })

  it('round-trips a configured squad handoff summary limit', () => {
    const draft = squadDraftOf({
      id: 'team', name: 'Long-form', members: ['a'], collabNote: '', handoffSummaryMaxChars: 24_000,
    })
    expect(draft.handoffSummaryMaxChars).toBe('24000')
    expect(toSquadRecord(draft)).toMatchObject({ handoffSummaryMaxChars: 24_000 })
  })

  it('validates inherited context and execution against the Host defaults', () => {
    const draft = { ...EMPTY_SQUAD, name: 'Team', members: ['a'], executionMode: 'inherit' as const, contextMode: 'inherit' as const }
    const defaults = { executionMode: 'parallel' as const, fixedOrderExecutionMode: 'serial' as const, contextMode: 'chain' as const, planningContext: 'full' as const, plannerMaxTokens: 2048 }
    expect(validateSquad(draft, [], defaults).errors.contextMode).toBe('chainParallelConflict')
    expect(validateSquad({ ...draft, fixedOrder: true, executionOrder: ['a'] }, [], defaults).errors.contextMode).toBeUndefined()
  })

  it('layers a DAG and degrades a cycle to stable member order', () => {
    const plan = {
      summary: 'Plan', planner: 'main-agent' as const, memberOrder: ['a', 'b', 'c'], assignments: [
        { agentId: 'a', task: 'A', dependsOn: [] },
        { agentId: 'b', task: 'B', dependsOn: ['a'] },
        { agentId: 'c', task: 'C', dependsOn: ['a'] },
      ],
    }
    expect(planStages(plan)).toEqual([{ index: 0, agentIds: ['a'] }, { index: 1, agentIds: ['b', 'c'] }])
    expect(planStages({ ...plan, assignments: [
      { agentId: 'a', task: 'A', dependsOn: ['b'] },
      { agentId: 'b', task: 'B', dependsOn: ['a'] },
    ], memberOrder: ['a', 'b'] })).toEqual([{ index: 0, agentIds: ['a'] }, { index: 1, agentIds: ['b'] }])
    expect(planStages({ ...plan, assignments: [
      { agentId: 'a', task: 'A', dependsOn: [] },
      { agentId: 'b', task: 'B', dependsOn: ['c'] },
      { agentId: 'c', task: 'C', dependsOn: ['b'] },
    ] })).toEqual([{ index: 0, agentIds: ['a'] }, { index: 1, agentIds: ['b'] }, { index: 2, agentIds: ['c'] }])
  })

  it('does not count intentionally skipped or cancelled runs against completion rate', () => {
    const run = (id: string, status: RunView['status']): RunView => ({
      id, sessionId: 's', squadId: 't', squadName: 'Team', task: id, status, startedAt: 1,
      executionMode: 'serial', contextMode: 'fork', members: [], usage: EMPTY_USAGE,
    })
    expect(completionRate([run('done', 'completed'), run('skip', 'skipped'), run('cancel', 'cancelled'), run('fail', 'failed')])).toBe(.5)
    expect(completionRate([run('plan', 'planning'), run('queued', 'queued'), run('live', 'running')])).toBeNull()
  })

  it('rejects partial or contradictory v3 mode mutation responses', () => {
    const valid = {
      mode: null,
      sessionOverride: 'inherit' as const,
      sessionReady: true,
      projectKey: null,
      projectDefault: null,
      nextOverride: null,
    }
    expect(isModeResponse(valid)).toBe(true)
    expect(isModeResponse({ mode: null })).toBe(false)
    expect(isModeResponse({ ...valid, sessionOverride: 'enabled' })).toBe(false)
    expect(isModeResponse({ ...valid, sessionOverride: 'disabled', mode: { sessionId: 's', squadId: 't', squadName: 'T' } })).toBe(false)
    expect(isModeResponse({ ...valid, nextOverride: { squadId: 't' } })).toBe(false)
  })

  it('rejects malformed nested snapshot records before the catalog becomes ready', async () => {
    expect(isTeamSnapshot(VALID_SNAPSHOT)).toBe(true)
    expect(isTeamSnapshot({ ...VALID_SNAPSHOT, capabilities: undefined })).toBe(false)
    expect(isTeamSnapshot({ ...VALID_SNAPSHOT, defaults: { ...VALID_SNAPSHOT.defaults, plannerMaxTokens: 0 } })).toBe(false)
    expect(isTeamSnapshot({ apiVersion: 4, agents: [{ id: 'a' }], squads: [], models: [], tools: [] })).toBe(false)
    expect(isTeamSnapshot({ apiVersion: 4, agents: [], squads: [{ id: 't', name: 'T', collabNote: '', members: [42] }], models: [], tools: [] })).toBe(false)
    const controller = new AgentTeamController(async <T,>() => ({ apiVersion: 4, agents: [{ id: 'a' }], squads: [], models: [], tools: [] }) as T)
    await expect(controller.load()).rejects.toThrow('DeepSeek Harness')
    expect(controller.getSnapshot().status).toBe('error')
  })

  it('keeps responsive, reduced-motion, and theme styles scoped to plugin roots', () => {
    expect(CLIENT_STYLES).toContain('@media(max-width:760px)')
    expect(CLIENT_STYLES).toContain('@media(max-width:430px)')
    expect(CLIENT_STYLES).toContain('@media(prefers-reduced-motion:reduce)')
    expect(CLIENT_STYLES).toContain('var(--dsw-alias-bg-layer-1)')
    expect(CLIENT_STYLES).toContain('max-height:min(680px,calc(100dvh - 24px))')
    expect(CLIENT_STYLES).toContain('overscroll-behavior:contain')
    expect(CLIENT_STYLES).toContain('scrollbar-gutter:stable')
    expect(CLIENT_STYLES).toContain('width:min(350px,calc(100vw - 24px))')
    expect(CLIENT_STYLES).toContain('.atg-mode-panel.placement-above')
    expect(CLIENT_STYLES).toContain(':is(.atg-page,.atg-run-center,.atg-composer-wrap,.atg-run-dock-wrap,.atg-slot-fallback) small{font-size:11px}')
    expect(CLIENT_STYLES).toContain('.atg-synthesis small{font-size:12px;color:var(--dsw-alias-label-secondary)}')
    expect(CLIENT_STYLES).not.toMatch(/\nbutton:focus-visible/)
    expect(CLIENT_STYLES).not.toContain('.sr-only')
  })
})
