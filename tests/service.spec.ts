import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { AgentTeamError } from '../src/index.ts'
import { createDispatchToSquadTool } from '../src/tools/dispatch-to-squad.ts'
import { AgentId, SquadId } from '../src/types.ts'
import { agent, createService, populate, researcherId, reviewerId, squadId, writerId } from './helpers.ts'

describe('AgentTeamService CRUD', () => {
  it('validates model routes and squad references before durable writes', async () => {
    const resolveModelInfo = vi.fn(async () => { throw new Error('route is not configured') })
    const { service } = createService({ resolveModelInfo: resolveModelInfo as unknown as LlmRuntime['resolveModelInfo'] })

    await expect(service.createAgent(agent('Unknown'), AgentId('unknown')))
      .rejects.toThrow('invalid model route configured/unknown: route is not configured')
    expect(service.listAgents()).toEqual([])

    const valid = createService()
    await valid.service.createAgent(agent('Researcher'), researcherId)
    await expect(valid.service.createSquad({ name: 'Bad', members: [researcherId, researcherId] }, SquadId('bad')))
      .rejects.toMatchObject({ code: 'INVALID_MEMBERS' })
    await expect(valid.service.createSquad({ name: 'Missing', members: [AgentId('missing')] }, SquadId('missing')))
      .rejects.toMatchObject({ code: 'INVALID_MEMBERS' })
    await expect(valid.service.createSquad({
      name: 'Bad order',
      members: [researcherId],
      executionOrder: [researcherId, researcherId],
    }, SquadId('bad-order'))).rejects.toMatchObject({ code: 'INVALID_MEMBERS' })
    await expect(valid.service.createSquad({
      name: 'Bad defaults',
      members: [researcherId],
      executionMode: 'parallel',
      contextMode: 'chain',
    }, SquadId('bad-defaults'))).rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
  })

  it('removes a deleted agent from every squad with atomic table updates', async () => {
    const { service } = await populate()
    await service.updateSquad(squadId, {
      name: 'Delivery',
      members: [researcherId, writerId, reviewerId],
      executionOrder: [reviewerId, writerId, researcherId],
      leaderAgentId: writerId,
    })
    await service.createSquad({ name: 'Second', members: [writerId, researcherId] }, SquadId('second'))

    await expect(service.deleteAgent(writerId)).resolves.toBe(true)
    expect(service.getSquad(squadId)?.members).toEqual([researcherId, reviewerId])
    expect(service.getSquad(squadId)?.executionOrder).toEqual([reviewerId, researcherId])
    expect(service.getSquad(squadId)?.leaderAgentId).toBeUndefined()
    expect(service.listSquadVersions(squadId).map(item => item.version)).toEqual([2, 1])
    expect(service.getSquad(SquadId('second'))?.members).toEqual([researcherId])
    expect(service.getAgent(writerId)).toBeUndefined()
  })

  it('resolves a unique squad by durable id or exact name for natural-language dispatch', async () => {
    const { service } = await populate()
    expect(service.resolveSquadId('delivery')).toBe(squadId)
    expect(service.resolveSquadId('  DELIVERY  ')).toBe(squadId)
    await service.createSquad({ name: 'Delivery', members: [researcherId] }, SquadId('delivery-duplicate'))
    expect(() => service.resolveSquadId('Delivery')).toThrow('ambiguous')
  })

  it('persists normal-conversation squad mode and renders model-facing guidance', async () => {
    const { service } = await populate()
    await service.updateSquad(squadId, {
      name: 'Delivery',
      members: [researcherId, writerId, reviewerId],
      collabNote: 'Cross-check claims.',
      executionMode: 'serial',
      contextMode: 'chain',
    })
    const sessionId = SessionId('conversation')

    await expect(service.setSessionSquadMode(sessionId, squadId)).resolves.toEqual({
      sessionId,
      squadId,
      squadName: 'Delivery',
    })
    const live = { id: sessionId, session: { header: {} } } as unknown as Agent
    const guidance = service.squadModeGuidance(live)
    expect(guidance).toContain('host runs this squad before your request')
    expect(guidance).toContain('Do not call dispatch_to_squad again')
    expect(guidance).toContain('researcher (Researcher, configured/researcher)')
    expect(guidance).toContain('Collaboration note: Cross-check claims.')
    expect(guidance).toContain('No fixed member order is configured')

    await expect(service.setSessionSquadMode(sessionId)).resolves.toBeUndefined()
    expect(service.squadModeGuidance(live)).toBe('')
  })

  it('clears every session mode that points at a deleted squad', async () => {
    const { service } = await populate()
    const one = SessionId('one')
    const two = SessionId('two')
    await service.setSessionSquadMode(one, squadId)
    await service.setSessionSquadMode(two, squadId)

    await expect(service.deleteSquad(squadId)).resolves.toBe(true)
    expect(service.getSessionSquadMode(one)).toBeUndefined()
    expect(service.getSessionSquadMode(two)).toBeUndefined()
  })

  it('keeps immutable squad versions and restores a prior definition', async () => {
    const state = await populate()
    await state.service.updateSquad(squadId, { name: 'Delivery v2', members: [researcherId, writerId] })
    await state.service.updateSquad(squadId, { name: 'Delivery v3', members: [reviewerId] })

    expect(state.service.listSquadVersions(squadId).map(item => item.version)).toEqual([2, 1])
    await state.service.restoreSquadVersion(squadId, 1)
    expect(state.service.getSquad(squadId)).toMatchObject({ name: 'Delivery v2', members: [researcherId, writerId] })
    expect(state.service.listSquadVersions(squadId).map(item => item.version)).toEqual([3, 2, 1])
  })

  it('inherits a project default but lets one session explicitly opt out', async () => {
    const state = await populate()
    const session = { id: SessionId('project-chat'), session: { header: { cwd: '/workspace/project' } } } as unknown as Agent
    expect(state.service.getSessionSquadOverride(session.id)).toBe('inherit')
    await state.service.setProjectDefault('/workspace/project', squadId)
    expect(state.service.getEffectiveSessionSquadMode(session)).toMatchObject({ squadId, squadName: 'Delivery' })

    await state.service.setSessionSquadMode(session.id)
    expect(state.service.getSessionSquadOverride(session.id)).toBe('disabled')
    expect(state.service.getEffectiveSessionSquadMode(session)).toBeUndefined()

    await state.service.setSessionSquadMode(session.id, squadId)
    expect(state.service.getSessionSquadOverride(session.id)).toBe('enabled')
  })

  it('never inherits project squad mode into a delegated child session', async () => {
    const state = await populate()
    await state.service.setProjectDefault('/workspace/project', squadId)
    const child = {
      id: SessionId('delegated-child'),
      session: { header: {
        cwd: '/workspace/project',
        parentSession: state.parent.id,
        origin: 'subagent',
        delegationDepth: 1,
      } },
    } as unknown as Agent

    expect(state.service.getEffectiveSessionSquadMode(child)).toBeUndefined()
    expect(state.service.squadModeGuidance(child)).toBe('')
  })

  it('claims each automatic user message once and honors durable run traces after restart', async () => {
    const state = await populate()
    const claim = (agentValue: Agent, messageId: string): Promise<boolean> =>
      (state.service as unknown as {
        claimGuaranteedMessage(agent: Agent, id: string, kind: 'solo' | 'team'): Promise<boolean>
      }).claimGuaranteedMessage(agentValue, messageId, 'team')

    await expect(claim(state.parent, 'message-1')).resolves.toBe(true)
    await expect(claim(state.parent, 'message-1')).resolves.toBe(false)
    await state.service.dispatch({ squadId, task: 'once' }, state.parent, new AbortController().signal, {
      sessionId: state.parent.id,
      sourceMessageId: 'durable-message',
    })
    const resumed = { id: state.parent.id, session: state.parent.session } as Agent
    await expect(claim(resumed, 'durable-message')).resolves.toBe(false)
  })

  it('diagnoses every primary and fallback model route without mutating the team', async () => {
    const state = await populate()
    await state.service.updateAgent(researcherId, {
      ...agent('Researcher'), fallbackProvider: 'configured', fallbackModel: 'backup',
    })
    const before = state.service.getSquad(squadId)
    const result = await state.service.diagnoseSquad(squadId)
    expect(result.ok).toBe(true)
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'definition', ok: true }),
      expect.objectContaining({ name: 'Researcher', ok: true, message: expect.stringContaining('backup') }),
    ]))
    expect(state.service.getSquad(squadId)).toEqual(before)
  })
})

describe('AgentTeamService dispatch', () => {
  it('uses the parent Main Agent route to dynamically assign every configured member', async () => {
    const requests: Array<{ provider: string; request: SubagentStartRequest }> = []
    const state = createService({
      start: async (provider, request) => {
        requests.push({ provider, request })
        const id = SessionId(`planned-child-${requests.length}`)
        if (request.label === 'Delivery/Main workflow planner') {
          return {
            id,
            localAgent: undefined,
            result: Promise.resolve({
              output: [],
              structured: {
                decision: 'run',
                reason: 'The feature needs the full delivery workflow.',
                summary: 'Design, implement, then review.',
                memberOrder: [researcherId, writerId, reviewerId],
                assignments: [
                  { agentId: researcherId, task: 'DESIGN-SCOPE: define the architecture and acceptance criteria.', dependsOn: [] },
                  { agentId: writerId, task: 'IMPLEMENT-SCOPE: implement only the approved architecture.', dependsOn: [researcherId] },
                  { agentId: reviewerId, task: 'REVIEW-SCOPE: audit the implementation against the criteria.', dependsOn: [writerId] },
                ],
              },
              stopReason: 'completed' as const,
            }),
            async dispose() {},
          }
        }
        return {
          id,
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text' as const, text: request.label ?? '' }], stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, { ...agent('Designer'), systemPrompt: 'Design the technical approach.' })
    await state.agents.put(writerId, { ...agent('Implementer'), systemPrompt: 'Implement approved designs.' })
    await state.agents.put(reviewerId, { ...agent('Reviewer'), systemPrompt: 'Review completed implementation.' })
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId, reviewerId] })

    const result = await state.service.dispatch(
      { squadId, task: 'Build a reliable feature' },
      state.parent,
      new AbortController().signal,
      { sessionId: state.parent.id, sourceMessageId: 'main-plan-message' },
    )

    expect(requests.map(item => item.request.label)).toEqual([
      'Delivery/Main workflow planner',
      'Delivery/Designer',
      'Delivery/Implementer',
      'Delivery/Reviewer',
    ])
    expect(requests[0]).toMatchObject({
      provider: 'fork',
      request: {
        agentOptions: { provider: 'main-provider', model: 'main-model', maxTokens: 2_048 },
        toolFilter: { allow: [] },
        outputSchema: { type: 'object' },
      },
    })
    expect(requests[0]?.request.prompt[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/Designer[\s\S]*Implementer[\s\S]*Reviewer/),
    })
    expect(result.plan).toMatchObject({
      planner: 'main-agent',
      plannerProvider: 'main-provider',
      plannerModel: 'main-model',
      memberOrder: [researcherId, writerId, reviewerId],
    })
    const memberPrompts = requests.slice(1).map(item => (item.request.prompt[0] as { text: string }).text)
    expect(memberPrompts[0]).toContain('DESIGN-SCOPE')
    expect(memberPrompts[0]).not.toContain('IMPLEMENT-SCOPE')
    expect(memberPrompts[1]).toContain('IMPLEMENT-SCOPE')
    expect(memberPrompts[1]).not.toContain('REVIEW-SCOPE')
    expect(memberPrompts[2]).toContain('REVIEW-SCOPE')
    expect(memberPrompts[2]).toContain('Do not perform or replace another member')
  })

  it('falls back to a distinct role-scoped assignment for every member when planning fails', async () => {
    const requests: SubagentStartRequest[] = []
    const state = createService({
      start: async (_provider, request) => {
        requests.push(request)
        const id = SessionId(`fallback-child-${requests.length}`)
        return {
          id,
          localAgent: undefined,
          result: Promise.resolve(request.label === 'Delivery/Main workflow planner'
            ? {
                output: [],
                structured: { summary: 'incomplete', memberOrder: [researcherId], assignments: [] },
                stopReason: 'completed' as const,
              }
            : { output: [{ type: 'text' as const, text: request.label ?? '' }], stopReason: 'completed' as const }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, { ...agent('Designer'), systemPrompt: 'Design boundaries.' })
    await state.agents.put(writerId, { ...agent('Implementer'), systemPrompt: 'Write production code.' })
    await state.agents.put(reviewerId, { ...agent('Reviewer'), systemPrompt: 'Find correctness defects.' })
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId, reviewerId] })

    const result = await state.service.dispatch(
      { squadId, task: 'Build it' },
      state.parent,
      new AbortController().signal,
      { sourceMessageId: 'fallback-plan-message' },
    )

    expect(result.plan).toMatchObject({ planner: 'deterministic-fallback', warning: expect.stringContaining('valid plan') })
    expect(result.plan?.assignments).toHaveLength(3)
    expect(new Set(result.plan?.assignments.map(item => item.task)).size).toBe(3)
    expect(result.plan?.assignments.map(item => item.task)).toEqual([
      expect.stringContaining('Design boundaries.'),
      expect.stringContaining('Write production code.'),
      expect.stringContaining('Find correctness defects.'),
    ])
    expect(requests).toHaveLength(4)
  })

  it('hard-denies recursive team and subagent tools inside squad members', async () => {
    const state = createService({
      toolSchemas: () => [
        { name: 'read_file', description: 'Read' },
        { name: 'dispatch_to_squad', description: 'Dispatch' },
        { name: 'subagent', description: 'Delegate' },
        { name: 'workflow', description: 'Orchestrate subagents' },
      ],
    })
    await state.agents.put(researcherId, {
      ...agent('Researcher'),
      toolScope: { allow: ['read_file'] },
    })
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })

    await state.service.dispatch({ squadId, task: 'safe work' }, state.parent, new AbortController().signal)

    expect(state.starts[0]?.request.toolFilter).toEqual({
      allow: ['read_file'],
      deny: ['dispatch_to_squad', 'subagent', 'workflow'],
    })
    expect(state.starts[0]?.request.prompt[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('do not create or delegate to subagents'),
    })
  })

  it('rejects a nested squad dispatch even if a child somehow reaches the tool', async () => {
    const state = await populate()
    const child = {
      id: SessionId('nested-child'),
      session: { header: { parentSession: state.parent.id, origin: 'subagent', delegationDepth: 1 } },
    } as unknown as Agent

    await expect(state.service.dispatch({ squadId, task: 'recurse' }, child, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH', message: expect.stringContaining('nested') })
    expect(state.starts).toEqual([])
    expect(state.service.listRuns()).toEqual([])
  })

  it('uses squad defaults and a complete model-selected memberOrder', async () => {
    const state = createService()
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.squads.put(squadId, {
      name: 'Delivery',
      members: [researcherId, writerId, reviewerId],
      executionMode: 'parallel',
      contextMode: 'fork',
    })

    const result = await state.service.dispatch({
      squadId,
      task: 'Ship it',
      memberOrder: [reviewerId, researcherId, writerId],
    }, state.parent, new AbortController().signal)

    expect(result).toMatchObject({ executionMode: 'parallel', contextMode: 'fork' })
    expect(state.starts.map(start => start.provider)).toEqual(['fork', 'fork', 'fork'])
    expect(state.starts.map(start => start.request.label)).toEqual([
      'Delivery/Reviewer',
      'Delivery/Researcher',
      'Delivery/Writer',
    ])
    expect(result.members.map(member => member.agentId)).toEqual([reviewerId, researcherId, writerId])
  })

  it('enforces fixed order and rejects incomplete or overriding memberOrder', async () => {
    const state = await populate()
    await state.service.updateSquad(squadId, {
      name: 'Delivery',
      members: [researcherId, writerId, reviewerId],
      executionOrder: [reviewerId, writerId, researcherId],
    })
    const signal = new AbortController().signal

    await expect(state.service.dispatch({
      squadId,
      task: 'x',
      memberOrder: [reviewerId, writerId, researcherId],
    }, state.parent, signal)).rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    await expect(state.service.dispatch({
      squadId,
      task: 'x',
      executionMode: 'parallel',
    }, state.parent, signal)).rejects.toMatchObject({ code: 'INVALID_DISPATCH' })

    await state.service.updateSquad(squadId, {
      name: 'Delivery',
      members: [researcherId, writerId, reviewerId],
    })
    await expect(state.service.dispatch({
      squadId,
      task: 'x',
      memberOrder: [reviewerId, researcherId],
    }, state.parent, signal)).rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    expect(state.starts).toEqual([])
  })

  it('chains serial output, preserves child ids, and continues after member failures', async () => {
    const requests: SubagentStartRequest[] = []
    let call = 0
    const state = createService({
      start: async (_provider, request) => {
        requests.push(request)
        call += 1
        if (call === 3) throw new Error('provider unavailable')
        const id = SessionId(`child-${call}`)
        return {
          id,
          localAgent: { id } as unknown as Agent,
          result: Promise.resolve(call === 1
            ? { output: [{ type: 'text', text: 'research evidence' }], stopReason: 'completed' }
            : { output: [{ type: 'text', text: 'partial draft' }], stopReason: 'max-tokens' }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId, reviewerId] })

    const result = await state.service.dispatch({
      squadId,
      task: 'Ship the report',
      executionMode: 'serial',
      contextMode: 'chain',
      assignments: [{ agentId: writerId, task: 'Write the final prose' }],
    }, state.parent, new AbortController().signal)

    expect(requests).toHaveLength(3)
    expect(requests[1]?.prompt[0]).toMatchObject({ text: expect.stringContaining('research evidence') })
    expect(requests[1]?.prompt[0]).toMatchObject({ text: expect.stringContaining('Write the final prose') })
    expect(result.status).toBe('partial')
    expect(result.members).toMatchObject([
      { status: 'completed', runId: 'child-1', childId: 'child-1', stopReason: 'completed' },
      { status: 'failed', runId: 'child-2', stopReason: 'max-tokens', error: expect.stringContaining('max-tokens') },
      { status: 'failed', error: 'start failed: provider unavailable' },
    ])
  })

  it('accepts delivered plain text from a protocol-error stop while preserving the stop reason', async () => {
    const chapter = `# Delivered chapter\n\n${'complete prose '.repeat(450)}`
    const state = createService({
      start: async () => ({
        id: SessionId('plain-text-delivery'),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text' as const, text: chapter }],
          stopReason: 'error' as const,
        }),
        async dispose() {},
      }),
    })
    await state.agents.put(researcherId, agent('Writer'))
    await state.squads.put(squadId, {
      name: 'Long-form delivery',
      members: [researcherId],
      executionOrder: [researcherId],
      handoffSummaryMaxChars: 8_000,
    })

    const result = await state.service.dispatch({ squadId, task: 'Write the chapter' }, state.parent, new AbortController().signal)

    expect(result.status).toBe('completed')
    expect(result.members[0]).toMatchObject({
      status: 'completed',
      stopReason: 'error',
      output: [{ type: 'text', text: chapter }],
      handoff: { summary: chapter.trim() },
    })
    expect(result.members[0]).not.toHaveProperty('error')
    expect(state.service.getRun(result.dispatchId)?.members[0]).toMatchObject({
      status: 'completed',
      stopReason: 'error',
      handoff: { summary: chapter.trim() },
    })
  })

  it('keeps an error stop without delivered text failed', async () => {
    const state = createService({
      start: async () => ({
        id: SessionId('empty-error'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text' as const, text: '  \n' }], stopReason: 'error' as const }),
        async dispose() {},
      }),
    })
    await state.agents.put(researcherId, agent('Writer'))
    await state.squads.put(squadId, { name: 'Empty delivery', members: [researcherId], executionOrder: [researcherId] })

    const result = await state.service.dispatch({ squadId, task: 'Write the chapter' }, state.parent, new AbortController().signal)

    expect(result.status).toBe('failed')
    expect(result.members[0]).toMatchObject({
      status: 'failed',
      stopReason: 'error',
      error: 'run ended with stop reason error',
    })
  })

  it('rejects ambiguous dispatch inputs before starting children', async () => {
    const { service, starts, parent, squads } = await populate()
    const signal = new AbortController().signal

    await expect(service.dispatch({ squadId, task: 'x', executionMode: 'parallel', contextMode: 'chain' }, parent, signal))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    await expect(service.dispatch({
      squadId,
      task: 'x',
      assignments: [
        { agentId: researcherId, task: 'one' },
        { agentId: researcherId, task: 'two' },
      ],
    }, parent, signal)).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENTS' })
    await expect(service.dispatch({
      squadId,
      task: 'x',
      assignments: [{ agentId: AgentId('outsider'), task: 'one' }],
    }, parent, signal)).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENTS' })
    await squads.put(SquadId('empty'), { name: 'Empty', members: [] })
    await expect(service.dispatch({ squadId: SquadId('empty'), task: 'x' }, parent, signal))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    expect(starts).toEqual([])
  })

  it('reports cleanup failure without replacing other member outcomes', async () => {
    const state = createService({
      start: async () => ({
        id: SessionId('cleanup-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'answer' }], stopReason: 'completed' }),
        async dispose() { throw new Error('cleanup broke') },
      }),
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })

    const result = await state.service.dispatch({ squadId, task: 'x' }, state.parent, new AbortController().signal)
    expect(result.status).toBe('failed')
    expect(result.members[0]).toMatchObject({
      runId: 'cleanup-child',
      output: [{ type: 'text', text: 'answer' }],
      error: 'run cleanup failed: cleanup broke',
    })
  })

  it('retries once on the configured fallback route and records durable progress', async () => {
    const routes: Array<{ provider?: string; model?: string }> = []
    let attempt = 0
    const state = createService({
      start: async (_provider, request) => {
        routes.push(request.agentOptions ?? {})
        attempt += 1
        return {
          id: SessionId(`retry-${attempt}`),
          localAgent: undefined,
          result: Promise.resolve(attempt === 1
            ? { output: [{ type: 'text', text: 'partial' }], stopReason: 'max-tokens' }
            : { output: [{ type: 'text', text: 'recovered' }], stopReason: 'completed' }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, {
      ...agent('Researcher'), fallbackProvider: 'configured', fallbackModel: 'backup',
    })
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId], failurePolicy: 'retry-once',
    })

    const result = await state.service.dispatch({ squadId, task: 'recover' }, state.parent, new AbortController().signal)
    expect(result).toMatchObject({ status: 'completed', members: [{ status: 'completed', attempts: 2 }] })
    expect(routes).toEqual([
      expect.objectContaining({ provider: 'configured', model: 'researcher' }),
      expect.objectContaining({ provider: 'configured', model: 'backup' }),
    ])
    expect(state.service.listRuns(state.parent.id)).toMatchObject([{
      id: result.dispatchId, status: 'completed', members: [{ status: 'completed', attempts: 2 }],
    }])
  })

  it('uses the official token projection and stops starting members after the soft budget', async () => {
    let call = 0
    const state = createService({
      start: async (_provider, request) => {
        call += 1
        const localAgent = { id: SessionId(`usage-${call}`), session: { marker: call } } as unknown as Agent
        return {
          id: localAgent.id,
          localAgent,
          result: Promise.resolve({ output: [{ type: 'text', text: request.label ?? '' }], stopReason: 'completed' }),
          async dispose() {},
        }
      },
    })
    state.ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { tokenUsage: {
        uncachedInputTokens: 80, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0,
      } } }),
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.squads.put(squadId, {
      name: 'Delivery', members: [researcherId, writerId], executionMode: 'serial', tokenBudget: 100,
    })

    const result = await state.service.dispatch({ squadId, task: 'budgeted' }, state.parent, new AbortController().signal)
    expect(call).toBe(1)
    expect(result.usage).toEqual({
      uncachedInputTokens: 80, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0,
      totalTokens: 120, providerReported: true,
    })
    expect(result.status).toBe('partial')
    expect(state.service.getRun(result.dispatchId)?.members).toMatchObject([
      { agentId: researcherId, status: 'completed' },
      { agentId: writerId, status: 'skipped', error: expect.stringContaining('budget') },
    ])
  })

  it('streams official token projection updates while a member is still running', async () => {
    let finish: ((value: { output: never[]; stopReason: 'completed' }) => void) | undefined
    let child: Agent | undefined
    let listener: ((session: Agent['session'], key: string, value: unknown, seq: number) => void) | undefined
    let projection = {
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const result = new Promise<{ output: never[]; stopReason: 'completed' }>((resolve) => { finish = resolve })
    const state = createService({
      start: async () => {
        child = { id: SessionId('live-usage'), session: { header: {} } } as unknown as Agent
        return { id: child.id, localAgent: child, result, async dispose() {} }
      },
    })
    state.ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { tokenUsage: projection } }),
      onChanged: (next: typeof listener) => { listener = next; return () => { listener = undefined } },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })

    const dispatch = state.service.dispatch({ squadId, task: 'meter live' }, state.parent, new AbortController().signal)
    await vi.waitFor(() => { expect(listener).toBeDefined() })
    projection = { uncachedInputTokens: 90, outputTokens: 12, cacheReadTokens: 8, cacheWriteTokens: 0 }
    listener?.(child!.session, 'tokenUsage', projection, 1)
    await vi.waitFor(() => {
      expect(state.service.listRuns(state.parent.id)[0]).toMatchObject({
        status: 'running',
        usage: { totalTokens: 110, providerReported: true },
        members: [{ status: 'running', usage: { totalTokens: 110, providerReported: true } }],
      })
    })

    finish?.({ output: [], stopReason: 'completed' })
    await expect(dispatch).resolves.toMatchObject({ usage: { totalTokens: 110 } })
  })
})

it('exposes stable typed errors to RPC callers', () => {
  expect(new AgentTeamError('bad', 'INVALID_DISPATCH')).toMatchObject({
    name: 'AgentTeamError',
    code: 'INVALID_DISPATCH',
  })
})

it('exposes memberOrder in the model-facing dispatch tool schema', () => {
  const { service } = createService()
  const tool = createDispatchToSquadTool(service)
  const parameters = tool.parameters as {
    properties: Record<string, unknown>
  }
  expect(parameters.properties.memberOrder).toMatchObject({
    type: 'array',
    items: { type: 'string' },
  })

  const rendered = tool.output.render({}, {
    dispatchId: 'dispatch-1',
    squadId: 'delivery',
    squadName: 'Delivery',
    task: 'Ship it',
    executionMode: 'serial',
    contextMode: 'spawn',
    status: 'partial',
    members: [{
      agentId: 'researcher',
      agentName: 'Researcher',
      status: 'failed',
      runId: 'run-1',
      childId: 'child-1',
      stopReason: 'max-tokens',
      output: [{ type: 'text', text: 'partial evidence' }],
      error: 'run ended with stop reason max-tokens',
    }],
  })
  expect(rendered[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('"childId": "child-1"'),
  })
  expect(rendered[0]).toMatchObject({
    text: expect.not.stringContaining('partial evidence'),
  })
  expect(rendered[0]).toMatchObject({
    text: expect.stringContaining('Full output is available in Run Center'),
  })
})
