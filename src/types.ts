import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Durable identifier owned by an agent definition. */
export type AgentId = Branded<'AgentTeamAgentId'>

/** Brand an external or generated string as an agent identifier. */
export function AgentId(value: string): AgentId {
  return value as AgentId
}

/** Durable identifier owned by a squad definition. */
export type SquadId = Branded<'AgentTeamSquadId'>

/** Brand an external or generated string as a squad identifier. */
export function SquadId(value: string): SquadId {
  return value as SquadId
}

/** Correlates one squad dispatch with its member outcomes. */
export type DispatchId = Branded<'AgentTeamDispatchId'>

/** Brand a generated string as a dispatch identifier. */
export function DispatchId(value: string): DispatchId {
  return value as DispatchId
}

/** Per-child tool visibility passed to the existing subagent runtime. */
export interface AgentToolScope {
  readonly allow?: string[]
  readonly deny?: string[]
}

/** Durable agent definition. Model routes contain no credential material. */
export interface AgentRecord {
  readonly name: string
  readonly systemPrompt: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly toolScope?: AgentToolScope
  /** Optional route used by retry-once when the primary route fails. */
  readonly fallbackProvider?: string
  readonly fallbackModel?: string
}

/** Durable squad definition. One agent may appear in several squads. */
export interface SquadRecord {
  readonly name: string
  readonly members: AgentId[]
  readonly collabNote?: string
  /** Complete fixed serial order. Omission lets dispatch assignments choose order. */
  readonly executionOrder?: AgentId[]
  /** Squad-specific default; plugin config is used when omitted. */
  readonly executionMode?: 'serial' | 'parallel'
  /** Squad-specific default; plugin config is used when omitted. */
  readonly contextMode?: 'spawn' | 'fork' | 'chain'
  /** Member used to create an automatic plan when no fixed order exists. */
  readonly leaderAgentId?: AgentId
  /** Whether an ordinary Send is intercepted before the parent model request. */
  readonly triggerMode?: 'guaranteed' | 'model-tool'
  /** Member failure handling for one dispatch. */
  readonly failurePolicy?: 'continue' | 'stop' | 'retry-once'
  /** Maximum parallel members started at once. */
  readonly maxConcurrency?: number
  /** Per-attempt timeout. */
  readonly memberTimeoutMs?: number
  /** Soft provider-reported token ceiling for the whole run. */
  readonly tokenBudget?: number
  /** Per-member handoff summary ceiling in characters. Raw output remains complete. */
  readonly handoffSummaryMaxChars?: number
  /** When an ordinary top-level message should start this squad. Missing preserves v0.4 `always`. */
  readonly activationMode?: 'always' | 'smart' | 'manual'
  /** Whether planning must use every member or may choose a focused subset. */
  readonly memberSelectionMode?: 'all' | 'adaptive'
  /** Whether normal conversation waits for the squad or acknowledges a Run Center job. */
  readonly responseMode?: 'foreground' | 'background'
  /** Amount of parent conversation exposed to the bounded planner. */
  readonly planningContext?: 'current' | 'recent' | 'full'
  /** Planner-only output ceiling. This never inherits an unbounded parent maximum. */
  readonly plannerMaxTokens?: number
  /** Optional bounded reviewer -> repair owner -> reviewer loop. */
  readonly qualityGate?: SquadQualityGate
}

/** A finite, explicitly-owned quality loop; arbitrary planner recursion is never permitted. */
export interface SquadQualityGate {
  readonly reviewerAgentId: AgentId
  readonly repairAgentId: AgentId
  readonly maxRounds: 0 | 1 | 2
  readonly criteria?: string
}

/** Durable per-session selection that enables normal-conversation squad mode. */
export interface SessionSquadModeRecord {
  readonly squadId?: SquadId
  /** Explicitly disabled so a project default does not immediately re-enable the session. */
  readonly disabled?: boolean
}

/** One-shot override consumed by exactly one eligible top-level user message. */
export interface SessionNextSquadModeRecord {
  readonly state: 'solo' | 'team'
  readonly squadId?: SquadId
  /** Crash-safe binding: a claimed one-shot can never leak to a later message. */
  readonly claimedMessageId?: string
  readonly claimedAt?: number
}

/** Durable idempotency receipt for one top-level user message. */
export interface SquadMessageClaimRecord {
  readonly sessionId: SessionId
  readonly messageId: string
  readonly kind: 'solo' | 'team'
  readonly createdAt: number
}

/** Resolved session mode returned to host/RPC callers. */
export interface SessionSquadModeView {
  readonly sessionId: SessionId
  readonly squadId: SquadId
  readonly squadName: string
}

/** One model-selected member assignment. Omitted members receive the shared task. */
export interface SquadAssignment {
  readonly agentId: AgentId
  readonly task: string
}

/** One node in a validated acyclic squad plan. */
export interface SquadPlanAssignment extends SquadAssignment {
  readonly dependsOn: AgentId[]
}

/** User- or model-facing request resolved by {@link AgentTeamService.dispatch}. */
export interface SquadDispatchRequest {
  readonly squadId: SquadId
  readonly task: string
  readonly assignments?: readonly SquadAssignment[]
  /** Complete per-dispatch permutation used only when the squad has no fixed order. */
  readonly memberOrder?: readonly AgentId[]
  readonly executionMode?: 'serial' | 'parallel'
  readonly contextMode?: 'spawn' | 'fork' | 'chain'
  /** Explicit API calls may request a detached process-local job. */
  readonly background?: boolean
}

/** One traceable member result recorded inside the parent tool result. */
export interface SquadMemberResult {
  readonly agentId: AgentId
  readonly agentName: string
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed-out'
  readonly runId?: string
  readonly childId?: string
  readonly stopReason?: string
  readonly output: ContentBlock[]
  readonly error?: string
  readonly attempts: number
  /** Exact route used by this concrete execution/review/repair attempt. */
  readonly provider?: string
  readonly model?: string
  readonly startedAt?: number
  readonly endedAt?: number
  readonly usage?: AgentTokenUsage
  /** Bounded model-facing summary; the complete output above remains durable. */
  readonly handoff?: SquadMemberHandoff
}

/** Bounded structured contribution passed between dependencies and to the lead Agent. */
export interface SquadMemberHandoff {
  readonly summary: string
  readonly deliverables: string[]
  readonly risks: string[]
  readonly changedFiles: string[]
}

/** Provider-reported token usage, folded by the official dsh tokenUsage projection. */
export interface AgentTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  /** True when at least one contributing sample came from the official projection. */
  readonly providerReported: boolean
}

/** Automatic division of work produced before squad members start. */
export interface SquadExecutionPlan {
  readonly decision: 'run' | 'skip'
  readonly reason: string
  readonly summary: string
  readonly memberOrder: AgentId[]
  readonly assignments: SquadPlanAssignment[]
  /** Normal conversation sends are planned with the parent Agent's model route. */
  readonly planner: 'main-agent' | 'squad-leader' | 'deterministic-fallback'
  readonly plannerProvider?: string
  readonly plannerModel?: string
  readonly leaderAgentId?: AgentId
  readonly usage?: AgentTokenUsage
  readonly warning?: string
}

/** Canonical squad result; it is lossless JSON when materialized by the tool registry. */
export interface SquadDispatchResult {
  readonly dispatchId: DispatchId
  readonly squadId: SquadId
  readonly squadName: string
  readonly task: string
  readonly executionMode: 'serial' | 'parallel'
  readonly contextMode: 'spawn' | 'fork' | 'chain'
  readonly status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
  readonly members: SquadMemberResult[]
  readonly usage: AgentTokenUsage
  readonly startedAt: number
  readonly endedAt: number
  readonly plan?: SquadExecutionPlan
  readonly quality?: SquadQualityResult
}

/** Durable progress/history row used by the Web run center. */
export interface SquadRunRecord {
  readonly id: DispatchId
  readonly sessionId: SessionId
  readonly sourceMessageId?: string
  readonly projectKey?: string
  readonly squadId: SquadId
  readonly squadName: string
  readonly task: string
  readonly executionMode: 'serial' | 'parallel'
  readonly contextMode: 'spawn' | 'fork' | 'chain'
  readonly status: 'planning' | 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
  /** Official usage coverage across every expected planner/member/review/repair sample. */
  readonly meteringCoverage?: 'full' | 'partial' | 'none'
  /** Fine-grained live phase; optional so v0.4/v0.5-preview rows still parse. */
  readonly phase?: 'queued' | 'planning' | 'members' | 'quality-review' | 'quality-repair' | 'synthesis' | 'settled'
  readonly startedAt: number
  readonly endedAt?: number
  readonly members: SquadRunMember[]
  readonly usage: AgentTokenUsage
  readonly plan?: SquadExecutionPlan
  readonly error?: string
  /** A retry creates a new immutable history row instead of rewriting the source. */
  readonly retryOf?: DispatchId
  readonly responseMode?: 'foreground' | 'background'
  readonly backgroundJobId?: string
  /** Stable hash used to deduplicate an accepted background request. */
  readonly backgroundRequestKey?: string
  readonly quality?: SquadQualityResult
  /** Durable progress while a bounded quality round is still in flight. */
  readonly qualityProgress?: {
    readonly round: number
    readonly maxRepairRounds: number
    readonly totalReviews: number
    readonly reviewerAgentId: AgentId
    readonly repairAgentId: AgentId
    readonly state: 'reviewing' | 'repairing'
  }
  /** Official projection samples for non-member work that is still in flight. */
  readonly liveUsage?: {
    readonly planner?: AgentTokenUsage
    readonly review?: AgentTokenUsage
    readonly repair?: AgentTokenUsage
  }
}

/** One live or settled row within a durable squad run. */
export interface SquadRunMember {
  readonly agentId: AgentId
  readonly agentName: string
  readonly provider: string
  readonly model: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timed-out' | 'skipped'
  readonly attempts: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly runId?: string
  readonly childId?: string
  readonly stopReason?: string
  readonly output: ContentBlock[]
  readonly error?: string
  readonly usage?: AgentTokenUsage
  /** Attempt-level coverage survives aggregation, so retry-once cannot look fully metered when one attempt was missing. */
  readonly usageSamples?: { readonly metered: number; readonly total: number }
  /** Per-attempt route and usage keeps retry attribution honest. */
  readonly attemptUsage?: Array<{
    readonly attempt: number
    readonly provider: string
    readonly model: string
    readonly usage?: AgentTokenUsage
  }>
  readonly handoff?: SquadMemberHandoff
}

/** One bounded review cycle. Full review and repair output remain in the durable run. */
export interface SquadQualityRound {
  readonly round: number
  readonly approved: boolean
  readonly feedback: string
  readonly reviewer: SquadMemberResult
  readonly repair?: SquadMemberResult
}

export interface SquadQualityResult {
  readonly approved: boolean
  readonly rounds: SquadQualityRound[]
}

/** Immutable definition copy embedded in a squad version or recipe. */
export interface AgentDefinitionSnapshot {
  readonly id: AgentId
  readonly record: AgentRecord
}

/** One immutable squad revision retained for restore and audit. */
export interface SquadVersionRecord {
  readonly squadId: SquadId
  readonly version: number
  readonly createdAt: number
  readonly record: SquadRecord
  /** Missing only on legacy v0.4 revisions. */
  readonly memberSnapshots?: AgentDefinitionSnapshot[]
}

/** Per-workspace default applied to new sessions without an explicit selection. */
export interface ProjectSquadDefaultRecord {
  readonly projectKey: string
  readonly squadId: SquadId
  readonly enabled: boolean
}

/** One agent row inside an exported definition document. */
export interface AgentExportItem {
  readonly id: AgentId
  readonly name: string
  readonly systemPrompt: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly toolScope?: AgentToolScope
  readonly fallbackProvider?: string
  readonly fallbackModel?: string
}

/** One squad row inside an exported definition document. */
export interface SquadExportItem {
  readonly id: SquadId
  readonly name: string
  readonly members: AgentId[]
  readonly collabNote?: string
  readonly executionOrder?: AgentId[]
  readonly executionMode?: 'serial' | 'parallel'
  readonly contextMode?: 'spawn' | 'fork' | 'chain'
  readonly leaderAgentId?: AgentId
  readonly triggerMode?: 'guaranteed' | 'model-tool'
  readonly failurePolicy?: 'continue' | 'stop' | 'retry-once'
  readonly maxConcurrency?: number
  readonly memberTimeoutMs?: number
  readonly tokenBudget?: number
  readonly activationMode?: 'always' | 'smart' | 'manual'
  readonly memberSelectionMode?: 'all' | 'adaptive'
  readonly responseMode?: 'foreground' | 'background'
  readonly planningContext?: 'current' | 'recent' | 'full'
  readonly plannerMaxTokens?: number
  readonly qualityGate?: SquadQualityGate
}

/** Versioned, self-describing dump of every durable agent/squad definition. */
export interface AgentTeamExportDocument {
  readonly format: 'agent-team-gui/definitions'
  readonly version: 1 | 2
  readonly exportedAt?: number
  readonly agents: AgentExportItem[]
  readonly squads: SquadExportItem[]
}

/** How an imported document is applied to the existing durable store. */
export type AgentTeamImportMode = 'merge' | 'replace'

/** Count of rows actually written by one import call. */
export interface AgentTeamImportResult {
  readonly agents: number
  readonly squads: number
}

/** Read-only impact report shown before a full merge/replace backup apply. */
export interface AgentTeamImportPreview {
  readonly valid: true
  /** Optimistic precondition required by the subsequent RPC apply. */
  readonly definitionRevision: number
  readonly mode: AgentTeamImportMode
  readonly incoming: { readonly agents: number; readonly squads: number }
  readonly conflicts: { readonly agentIds: AgentId[]; readonly squadIds: SquadId[] }
  readonly affectedSquads: Array<{ readonly squadId: SquadId; readonly squadName: string; readonly agentIds: AgentId[] }>
  readonly deletions: {
    readonly agents: number
    readonly squads: number
    readonly sessionModes: number
    readonly nextModes: number
    readonly projectDefaults: number
    readonly squadVersions: number
  }
}

/** Portable, credential-free definition of one reproducible squad. */
export interface AgentTeamRecipeDocument {
  readonly format: 'agent-team-gui/recipe'
  readonly version: 1
  readonly exportedAt: number
  readonly squad: SquadExportItem
  readonly agents: AgentExportItem[]
}

export interface AgentRouteRemap {
  readonly provider: string
  readonly model: string
  readonly fallbackProvider?: string
  readonly fallbackModel?: string
}

export interface RecipeMissingRoute {
  readonly agentId: AgentId
  readonly kind: 'primary' | 'fallback'
  readonly provider: string
  readonly model: string
  readonly message: string
}

export interface RecipeConflict {
  readonly kind: 'agent' | 'squad'
  readonly id: string
  readonly existingName: string
  readonly incomingName: string
}

export interface RecipePreviewResult {
  readonly valid: boolean
  /** Optimistic precondition required by the subsequent RPC apply. */
  readonly definitionRevision: number
  readonly squad: SquadExportItem
  readonly agents: AgentExportItem[]
  readonly conflicts: RecipeConflict[]
  readonly missingRoutes: RecipeMissingRoute[]
  readonly affectedSquads: Array<{ readonly squadId: SquadId; readonly squadName: string; readonly agentIds: AgentId[] }>
}

export interface RecipeImportResult {
  readonly squadId: SquadId
  readonly agents: number
  readonly createdAgents: number
  readonly updatedAgents: number
}

/** Aggregate row returned by the Run Center insights endpoint. */
export interface UsageAggregateRow {
  readonly key: string
  readonly label: string
  readonly runCount: number
  readonly usage: AgentTokenUsage
  readonly meteredSamples: number
  readonly unmeteredSamples: number
}

export interface SquadInsightsSummary {
  readonly runCount: number
  /** Runs where every expected sample has official provider usage. */
  readonly fullyMeteredRuns: number
  /** Runs with some, but not all, expected samples metered. */
  readonly partiallyMeteredRuns: number
  /** Compatibility total: fullyMeteredRuns + partiallyMeteredRuns. */
  readonly meteredRuns: number
  /** Runs with no official sample. */
  readonly unmeteredRuns: number
  readonly statuses: Record<string, number>
  readonly usage: AgentTokenUsage
  readonly plannerUsage: AgentTokenUsage
  readonly memberUsage: AgentTokenUsage
  readonly qualityUsage: AgentTokenUsage
  readonly reviewUsage: AgentTokenUsage
  readonly repairUsage: AgentTokenUsage
  readonly bySquad: UsageAggregateRow[]
  readonly byAgent: UsageAggregateRow[]
  readonly byModel: UsageAggregateRow[]
  readonly byProject: UsageAggregateRow[]
}

export interface AgentTeamRunExportDocument {
  readonly format: 'agent-team-gui/run'
  readonly version: 1
  readonly exportedAt: number
  readonly run: SquadRunRecord
}
