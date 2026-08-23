/** Web UI 与 host service 之间的 loopback-only Connection RPC 适配层。 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z, ZodError } from 'zod'
import type { AgentTeamService } from './index.ts'
import { AgentTeamError } from './tools/domain/host.ts'
import { AgentId, DispatchId, SquadId, type AgentRouteRemap } from './types.ts'
import { MAX_HANDOFF_SUMMARY_MAX_CHARS, MIN_HANDOFF_SUMMARY_MAX_CHARS } from './limits.ts'

/** 与浏览器入口共享的 RPC channel。 */
export const AGENT_TEAM_RPC_CHANNEL = '/agent-team-gui'
/** Browser/host contract revision. A snapshot handshake prevents mixed-version UIs. */
export const AGENT_TEAM_RPC_API_VERSION = 4

const emptySchema = z.object({}).strict()
const idSchema = z.string().min(1)
const agentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  systemPrompt: z.string().max(50_000),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  toolScope: z.object({
    allow: z.array(z.string().trim().min(1).max(200)).min(1).max(256).refine(items => new Set(items).size === items.length).optional(),
    deny: z.array(z.string().trim().min(1).max(200)).min(1).max(256).refine(items => new Set(items).size === items.length).optional(),
  }).refine(value => value.allow !== undefined || value.deny !== undefined)
    .refine(value => value.allow === undefined || value.deny === undefined || value.allow.every(name => !value.deny!.includes(name))).optional(),
  fallbackProvider: z.string().trim().min(1).max(200).optional(),
  fallbackModel: z.string().trim().min(1).max(200).optional(),
}).strict()
const squadInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  members: z.array(idSchema).min(1).max(32),
  collabNote: z.string().max(20_000).optional(),
  executionOrder: z.array(idSchema).max(32).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
  leaderAgentId: idSchema.optional(),
  triggerMode: z.enum(['guaranteed', 'model-tool']).optional(),
  failurePolicy: z.enum(['continue', 'stop', 'retry-once']).optional(),
  maxConcurrency: z.number().int().positive().max(32).optional(),
  memberTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  tokenBudget: z.number().int().positive().max(100_000_000).optional(),
  handoffSummaryMaxChars: z.number().int().min(MIN_HANDOFF_SUMMARY_MAX_CHARS).max(MAX_HANDOFF_SUMMARY_MAX_CHARS).optional(),
  activationMode: z.enum(['always', 'smart', 'manual']).optional(),
  memberSelectionMode: z.enum(['all', 'adaptive']).optional(),
  responseMode: z.enum(['foreground', 'background']).optional(),
  planningContext: z.enum(['current', 'recent', 'full']).optional(),
  plannerMaxTokens: z.number().int().min(256).max(8_192).optional(),
  qualityGate: z.object({
    reviewerAgentId: idSchema,
    repairAgentId: idSchema,
    maxRounds: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    criteria: z.string().max(20_000).optional(),
  }).strict().optional(),
}).strict()
const assignmentSchema = z.object({ agentId: idSchema, task: z.string().min(1).max(100_000) }).strict()
const dispatchInputSchema = z.object({
  sessionId: idSchema,
  squadId: idSchema,
  task: z.string().trim().min(1).max(100_000),
  assignments: z.array(assignmentSchema).min(1).max(32).optional(),
  memberOrder: z.array(idSchema).min(1).max(32).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
  background: z.boolean().optional(),
}).strict()

type AgentInput = z.infer<typeof agentInputSchema>
type SquadInput = z.infer<typeof squadInputSchema>

function agentRecord(input: AgentInput) {
  return {
    name: input.name,
    systemPrompt: input.systemPrompt,
    provider: input.provider,
    model: input.model,
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(input.toolScope === undefined ? {} : {
      toolScope: {
        ...(input.toolScope.allow === undefined ? {} : { allow: input.toolScope.allow }),
        ...(input.toolScope.deny === undefined ? {} : { deny: input.toolScope.deny }),
      },
    }),
    ...(input.fallbackProvider === undefined ? {} : { fallbackProvider: input.fallbackProvider }),
    ...(input.fallbackModel === undefined ? {} : { fallbackModel: input.fallbackModel }),
  }
}

function squadRecord(input: SquadInput) {
  return {
    name: input.name,
    members: input.members.map(AgentId),
    ...(input.collabNote === undefined ? {} : { collabNote: input.collabNote }),
    ...(input.executionOrder === undefined ? {} : { executionOrder: input.executionOrder.map(AgentId) }),
    ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
    ...(input.contextMode === undefined ? {} : { contextMode: input.contextMode }),
    ...(input.leaderAgentId === undefined ? {} : { leaderAgentId: AgentId(input.leaderAgentId) }),
    ...(input.triggerMode === undefined ? {} : { triggerMode: input.triggerMode }),
    ...(input.failurePolicy === undefined ? {} : { failurePolicy: input.failurePolicy }),
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.memberTimeoutMs === undefined ? {} : { memberTimeoutMs: input.memberTimeoutMs }),
    ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
    ...(input.handoffSummaryMaxChars === undefined ? {} : { handoffSummaryMaxChars: input.handoffSummaryMaxChars }),
    ...(input.activationMode === undefined ? {} : { activationMode: input.activationMode }),
    ...(input.memberSelectionMode === undefined ? {} : { memberSelectionMode: input.memberSelectionMode }),
    ...(input.responseMode === undefined ? {} : { responseMode: input.responseMode }),
    ...(input.planningContext === undefined ? {} : { planningContext: input.planningContext }),
    ...(input.plannerMaxTokens === undefined ? {} : { plannerMaxTokens: input.plannerMaxTokens }),
    ...(input.qualityGate === undefined ? {} : {
      qualityGate: {
        reviewerAgentId: AgentId(input.qualityGate.reviewerAgentId),
        repairAgentId: AgentId(input.qualityGate.repairAgentId),
        maxRounds: input.qualityGate.maxRounds,
        ...(input.qualityGate.criteria === undefined ? {} : { criteria: input.qualityGate.criteria }),
      },
    }),
  }
}

function normalizeRouteRemap(input: Record<string, {
  provider: string
  model: string
  fallbackProvider?: string | undefined
  fallbackModel?: string | undefined
}> | undefined): Record<string, AgentRouteRemap> {
  return Object.fromEntries(Object.entries(input ?? {}).map(([id, route]) => [id, {
    provider: route.provider,
    model: route.model,
    ...(route.fallbackProvider === undefined ? {} : { fallbackProvider: route.fallbackProvider }),
    ...(route.fallbackModel === undefined ? {} : { fallbackModel: route.fallbackModel }),
  }]))
}

// Snapshot output is a read surface: it must represent v0 rows that predate
// v2 resource ceilings. Mutation payloads above remain strictly bounded.
const agentSnapshotSchema = agentInputSchema.extend({
  name: z.string().trim().min(1),
  systemPrompt: z.string(),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  maxTokens: z.number().int().positive().optional(),
  toolScope: z.object({
    allow: z.array(z.string().min(1)).min(1).optional(),
    deny: z.array(z.string().min(1)).min(1).optional(),
  }).refine(value => value.allow !== undefined || value.deny !== undefined).optional(),
  fallbackProvider: z.string().trim().min(1).optional(),
  fallbackModel: z.string().trim().min(1).optional(),
})

const squadSnapshotSchema = squadInputSchema.extend({
  name: z.string().trim().min(1),
  members: z.array(idSchema),
  collabNote: z.string(),
  executionOrder: z.array(idSchema).optional(),
  tokenBudget: z.number().int().positive().optional(),
  plannerMaxTokens: z.number().int().positive().optional(),
  qualityGate: z.object({
    reviewerAgentId: idSchema,
    repairAgentId: idSchema,
    maxRounds: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    criteria: z.string().optional(),
  }).strict().optional(),
})

const snapshotSchema = z.object({
  apiVersion: z.literal(AGENT_TEAM_RPC_API_VERSION),
  agents: z.array(z.object({ id: z.string(), ...agentSnapshotSchema.shape })),
  squads: z.array(z.object({ id: z.string(), ...squadSnapshotSchema.shape })),
  models: z.array(z.object({
    provider: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
  })),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  capabilities: z.object({
    smartActivation: z.boolean(), dags: z.boolean(), qualityGate: z.boolean(), backgroundRuns: z.boolean(),
    recipes: z.boolean(), insights: z.boolean(), reproducibleVersions: z.boolean(), remoteRecipeFetch: z.boolean(),
  }).strict(),
  defaults: z.object({
    executionMode: z.enum(['serial', 'parallel']),
    fixedOrderExecutionMode: z.literal('serial'),
    contextMode: z.enum(['spawn', 'fork', 'chain']),
    planningContext: z.literal('full'),
    plannerMaxTokens: z.literal(2_048),
  }).strict(),
})

function success<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function failure(error: unknown, signal: AbortSignal): RpcResult<never> {
  if (signal.aborted) {
    return { ok: false, error: { code: 'cancelled', message: 'agent team request was cancelled', details: {} } }
  }
  if (error instanceof ZodError) {
    return {
      ok: false,
      error: { code: 'bad-request', message: error.issues.map(issue => issue.message).join('; '), details: { issues: error.issues } },
    }
  }
  if (error instanceof AgentTeamError) {
    return {
      ok: false,
      error: { code: 'bad-request', message: `${error.code}: ${error.message}`, details: { issues: [] } },
    }
  }
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
  }
}

async function readSnapshot(ctx: Context, service: AgentTeamService, signal?: AbortSignal) {
  const definitions = await service.readDefinitionSnapshot(signal)
  const withCatalogDeadline = <T>(promise: Promise<T>, timeoutMs = 1_500): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      operation()
    }
    const onAbort = (): void => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error('snapshot cancelled')))
    const timer = setTimeout(() => finish(() => reject(new Error(`model catalog timed out after ${timeoutMs}ms`))), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    if (signal?.aborted === true) onAbort()
  })
  const models = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
    try {
      return {
        provider: provider.id,
        name: provider.name,
        models: (await withCatalogDeadline(ctx.llm.listModels(provider.id))).map(model => ({ id: model.id, name: model.name })),
      }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      ctx.logger.warn(`[agent-team-gui] model catalog failed for ${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
      return { provider: provider.id, name: provider.name, models: [] }
    }
  }))
  return snapshotSchema.parse({
    apiVersion: AGENT_TEAM_RPC_API_VERSION,
    agents: [...definitions.agents].map(([id, record]) => ({ id, ...record })),
    squads: [...definitions.squads].map(([id, record]) => ({ id, ...record, collabNote: record.collabNote ?? '' })),
    models,
    tools: ctx.tools.schemas().map(tool => ({ name: tool.name, description: tool.description })),
    capabilities: {
      smartActivation: true,
      dags: true,
      qualityGate: true,
      backgroundRuns: service.backgroundJobsAvailable(),
      recipes: true,
      insights: true,
      reproducibleVersions: true,
      // Deliberately disabled: accepting remote URLs safely requires a dedicated SSRF-hardened fetch service.
      remoteRecipeFetch: false,
    },
    defaults: service.definitionDefaults(),
  })
}

function readModeResponse(ctx: Context, service: AgentTeamService, sessionId: ReturnType<typeof SessionId>, signal?: AbortSignal) {
  return service.readDefinitionState(() => {
    const parent = ctx.agents.get(sessionId)
    const session = parent?.session ?? ctx.sessions.get(sessionId)
    const projectKey = session === undefined ? undefined : service.projectKeyForSession(session)
    const next = service.getNextSessionSquadMode(sessionId)
    const nextSquad = next?.squadId === undefined ? undefined : service.getSquad(next.squadId)
    return {
    mode: session === undefined
      ? service.getSessionSquadMode(sessionId) ?? null
      : service.getEffectiveSessionSquadModeForSession(session, sessionId) ?? null,
    sessionOverride: service.getSessionSquadOverride(sessionId),
    sessionReady: session !== undefined,
    projectKey: projectKey ?? null,
    projectDefault: projectKey === undefined ? null : service.getProjectDefault(projectKey) ?? null,
    nextOverride: next === undefined ? null
      : next.state === 'solo' ? 'solo' as const
        : next.squadId === undefined || nextSquad === undefined ? null
          : { squadId: next.squadId, squadName: nextSquad.name },
    }
  }, signal)
}

/** 创建逐 endpoint 校验的 RPC handler；所有失败使用 dsh 已有闭合 RpcError。 */
export function createAgentTeamRpcHandler(ctx: Context, service: AgentTeamService): ConnectionRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      if (signal.aborted) return failure(signal.reason, signal)
      switch (endpoint) {
        case 'snapshot': {
          emptySchema.parse(rawPayload)
          return success(await readSnapshot(ctx, service, signal))
        }
        case 'agent/create': {
          const payload = z.object({ record: agentInputSchema }).strict().parse(rawPayload)
          return success({ id: await service.createAgent(agentRecord(payload.record), undefined, signal) })
        }
        case 'agent/update': {
          const payload = z.object({ id: idSchema, record: agentInputSchema }).strict().parse(rawPayload)
          await service.updateAgent(AgentId(payload.id), agentRecord(payload.record), signal)
          return success({ updated: true })
        }
        case 'agent/delete': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ deleted: await service.deleteAgent(AgentId(payload.id), signal) })
        }
        case 'squad/create': {
          const payload = z.object({ record: squadInputSchema }).strict().parse(rawPayload)
          return success({ id: await service.createSquad(squadRecord(payload.record), undefined, signal) })
        }
        case 'squad/update': {
          const payload = z.object({ id: idSchema, record: squadInputSchema }).strict().parse(rawPayload)
          await service.updateSquad(SquadId(payload.id), squadRecord(payload.record), signal)
          return success({ updated: true })
        }
        case 'squad/delete': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ deleted: await service.deleteSquad(SquadId(payload.id), signal) })
        }
        case 'squad/versions': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success(service.listSquadVersions(SquadId(payload.id)))
        }
        case 'squad/restore': {
          const payload = z.object({
            id: idSchema, version: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(),
          }).strict().parse(rawPayload)
          await service.restoreSquadVersion(SquadId(payload.id), payload.version, signal, payload.expectedRevision)
          return success({ restored: true })
        }
        case 'squad/restore-preview': {
          const payload = z.object({ id: idSchema, version: z.number().int().positive() }).strict().parse(rawPayload)
          return success(await service.previewSquadRestore(SquadId(payload.id), payload.version, signal))
        }
        case 'squad/diagnose': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success(await service.diagnoseSquad(SquadId(payload.id), signal))
        }
        case 'mode/get': {
          const payload = z.object({ sessionId: idSchema }).strict().parse(rawPayload)
          const sessionId = SessionId(payload.sessionId)
          return success(await readModeResponse(ctx, service, sessionId, signal))
        }
        case 'project/default-set': {
          const payload = z.object({ sessionId: idSchema, squadId: idSchema.nullable() }).strict().parse(rawPayload)
          const parent = ctx.agents.get(SessionId(payload.sessionId))
          if (parent === undefined) {
            return { ok: false, error: { code: 'session-not-found', message: `no live parent agent for session ${payload.sessionId}`, details: { sessionId: SessionId(payload.sessionId) } } }
          }
          const projectKey = service.projectKeyFor(parent)
          if (projectKey === undefined) return success(await readModeResponse(ctx, service, SessionId(payload.sessionId), signal))
          const project = {
            projectKey,
            projectDefault: await service.setProjectDefault(projectKey, payload.squadId === null ? undefined : SquadId(payload.squadId), signal) ?? null,
          }
          return success({ ...await readModeResponse(ctx, service, SessionId(payload.sessionId), signal), ...project })
        }
        case 'mode/set': {
          const payload = z.union([
            z.object({ sessionId: idSchema, state: z.enum(['enabled', 'disabled']), squadId: idSchema.optional() }).strict(),
            z.object({ sessionId: idSchema, squadId: idSchema.nullable() }).strict(),
          ]).parse(rawPayload)
          const enabled = 'state' in payload ? payload.state === 'enabled' : payload.squadId !== null
          const squadId = payload.squadId
          if (enabled && (squadId === undefined || squadId === null)) {
            return failure(new AgentTeamError('enabled mode requires squadId', 'INVALID_DISPATCH'), signal)
          }
          const sessionId = SessionId(payload.sessionId)
          await service.setSessionSquadMode(
              sessionId,
              !enabled || squadId === undefined || squadId === null ? undefined : SquadId(squadId),
              signal,
          )
          return success(await readModeResponse(ctx, service, sessionId, signal))
        }
        case 'mode/inherit': {
          const payload = z.object({ sessionId: idSchema }).strict().parse(rawPayload)
          const sessionId = SessionId(payload.sessionId)
          await service.inheritSessionSquadMode(sessionId, signal)
          return success(await readModeResponse(ctx, service, sessionId, signal))
        }
        case 'mode/next-set': {
          const payload = z.object({
            sessionId: idSchema,
            state: z.enum(['inherit', 'solo', 'team']),
            squadId: idSchema.optional(),
          }).strict().parse(rawPayload)
          const sessionId = SessionId(payload.sessionId)
          await service.setNextSessionSquadMode(
            sessionId, payload.state,
            payload.squadId === undefined ? undefined : SquadId(payload.squadId),
            signal,
          )
          return success(await readModeResponse(ctx, service, sessionId, signal))
        }
        case 'export': {
          emptySchema.parse(rawPayload)
          return success(await service.exportDefinitions())
        }
        case 'import': {
          const payload = z.object({
            doc: z.unknown(),
            mode: z.enum(['merge', 'replace']).optional(),
            expectedRevision: z.number().int().nonnegative(),
          }).strict().parse(rawPayload)
          return success(await service.importDefinitions(payload.doc, payload.mode ?? 'merge', signal, payload.expectedRevision))
        }
        case 'import/preview': {
          const payload = z.object({
            doc: z.unknown(),
            mode: z.enum(['merge', 'replace']).optional(),
          }).strict().parse(rawPayload)
          return success(await service.previewDefinitionsImport(payload.doc, payload.mode ?? 'merge', signal))
        }
        case 'dispatch': {
          const payload = dispatchInputSchema.parse(rawPayload)
          const parent = ctx.agents.get(SessionId(payload.sessionId))
          if (parent === undefined) {
            return {
              ok: false,
              error: {
                code: 'session-not-found',
                message: `no live parent agent for session ${payload.sessionId}`,
                details: { sessionId: SessionId(payload.sessionId) },
              },
            }
          }
          const request = {
            squadId: SquadId(payload.squadId),
            task: payload.task,
            ...payload.assignments === undefined ? {} : {
              assignments: payload.assignments.map(item => ({ agentId: AgentId(item.agentId), task: item.task })),
            },
            ...payload.memberOrder === undefined ? {} : { memberOrder: payload.memberOrder.map(AgentId) },
            ...payload.executionMode === undefined ? {} : { executionMode: payload.executionMode },
            ...payload.contextMode === undefined ? {} : { contextMode: payload.contextMode },
          }
          return success(payload.background === true
            ? await service.startBackgroundDispatch(request, parent, { sessionId: SessionId(payload.sessionId) }, signal)
            : await service.dispatch(request, parent, signal, { sessionId: SessionId(payload.sessionId) }))
        }
        case 'run/start': {
          const payload = dispatchInputSchema.parse(rawPayload)
          const parent = ctx.agents.get(SessionId(payload.sessionId))
          if (parent === undefined) {
            return { ok: false, error: { code: 'session-not-found', message: `no live parent agent for session ${payload.sessionId}`, details: { sessionId: SessionId(payload.sessionId) } } }
          }
          return success(await service.startBackgroundDispatch({
            squadId: SquadId(payload.squadId), task: payload.task,
            ...(payload.assignments === undefined ? {} : { assignments: payload.assignments.map(item => ({ agentId: AgentId(item.agentId), task: item.task })) }),
            ...(payload.memberOrder === undefined ? {} : { memberOrder: payload.memberOrder.map(AgentId) }),
            ...(payload.executionMode === undefined ? {} : { executionMode: payload.executionMode }),
            ...(payload.contextMode === undefined ? {} : { contextMode: payload.contextMode }),
          }, parent, { sessionId: SessionId(payload.sessionId) }, signal))
        }
        case 'plan/preview': {
          const payload = z.object({ sessionId: idSchema, squadId: idSchema, task: z.string().trim().min(1).max(100_000) }).strict().parse(rawPayload)
          const parent = ctx.agents.get(SessionId(payload.sessionId))
          if (parent === undefined) {
            return { ok: false, error: { code: 'session-not-found', message: `no live parent agent for session ${payload.sessionId}`, details: { sessionId: SessionId(payload.sessionId) } } }
          }
          return success({ plan: await service.previewPlan(SquadId(payload.squadId), payload.task, parent, signal) })
        }
        case 'run/list': {
          const payload = z.object({ sessionId: idSchema.optional(), limit: z.number().int().positive().max(200).optional(), detail: z.boolean().optional() }).strict().parse(rawPayload)
          return success({ runs: service.listRuns(payload.sessionId === undefined ? undefined : SessionId(payload.sessionId), payload.limit ?? 50, payload.detail ?? false) })
        }
        case 'run/get': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ run: service.getRun(DispatchId(payload.id)) ?? null })
        }
        case 'run/cancel': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ cancelled: service.cancelRun(DispatchId(payload.id)) })
        }
        case 'run/retry': {
          const payload = z.object({ id: idSchema, agentId: idSchema.optional() }).strict().parse(rawPayload)
          const source = service.getRun(DispatchId(payload.id))
          if (source === undefined) return failure(new AgentTeamError(`run "${payload.id}" does not exist`, 'INVALID_DISPATCH'), signal)
          const parent = ctx.agents.get(source.sessionId)
          if (parent === undefined) {
            return { ok: false, error: { code: 'session-not-found', message: `no live parent agent for session ${source.sessionId}`, details: { sessionId: source.sessionId } } }
          }
          return success(await service.retryRun(
            DispatchId(payload.id),
            parent,
            payload.agentId === undefined ? undefined : AgentId(payload.agentId),
            signal,
          ))
        }
        case 'run/clear': {
          const payload = z.object({
            id: idSchema.optional(), sessionId: idSchema.optional(), before: z.number().int().nonnegative().optional(), settledOnly: z.boolean().optional(),
          }).strict().refine(value => value.id !== undefined || value.sessionId !== undefined || value.before !== undefined, {
            message: 'run/clear requires id, sessionId, or before',
          }).parse(rawPayload)
          return success({ cleared: await service.clearRuns({
            ...(payload.id === undefined ? {} : { id: DispatchId(payload.id) }),
            ...(payload.sessionId === undefined ? {} : { sessionId: SessionId(payload.sessionId) }),
            ...(payload.before === undefined ? {} : { before: payload.before }),
            ...(payload.settledOnly === undefined ? {} : { settledOnly: payload.settledOnly }),
          }, signal) })
        }
        case 'run/export': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success(service.exportRun(DispatchId(payload.id)))
        }
        case 'insights/summary': {
          const payload = z.object({
            sessionId: idSchema.optional(), projectKey: z.string().min(1).optional(), squadId: idSchema.optional(),
            since: z.number().int().nonnegative().optional(), until: z.number().int().nonnegative().optional(),
          }).strict().refine(value => value.since === undefined || value.until === undefined || value.since <= value.until, {
            message: 'since must be earlier than until',
          }).parse(rawPayload)
          return success(service.insights({
            ...(payload.sessionId === undefined ? {} : { sessionId: SessionId(payload.sessionId) }),
            ...(payload.projectKey === undefined ? {} : { projectKey: payload.projectKey }),
            ...(payload.squadId === undefined ? {} : { squadId: SquadId(payload.squadId) }),
            ...(payload.since === undefined ? {} : { since: payload.since }),
            ...(payload.until === undefined ? {} : { until: payload.until }),
          }))
        }
        case 'recipe/export': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success(await service.exportRecipe(SquadId(payload.id), signal))
        }
        case 'recipe/preview': {
          const payload = z.object({ doc: z.unknown(), routeRemap: z.record(z.string(), z.object({
            provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(200), fallbackProvider: z.string().trim().min(1).max(200).optional(), fallbackModel: z.string().trim().min(1).max(200).optional(),
          }).strict()).refine(value => Object.keys(value).length <= 256, { message: 'routeRemap supports at most 256 agents' }).optional() }).strict().parse(rawPayload)
          return success(await service.previewRecipe(payload.doc, normalizeRouteRemap(payload.routeRemap), signal))
        }
        case 'recipe/import': {
          const payload = z.object({
            doc: z.unknown(), policy: z.enum(['merge', 'copy']), expectedRevision: z.number().int().nonnegative(), routeRemap: z.record(z.string(), z.object({
              provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(200), fallbackProvider: z.string().trim().min(1).max(200).optional(), fallbackModel: z.string().trim().min(1).max(200).optional(),
            }).strict()).refine(value => Object.keys(value).length <= 256, { message: 'routeRemap supports at most 256 agents' }).optional(),
          }).strict().parse(rawPayload)
          return success(await service.importRecipe(payload.doc, payload.policy, normalizeRouteRemap(payload.routeRemap), signal, payload.expectedRevision))
        }
        default:
          return {
            ok: false,
            error: { code: 'bad-request', message: `unknown agent team endpoint ${endpoint}`, details: { issues: [] } },
          }
      }
    } catch (error: unknown) {
      return failure(error, signal)
    }
  }
}

/** Connection 是 Web 可选服务；headless 仍可加载 host service 与模型工具。 */
export function registerAgentTeamRpc(ctx: Context, service: AgentTeamService): void {
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle(
      AGENT_TEAM_RPC_CHANNEL,
      createAgentTeamRpcHandler(connectionCtx, service),
      { authority: 'loopback' },
    )
  })
}
