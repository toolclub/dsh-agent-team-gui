import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentExportItem, AgentId, AgentRecord, AgentTeamExportDocument, AgentTeamRecipeDocument, DispatchId, ProjectSquadDefaultRecord, SessionNextSquadModeRecord, SessionSquadModeRecord, SquadExportItem, SquadId, SquadMessageClaimRecord, SquadRecord, SquadRunRecord, SquadVersionRecord } from './types.ts'
import { MAX_HANDOFF_SUMMARY_MAX_CHARS, MIN_HANDOFF_SUMMARY_MAX_CHARS } from './limits.ts'

/**
 * v0 used an intentionally small schema with no resource ceilings. Durable
 * tables keep accepting every record that v0 accepted so a plugin upgrade can
 * never make the storage domain fail to open. Mutating boundaries use the
 * bounded write schemas below.
 */
const agentReadFields = z.object({
  name: z.string().trim().min(1),
  systemPrompt: z.string(),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  maxTokens: z.number().int().positive().optional(),
  toolScope: z.object({
    allow: z.array(z.string().min(1)).min(1).optional(),
    deny: z.array(z.string().min(1)).min(1).optional(),
  }).refine(scope => scope.allow !== undefined || scope.deny !== undefined, {
    message: 'toolScope must declare allow or deny',
  }).optional(),
  fallbackProvider: z.string().trim().min(1).optional(),
  fallbackModel: z.string().trim().min(1).optional(),
}).strict()

/** Strict bounded schema for every new agent write and v2 document. */
const agentWriteFields = z.object({
  name: z.string().trim().min(1).max(120),
  systemPrompt: z.string().max(50_000),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  toolScope: z.object({
    allow: z.array(z.string().trim().min(1).max(200)).min(1).max(256).refine(items => new Set(items).size === items.length, { message: 'allow tools must be unique' }).optional(),
    deny: z.array(z.string().trim().min(1).max(200)).min(1).max(256).refine(items => new Set(items).size === items.length, { message: 'deny tools must be unique' }).optional(),
  }).refine(scope => scope.allow !== undefined || scope.deny !== undefined, {
    message: 'toolScope must declare allow or deny',
  }).refine(scope => scope.allow === undefined || scope.deny === undefined || scope.allow.every(name => !scope.deny!.includes(name)), {
    message: 'toolScope allow and deny must not overlap',
  }).optional(),
  fallbackProvider: z.string().trim().min(1).max(200).optional(),
  fallbackModel: z.string().trim().min(1).max(200).optional(),
}).strict()

/** New-write validation. Kept under the original export name for API compatibility. */
export const agentRecordSchema = agentWriteFields as unknown as z.ZodType<AgentRecord>
/** Backward-compatible durable/v1 read validation. */
export const agentRecordReadSchema = agentReadFields as unknown as z.ZodType<AgentRecord>

const squadReadFields = z.object({
  name: z.string().trim().min(1),
  members: z.array(z.string().min(1).transform(value => value as AgentId)),
  collabNote: z.string().optional(),
  executionOrder: z.array(z.string().min(1).transform(value => value as AgentId)).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
  leaderAgentId: z.string().min(1).transform(value => value as AgentId).optional(),
  triggerMode: z.enum(['guaranteed', 'model-tool']).optional(),
  failurePolicy: z.enum(['continue', 'stop', 'retry-once']).optional(),
  maxConcurrency: z.number().int().positive().max(32).optional(),
  memberTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  tokenBudget: z.number().int().positive().optional(),
  handoffSummaryMaxChars: z.number().int().min(MIN_HANDOFF_SUMMARY_MAX_CHARS).max(MAX_HANDOFF_SUMMARY_MAX_CHARS).optional(),
  activationMode: z.enum(['always', 'smart', 'manual']).optional(),
  memberSelectionMode: z.enum(['all', 'adaptive']).optional(),
  responseMode: z.enum(['foreground', 'background']).optional(),
  planningContext: z.enum(['current', 'recent', 'full']).optional(),
  plannerMaxTokens: z.number().int().positive().optional(),
  qualityGate: z.object({
    reviewerAgentId: z.string().min(1).transform(value => value as AgentId),
    repairAgentId: z.string().min(1).transform(value => value as AgentId),
    maxRounds: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    criteria: z.string().optional(),
  }).strict().optional(),
}).strict()

/** Strict bounded schema for every new squad write and v2 document. */
const squadWriteFields = z.object({
  name: z.string().trim().min(1).max(120),
  members: z.array(z.string().min(1).transform(value => value as AgentId)).min(1).max(32),
  collabNote: z.string().max(20_000).optional(),
  executionOrder: z.array(z.string().min(1).transform(value => value as AgentId)).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
  leaderAgentId: z.string().min(1).transform(value => value as AgentId).optional(),
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
    reviewerAgentId: z.string().min(1).transform(value => value as AgentId),
    repairAgentId: z.string().min(1).transform(value => value as AgentId),
    maxRounds: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    criteria: z.string().max(20_000).optional(),
  }).strict().optional(),
}).strict()

/** New-write validation. Kept under the original export name for API compatibility. */
export const squadRecordSchema = squadWriteFields as unknown as z.ZodType<SquadRecord>
/** Backward-compatible durable/v1 read validation. */
export const squadRecordReadSchema = squadReadFields as unknown as z.ZodType<SquadRecord>

/** One agent row of an import/export document; the durable fields plus its id. */
export const agentExportItemSchema = z.object({
  id: z.string().min(1),
  ...agentWriteFields.shape,
}).strict() as unknown as z.ZodType<AgentExportItem>

/** One squad row of an import/export document; the durable fields plus its id. */
export const squadExportItemSchema = z.object({
  id: z.string().min(1),
  ...squadWriteFields.shape,
}).strict() as unknown as z.ZodType<SquadExportItem>

const legacyAgentExportItemSchema = z.object({
  id: z.string().min(1),
  ...agentReadFields.shape,
}).strict()

const legacySquadExportItemSchema = z.object({
  id: z.string().min(1),
  ...squadReadFields.shape,
}).strict()

/** v1 remains the unbounded legacy import contract; v2 is the bounded write contract. */
const agentTeamExportV1Schema = z.object({
  format: z.literal('agent-team-gui/definitions'),
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative().optional(),
  agents: z.array(legacyAgentExportItemSchema).max(2_000),
  squads: z.array(legacySquadExportItemSchema).max(1_000),
}).strict()

const agentTeamExportV2Schema = z.object({
  format: z.literal('agent-team-gui/definitions'),
  version: z.literal(2),
  exportedAt: z.number().int().nonnegative().optional(),
  agents: z.array(agentExportItemSchema).max(2_000),
  squads: z.array(squadExportItemSchema).max(1_000),
}).strict()

export const agentTeamExportSchema = z.discriminatedUnion('version', [
  agentTeamExportV1Schema,
  agentTeamExportV2Schema,
]) as unknown as z.ZodType<AgentTeamExportDocument>

/**
 * Recipe v1 predates the v2 definition ceilings. Keep it able to round-trip
 * an upgraded legacy squad (for example 33 members), while bounding the one-
 * team document globally and leaving ordinary CRUD on the strict schemas.
 */
export const agentTeamRecipeSchema = z.object({
  format: z.literal('agent-team-gui/recipe'),
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative(),
  squad: z.object({
    id: z.string().min(1),
    ...squadReadFields.shape,
    members: z.array(z.string().min(1).transform(value => value as AgentId)).max(256),
    executionOrder: z.array(z.string().min(1).transform(value => value as AgentId)).max(256).optional(),
  }).strict(),
  agents: z.array(legacyAgentExportItemSchema).max(256),
}).strict() as unknown as z.ZodType<AgentTeamRecipeDocument>

/** Durable session-to-squad mode selection. */
export const sessionSquadModeSchema = z.object({
  squadId: z.string().min(1).transform(value => value as SquadId).optional(),
  disabled: z.boolean().optional(),
}).strict().refine(value => value.disabled === true || value.squadId !== undefined, {
  message: 'session mode must select a squad or explicitly disable project defaults',
}) as unknown as z.ZodType<SessionSquadModeRecord>

/** One-shot selection is deliberately separate from the durable session override. */
export const sessionNextSquadModeSchema = z.object({
  state: z.enum(['solo', 'team']),
  squadId: z.string().min(1).transform(value => value as SquadId).optional(),
  claimedMessageId: z.string().min(1).optional(),
  claimedAt: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.state === 'solo' || value.squadId !== undefined, {
  message: 'one-shot team mode must select a squad',
}) as unknown as z.ZodType<SessionNextSquadModeRecord>

export const squadMessageClaimSchema = z.object({
  sessionId: z.string().min(1).transform(value => value as SessionId),
  messageId: z.string().min(1),
  kind: z.enum(['solo', 'team']),
  createdAt: z.number().int().nonnegative(),
}).strict() as unknown as z.ZodType<SquadMessageClaimRecord>

const usageSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  providerReported: z.boolean(),
}).strict()

const assignmentSchema = z.object({
  agentId: z.string().min(1).transform(value => value as AgentId),
  task: z.string(),
  dependsOn: z.array(z.string().min(1).transform(value => value as AgentId)).default([]),
}).strict()

const planSchema = z.object({
  decision: z.enum(['run', 'skip']).default('run'),
  reason: z.string().default(''),
  summary: z.string(),
  memberOrder: z.array(z.string().min(1).transform(value => value as AgentId)),
  assignments: z.array(assignmentSchema),
  planner: z.enum(['main-agent', 'squad-leader', 'deterministic-fallback']).default('squad-leader'),
  plannerProvider: z.string().min(1).optional(),
  plannerModel: z.string().min(1).optional(),
  leaderAgentId: z.string().min(1).transform(value => value as AgentId).optional(),
  usage: usageSchema.optional(),
  warning: z.string().optional(),
}).strict()

const runMemberSchema = z.object({
  agentId: z.string().min(1).transform(value => value as AgentId),
  agentName: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'timed-out', 'skipped']),
  attempts: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  runId: z.string().optional(),
  childId: z.string().optional(),
  stopReason: z.string().optional(),
  output: z.array(z.unknown()),
  error: z.string().optional(),
  usage: usageSchema.optional(),
  usageSamples: z.object({
    metered: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict().refine(value => value.metered <= value.total, 'metered samples cannot exceed total samples').optional(),
  attemptUsage: z.array(z.object({
    attempt: z.number().int().positive(),
    provider: z.string(),
    model: z.string(),
    usage: usageSchema.optional(),
  }).strict()).max(2).optional(),
  handoff: z.object({
    summary: z.string(),
    deliverables: z.array(z.string()),
    risks: z.array(z.string()),
    changedFiles: z.array(z.string()),
  }).strict().optional(),
}).strict()

const memberResultSchema = z.object({
  agentId: z.string().min(1).transform(value => value as AgentId),
  agentName: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled', 'timed-out']),
  runId: z.string().optional(),
  childId: z.string().optional(),
  stopReason: z.string().optional(),
  output: z.array(z.unknown()),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  provider: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  usage: usageSchema.optional(),
  handoff: z.object({
    summary: z.string(), deliverables: z.array(z.string()), risks: z.array(z.string()), changedFiles: z.array(z.string()),
  }).strict().optional(),
}).strict()

const qualitySchema = z.object({
  approved: z.boolean(),
  rounds: z.array(z.object({
    round: z.number().int().positive(),
    approved: z.boolean(),
    feedback: z.string(),
    reviewer: memberResultSchema,
    repair: memberResultSchema.optional(),
  }).strict()),
}).strict()

/** Durable run-center row; output blocks remain provider-neutral JSON. */
export const squadRunRecordSchema = z.object({
  id: z.string().min(1).transform(value => value as DispatchId),
  sessionId: z.string().min(1).transform(value => value as SessionId),
  sourceMessageId: z.string().optional(),
  projectKey: z.string().optional(),
  squadId: z.string().min(1).transform(value => value as SquadId),
  squadName: z.string(),
  task: z.string(),
  executionMode: z.enum(['serial', 'parallel']),
  contextMode: z.enum(['spawn', 'fork', 'chain']),
  status: z.enum(['planning', 'queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted', 'skipped']),
  meteringCoverage: z.enum(['full', 'partial', 'none']).optional(),
  phase: z.enum(['queued', 'planning', 'members', 'quality-review', 'quality-repair', 'synthesis', 'settled']).optional(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  members: z.array(runMemberSchema),
  usage: usageSchema,
  plan: planSchema.optional(),
  error: z.string().optional(),
  retryOf: z.string().min(1).transform(value => value as DispatchId).optional(),
  responseMode: z.enum(['foreground', 'background']).optional(),
  backgroundJobId: z.string().min(1).optional(),
  backgroundRequestKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  quality: qualitySchema.optional(),
  qualityProgress: z.object({
    round: z.number().int().positive(),
    maxRepairRounds: z.number().int().min(0).max(2),
    totalReviews: z.number().int().min(1).max(3),
    reviewerAgentId: z.string().min(1).transform(value => value as AgentId),
    repairAgentId: z.string().min(1).transform(value => value as AgentId),
    state: z.enum(['reviewing', 'repairing']),
  }).strict().optional(),
  liveUsage: z.object({
    planner: usageSchema.optional(),
    review: usageSchema.optional(),
    repair: usageSchema.optional(),
  }).strict().optional(),
}).strict() as unknown as z.ZodType<SquadRunRecord>

export const squadVersionRecordSchema = z.object({
  squadId: z.string().min(1).transform(value => value as SquadId),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  record: squadReadFields,
  memberSnapshots: z.array(z.object({
    id: z.string().min(1).transform(value => value as AgentId),
    record: agentReadFields,
  }).strict()).optional(),
}).strict() as unknown as z.ZodType<SquadVersionRecord>

export const projectSquadDefaultRecordSchema = z.object({
  projectKey: z.string().min(1),
  squadId: z.string().min(1).transform(value => value as SquadId),
  enabled: z.boolean(),
}).strict() as unknown as z.ZodType<ProjectSquadDefaultRecord>

/** One versioned domain containing both definition tables. */
export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team_gui',
  // Adding a table is backward-compatible for both bundled backends. Keep v0:
  // storage-domain intentionally rejects version bumps and has no migration API.
  version: 0,
  tables: {
    agents: domainTable<AgentId, AgentRecord>(agentRecordReadSchema),
    squads: domainTable<SquadId, SquadRecord>(squadRecordReadSchema),
    session_modes: domainTable<SessionId, SessionSquadModeRecord>(sessionSquadModeSchema),
    next_modes: domainTable<SessionId, SessionNextSquadModeRecord>(sessionNextSquadModeSchema),
    message_claims: domainTable<string, SquadMessageClaimRecord>(squadMessageClaimSchema),
    runs: domainTable<DispatchId, SquadRunRecord>(squadRunRecordSchema),
    squad_versions: domainTable<string, SquadVersionRecord>(squadVersionRecordSchema),
    project_defaults: domainTable<string, ProjectSquadDefaultRecord>(projectSquadDefaultRecordSchema),
  },
})
