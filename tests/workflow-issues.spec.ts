import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { boundedHandoffChain, type HandoffDelivery } from '../src/tools/handoff-chain.ts'
import { isDelegationTool, teamChildToolGuard } from '../src/tools/delegation-policy.ts'
import { agent, createService, researcherId, reviewerId, squadId } from './helpers.ts'

const handoff = (summary: string) => ({ summary, deliverables: ['artifact'], risks: [], changedFiles: ['src/example.ts'] })
const delivery = (id: string, summary: string): HandoffDelivery => ({ agentId: id, status: 'completed', handoff: handoff(summary) })
const signal = () => new AbortController().signal

function withHumanMessage(parent: Agent): Agent {
  return { ...parent, session: {
    header: parent.session.header,
    snapshotEvents: () => [{ type: 'user/message', data: { id: 'human-1', source: { kind: 'user' } } }],
  } } as unknown as Agent
}

describe('bounded JSON chains (#69)', () => {
  it('preserves short handoffs and identities without mutation', () => {
    const source = [delivery('a', 'build'), delivery('b', 'review')]
    const copy = structuredClone(source)
    const chain = JSON.parse(boundedHandoffChain(source))
    expect(chain.chainTruncated).toBe(false)
    expect(chain.handoffs.map((row: HandoffDelivery) => row.agentId)).toEqual(['a', 'b'])
    expect(chain.handoffs[1].handoff).toEqual(source[1]?.handoff)
    expect(source).toEqual(copy)
  })

  it.each(['x', '\n', '\"', '\\', '\u0000', '😀'])('budgets serialized escape expansion for %j', character => {
    const text = boundedHandoffChain([delivery('verbose', character.repeat(16_000)), delivery('later', 'important later result')])
    expect(text.length).toBeLessThanOrEqual(12_000)
    const chain = JSON.parse(text)
    expect(chain.chainTruncated).toBe(true)
    expect(chain.handoffs.map((row: HandoffDelivery) => row.agentId)).toEqual(['verbose', 'later'])
    expect(chain.handoffs[1].handoff.summary).toBe('important later result')
    expect(chain.handoffs[0].chainTruncated).toBe(true)
    expect(chain.omittedHandoffs).toBe(0)
  })

  it('keeps all 32 members represented with large summaries and arrays', () => {
    const source = Array.from({ length: 32 }, (_, i) => ({ ...delivery(`agent-${i}`, 'result'.repeat(5_000)), handoff: {
      summary: 'result'.repeat(5_000), deliverables: Array(12).fill('\n'.repeat(1_000)),
      risks: Array(12).fill('r'.repeat(1_000)), changedFiles: Array(50).fill('p'.repeat(1_000)),
    } }))
    const text = boundedHandoffChain(source)
    expect(text.length).toBeLessThanOrEqual(12_000)
    expect(JSON.parse(text).handoffs).toHaveLength(32)
  })

  it('reports identity records that cannot fit and supports an empty chain', () => {
    const text = boundedHandoffChain([delivery('a'.repeat(2_000), 'x'), delivery('b', 'y')], 256)
    expect(text.length).toBeLessThanOrEqual(256)
    expect(JSON.parse(text)).toMatchObject({ chainTruncated: true, omittedHandoffs: 2 })
    const larger = JSON.parse(boundedHandoffChain([delivery('a'.repeat(2_000), 'x'), delivery('b', 'y')], 512))
    expect(larger.omittedHandoffs).toBe(1)
    expect(larger.handoffs[0].agentId).toBe('b')
    expect(JSON.parse(boundedHandoffChain([])).handoffs).toEqual([])
  })
})

describe('model-tool admission (#68)', () => {
  it('allows a corrected call after invalid fixed-order overrides without spending a claim', async () => {
    const state = createService()
    await state.agents.put(researcherId, agent('Builder'))
    await state.squads.put(squadId, { name: 'Fixed', members: [researcherId], executionOrder: [researcherId] })
    const parent = withHumanMessage(state.parent)
    await expect(state.service.dispatchFromTool({ squadId, task: 'build', memberOrder: [researcherId] }, parent, signal()))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    expect(state.messageClaims.size).toBe(0)
    expect(state.runs.size).toBe(0)
    await expect(state.service.dispatchFromTool({ squadId, task: 'build' }, parent, signal())).resolves.toMatchObject({ status: 'completed' })
    expect(state.starts).toHaveLength(1)
    expect(state.messageClaims.size).toBe(1)
    await expect(state.service.dispatchFromTool({ squadId, task: 'build again' }, { ...parent }, signal()))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    expect(state.starts).toHaveLength(1)
  })

  it('admits only one concurrent call for a message', async () => {
    const state = createService()
    await state.agents.put(researcherId, agent('Builder'))
    await state.squads.put(squadId, { name: 'Fixed', members: [researcherId], executionOrder: [researcherId] })
    const parent = withHumanMessage(state.parent)
    const outcomes = await Promise.allSettled(['one', 'two'].map(task => state.service.dispatchFromTool({ squadId, task }, parent, signal())))
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(state.starts).toHaveLength(1)
  })

  it('keeps the claim after an admitted run fails', async () => {
    let starts = 0
    const state = createService({ start: async () => { starts++; throw new Error('provider unavailable') } })
    await state.agents.put(researcherId, agent('Builder'))
    await state.squads.put(squadId, { name: 'Fixed', members: [researcherId], executionOrder: [researcherId] })
    const parent = withHumanMessage(state.parent)
    await expect(state.service.dispatchFromTool({ squadId, task: 'build' }, parent, signal())).resolves.toMatchObject({ status: 'failed' })
    await expect(state.service.dispatchFromTool({ squadId, task: 'build' }, parent, signal())).rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    expect(starts).toBe(1)
  })
})

describe('review and repair integration (#67, #69)', () => {
  it.each([undefined, 512, 8_192])('uses the reviewer budget %s and retains attributed valid chains through repair', async maxTokens => {
    const requests: SubagentStartRequest[] = []
    let reviews = 0
    const state = createService({ start: async (_provider, request) => {
      requests.push(request)
      const verdict = request.label?.includes('Quality review')
      if (verdict) reviews++
      return { id: state.parent.id, localAgent: undefined, async dispose() {}, result: Promise.resolve({
        output: [], stopReason: 'completed' as const,
        structured: verdict ? { approved: reviews > 1, feedback: 'Fix the missing check.' } : handoff('result\n'.repeat(3_000)),
      }) }
    } })
    await state.agents.put(researcherId, agent('Builder'))
    await state.agents.put(reviewerId, { ...agent('Reviewer'), ...(maxTokens === undefined ? {} : { maxTokens }) })
    await state.squads.put(squadId, { name: 'Quality', members: [researcherId, reviewerId], executionOrder: [researcherId, reviewerId],
      qualityGate: { reviewerAgentId: reviewerId, repairAgentId: researcherId, maxRounds: 1 },
    })
    const result = await state.service.dispatch({ squadId, task: 'build' }, state.parent, signal())
    expect(result.quality?.approved).toBe(true)
    const review = requests.find(request => request.label?.includes('Quality review'))!
    expect(review.agentOptions?.maxTokens).toBe(maxTokens ?? 2_048)
    const repair = requests.find(request => JSON.stringify(request.prompt).includes('Repair only the quality issues'))!
    const prompt = repair.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    const chain = prompt.split('Dependency handoffs (bounded JSON; full outputs in Run Center):\n')[1]!.split('\n\n---\n\n')[0]!
    expect(chain.length).toBeLessThanOrEqual(12_000)
    expect(JSON.parse(chain).chainTruncated).toBe(true)
    expect(JSON.parse(chain).handoffs.map((row: HandoffDelivery) => row.agentId)).toEqual([researcherId, reviewerId])
  })
})

describe('scoped delegation restrictions (#66)', () => {
  const delegateShape = {
    type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, reasoning_effort: { type: 'string' } },
    required: ['description', 'prompt'],
  }

  it('recognizes renamed delegation with route options and never emits a phantom deny name', async () => {
    const global = [{ name: 'read_file', description: 'read' }, { name: 'subagent_fork', description: 'delegate', parameters: delegateShape }]
    const scoped = [...global, { name: 'subagent', description: 'scope alias', parameters: delegateShape }, { name: 'local_read', description: 'read' }]
    const requests: SubagentStartRequest[] = []
    const state = createService({ toolSchemas: parent => parent === undefined ? global : scoped, start: async (_provider, request) => {
      requests.push(request)
      expect(request.toolFilter?.deny).toEqual(['subagent_fork'])
      expect(request.toolFilter?.allow).toEqual(['local_read'])
      expect(request.agentOptions?.agentTeamGuiChild).toBe(true)
      return { id: state.parent.id, localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' as const }), async dispose() {} }
    } })
    await state.agents.put(researcherId, { ...agent('Reader'), toolScope: { allow: ['local_read'] } })
    await state.squads.put(squadId, { name: 'Reader', members: [researcherId], executionOrder: [researcherId] })
    expect((await state.service.dispatch({ squadId, task: 'read' }, state.parent, signal())).status).toBe('completed')
    expect(requests).toHaveLength(1)
    expect(isDelegationTool({ name: 'custom_delegate', parameters: delegateShape })).toBe(true)
  })

  it('blocks actual scoped tool execution for marked children while allowing other agents', async () => {
    const ctx = new Context()
    ctx.provide('systemPrompt', { tools: () => () => {} })
    const tools = new ToolRuntime(ctx)
    const child = { options: { agentTeamGuiChild: true } } as unknown as Agent
    const other = { options: {} } as unknown as Agent
    const scope = createScope(ctx, child)
    let calls = 0
    const definition = defineTool({ name: 'custom_delegate', description: 'delegate',
      parameters: { description: { type: 'string', required: true }, prompt: { type: 'string', required: true }, provider: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { calls++; return 'spawned' },
    })
    tools.register(definition)
    scope.ctx.tools.register({ ...definition, name: 'subagent' })
    tools.guard(teamChildToolGuard(tools))
    const call = (name: string, actor: Agent) => tools.execute({ name, agent: actor, arguments: { description: 'delegate', prompt: 'work' }, signal: signal(), callId: ToolCallId('test') })
    expect((await call('subagent', child)).isError).toBe(true)
    expect((await call('custom_delegate', child)).isError).toBe(true)
    expect(calls).toBe(0)
    expect((await call('custom_delegate', other)).isError).toBe(false)
    expect(calls).toBe(1)
  })
})
