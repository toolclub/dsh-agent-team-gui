import { AgentId, type AgentRecord, type SquadExecutionPlan, type SquadMemberHandoff, type SquadPlanAssignment, type SquadRecord } from '../types.ts'
import { DEFAULT_HANDOFF_SUMMARY_MAX_CHARS, MAX_HANDOFF_SUMMARY_MAX_CHARS, MIN_HANDOFF_SUMMARY_MAX_CHARS } from '../limits.ts'

function boundedExcerpt(value: string, max: number): string {
  if (value.length <= max) return value
  const marker = '\n… [bounded excerpt: middle omitted] …\n'
  const available = Math.max(0, max - marker.length)
  const head = Math.ceil(available * 0.6)
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`
}

export interface PlanValidationOptions {
  readonly requireAllMembers: boolean
  readonly allowSkip: boolean
}

/** Validate identities and dependencies, then produce a deterministic topological display order. */
export function validateExecutionPlan(
  plan: SquadExecutionPlan,
  squad: SquadRecord,
  options: PlanValidationOptions,
): SquadExecutionPlan {
  if (plan.reason.length > 8_000 || plan.summary.length > 8_000 || (plan.warning?.length ?? 0) > 8_000) {
    throw new Error('plan summary/reason exceeds the bounded planner limits')
  }
  if (plan.decision === 'skip') {
    if (!options.allowSkip) throw new Error('this squad activation policy cannot skip the request')
    if (plan.assignments.length !== 0 || plan.memberOrder.length !== 0) {
      throw new Error('a skipped plan must not contain assignments or memberOrder')
    }
    return plan
  }
  if (plan.assignments.length === 0) throw new Error('a running plan must select at least one member')
  if (plan.assignments.length > 32 || plan.memberOrder.length > 32) throw new Error('a plan may contain at most 32 members')
  const squadIds = new Set(squad.members)
  const assignments = new Map<AgentId, SquadPlanAssignment>()
  for (const node of plan.assignments) {
    if (!squadIds.has(node.agentId)) throw new Error(`plan member "${node.agentId}" is not in the squad`)
    if (assignments.has(node.agentId)) throw new Error(`plan member "${node.agentId}" appears more than once`)
    if (node.task.trim() === '') throw new Error(`plan assignment for "${node.agentId}" is empty`)
    if (node.task.length > 100_000 || node.dependsOn.length > 32) throw new Error(`plan assignment for "${node.agentId}" exceeds bounded limits`)
    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new Error(`plan dependencies for "${node.agentId}" must be unique`)
    }
    assignments.set(node.agentId, { ...node, task: node.task.trim(), dependsOn: [...node.dependsOn] })
  }
  if (options.requireAllMembers && assignments.size !== squad.members.length) {
    throw new Error('the plan must assign every configured member')
  }
  for (const node of assignments.values()) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.agentId) throw new Error(`plan member "${node.agentId}" cannot depend on itself`)
      if (!assignments.has(dependency)) {
        throw new Error(`plan dependency "${dependency}" is not a selected member`)
      }
    }
  }

  const claimed = new Set(plan.memberOrder)
  if (plan.memberOrder.length !== assignments.size || claimed.size !== assignments.size
    || [...assignments.keys()].some(id => !claimed.has(id))) {
    throw new Error('memberOrder must contain every selected plan member exactly once')
  }
  // The planner's order is authoritative for otherwise-ready nodes. Requiring
  // each dependency to appear first makes that order a valid topological
  // ordering instead of silently rewriting the Main Agent's workflow.
  const stableIndex = new Map(plan.memberOrder.map((id, index) => [id, index]))
  for (const node of assignments.values()) {
    for (const dependency of node.dependsOn) {
      if ((stableIndex.get(dependency) ?? Number.MAX_SAFE_INTEGER) >= (stableIndex.get(node.agentId) ?? -1)) {
        throw new Error(`memberOrder places dependency "${dependency}" after "${node.agentId}"`)
      }
    }
  }

  const indegree = new Map<AgentId, number>()
  const followers = new Map<AgentId, AgentId[]>()
  for (const node of assignments.values()) {
    indegree.set(node.agentId, node.dependsOn.length)
    for (const dependency of node.dependsOn) {
      const list = followers.get(dependency) ?? []
      list.push(node.agentId)
      followers.set(dependency, list)
    }
  }
  const ready = [...assignments.keys()].filter(id => indegree.get(id) === 0)
    .sort((left, right) => (stableIndex.get(left) ?? 0) - (stableIndex.get(right) ?? 0))
  const order: AgentId[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const follower of followers.get(id) ?? []) {
      const next = (indegree.get(follower) ?? 1) - 1
      indegree.set(follower, next)
      if (next === 0) {
        ready.push(follower)
        ready.sort((left, right) => (stableIndex.get(left) ?? 0) - (stableIndex.get(right) ?? 0))
      }
    }
  }
  if (order.length !== assignments.size) throw new Error('plan dependencies contain a cycle')
  return { ...plan, memberOrder: order, assignments: order.map(id => assignments.get(id)!) }
}

/** Role-scoped fallback used when a planner route fails or emits an invalid/cyclic graph. */
export function deterministicExecutionPlan(
  squad: SquadRecord,
  task: string,
  agents: ReadonlyMap<AgentId, AgentRecord>,
  warning?: string,
  effectiveExecutionMode: 'serial' | 'parallel' = squad.executionMode ?? 'serial',
): SquadExecutionPlan {
  const order = squad.executionOrder ?? squad.members
  const boundedWarning = warning === undefined ? undefined : boundedExcerpt(warning, 8_000)
  return {
    decision: 'run',
    reason: boundedWarning === undefined ? 'Configured deterministic workflow.' : 'Planner failed validation; using the configured deterministic workflow.',
    summary: boundedWarning === undefined
      ? 'Configured member workflow.'
      : 'Dynamic planning failed; using a bounded role-scoped assignment for every configured member.',
    memberOrder: [...order],
    assignments: order.map((agentId, index) => {
      const record = agents.get(agentId)
      const name = record?.name ?? String(agentId)
      const role = boundedExcerpt(record?.systemPrompt.trim() || `Act as ${name}.`, 8_000)
      const goal = boundedExcerpt(task, 40_000)
      return {
        agentId,
        task: [
          `Exclusive role boundary for ${name}: ${role}`,
          'Do only this role-specific contribution; do not replace another squad member.',
          `Overall goal (bounded head/tail excerpt): ${goal}`,
        ].join('\n\n').slice(0, 50_000),
        dependsOn: effectiveExecutionMode === 'parallel' || index === 0 ? [] : [order[index - 1]!],
      }
    }),
    planner: 'deterministic-fallback',
    ...(boundedWarning === undefined ? {} : { warning: boundedWarning }),
  }
}

/** Dependency-ready waves. Nodes in one wave may execute concurrently. */
export function executionWaves(assignments: readonly SquadPlanAssignment[]): SquadPlanAssignment[][] {
  const remaining = new Map(assignments.map(item => [item.agentId, item]))
  const completed = new Set<AgentId>()
  const waves: SquadPlanAssignment[][] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(item => item.dependsOn.every(id => completed.has(id)))
    if (ready.length === 0) throw new Error('plan dependencies contain a cycle')
    waves.push(ready)
    for (const item of ready) {
      remaining.delete(item.agentId)
      completed.add(item.agentId)
    }
  }
  return waves
}

/** Keep model-facing handoffs bounded even when a member returns a very large artifact or log. */
export function normalizeHandoff(
  value: unknown,
  fallbackText: string,
  summaryMaxChars = DEFAULT_HANDOFF_SUMMARY_MAX_CHARS,
): SquadMemberHandoff {
  if (!Number.isInteger(summaryMaxChars)
    || summaryMaxChars < MIN_HANDOFF_SUMMARY_MAX_CHARS
    || summaryMaxChars > MAX_HANDOFF_SUMMARY_MAX_CHARS) {
    throw new RangeError(`handoff summary limit must be ${MIN_HANDOFF_SUMMARY_MAX_CHARS}-${MAX_HANDOFF_SUMMARY_MAX_CHARS} characters`)
  }
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const strings = (candidate: unknown, max: number): string[] => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === 'string').slice(0, max).map(item => item.slice(0, 1_000))
    : []
  const summary = typeof raw['summary'] === 'string' && raw['summary'].trim() !== ''
    ? raw['summary'].trim().slice(0, summaryMaxChars)
    : fallbackText.trim().slice(0, summaryMaxChars)
  return {
    summary: summary || 'Member completed without a textual summary.',
    deliverables: strings(raw['deliverables'], 12),
    risks: strings(raw['risks'], 12),
    changedFiles: strings(raw['changedFiles'], 50),
  }
}
