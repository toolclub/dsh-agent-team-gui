import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { DispatchId, type SquadRecord } from '../src/types.ts'
import { agent, createService, researcherId, squadId, writerId } from './helpers.ts'

type Decision = { kind: 'enter' | 'reject'; messages: UserMessage[] }
type Hook = (input: { agent: Agent; signal: AbortSignal }, next: () => Promise<Decision>) => Promise<Decision>

async function setup(overrides: Partial<SquadRecord> = {}) {
  const state = createService()
  await state.agents.put(researcherId, { ...agent('Researcher'), systemPrompt: 'Inspect APIs and report evidence.', toolScope: { allow: ['read_file'] } })
  await state.squads.put(squadId, { name: 'Delivery', members: [researcherId], triggerMode: 'model-tool', executionOrder: [researcherId], ...overrides })
  await state.service.setSessionSquadMode(state.parent.id, squadId)
  let message = createUserMessage({ content: [{ type: 'text', text: '1+1' }], source: { kind: 'user' } })
  const parent = { ...state.parent, session: { ...state.parent.session,
    snapshotEvents: () => [{ type: 'user/message', data: message }],
  } } as unknown as Agent
  let hook: Hook | undefined
  const internal = state.service as unknown as { ctx: { on(name: string, callback: Hook): unknown }; registerConversationOrchestration(): void }
  internal.ctx.on = (name, callback) => { if (name === 'agent/pre-step') hook = callback; return () => undefined }
  internal.registerConversationOrchestration()
  const step = (decision: Decision = { kind: 'enter', messages: [message] }, actor = parent, signal = new AbortController().signal) => hook!({ agent: actor, signal }, async () => decision)
  const sendNext = () => { message = createUserMessage({ content: [{ type: 'text', text: 'Next task' }], source: { kind: 'user' } }) }
  const dispatch = (task = 'Work requiring this team') => state.service.dispatchFromTool({ squadId, task }, parent, new AbortController().signal)
  return { ...state, parent, step, sendNext, dispatch }
}

describe('on-demand dispatch and mode precedence', () => {
  it('does not start a planner/member or consume admission before the lead decides', async () => {
    const state = await setup()
    await state.step()
    expect(state.starts).toHaveLength(0)
    expect(state.runs.size).toBe(0)
    expect(state.messageClaims.size).toBe(0)
    const guidance = state.service.squadModeGuidance(state.parent)
    expect(guidance).toContain('AVAILABLE ON DEMAND')
    expect(guidance).toContain('1+1')
    expect(guidance).toContain('Inspect APIs and report evidence.')
    expect(guidance).toContain('allowed tools=read_file')
    expect(guidance).not.toContain('exactly once before your final answer')
    expect((await state.dispatch()).status).toBe('completed')
    expect(state.starts).toHaveLength(1)
    await expect(state.dispatch('different wording')).rejects.toThrow(/already dispatched/)
  })

  it('still dispatches before the lead in guaranteed mode', async () => {
    const state = await setup({ triggerMode: 'guaranteed' })
    const result = await state.step()
    expect(state.starts).toHaveLength(1)
    expect(result.messages).toHaveLength(2)
    await state.step()
    expect(state.starts).toHaveLength(1)
  })

  it('retains guaranteed behavior for legacy records without triggerMode', async () => {
    const state = await setup()
    await state.squads.put(squadId, { name: 'Legacy', members: [researcherId], executionOrder: [researcherId] })
    await state.step()
    expect(state.starts).toHaveLength(1)
  })

  it.each(['model-tool', 'guaranteed'] as const)('one-shot Solo overrides %s and then expires', async triggerMode => {
    const state = await setup({ triggerMode })
    await state.service.setNextSessionSquadMode(state.parent.id, 'solo')
    const result = await state.step()
    expect(JSON.stringify(result.messages)).toContain('The user selected Solo')
    expect(state.starts).toHaveLength(0)
    await expect(state.dispatch()).rejects.toThrow(/Solo/)
    expect(state.service.getNextSessionSquadMode(state.parent.id)).toBeUndefined()
    state.sendNext()
    await state.step()
    if (triggerMode === 'model-tool') await state.dispatch()
    expect(state.starts).toHaveLength(1)
  })

  it('explicit next-message Team overrides on-demand, Manual and durable Solo exactly once', async () => {
    const state = await setup({ activationMode: 'manual' })
    await state.service.setSessionSquadMode(state.parent.id)
    await state.service.setNextSessionSquadMode(state.parent.id, 'team', squadId)
    await state.step()
    expect(state.starts).toHaveLength(1)
    state.sendNext()
    await state.step()
    await expect(state.dispatch()).rejects.toThrow(/Solo/)
    expect(state.starts).toHaveLength(1)
  })

  it.each(['model-tool', 'guaranteed'] as const)('Manual blocks both automatic and model dispatch in %s', async triggerMode => {
    const state = await setup({ triggerMode, activationMode: 'manual' })
    await state.step()
    expect(state.starts).toHaveLength(0)
    expect(state.service.squadModeGuidance(state.parent)).toContain('Manual-only')
    expect(state.service.squadModeGuidance(state.parent)).not.toContain('host runs this squad before')
    await expect(state.dispatch()).rejects.toThrow(/Manual-only/)
    expect(state.messageClaims.size).toBe(0)
  })

  it('honors explicit Solo even if the model tries the globally registered tool', async () => {
    const state = await setup()
    await state.service.setSessionSquadMode(state.parent.id)
    await state.step()
    await expect(state.dispatch()).rejects.toThrow(/Solo/)
    expect(state.runs.size).toBe(0)
  })

  it('uses the effective project team and prevents selecting a different team through tool arguments', async () => {
    const state = await setup()
    await state.squads.put('other' as typeof squadId, { name: 'Other', members: [researcherId] })
    await state.modes.delete(state.parent.id)
    await state.projectDefaults.put('/workspace/project', { projectKey: '/workspace/project', squadId, enabled: true })
    expect(state.service.squadModeGuidance(state.parent)).toContain('AVAILABLE ON DEMAND')
    await expect(state.service.dispatchFromTool({ squadId: 'other' as typeof squadId, task: 'bypass selection' }, state.parent, new AbortController().signal)).rejects.toThrow(/selected squad/)
    expect(state.runs.size).toBe(0)
  })

  it('ignores rejected, non-user and delegated steps without consuming a one-shot', async () => {
    const state = await setup({ triggerMode: 'guaranteed' })
    await state.service.setNextSessionSquadMode(state.parent.id, 'team', squadId)
    await state.step({ kind: 'reject', messages: [] })
    await state.step({ kind: 'enter', messages: [] })
    const cancelled = new AbortController(); cancelled.abort()
    await state.step(undefined, state.parent, cancelled.signal)
    await state.step(undefined, { ...state.parent, options: { ...state.parent.options, agentTeamGuiChild: true } } as Agent)
    expect(state.service.getNextSessionSquadMode(state.parent.id)?.state).toBe('team')
    expect(state.starts).toHaveLength(0)
  })

  it('uses a planner only when the model delegates without explicit assignments/order', async () => {
    const state = await setup()
    await state.squads.put(squadId, { name: 'Dynamic', members: [researcherId], triggerMode: 'model-tool', memberSelectionMode: 'adaptive' })
    await state.step()
    expect(state.starts).toHaveLength(0)
    await state.dispatch()
    expect(state.starts).toHaveLength(2) // planner (fixture falls back), then member
  })

  it.each([false, true])('keeps continuation usable for an explicit one-shot team (durable Solo=%s)', async solo => {
    const state = await setup()
    const otherId = 'one-shot-team' as typeof squadId
    await state.squads.put(otherId, { name: 'One-shot', members: [researcherId], executionOrder: [researcherId], triggerMode: 'model-tool', activationMode: 'manual' })
    if (solo) await state.service.setSessionSquadMode(state.parent.id)
    const start = vi.spyOn(state.ctx.subagents, 'start')
    start.mockResolvedValueOnce({ id: state.parent.id, localAgent: undefined, async dispose() {}, result: Promise.resolve({ output: [], stopReason: 'error' }) })
    await state.service.setNextSessionSquadMode(state.parent.id, 'team', otherId)
    await state.step()
    const source = state.service.listRuns()[0]!
    expect(source.squadId).toBe(otherId)
    expect(source.status).toBe('failed')
    const continued = await state.service.continueFromTool({ sourceRunId: source.id, expectedRevision: 0,
      reason: 'Retry only the incomplete work after inspecting failure.', progressReview: 'No completed output was returned; verify workspace state first.',
      assignments: [{ agentId: researcherId, task: 'Inspect prior progress and finish the remaining verification.' }],
    }, state.parent, new AbortController().signal)
    expect(continued.status).toBe('completed')
    expect(continued.chain?.revision).toBe(1)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('keeps independent continuation checks in effect for on-demand dispatch', async () => {
    const state = await setup()
    await state.agents.put(writerId, agent('Writer'))
    await state.step()
    const result = await state.dispatch()
    expect(result.chain?.revision).toBe(0)
    expect(result.continuation?.allowed).toBe(false) // completed work needs no continuation
  })

  it('uses background execution only for an explicit host dispatch, not ordinary on-demand sends', async () => {
    const state = await setup({ responseMode: 'background' })
    const background = vi.spyOn(state.service, 'startBackgroundDispatch').mockResolvedValue({ id: DispatchId('background'), status: 'queued' })
    await state.step()
    expect(background).not.toHaveBeenCalled()
    await state.dispatch()
    expect(state.starts).toHaveLength(1)
    expect(background).not.toHaveBeenCalled()
    state.sendNext()
    await state.service.setNextSessionSquadMode(state.parent.id, 'team', squadId)
    const notice = await state.step()
    expect(background).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(notice.messages)).toContain('started in the background')
  })

  it('allows a smart planner to skip without starting members or reopening first-dispatch admission', async () => {
    const state = await setup()
    await state.squads.put(squadId, { name: 'Smart', members: [researcherId], triggerMode: 'model-tool', activationMode: 'smart' })
    const start = vi.spyOn(state.ctx.subagents, 'start').mockResolvedValue({
      id: state.parent.id, localAgent: undefined, async dispose() {}, result: Promise.resolve({
        output: [], stopReason: 'completed', structured: { decision: 'skip', reason: 'Outside the team scope.', summary: 'Answer directly.', memberOrder: [], assignments: [] },
      }),
    })
    await state.step()
    expect(start).not.toHaveBeenCalled()
    const result = await state.dispatch()
    expect(result.status).toBe('skipped')
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.members).toEqual([])
    await expect(state.dispatch()).rejects.toThrow(/already dispatched/)
  })
})
