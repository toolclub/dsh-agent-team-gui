import { z } from 'zod'
import { AgentId, DispatchId, type SquadContinuationRequest, type SquadRunRecord } from '../types.ts'
import { executionWaves, validateExecutionPlan } from './orchestration.ts'

export const continuationRequestSchema = z.object({
  sourceRunId: z.string().min(1).transform(DispatchId),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2_000),
  progressReview: z.string().trim().min(1).max(4_000),
  assignments: z.array(z.object({
    agentId: z.string().min(1).transform(AgentId),
    task: z.string().trim().min(1).max(16_000),
    dependsOn: z.array(z.string().min(1).transform(AgentId)).max(32).optional(),
  }).strict()).min(1).max(32),
}).strict()

/** Keep stable member-task identities; only unsuccessful tasks and affected descendants may change. */
export function prepareContinuation(source: SquadRunRecord, request: SquadContinuationRequest) {
  const original = source.plan!
  const squad = source.definitionSnapshot!.squad
  const oldById = new Map(original.assignments.map(node => [node.agentId, node]))
  const changed = new Map(request.assignments.map(node => [node.agentId, node]))
  if (changed.size !== request.assignments.length) throw new Error('Continuation contains duplicate task identities.')
  for (const id of changed.keys()) if (!oldById.has(id)) throw new Error('Continuation cannot introduce a new member/task identity.')
  const failed = new Set(original.assignments.filter(node => source.members.find(member => member.agentId === node.agentId)?.status !== 'completed').map(node => node.agentId))
  if (failed.size === 0) throw new Error('No unfinished member tasks; quality-only failures require explicit user review.')
  for (const id of failed) if (!changed.has(id)) throw new Error(`Supply an explicit remaining assignment for unfinished task "${id}".`)
  const editable = new Set(failed)
  let expanding = true
  while (expanding) {
    expanding = false
    for (const node of original.assignments) {
      if (!editable.has(node.agentId) && node.dependsOn.some(id => editable.has(id))) { editable.add(node.agentId); expanding = true }
    }
  }
  for (const id of changed.keys()) if (!editable.has(id)) throw new Error(`Successful independent task "${id}" cannot be restarted by adding a new dependency.`)
  const nodes = original.assignments.map(node => {
    const replacement = changed.get(node.agentId)
    return replacement === undefined ? { ...node, dependsOn: [...node.dependsOn] }
      : { agentId: node.agentId, task: replacement.task, dependsOn: [...(replacement.dependsOn ?? node.dependsOn)] }
  })
  const affected = new Set(failed)
  // Traverse both plans: removing an old dependency must not make a stale success reusable.
  let grew = true
  while (grew) {
    grew = false
    for (const node of [...original.assignments, ...nodes]) {
      if (!affected.has(node.agentId) && node.dependsOn.some(id => affected.has(id))) {
        affected.add(node.agentId); grew = true
      }
    }
  }
  for (const id of changed.keys()) if (!affected.has(id)) throw new Error(`Successful independent task "${id}" cannot be restarted by a continuation.`)
  const memberOrder = executionWaves(nodes).flat().map(node => node.agentId)
  if (squad.executionOrder !== undefined && memberOrder.some((id, index) => id !== original.memberOrder[index])) {
    throw new Error('Continuation cannot override the configured fixed member order.')
  }
  const plan = validateExecutionPlan({
    decision: 'run', reason: request.reason, summary: 'Lead-approved continuation of unfinished work.',
    planner: 'lead-continuation', memberOrder, assignments: nodes,
  }, squad, { requireAllMembers: false, allowSkip: false })
  return { plan, affected }
}
