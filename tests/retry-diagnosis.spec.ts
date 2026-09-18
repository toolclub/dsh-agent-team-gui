import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { squadRunRecordSchema } from '../src/spec.ts'
import { exhaustedQuota, retryDecisionSchema } from '../src/tools/retry-diagnosis.ts'
import { agent, createService, researcherId, squadId, writerId } from './helpers.ts'

const decision = {
  action: 'revise', cause: 'task-scope', confidence: 'limited',
  reason: 'The broad assignment exhausted the attempt before tests were added.',
  evidence: ['Member reported completing the API; stop reason is max-tokens.'],
  progress: 'API may be complete; inspect src/api.ts before changing it.',
  nextTask: 'Verify the existing API, then implement the remaining UI and tests in order. Preserve the original acceptance criteria.',
  uncertainty: 'The reported API changes have not been independently verified.',
} as const

async function setup(structured: unknown = decision, config: { budget?: number; failDiagnosis?: boolean; abort?: AbortController; failRetry?: boolean } = {}) {
  const calls: SubagentStartRequest[] = []
  const meters = new Map<Agent['session'], number>()
  let memberAttempts = 0
  const state = createService({ start: async (_provider, request) => {
    calls.push(request)
    const diagnosis = request.agentOptions?.agentTeamGuiDiagnosis === true
    if (diagnosis && config.failDiagnosis) throw new Error('diagnosis unavailable')
    if (!diagnosis) memberAttempts++
    if (diagnosis) config.abort?.abort()
    const session = {
      firstLiveSeq: 0,
      snapshotEvents: () => [{ type: 'tool/result', data: { content: 'wrote src/api.ts' } }],
    } as unknown as Agent['session']
    meters.set(session, diagnosis ? 3 : 7)
    const localAgent = { id: SessionId(`attempt-${calls.length}`), session } as unknown as Agent
    return {
      id: localAgent.id, localAgent, async dispose() {},
      result: Promise.resolve(diagnosis
        ? { output: [], stopReason: 'completed' as const, structured }
        : memberAttempts === 1 || config.failRetry
          ? { output: [{ type: 'text' as const, text: 'API done; UI and tests remain.' }], stopReason: 'max-tokens' as const }
          : { output: [{ type: 'text' as const, text: 'API, UI and tests verified.' }], stopReason: 'completed' as const }),
    }
  } })
  state.ctx.provide('sessionProjections', { snapshot: (session: Agent['session']) => ({ values: { tokenUsage: {
    uncachedInputTokens: meters.get(session) ?? 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  } } }) })
  await state.agents.put(researcherId, agent('Builder'))
  await state.squads.put(squadId, {
    name: 'Delivery', members: [researcherId], executionOrder: [researcherId], failurePolicy: 'retry-once',
    ...(config.budget === undefined ? {} : { tokenBudget: config.budget }),
  })
  const run = () => state.service.dispatch({ squadId, task: 'Deliver the app', assignments: [{ agentId: researcherId, task: 'Implement API, UI and tests.' }] }, state.parent, config.abort?.signal ?? new AbortController().signal)
  return { ...state, calls, run }
}

describe('failure-aware retry (#70)', () => {
  it('diagnoses on the parent route and returns structural revisions to the lead with durable evidence/usage', async () => {
    const state = await setup()
    const result = await state.run()
    expect(result.status).toBe('failed')
    expect(state.calls).toHaveLength(2)
    const diagnosis = state.calls[1]!
    expect(diagnosis).toMatchObject({ toolFilter: { allow: [] }, maxDepth: 1, agentOptions: {
      agentTeamGuiDiagnosis: true, provider: 'main-provider', model: 'main-model', maxTokens: 2_048,
    } })
    const prompt = JSON.stringify(diagnosis.prompt)
    expect(prompt).toContain('API done; UI and tests remain.')
    expect(prompt).toContain('wrote src/api.ts')
    expect(prompt).toContain('timeout alone does not prove')
    const saved = state.service.getRun(result.dispatchId)!
    expect(saved.members[0]).toMatchObject({ attempts: 1, recovery: {
      state: 'completed', decision, usage: { totalTokens: 3 }, firstAttempt: { status: 'failed', output: [{ text: 'API done; UI and tests remain.' }] },
    } })
    expect(saved.members[0]?.error).toContain('max-tokens')
    expect(saved.usage.totalTokens).toBe(10)
    expect(saved.meteringCoverage).toBe('full')
    expect(squadRunRecordSchema.safeParse(saved).success).toBe(true)
    expect(state.service.insights({}).byAgent).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '(system-recovery)', usage: expect.objectContaining({ totalTokens: 3 }) }),
      expect.objectContaining({ key: researcherId, usage: expect.objectContaining({ totalTokens: 7 }) }),
    ]))
    expect(state.service.listRuns()[0]?.members[0]?.recovery?.firstAttempt.output).toEqual([])
  })

  it.each([
    { ...decision, action: 'stop', cause: 'missing-context', nextTask: '' },
    { ...decision, action: 'revise', evidence: [] },
    { ...decision, action: 'revise', confidence: 'insufficient' },
    { ...decision, action: 'retry', cause: 'task-scope' },
    { ...decision, nextTask: '' },
    { ...decision, nextTask: 'Implement API, UI and tests.' },
    { ...decision, nextTask: 'x'.repeat(8_001) },
    { wrong: true },
  ])('does not blindly retry a stopped or invalid diagnosis %#', async structured => {
    const state = await setup(structured)
    const result = await state.run()
    expect(result.status).toBe('failed')
    expect(state.calls).toHaveLength(2)
    expect(result.members[0]?.attempts).toBe(1)
    expect(result.members[0]?.error).toContain('max-tokens')
    expect(result.usage.totalTokens).toBe(10)
  })

  it('allows an evidence-supported transient retry with progress context', async () => {
    const state = await setup({ ...decision, action: 'retry', cause: 'transient', nextTask: '', reason: 'Temporary transport failure.' })
    expect((await state.run()).status).toBe('completed')
    expect(JSON.stringify(state.calls[2]!.prompt)).toContain('Previous failure and output')
  })

  it('stops when the coordinator cannot run instead of falling back to a blind retry', async () => {
    const state = await setup(decision, { failDiagnosis: true })
    const result = await state.run()
    expect(state.calls).toHaveLength(2)
    expect(result.members[0]?.recovery).toMatchObject({ state: 'failed', error: 'diagnosis unavailable' })
  })

  it.each([7, 10])('checks the cumulative soft budget before diagnosis and retry (%s)', async budget => {
    const state = await setup(decision, { budget })
    const result = await state.run()
    expect(state.calls).toHaveLength(budget === 7 ? 1 : 2)
    expect(result.members[0]?.recovery?.state).toBe('skipped')
    if (budget === 10) expect(state.calls[1]?.agentOptions?.maxTokens).toBe(3)
  })

  it('honors cancellation during diagnosis without a second member attempt', async () => {
    const state = await setup(decision, { abort: new AbortController() })
    expect((await state.run()).status).toBe('cancelled')
    expect(state.calls).toHaveLength(2)
  })

  it('caps recovery at one diagnosis and two execution attempts even when the retry fails', async () => {
    const state = await setup({ ...decision, action: 'retry', cause: 'transient' }, { failRetry: true })
    expect((await state.run()).members[0]?.attempts).toBe(2)
    expect(state.calls).toHaveLength(3)
  })

  it('leaves successful members untouched', async () => {
    const state = await setup()
    await state.agents.put(writerId, agent('Writer'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId], executionOrder: [researcherId, writerId], failurePolicy: 'retry-once' })
    expect((await state.run()).status).toBe('partial')
    expect(state.calls.filter(call => call.label?.endsWith('/Writer'))).toHaveLength(1)
    expect(state.calls.filter(call => call.agentOptions?.agentTeamGuiDiagnosis)).toHaveLength(1)
  })

  it('does not diagnose when retry is not selected', async () => {
    const state = await setup()
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], executionOrder: [researcherId], failurePolicy: 'stop' })
    await state.run()
    expect(state.calls).toHaveLength(1)
  })

  it('bounds diagnosis duration and preserves the original failure', async () => {
    vi.useFakeTimers()
    try {
      const state = createService({ start: async (_provider, request) => ({
        id: SessionId('child'), localAgent: undefined, async dispose() {},
        result: request.agentOptions?.agentTeamGuiDiagnosis
          ? new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error('diagnosis timeout')), { once: true }))
          : Promise.resolve({ output: [], stopReason: 'error' as const }),
      }) })
      await state.agents.put(researcherId, agent('Builder'))
      await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], executionOrder: [researcherId], failurePolicy: 'retry-once' })
      const pending = state.service.dispatch({ squadId, task: 'build' }, state.parent, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(60_001)
      const result = await pending
      expect(result.members[0]).toMatchObject({ attempts: 1, recovery: { state: 'failed' } })
    } finally { vi.useRealTimers() }
  })

  it('rejects confident recommendations with no supplied evidence', () => {
    expect(retryDecisionSchema.safeParse({ ...decision, evidence: [] }).success).toBe(false)
  })

  it.each(['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low', 'Insufficient balance'])('stops for explicit billing exhaustion without spending another model call: %s', async code => {
    let starts = 0
    const state = createService({ start: async () => { starts++; throw new Error(code) } })
    await state.agents.put(researcherId, agent('Builder'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], executionOrder: [researcherId], failurePolicy: 'retry-once' })
    const result = await state.service.dispatch({ squadId, task: 'build' }, state.parent, new AbortController().signal)
    expect(starts).toBe(1)
    expect(result.members[0]?.recovery).toMatchObject({ state: 'skipped', attempted: false })
  })

  it('does not confuse temporary rate limiting with exhausted billing quota', () => {
    expect(exhaustedQuota('429 Too Many Requests: rate_limit_exceeded')).toBe(false)
  })

  it('retries explicit startup DNS failure without spending a diagnostic model call', async () => {
    const calls: SubagentStartRequest[] = []
    const state = createService({ start: async (_provider, request) => {
      calls.push(request)
      if (calls.length === 1) throw new Error('EAI_AGAIN provider.example')
      return { id: SessionId('recovered'), localAgent: undefined, async dispose() {}, result: Promise.resolve({ output: [], stopReason: 'completed' as const }) }
    } })
    await state.agents.put(researcherId, agent('Builder'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], executionOrder: [researcherId], failurePolicy: 'retry-once' })
    const result = await state.service.dispatch({ squadId, task: 'build' }, state.parent, new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(calls).toHaveLength(2)
    expect(calls.some(call => call.agentOptions?.agentTeamGuiDiagnosis)).toBe(false)
    expect(result.members[0]?.recovery).toMatchObject({ attempted: false, decision: { action: 'retry', cause: 'transient' } })
    expect(state.service.getRun(result.dispatchId)?.members[0]?.error).toBeUndefined()
  })
})
