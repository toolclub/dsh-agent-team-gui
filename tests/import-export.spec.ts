import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, SquadId } from '../src/types.ts'
import { agent, createService, populate, researcherId, reviewerId, squadId, writerId } from './helpers.ts'

describe('AgentTeamService export/import', () => {
  it('exports a versioned document that round-trips into an empty store', async () => {
    const source = await populate()
    await source.service.updateAgent(researcherId, {
      ...agent('Researcher'), fallbackProvider: 'configured', fallbackModel: 'researcher-backup',
    })
    await source.service.updateSquad(squadId, {
      name: 'Delivery',
      members: [researcherId, writerId, reviewerId],
      executionOrder: [reviewerId, writerId, researcherId],
      contextMode: 'chain',
      handoffSummaryMaxChars: 24_000,
    })
    const doc = await source.service.exportDefinitions()

    expect(doc.format).toBe('agent-team-gui/definitions')
    expect(doc.version).toBe(2)
    expect(doc.agents).toHaveLength(3)
    expect(doc.squads).toHaveLength(1)
    expect(doc.squads[0]).toMatchObject({ handoffSummaryMaxChars: 24_000 })

    const target = createService()
    const result = await target.service.importDefinitions(doc)
    expect(result).toEqual({ agents: 3, squads: 1 })
    expect(target.service.listAgents()).toEqual(source.service.listAgents())
    expect(target.service.getAgent(researcherId)).toMatchObject({ fallbackModel: 'researcher-backup' })
    expect(target.service.listSquads()).toEqual(source.service.listSquads())
    expect(target.service.getSquad(squadId)).toMatchObject({ handoffSummaryMaxChars: 24_000 })
  })

  it('merges by upserting document rows and keeping unrelated store rows', async () => {
    const state = createService()
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })

    const doc = {
      format: 'agent-team-gui/definitions',
      version: 1,
      agents: [
        { id: researcherId, name: 'Researcher v2', systemPrompt: 'updated', provider: 'configured', model: 'researcher' },
        { id: writerId, name: 'Writer', systemPrompt: 'You are Writer.', provider: 'configured', model: 'writer' },
      ],
      squads: [
        { id: squadId, name: 'Delivery', members: [researcherId, writerId] },
        { id: SquadId('docs'), name: 'Docs', members: [writerId] },
      ],
    }
    const result = await state.service.importDefinitions(doc, 'merge')
    expect(result).toEqual({ agents: 2, squads: 2 })
    expect(state.service.getAgent(researcherId)).toMatchObject({ name: 'Researcher v2', systemPrompt: 'updated' })
    expect(state.service.getSquad(squadId)?.members).toEqual([researcherId, writerId])
    expect(state.service.getSquad(SquadId('docs'))?.members).toEqual([writerId])
  })

  it('replace mode makes the document the whole store', async () => {
    const state = await populate()
    const sessionId = SessionId('conversation')
    await state.service.setSessionSquadMode(sessionId, squadId)
    await state.service.setProjectDefault('/workspace/project', squadId)
    await state.service.updateSquad(squadId, { name: 'Delivery revised', members: [researcherId, writerId, reviewerId] })
    const doc = {
      format: 'agent-team-gui/definitions',
      version: 1,
      agents: [{
        id: researcherId,
        name: 'Researcher',
        systemPrompt: 'You are Researcher.',
        provider: 'configured',
        model: 'researcher',
      }],
      squads: [],
    }
    const result = await state.service.importDefinitions(doc, 'replace')
    expect(result).toEqual({ agents: 1, squads: 0 })
    expect(state.service.listAgents().map(([id]) => id)).toEqual([researcherId])
    expect(state.service.listSquads()).toEqual([])
    expect(state.service.getSessionSquadMode(sessionId)).toBeUndefined()
    expect(state.service.getProjectDefault('/workspace/project')).toBeUndefined()
    expect(state.service.listSquadVersions(squadId)).toEqual([])
  })

  it('rejects duplicate ids and unknown member references before writing anything', async () => {
    const state = await populate()
    const duplicates = {
      format: 'agent-team-gui/definitions',
      version: 1,
      agents: [
        { id: researcherId, name: 'A', systemPrompt: '', provider: 'configured', model: 'a' },
        { id: researcherId, name: 'B', systemPrompt: '', provider: 'configured', model: 'b' },
      ],
      squads: [],
    }
    await expect(state.service.importDefinitions(duplicates)).rejects.toMatchObject({ code: 'INVALID_IMPORT' })

    const dangling = {
      format: 'agent-team-gui/definitions',
      version: 1,
      agents: [],
      squads: [{ id: squadId, name: 'Delivery', members: [AgentId('ghost')] }],
    }
    await expect(state.service.importDefinitions(dangling)).rejects.toMatchObject({ code: 'INVALID_IMPORT' })

    // replace mode must not reference agents that only exist in the old store
    const replaceDangling = {
      format: 'agent-team-gui/definitions',
      version: 1,
      agents: [{ id: researcherId, name: 'A', systemPrompt: '', provider: 'configured', model: 'a' }],
      squads: [{ id: squadId, name: 'Delivery', members: [writerId] }],
    }
    await expect(state.service.importDefinitions(replaceDangling, 'replace'))
      .rejects.toMatchObject({ code: 'INVALID_IMPORT' })

    // failed imports must leave the store untouched
    expect(state.service.listAgents()).toHaveLength(3)
    expect(state.service.getSquad(squadId)?.members).toEqual([researcherId, writerId, reviewerId])
  })

  it('validates model routes and document shape before writing', async () => {
    const resolveModelInfo = vi.fn(async (_provider: string, model: string) => {
      if (model === 'missing-model') throw new Error('route is not configured')
      return { provider: 'configured', id: model, name: model }
    })
    const state = createService({ resolveModelInfo: resolveModelInfo as unknown as LlmRuntime['resolveModelInfo'] })
    const badRoute = {
      format: 'agent-team-gui/definitions',
      version: 1,
      agents: [{
        id: AgentId('new'),
        name: 'New',
        systemPrompt: '',
        provider: 'configured',
        model: 'missing-model',
      }],
      squads: [],
    }
    await expect(state.service.importDefinitions(badRoute)).rejects.toThrow('invalid model route')
    expect(state.service.getAgent(AgentId('new'))).toBeUndefined()

    await expect(state.service.importDefinitions({ format: 'wrong', version: 1, agents: [], squads: [] }))
      .rejects.toBeInstanceOf(ZodError)
    await expect(state.service.importDefinitions(undefined)).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects an unknown import mode', async () => {
    const { service } = await populate()
    const doc = await service.exportDefinitions()
    await expect(service.importDefinitions(doc, 'delete' as never))
      .rejects.toMatchObject({ code: 'INVALID_IMPORT' })
  })
})
