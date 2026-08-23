import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createAgentTeamRpcHandler } from '../src/rpc.ts'
import type { AgentId } from '../src/types.ts'
import type { AgentTeamExportDocument, AgentTeamImportResult, SquadDispatchResult } from '../src/types.ts'
import { agent, createService, populate, researcherId, squadId, writerId } from './helpers.ts'

type Handler = ReturnType<typeof createAgentTeamRpcHandler>

/** Run one endpoint with a typed success value; the handler itself is RpcResult<unknown>. */
async function call<T>(handler: Handler, endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<T>> {
  return await handler(endpoint, payload, signal) as RpcResult<T>
}

interface SnapshotValue {
  apiVersion: number
  capabilities: {
    smartActivation: boolean
    dags: boolean
    qualityGate: boolean
    backgroundRuns: boolean
    recipes: boolean
    insights: boolean
    reproducibleVersions: boolean
    remoteRecipeFetch: boolean
  }
  agents: Array<{ id: string; name: string }>
  squads: Array<{ id: string; name: string }>
  models: Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }>
  tools: Array<{ name: string; description: string }>
}

describe('agent team RPC handler', () => {
  const signal = (): AbortSignal => new AbortController().signal

  it('serves a snapshot with agents, squads, and the model catalog', async () => {
    const state = await populate()
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const result = await call<SnapshotValue>(handler, 'snapshot', {}, signal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.apiVersion).toBe(4)
    expect(result.value.capabilities).toMatchObject({ dags: true, recipes: true, remoteRecipeFetch: false })
    expect(result.value.agents).toHaveLength(3)
    expect(result.value.squads).toHaveLength(1)
    expect(result.value.models).toEqual([{
      provider: 'configured',
      name: 'Configured',
      models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
    }])
    expect(result.value.tools).toEqual([{ name: 'read_file', description: 'Read a workspace file' }])
  })

  it('creates, updates, and deletes agents through the endpoint boundary', async () => {
    const state = createService()
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const created = await call<{ id: string }>(handler, 'agent/create', {
      record: { name: 'Researcher', systemPrompt: 'You are Researcher.', provider: 'configured', model: 'researcher' },
    }, signal())
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.id

    const updated = await call<{ updated: boolean }>(handler, 'agent/update', {
      id,
      record: { name: 'Researcher v2', systemPrompt: 'updated', provider: 'configured', model: 'researcher' },
    }, signal())
    expect(updated.ok).toBe(true)
    expect(state.service.getAgent(id as AgentId)?.name).toBe('Researcher v2')

    const deleted = await call<{ deleted: boolean }>(handler, 'agent/delete', { id }, signal())
    expect(deleted.ok).toBe(true)
    expect(state.service.getAgent(id as AgentId)).toBeUndefined()
  })

  it('maps zod boundary violations and domain errors to RpcError', async () => {
    const state = createService()
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const invalid = await call<unknown>(handler, 'agent/create', {
      record: { name: '', systemPrompt: '', provider: '', model: '' },
    }, signal())
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.error.code).toBe('bad-request')
    expect(invalid.error.message.length).toBeGreaterThan(0)

    const missingMember = await call<unknown>(handler, 'squad/create', { record: { name: 'S', members: ['nope'] } }, signal())
    expect(missingMember.ok).toBe(false)
    if (missingMember.ok) return
    expect(missingMember.error.code).toBe('bad-request')
    expect(missingMember.error.message).toContain('INVALID_MEMBERS')
  })

  it('round-trips squad execution and context defaults through RPC', async () => {
    const state = await populate()
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)
    const updated = await call<{ updated: boolean }>(handler, 'squad/update', {
      id: squadId,
      record: {
        name: 'Delivery',
        members: [researcherId, writerId, 'reviewer'],
        collabNote: 'Cross-check.',
        executionOrder: ['reviewer', writerId, researcherId],
        executionMode: 'serial',
        contextMode: 'chain',
        handoffSummaryMaxChars: 24_000,
      },
    }, signal())

    expect(updated).toEqual({ ok: true, value: { updated: true } })
    expect(state.service.getSquad(squadId)).toMatchObject({
      executionOrder: ['reviewer', writerId, researcherId],
      executionMode: 'serial',
      contextMode: 'chain',
      handoffSummaryMaxChars: 24_000,
    })
    const snapshot = await call<SnapshotValue & { squads: Array<Record<string, unknown>> }>(
      handler, 'snapshot', {}, signal(),
    )
    expect(snapshot.ok && snapshot.value.squads[0]).toMatchObject({
      executionOrder: ['reviewer', writerId, researcherId],
      executionMode: 'serial',
      contextMode: 'chain',
      handoffSummaryMaxChars: 24_000,
    })
  })

  it('rejects unknown endpoints and surfaces cancellation', async () => {
    const state = createService()
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const unknown = await call<unknown>(handler, 'bogus', {}, signal())
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.error.code).toBe('bad-request')

    const controller = new AbortController()
    controller.abort()
    const cancelled = await call<unknown>(handler, 'agent/create', { record: { name: '' } }, controller.signal)
    expect(cancelled.ok).toBe(false)
    if (cancelled.ok) return
    expect(cancelled.error.code).toBe('cancelled')
  })

  it('dispatch requires a live parent agent for the session', async () => {
    const state = await populate()
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const result = await call<unknown>(handler, 'dispatch', { sessionId: 'nope', squadId, task: 'x' }, signal())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('session-not-found')
  })

  it('dispatch rejects an unknown squad id', async () => {
    const state = createService({ agentsGet: () => ({ id: SessionId('parent'), session: { header: {} } }) as unknown })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const result = await call<unknown>(handler, 'dispatch', { sessionId: 'parent', squadId: 'nope', task: 'x' }, signal())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad-request')
    expect(result.error.message).toContain('SQUAD_NOT_FOUND')
  })

  it('dispatches a full squad through the endpoint', async () => {
    const state = createService({ agentsGet: () => ({ id: SessionId('parent'), session: { header: {} } }) as unknown })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId] })
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const result = await call<SquadDispatchResult>(handler, 'dispatch', {
      sessionId: 'parent',
      squadId,
      task: 'Ship it',
      executionMode: 'parallel',
      contextMode: 'spawn',
    }, signal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('completed')
    expect(result.value.members).toHaveLength(2)
  })

  it('persists, reads, and disables session squad mode through RPC', async () => {
    const state = await populate()
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    await expect(call(handler, 'mode/get', { sessionId: 'conversation' }, signal()))
      .resolves.toEqual({ ok: true, value: {
        mode: null,
        sessionOverride: 'inherit',
        sessionReady: false,
        projectKey: null,
        projectDefault: null,
        nextOverride: null,
      } })

    const enabled = await call<{ mode: { sessionId: string; squadId: string; squadName: string } | null }>(
      handler, 'mode/set', { sessionId: 'conversation', squadId }, signal(),
    )
    expect(enabled).toEqual({ ok: true, value: {
      mode: { sessionId: 'conversation', squadId, squadName: 'Delivery' },
      sessionOverride: 'enabled',
      nextOverride: null,
      projectKey: null,
      projectDefault: null,
      sessionReady: false,
    } })
    await expect(call(handler, 'mode/get', { sessionId: 'conversation' }, signal()))
      .resolves.toEqual({ ok: true, value: {
        mode: { sessionId: 'conversation', squadId, squadName: 'Delivery' },
        sessionOverride: 'enabled',
        sessionReady: false,
        projectKey: null,
        projectDefault: null,
        nextOverride: null,
      } })
    await expect(call(handler, 'mode/set', { sessionId: 'conversation', squadId: null }, signal()))
      .resolves.toEqual({ ok: true, value: {
        mode: null,
        sessionOverride: 'disabled',
        sessionReady: false,
        projectKey: null,
        projectDefault: null,
        nextOverride: null,
      } })
    await expect(call(handler, 'mode/get', { sessionId: 'conversation' }, signal()))
      .resolves.toEqual({ ok: true, value: {
        mode: null,
        sessionOverride: 'disabled',
        sessionReady: false,
        projectKey: null,
        projectDefault: null,
        nextOverride: null,
      } })
  })

  it('restores a project default from the Session before its Agent is live', async () => {
    const sessionId = SessionId('restoring')
    const session = { id: sessionId, header: { cwd: '/workspace/project' } } as unknown as Agent['session']
    const state = createService({ sessionsGet: id => id === sessionId ? session : undefined })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })
    await state.projectDefaults.put('/workspace/project', {
      projectKey: '/workspace/project', squadId, enabled: true,
    })
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    await expect(call(handler, 'mode/get', { sessionId }, signal())).resolves.toEqual({
      ok: true,
      value: {
        mode: { sessionId, squadId, squadName: 'Delivery' },
        sessionOverride: 'inherit',
        sessionReady: true,
        projectKey: '/workspace/project',
        projectDefault: { projectKey: '/workspace/project', squadId, enabled: true },
        nextOverride: null,
      },
    })
  })

  it('exports and imports definitions through the endpoint boundary', async () => {
    const source = await populate()
    const sourceHandler = createAgentTeamRpcHandler(source.ctx, source.service)
    const exported = await call<AgentTeamExportDocument>(sourceHandler, 'export', {}, signal())
    expect(exported.ok).toBe(true)
    if (!exported.ok) return

    const target = createService()
    const targetHandler = createAgentTeamRpcHandler(target.ctx, target.service)
    const preview = await target.service.previewDefinitionsImport(exported.value)
    const imported = await call<AgentTeamImportResult>(targetHandler, 'import', {
      doc: exported.value, expectedRevision: preview.definitionRevision,
    }, signal())
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.value).toEqual({ agents: 3, squads: 1 })
    expect(target.service.listSquads()).toEqual(source.service.listSquads())

    const bad = await call<unknown>(targetHandler, 'import', {
      doc: { format: 'nope', version: 1, agents: [], squads: [] },
    }, signal())
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error.code).toBe('bad-request')
  })

  it('exposes versions, diagnostics, project defaults, and durable run history', async () => {
    let live: unknown
    const state = createService({ agentsGet: () => live })
    live = state.parent
    await state.service.createAgent(agent('Researcher'), researcherId)
    await state.service.createSquad({ name: 'Delivery', members: [researcherId] }, squadId)
    await state.service.updateSquad(squadId, { name: 'Delivery v2', members: [researcherId] })
    const handler = createAgentTeamRpcHandler(state.ctx, state.service)

    const versions = await call<Array<{ version: number }>>(handler, 'squad/versions', { id: squadId }, signal())
    expect(versions.ok && versions.value.map(item => item.version)).toEqual([2, 1])
    const diagnosis = await call<{ ok: boolean }>(handler, 'squad/diagnose', { id: squadId }, signal())
    expect(diagnosis).toEqual({ ok: true, value: expect.objectContaining({ ok: true }) })

    const project = await call(handler, 'project/default-set', { sessionId: state.parent.id, squadId }, signal())
    expect(project).toEqual({ ok: true, value: expect.objectContaining({ projectDefault: expect.objectContaining({ squadId }) }) })
    await expect(call(handler, 'mode/get', { sessionId: state.parent.id }, signal())).resolves.toEqual({
      ok: true,
      value: {
        mode: { sessionId: state.parent.id, squadId, squadName: 'Delivery v2' },
        sessionOverride: 'inherit',
        sessionReady: true,
        projectKey: '/workspace/project',
        projectDefault: { projectKey: '/workspace/project', squadId, enabled: true },
        nextOverride: null,
      },
    })

    const dispatched = await state.service.dispatch({ squadId, task: 'history' }, state.parent, signal())
    const history = await call<{ runs: Array<{ id: string; status: string }> }>(handler, 'run/list', { sessionId: state.parent.id }, signal())
    expect(history.ok && history.value.runs).toMatchObject([{ id: dispatched.dispatchId, status: 'completed' }])
    await expect(call(handler, 'run/get', { id: dispatched.dispatchId }, signal())).resolves.toEqual({
      ok: true, value: { run: expect.objectContaining({ id: dispatched.dispatchId }) },
    })
  })
})
