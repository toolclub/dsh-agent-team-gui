/** Browser-side mirror of the loopback RPC v3 contract. No credentials cross this boundary. */

export const AGENT_TEAM_RPC_API_VERSION = 4

export type ActivationMode = 'always' | 'smart' | 'manual'
export type MemberSelectionMode = 'all' | 'adaptive'
export type ResponseMode = 'foreground' | 'background'
export type PlanningContext = 'current' | 'recent' | 'full'

export interface AgentView {
  id: string
  name: string
  systemPrompt: string
  provider: string
  model: string
  maxTokens?: number
  toolScope?: { allow?: string[]; deny?: string[] }
  fallbackProvider?: string
  fallbackModel?: string
}

export interface QualityGateView {
  reviewerAgentId: string
  repairAgentId: string
  maxRounds: 0 | 1 | 2
  criteria?: string
}

export interface SquadView {
  id: string
  name: string
  members: string[]
  collabNote: string
  executionOrder?: string[]
  executionMode?: 'serial' | 'parallel'
  contextMode?: 'spawn' | 'fork' | 'chain'
  leaderAgentId?: string
  triggerMode?: 'guaranteed' | 'model-tool'
  failurePolicy?: 'continue' | 'stop' | 'retry-once'
  maxConcurrency?: number
  memberTimeoutMs?: number
  tokenBudget?: number
  handoffSummaryMaxChars?: number
  activationMode?: ActivationMode
  memberSelectionMode?: MemberSelectionMode
  responseMode?: ResponseMode
  planningContext?: PlanningContext
  plannerMaxTokens?: number
  qualityGate?: QualityGateView
}

export interface ModelGroup {
  provider: string
  name: string
  models: Array<{ id: string; name: string }>
}

export interface TeamCapabilities {
  smartActivation: boolean
  dags: boolean
  qualityGate: boolean
  backgroundRuns: boolean
  recipes: boolean
  remoteRecipeFetch: boolean
  insights: boolean
  reproducibleVersions: boolean
}

export interface TeamDefaults {
  executionMode: 'serial' | 'parallel'
  fixedOrderExecutionMode: 'serial'
  contextMode: 'spawn' | 'fork' | 'chain'
  planningContext: 'full'
  plannerMaxTokens: number
}

export interface TeamSnapshot {
  apiVersion: number
  agents: AgentView[]
  squads: SquadView[]
  models: ModelGroup[]
  tools: Array<{ name: string; description: string }>
  capabilities: TeamCapabilities
  defaults: TeamDefaults
}

export interface ModeValue {
  sessionId: string
  squadId: string
  squadName: string
}

export type NextOverride = 'inherit' | 'solo' | { squadId: string; squadName: string } | null

export interface ModeResponse {
  mode: ModeValue | null
  sessionOverride: 'enabled' | 'disabled' | 'inherit'
  sessionReady: boolean
  projectKey: string | null
  projectDefault: { projectKey: string; squadId: string; enabled: boolean } | null
  nextOverride: NextOverride
}

export interface TokenUsageView {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  providerReported: boolean
}

export const EMPTY_USAGE: TokenUsageView = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  providerReported: false,
}

export type RunStatus = 'planning' | 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
export type RunMemberStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timed-out' | 'skipped'
export type RunPhase = 'queued' | 'planning' | 'members' | 'quality-review' | 'quality-repair' | 'synthesis' | 'settled'

export interface RunMemberView {
  agentId: string
  agentName: string
  provider: string
  model: string
  status: RunMemberStatus
  attempts: number
  startedAt?: number
  endedAt?: number
  runId?: string
  childId?: string
  stopReason?: string
  output: Array<{ type?: string; text?: string }>
  error?: string
  usage?: TokenUsageView
  /** Official metering coverage across this member's attempts (for example retry-once). */
  usageSamples?: { metered: number; total: number }
  phase?: 'member' | 'quality' | 'repair'
}

export interface PlanAssignmentView {
  agentId: string
  task: string
  dependsOn?: string[]
}

export interface PlanView {
  decision?: 'run' | 'skip'
  reason?: string
  summary: string
  memberOrder: string[]
  assignments: PlanAssignmentView[]
  planner: 'main-agent' | 'squad-leader' | 'deterministic-fallback'
  plannerProvider?: string
  plannerModel?: string
  usage?: TokenUsageView
  warning?: string
}

export interface QualityMemberView {
  agentId: string
  agentName: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out'
  output: Array<{ type?: string; text?: string }>
  error?: string
  attempts: number
  startedAt?: number
  endedAt?: number
  usage?: TokenUsageView
}

export interface QualityRoundView {
  round: number
  approved: boolean
  feedback: string
  reviewer: QualityMemberView
  repair?: QualityMemberView
}

export interface QualityResultView {
  approved: boolean
  rounds: QualityRoundView[]
}

export interface RunView {
  id: string
  sessionId: string
  squadId?: string
  squadName: string
  projectKey?: string
  task: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  executionMode: 'serial' | 'parallel'
  contextMode: 'spawn' | 'fork' | 'chain'
  members: RunMemberView[]
  usage: TokenUsageView
  plan?: PlanView
  retryOf?: string
  error?: string
  quality?: QualityResultView
  phase?: RunPhase
  qualityProgress?: {
    round: number
    maxRepairRounds: 0 | 1 | 2
    totalReviews: 1 | 2 | 3
    reviewerAgentId: string
    repairAgentId: string
    state: 'reviewing' | 'repairing'
  }
  liveUsage?: {
    planner?: TokenUsageView
    review?: TokenUsageView
    repair?: TokenUsageView
  }
  /** Official-token sample coverage for the work that actually occurred. */
  meteringCoverage?: 'full' | 'partial' | 'none'
}

export interface InsightsBucket {
  id?: string
  name?: string
  label?: string
  runCount?: number
  usage?: TokenUsageView
  meteredSamples?: number
  unmeteredSamples?: number
  [key: string]: unknown
}

export interface InsightsView {
  runCount: number
  fullyMeteredRuns?: number
  partiallyMeteredRuns?: number
  meteredRuns?: number
  unmeteredRuns?: number
  statuses: Partial<Record<RunStatus, number>>
  usage: TokenUsageView
  plannerUsage: TokenUsageView
  memberUsage: TokenUsageView
  qualityUsage: TokenUsageView
  reviewUsage: TokenUsageView
  repairUsage: TokenUsageView
  bySquad: InsightsBucket[]
  byAgent: InsightsBucket[]
  byModel: InsightsBucket[]
  byProject: InsightsBucket[]
}

export interface RecipePreview {
  valid: boolean
  /** Optimistic precondition that must be echoed by recipe/import. */
  definitionRevision: number
  conflicts: RecipeConflictView[]
  missingRoutes: RecipeMissingRouteView[]
  affectedSquads?: Array<{ squadId: string; squadName: string; agentIds: string[] }>
  squad?: SquadView
  agents?: AgentView[]
}

export interface RecipeConflictView {
  kind: 'agent' | 'squad'
  id: string
  existingName: string
  incomingName: string
}

export interface RecipeMissingRouteView {
  agentId: string
  kind: 'primary' | 'fallback'
  provider: string
  model: string
  message: string
}

export interface SquadVersionView {
  version: number
  createdAt: number
  memberSnapshots?: AgentView[]
}

export type AgentTeamRpc = <T>(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<T>

export const EMPTY_DATA: TeamSnapshot = {
  apiVersion: AGENT_TEAM_RPC_API_VERSION,
  agents: [],
  squads: [],
  models: [],
  tools: [],
  capabilities: {
    smartActivation: false, dags: false, qualityGate: false, backgroundRuns: false,
    recipes: false, remoteRecipeFetch: false, insights: false, reproducibleVersions: false,
  },
  defaults: { executionMode: 'serial', fixedOrderExecutionMode: 'serial', contextMode: 'fork', planningContext: 'full', plannerMaxTokens: 2_048 },
}
