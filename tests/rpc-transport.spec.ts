import { describe, expect, it, vi } from 'vitest'
import { createAgentTeamFetchHandler, createAgentTeamRpcHandler } from '../src/rpc.ts'
import { createService } from './helpers.ts'

function request(payload: unknown, method = 'agentTeamGui'): Request {
  return new Request('http://127.0.0.1/api/agentTeamGui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'transport-1', method, payload }),
  })
}

describe('authenticated Connection route adapter', () => {
  it('routes a snapshot and preserves response correlation', async () => {
    const { ctx, service } = createService()
    const handle = createAgentTeamFetchHandler(createAgentTeamRpcHandler(ctx, service))
    const response = await handle(request({ endpoint: 'snapshot', payload: {} }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: 'server-response', rpcId: 'transport-1',
      result: { ok: true, value: { apiVersion: 6, agents: [], squads: [] } },
    })
  })

  it('rejects malformed and mismatched envelopes before dispatch', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, value: null }))
    const handle = createAgentTeamFetchHandler(dispatch)
    for (const payload of [null, [], { endpoint: '' }, { endpoint: 42 }, { endpoint: 'snapshot', payload: {}, extra: true }]) {
      expect((await handle(request(payload))).status).toBe(400)
    }
    expect((await handle(request({ endpoint: 'snapshot', payload: {} }, 'wrong-method'))).status).toBe(400)
    expect((await handle(new Request('http://127.0.0.1/api/agentTeamGui', { method: 'POST', body: '{' }))).status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('preserves domain validation failures in the correlated result', async () => {
    const { ctx, service } = createService()
    const handle = createAgentTeamFetchHandler(createAgentTeamRpcHandler(ctx, service))
    const response = await handle(request({ endpoint: 'agent/create', payload: { name: '' } }))
    expect(await response.json()).toMatchObject({
      rpcId: 'transport-1', result: { ok: false, error: { code: 'bad-request' } },
    })
    expect((await service.readDefinitionSnapshot()).agents.size).toBe(0)
  })
})
