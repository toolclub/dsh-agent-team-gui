import type { AgentView, SquadView, TeamDefaults, TeamSnapshot } from './contracts.ts'
import type { MessageKey } from './i18n.ts'
import { MAX_HANDOFF_SUMMARY_MAX_CHARS, MIN_HANDOFF_SUMMARY_MAX_CHARS } from '../limits.ts'

export interface AgentDraft {
  id: string
  name: string
  systemPrompt: string
  provider: string
  model: string
  maxTokens: string
  allow: string
  deny: string
  fallbackProvider: string
  fallbackModel: string
}

export interface SquadDraft {
  id: string
  name: string
  collabNote: string
  members: string[]
  fixedOrder: boolean
  executionOrder: string[]
  executionMode: 'inherit' | 'serial' | 'parallel'
  contextMode: 'inherit' | 'spawn' | 'fork' | 'chain'
  leaderAgentId: string
  triggerMode: 'guaranteed' | 'model-tool'
  failurePolicy: 'continue' | 'stop' | 'retry-once'
  maxConcurrency: string
  memberTimeoutMs: string
  tokenBudget: string
  handoffSummaryMaxChars: string
  activationMode: 'always' | 'smart' | 'manual'
  memberSelectionMode: 'all' | 'adaptive'
  responseMode: 'foreground' | 'background'
  planningContext: 'inherit' | 'current' | 'recent' | 'full'
  plannerMaxTokens: string
  qualityEnabled: boolean
  reviewerAgentId: string
  repairAgentId: string
  qualityMaxRounds: '0' | '1' | '2'
  qualityCriteria: string
}

export interface ValidationResult {
  errors: Record<string, MessageKey>
  warnings: Record<string, MessageKey>
  valid: boolean
}

export const EMPTY_AGENT: AgentDraft = {
  id: '', name: '', systemPrompt: '', provider: '', model: '', maxTokens: '', allow: '', deny: '', fallbackProvider: '', fallbackModel: '',
}

export const EMPTY_SQUAD: SquadDraft = {
  id: '', name: '', collabNote: '', members: [], fixedOrder: false, executionOrder: [], executionMode: 'serial', contextMode: 'fork',
  leaderAgentId: '', triggerMode: 'guaranteed', failurePolicy: 'continue', maxConcurrency: '', memberTimeoutMs: '', tokenBudget: '',
  handoffSummaryMaxChars: '',
  activationMode: 'always', memberSelectionMode: 'all', responseMode: 'foreground', planningContext: 'current', plannerMaxTokens: '2048',
  qualityEnabled: false, reviewerAgentId: '', repairAgentId: '', qualityMaxRounds: '1', qualityCriteria: '',
}

export function agentDraftOf(agent: AgentView): AgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    provider: agent.provider,
    model: agent.model,
    maxTokens: agent.maxTokens?.toString() ?? '',
    allow: agent.toolScope?.allow?.join(', ') ?? '',
    deny: agent.toolScope?.deny?.join(', ') ?? '',
    fallbackProvider: agent.fallbackProvider ?? '',
    fallbackModel: agent.fallbackModel ?? '',
  }
}

export function defaultAgent(data: TeamSnapshot): AgentDraft {
  const provider = data.models[0]
  return {
    ...EMPTY_AGENT,
    provider: provider?.provider ?? '',
    model: provider?.models[0]?.id ?? '',
  }
}

export function squadDraftOf(squad: SquadView): SquadDraft {
  return {
    ...EMPTY_SQUAD,
    id: squad.id,
    name: squad.name,
    collabNote: squad.collabNote,
    members: [...squad.members],
    fixedOrder: squad.executionOrder !== undefined,
    executionOrder: squad.executionOrder === undefined ? [] : [...squad.executionOrder],
    executionMode: squad.executionMode ?? 'inherit',
    contextMode: squad.contextMode ?? 'inherit',
    leaderAgentId: squad.leaderAgentId ?? '',
    triggerMode: squad.triggerMode ?? 'guaranteed',
    failurePolicy: squad.failurePolicy ?? 'continue',
    maxConcurrency: squad.maxConcurrency?.toString() ?? '',
    memberTimeoutMs: squad.memberTimeoutMs?.toString() ?? '',
    tokenBudget: squad.tokenBudget?.toString() ?? '',
    handoffSummaryMaxChars: squad.handoffSummaryMaxChars?.toString() ?? '',
    activationMode: squad.activationMode ?? 'always',
    memberSelectionMode: squad.memberSelectionMode ?? 'all',
    responseMode: squad.responseMode ?? 'foreground',
    planningContext: squad.planningContext ?? 'inherit',
    plannerMaxTokens: squad.plannerMaxTokens?.toString() ?? '2048',
    qualityEnabled: squad.qualityGate !== undefined,
    reviewerAgentId: squad.qualityGate?.reviewerAgentId ?? '',
    repairAgentId: squad.qualityGate?.repairAgentId ?? '',
    qualityMaxRounds: String(squad.qualityGate?.maxRounds ?? 1) as '0' | '1' | '2',
    qualityCriteria: squad.qualityGate?.criteria ?? '',
  }
}

export function validateAgent(draft: AgentDraft, tools?: readonly { name: string }[]): ValidationResult {
  const errors: Record<string, MessageKey> = {}
  const warnings: Record<string, MessageKey> = {}
  if (draft.name.trim() === '') errors.name = 'required'
  else if (draft.name.trim().length > 120) errors.name = 'nameLength'
  if (draft.systemPrompt.trim() === '') errors.systemPrompt = 'required'
  else if (draft.systemPrompt.length > 50_000) errors.systemPrompt = 'promptLength'
  if (draft.provider === '') errors.provider = 'required'
  else if (draft.provider.trim().length > 200) errors.provider = 'routeLength'
  if (draft.model === '') errors.model = 'required'
  else if (draft.model.trim().length > 200) errors.model = 'routeLength'
  if (draft.maxTokens !== '' && !isIntegerInRange(draft.maxTokens, 1, 1_000_000)) errors.maxTokens = 'agentTokenRange'
  if ((draft.fallbackProvider === '') !== (draft.fallbackModel === '')) errors.fallback = 'fallbackPairError'
  else if (draft.fallbackProvider.trim().length > 200 || draft.fallbackModel.trim().length > 200) errors.fallback = 'routeLength'
  const denied = new Set(csv(draft.deny))
  const allowed = csv(draft.allow)
  if (allowed.length > 256 || denied.size > 256) errors.tools = 'toolCountError'
  else if ([...allowed, ...denied].some(tool => tool.length > 200)) errors.tools = 'toolNameLengthError'
  else if (allowed.some(tool => denied.has(tool))) errors.tools = 'toolConflictError'
  else if (tools !== undefined) {
    const known = new Set(tools.map(tool => tool.name))
    // Tool registrations may live in an Agent preset scope rather than the
    // Host-global catalog. Keep the catalog useful without turning it into a
    // false closed allowlist; the Host validates against the actual parent
    // scope when the member is dispatched.
    if ([...allowed, ...denied].some(tool => !known.has(tool))) warnings.tools = 'unknownToolWarning'
  }
  return { errors, warnings, valid: Object.keys(errors).length === 0 }
}

export function validateSquad(draft: SquadDraft, agents: readonly AgentView[], defaults?: TeamDefaults): ValidationResult {
  const errors: Record<string, MessageKey> = {}
  const warnings: Record<string, MessageKey> = {}
  if (draft.name.trim() === '') errors.name = 'required'
  else if (draft.name.trim().length > 120) errors.name = 'nameLength'
  if (draft.members.length === 0) errors.members = 'chooseMemberError'
  else if (draft.members.length > 32) errors.members = 'memberCountError'
  if (draft.collabNote.length > 20_000) errors.collabNote = 'longTextLength'
  if (draft.maxConcurrency !== '' && (!isIntegerInRange(draft.maxConcurrency, 1, 32))) errors.maxConcurrency = 'concurrencyRange'
  if (draft.memberTimeoutMs !== '' && (!isIntegerInRange(draft.memberTimeoutMs, 1_000, 3_600_000))) errors.memberTimeoutMs = 'timeoutRange'
  if (draft.tokenBudget !== '' && !isIntegerInRange(draft.tokenBudget, 1, 100_000_000)) errors.tokenBudget = 'budgetRange'
  if (draft.handoffSummaryMaxChars !== '' && !isIntegerInRange(draft.handoffSummaryMaxChars, MIN_HANDOFF_SUMMARY_MAX_CHARS, MAX_HANDOFF_SUMMARY_MAX_CHARS)) errors.handoffSummaryMaxChars = 'handoffSummaryRange'
  if (!isIntegerInRange(draft.plannerMaxTokens, 256, 8_192)) errors.plannerMaxTokens = 'plannerRange'
  const effectiveExecution = draft.fixedOrder ? 'serial' : draft.executionMode === 'inherit' ? defaults?.executionMode : draft.executionMode
  const effectiveContext = draft.contextMode === 'inherit' ? defaults?.contextMode : draft.contextMode
  if (effectiveContext === 'chain' && effectiveExecution === 'parallel') errors.contextMode = 'chainParallelConflict'
  if (draft.failurePolicy === 'retry-once') {
    const selected = agents.filter(agent => draft.members.includes(agent.id))
    if (selected.some(agent => agent.fallbackProvider === undefined || agent.fallbackModel === undefined)) warnings.failurePolicy = 'retryFallbackWarning'
  }
  if (draft.qualityEnabled) {
    if (!draft.members.includes(draft.reviewerAgentId) || !draft.members.includes(draft.repairAgentId)) errors.qualityMembers = 'qualityMembersError'
    if (draft.reviewerAgentId !== '' && draft.reviewerAgentId === draft.repairAgentId) errors.qualityDistinct = 'qualityDistinctError'
    if (draft.qualityCriteria.length > 20_000) errors.qualityCriteria = 'longTextLength'
  }
  return { errors, warnings, valid: Object.keys(errors).length === 0 }
}

export function toAgentRecord(draft: AgentDraft): Omit<AgentView, 'id'> {
  const allow = csv(draft.allow)
  const deny = csv(draft.deny)
  return {
    name: draft.name.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    provider: draft.provider,
    model: draft.model,
    ...(draft.maxTokens === '' ? {} : { maxTokens: Number(draft.maxTokens) }),
    ...(allow.length === 0 && deny.length === 0 ? {} : { toolScope: {
      ...(allow.length === 0 ? {} : { allow }),
      ...(deny.length === 0 ? {} : { deny }),
    } }),
    ...(draft.fallbackProvider === '' || draft.fallbackModel === '' ? {} : {
      fallbackProvider: draft.fallbackProvider,
      fallbackModel: draft.fallbackModel,
    }),
  }
}

export function toSquadRecord(draft: SquadDraft): Omit<SquadView, 'id'> {
  return {
    name: draft.name.trim(),
    members: draft.members,
    collabNote: draft.collabNote.trim(),
    ...(draft.fixedOrder
      ? {
          executionOrder: normalizeOrder(draft.members, draft.executionOrder),
          ...(draft.executionMode === 'inherit' ? {} : { executionMode: 'serial' as const }),
        }
      : draft.executionMode === 'inherit' ? {} : { executionMode: draft.executionMode }),
    ...(draft.contextMode === 'inherit' ? {} : { contextMode: draft.contextMode }),
    ...(draft.leaderAgentId === '' ? {} : { leaderAgentId: draft.leaderAgentId }),
    triggerMode: draft.triggerMode,
    failurePolicy: draft.failurePolicy,
    ...(draft.maxConcurrency === '' ? {} : { maxConcurrency: Number(draft.maxConcurrency) }),
    ...(draft.memberTimeoutMs === '' ? {} : { memberTimeoutMs: Number(draft.memberTimeoutMs) }),
    ...(draft.tokenBudget === '' ? {} : { tokenBudget: Number(draft.tokenBudget) }),
    ...(draft.handoffSummaryMaxChars === '' ? {} : { handoffSummaryMaxChars: Number(draft.handoffSummaryMaxChars) }),
    activationMode: draft.activationMode,
    memberSelectionMode: draft.memberSelectionMode,
    responseMode: draft.responseMode,
    ...(draft.planningContext === 'inherit' ? {} : { planningContext: draft.planningContext }),
    plannerMaxTokens: Number(draft.plannerMaxTokens),
    ...(draft.qualityEnabled ? { qualityGate: {
      reviewerAgentId: draft.reviewerAgentId,
      repairAgentId: draft.repairAgentId,
      maxRounds: Number(draft.qualityMaxRounds) as 0 | 1 | 2,
      ...(draft.qualityCriteria.trim() === '' ? {} : { criteria: draft.qualityCriteria.trim() }),
    } } : {}),
  }
}

export function normalizeOrder(members: readonly string[], order: readonly string[]): string[] {
  return [...order.filter(id => members.includes(id)), ...members.filter(id => !order.includes(id))]
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function csv(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function isIntegerInRange(value: string, min: number, max: number): boolean {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max && Number.isSafeInteger(Number(value))
}
