import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { squadRunRecordSchema } from '../src/spec.ts'
import { createContinueSquadRunTool } from '../src/tools/continue-squad-run.ts'
import { RunHistoryStore } from '../src/tools/run-history.ts'
import { type SquadContinuationRequest, type SquadRunRecord } from '../src/types.ts'
import { agent, createService, researcherId, writerId, reviewerId, squadId } from './helpers.ts'

const signal = () => new AbortController().signal
async function fixture(budget?: number) {
  const calls: SubagentStartRequest[] = []
  const state = createService({ start: async (_provider, request) => {
    calls.push(request)
    const diagnosis = request.agentOptions?.agentTeamGuiDiagnosis
    const writerAttempts = calls.filter(call => call.label === 'Team/Builder').length
    const failed = !diagnosis && request.label === 'Team/Builder' && writerAttempts === 1
    const localAgent = { id: SessionId(`child-${calls.length}`), session: { firstLiveSeq: 0 } } as unknown as Agent
    return { id: localAgent.id, localAgent, async dispose() {}, result: Promise.resolve({
      output: [{ type: 'text' as const, text: failed ? 'API exists; UI and tests remain.' : 'deliverable complete' }],
      stopReason: failed ? 'max-tokens' as const : 'completed' as const,
      ...(diagnosis ? { structured: { action: 'revise', cause: 'task-scope', confidence: 'limited',
        reason: 'The assignment did not reach UI/tests.', evidence: ['The failed output says UI/tests remain.'],
        progress: 'Inspect the reported API first.', nextTask: 'Inspect API, then implement UI/tests in order.', uncertainty: 'API is not verified.',
      } } : {}),
    }) }
  } })
  state.ctx.provide('sessionProjections', { snapshot: () => ({ values: { tokenUsage: { uncachedInputTokens: 4, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) })
  await state.agents.put(researcherId, agent('Researcher'))
  await state.agents.put(writerId, agent('Builder'))
  await state.agents.put(reviewerId, agent('Verifier'))
  await state.squads.put(squadId, { name: 'Team', members: [researcherId, writerId, reviewerId], executionOrder: [researcherId, writerId, reviewerId], failurePolicy: 'retry-once', ...(budget === undefined ? {} : { tokenBudget: budget }) })
  const parent = { ...state.parent, session: { ...state.parent.session,
    snapshotEvents: () => [{ type: 'user/message', data: { id: 'human-1', source: { kind: 'user' } } }],
  } } as unknown as Agent
  const result = await state.service.dispatchFromTool({ squadId, task: 'Build the app', assignments: [
    { agentId: researcherId, task: 'Research the API contract.' }, { agentId: writerId, task: 'Implement API, UI and tests.' }, { agentId: reviewerId, task: 'Verify the implementation.' },
  ] }, parent, signal())
  const request: SquadContinuationRequest = { sourceRunId: result.dispatchId, expectedRevision: 0,
    reason: 'The member ran out of context before completing all deliverables.',
    progressReview: 'The API was reported as written. Inspect it before edits; do not repeat existing work. UI/tests remain.',
    assignments: [{ agentId: writerId, task: 'Inspect the existing API, then implement the remaining UI and tests in order.' }],
  }
  return { ...state, parent, result, request, calls }
}

describe('execution-chain continuation (#70)', () => {
  it('lets the lead continue the same message, reuses independent successes and invalidates successful descendants', async () => {
    const state = await fixture(100)
    expect(state.result.status).toBe('partial')
    expect(state.result.continuation?.allowed).toBe(true)
    expect(state.calls.filter(call => call.label === 'Team/Builder')).toHaveLength(1)
    const next = await state.service.continueFromTool(state.request, state.parent, signal())
    expect(next.status).toBe('completed')
    expect(next.chain).toMatchObject({ id: state.result.dispatchId, revision: 1, continuationOf: state.result.dispatchId, usageBeforeRun: { totalTokens: 16 }, tokenBudget: 100 })
    expect(next.usage.totalTokens).toBe(8)
    expect(next.continuation?.allowed).toBe(false)
    expect(next.members.find(member => member.agentId === researcherId)).toMatchObject({ attempts: 0, reusedFrom: state.result.dispatchId })
    expect(state.calls.filter(call => call.label === 'Team/Researcher')).toHaveLength(1)
    expect(state.calls.filter(call => call.label === 'Team/Builder')).toHaveLength(2)
    expect(state.calls.filter(call => call.label === 'Team/Verifier')).toHaveLength(2)
    const continuedPrompt = JSON.stringify(state.calls.filter(call => call.label === 'Team/Builder')[1]!.prompt)
    expect(continuedPrompt).toContain('API exists; UI and tests remain.')
    expect(continuedPrompt).toContain(state.request.assignments[0]!.task)
    expect(squadRunRecordSchema.safeParse(state.service.getRun(next.dispatchId)).success).toBe(true)
    expect(state.service.getRun(next.dispatchId)?.meteringCoverage).toBe('full')
    expect(state.service.insights({}).usage.totalTokens).toBe(24)
    expect(state.service.listRuns()[0]?.definitionSnapshot).toBeUndefined()
    expect(state.service.getRun(state.result.dispatchId)?.plan?.assignments.find(node => node.agentId === writerId)?.task).toBe('Implement API, UI and tests.')
    await expect(state.service.dispatchFromTool({ squadId, task: 'changed wording' }, state.parent, signal())).rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
  })

  it('coalesces identical concurrent submissions and returns the stored result on later duplicates', async () => {
    const state = await fixture()
    const [a, b] = await Promise.all([state.service.continueFromTool(state.request, state.parent, signal()), state.service.continueFromTool(state.request, state.parent, signal())])
    expect(a.dispatchId).toBe(b.dispatchId)
    const calls = state.calls.length
    expect((await state.service.continueFromTool({ ...state.request, reason: 'Reworded justification' }, state.parent, signal())).dispatchId).toBe(a.dispatchId)
    expect(state.calls).toHaveLength(calls)
    expect(state.runs.size).toBe(2)
  })

  it('does not let a changed task or fresh wording reset successor admission', async () => {
    const state = await fixture()
    await state.service.continueFromTool(state.request, state.parent, signal())
    await expect(state.service.continueFromTool({ ...state.request, assignments: [{ agentId: writerId, task: 'A differently worded task' }] }, state.parent, signal())).rejects.toThrow(/already.*continuation/)
    expect(state.runs.size).toBe(2)
  })

  it.each([false, true])('handles admission storage failure (committed=%s) without duplicate work', async committed => {
    const state = await fixture()
    const original = state.runs.update.bind(state.runs)
    let fail = true
    state.runs.update = async (id, transform) => {
      if (id === state.result.dispatchId && fail) {
        fail = false
        if (committed) await original(id, transform)
        throw new Error('storage write uncertain')
      }
      return original(id, transform)
    }
    if (!committed) {
      await expect(state.service.continueFromTool(state.request, state.parent, signal())).rejects.toThrow('storage write uncertain')
      expect(state.service.getRun(state.result.dispatchId)?.continuationReceipt).toBeUndefined()
    }
    const next = await state.service.continueFromTool(state.request, state.parent, signal())
    expect(next.status).toBe('completed')
    expect(state.calls.filter(call => call.label === 'Team/Builder')).toHaveLength(2)
  })

  it('does not make an independent success editable by adding a fake dependency', async () => {
    const state = await fixture()
    await expect(state.service.continueFromTool({ ...state.request, assignments: [
      ...state.request.assignments, { agentId: researcherId, task: 'Repeat research', dependsOn: [writerId] },
    ] }, state.parent, signal())).rejects.toThrow(/independent/)
    expect(state.runs.size).toBe(1)
  })

  it.each(['stale', 'duplicate', 'unknown', 'independent', 'cycle', 'missing-task'] as const)('rejects %s proposals before consuming continuation admission', async kind => {
    const state = await fixture()
    const request = {
      ...state.request,
      ...(kind === 'stale' ? { expectedRevision: 99 } : {}),
      ...(kind === 'duplicate' ? { assignments: [...state.request.assignments, ...state.request.assignments] } : {}),
      ...(kind === 'unknown' ? { assignments: [{ agentId: 'unknown' as typeof writerId, task: 'work' }] } : {}),
      ...(kind === 'independent' ? { assignments: [...state.request.assignments, { agentId: researcherId, task: 'redo successful independent research' }] } : {}),
      ...(kind === 'cycle' ? { assignments: [{ agentId: writerId, task: 'work', dependsOn: [reviewerId] }] } : {}),
      ...(kind === 'missing-task' ? { assignments: [{ agentId: reviewerId, task: 'verify again' }] } : {}),
    }
    await expect(state.service.continueFromTool(request, state.parent, signal())).rejects.toThrow()
    expect(state.service.getRun(state.result.dispatchId)?.continuationReceipt).toBeUndefined()
    expect((await state.service.continueFromTool(state.request, state.parent, signal())).status).toBe('completed')
  })

  it.each(['session', 'message', 'child'] as const)('rejects continuation from another %s', async kind => {
    const state = await fixture()
    const parent = { ...state.parent,
      ...(kind === 'session' ? { id: SessionId('other') } : {}),
      ...(kind === 'message' ? { session: { ...state.parent.session, snapshotEvents: () => [{ type: 'user/message', data: { id: 'new-message', source: { kind: 'user' } } }] } } : {}),
      ...(kind === 'child' ? { options: { ...state.parent.options, agentTeamGuiChild: true } } : {}),
    } as unknown as Agent
    await expect(state.service.continueFromTool(state.request, parent, signal())).rejects.toThrow()
    expect(state.runs.size).toBe(1)
  })

  it.each(['cancelled', 'interrupted', 'running', 'completed'] as const)('does not continue a %s source', async status => {
    const state = await fixture()
    await state.runs.update(state.result.dispatchId, run => ({ ...run, status }))
    await expect(state.service.continueFromTool(state.request, state.parent, signal())).rejects.toThrow()
    expect(state.runs.size).toBe(1)
  })

  it('rejects changed definitions and explicit quota exhaustion', async () => {
    const state = await fixture()
    await state.agents.put(writerId, { ...agent('Builder'), toolScope: { allow: ['read_file'] } })
    await expect(state.service.continueFromTool(state.request, state.parent, signal())).rejects.toThrow(/definitions changed/)
    await state.agents.put(writerId, agent('Builder'))
    await state.runs.update(state.result.dispatchId, run => ({ ...run, members: run.members.map(member => member.agentId === writerId ? { ...member, error: 'insufficient_quota' } : member) }))
    await expect(state.service.continueFromTool(state.request, state.parent, signal())).rejects.toThrow(/quota/)
  })

  it('carries the original soft budget across runs instead of resetting it', async () => {
    const state = await fixture(18)
    const next = await state.service.continueFromTool(state.request, state.parent, signal())
    expect(next.chain?.usageBeforeRun.totalTokens).toBe(16)
    expect(next.usage.totalTokens).toBe(4)
    expect(next.status).toBe('partial')
    // The builder pushes the known total past 18; the invalidated verifier must not start.
    expect(state.calls.filter(call => call.label === 'Team/Verifier')).toHaveLength(1)
    await expect(state.service.continueFromTool({ ...state.request, sourceRunId: next.dispatchId, expectedRevision: 1 }, state.parent, signal())).rejects.toThrow(/limit reached/)
  })

  it('refuses a successor when cumulative usage has already exhausted the budget', async () => {
    const state = await fixture(16)
    await expect(state.service.continueFromTool(state.request, state.parent, signal())).rejects.toThrow(/budget exhausted/)
  })

  it('keeps durable admission after process state is lost and does not replay missing results', async () => {
    const state = await fixture()
    const next = await state.service.continueFromTool(state.request, state.parent, signal())
    await state.runs.delete(next.dispatchId)
    await expect(state.service.continueFromTool(state.request, state.parent, signal())).rejects.toThrow(/accepted.*unavailable/)
    expect(state.calls.filter(call => call.label === 'Team/Builder')).toHaveLength(2)
  })

  it('reconciles an interrupted system diagnosis without automatically starting a successor', async () => {
    const state = await fixture()
    const source = state.service.getRun(state.result.dispatchId)!
    await state.runs.put(source.id, { ...source, status: 'running', members: source.members.map(member => member.recovery === undefined ? member : { ...member, recovery: { ...member.recovery, state: 'diagnosing' } }) })
    await new RunHistoryStore(state.runs).reconcileInterrupted(123)
    expect(state.service.getRun(source.id)?.members.find(member => member.agentId === writerId)?.recovery?.state).toBe('failed')
    await expect(state.service.continueFromTool(state.request, state.parent, signal())).rejects.toThrow(/interruption/)
  })

  it('exposes the continuation as a separate exclusive lead tool', async () => {
    const state = await fixture()
    const tool = createContinueSquadRunTool(state.service)
    expect(tool.name).toBe('continue_squad_run')
    expect(tool.isConcurrencySafe?.({} as never)).toBe(false)
  })
})
