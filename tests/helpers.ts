/** Shared in-memory fixture for host service, RPC handler, and import/export tests. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { vi } from 'vitest'
import AgentTeamService from '../src/index.ts'
import { AgentId, DispatchId, SquadId } from '../src/types.ts'
import type { AgentRecord, ProjectSquadDefaultRecord, SessionNextSquadModeRecord, SessionSquadModeRecord, SquadMessageClaimRecord, SquadRecord, SquadRunRecord, SquadVersionRecord } from '../src/types.ts'

export class MemoryTable<K extends string, V> implements KvTable<K, V> {
  private readonly values = new Map<K, V>()

  get size(): number {
    return this.values.size
  }

  get(key: K): V | undefined {
    return this.values.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return new Map(this.values).entries()
  }

  keys(): IterableIterator<K> {
    return new Map(this.values).keys()
  }

  async put(key: K, value: V): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.values.delete(key)
  }

  async update(key: K, transform: (current: V) => V): Promise<V> {
    const current = this.values.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = transform(current)
    this.values.set(key, next)
    return next
  }
}

export const researcherId = AgentId('researcher')
export const writerId = AgentId('writer')
export const reviewerId = AgentId('reviewer')
export const squadId = SquadId('delivery')

/** Explicit coordinator fixture for tests whose focus is execution-attempt routing/metering. */
export function successfulDiagnosisRun() {
  return {
    id: SessionId('system-diagnosis'), localAgent: undefined, async dispose() {},
    result: Promise.resolve({ output: [], stopReason: 'completed' as const, structured: {
      action: 'retry', cause: 'transient', confidence: 'limited', reason: 'Continue the remaining member work.',
      evidence: ['The previous attempt failed.'], progress: 'Check existing artifacts first.',
      nextTask: 'Inspect existing artifacts and complete the remaining original requirements in ordered steps.', uncertainty: 'Existing artifacts require verification.',
    } }),
  }
}

export const agent = (name: string, model = name.toLowerCase()): AgentRecord => ({
  name,
  systemPrompt: `You are ${name}.`,
  provider: 'configured',
  model,
})

export interface FixtureOptions {
  readonly start?: (provider: string, request: SubagentStartRequest) => ReturnType<SubagentRuntime['start']>
  readonly resolveModelInfo?: LlmRuntime['resolveModelInfo']
  readonly listProviders?: LlmRuntime['listProviders']
  readonly listModels?: LlmRuntime['listModels']
  /** Live-agent lookup for the RPC dispatch endpoint; defaults to no live sessions. */
  readonly agentsGet?: (sessionId: string) => unknown
  readonly sessionsGet?: (sessionId: string) => unknown
  readonly toolSchemas?: (scope?: unknown) => Array<{ readonly name: string; readonly description: string; readonly parameters?: unknown }>
}

export interface Fixture {
  readonly ctx: Context
  readonly service: AgentTeamService
  readonly agents: MemoryTable<AgentId, AgentRecord>
  readonly squads: MemoryTable<SquadId, SquadRecord>
  readonly modes: MemoryTable<SessionId, SessionSquadModeRecord>
  readonly nextModes: MemoryTable<SessionId, SessionNextSquadModeRecord>
  readonly messageClaims: MemoryTable<string, SquadMessageClaimRecord>
  readonly runs: MemoryTable<DispatchId, SquadRunRecord>
  readonly versions: MemoryTable<string, SquadVersionRecord>
  readonly projectDefaults: MemoryTable<string, ProjectSquadDefaultRecord>
  readonly starts: { provider: string; request: SubagentStartRequest }[]
  readonly parent: Agent
}

export function createService(options: FixtureOptions = {}): Fixture {
  const ctx = new Context()
  const starts: { provider: string; request: SubagentStartRequest }[] = []
  const subagents = {
    start: options.start ?? (async (provider: string, request: SubagentStartRequest) => {
      starts.push({ provider, request })
      const id = SessionId(`child-${starts.length}`)
      return {
        id,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text' as const, text: request.label ?? '' }],
          stopReason: 'completed' as const,
        }),
        async dispose() {},
      }
    }),
    getProvider: () => ({ capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }),
  }
  const llm = {
    resolveModelInfo: options.resolveModelInfo ?? vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
    })),
    listProviders: options.listProviders ?? vi.fn(() => [{ id: 'configured', name: 'Configured' }]),
    listModels: options.listModels ?? vi.fn(async () => [{ id: 'deepseek-v4', name: 'DeepSeek V4' }]),
  }
  ctx.provide('subagents', subagents)
  ctx.provide('llm', llm)
  ctx.provide('agents', { get: options.agentsGet ?? (() => undefined) })
  ctx.provide('sessions', { get: options.sessionsGet ?? (() => undefined) })
  ctx.provide('tools', { schemas: options.toolSchemas ?? (() => [{ name: 'read_file', description: 'Read a workspace file' }]) })
  const service = new AgentTeamService(ctx, {
    defaultProvider: 'spawn',
    defaultExecutionMode: 'serial',
    defaultContextMode: 'spawn',
  })
  const agents = new MemoryTable<AgentId, AgentRecord>()
  const squads = new MemoryTable<SquadId, SquadRecord>()
  const modes = new MemoryTable<SessionId, SessionSquadModeRecord>()
  const nextModes = new MemoryTable<SessionId, SessionNextSquadModeRecord>()
  const messageClaims = new MemoryTable<string, SquadMessageClaimRecord>()
  const runs = new MemoryTable<DispatchId, SquadRunRecord>()
  const versions = new MemoryTable<string, SquadVersionRecord>()
  const projectDefaults = new MemoryTable<string, ProjectSquadDefaultRecord>()
  Object.assign(service, {
    agentsTable: agents,
    squadsTable: squads,
    sessionModesTable: modes,
    nextModesTable: nextModes,
    messageClaimsTable: messageClaims,
    runsTable: runs,
    squadVersionsTable: versions,
    projectDefaultsTable: projectDefaults,
  })
  const parent = {
    id: SessionId('parent'),
    options: { provider: 'main-provider', model: 'main-model', maxTokens: 32_000 },
    session: { header: { cwd: '/workspace/project' } },
  } as unknown as Agent
  return { ctx, service, agents, squads, modes, nextModes, messageClaims, runs, versions, projectDefaults, starts, parent }
}

export async function populate(): Promise<Fixture> {
  const state = createService()
  await state.agents.put(researcherId, agent('Researcher'))
  await state.agents.put(writerId, agent('Writer'))
  await state.agents.put(reviewerId, agent('Reviewer'))
  await state.squads.put(squadId, {
    name: 'Delivery',
    members: [researcherId, writerId, reviewerId],
    collabNote: 'Return concrete evidence.',
  })
  return state
}
