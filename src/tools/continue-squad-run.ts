import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AgentTeamService } from '../index.ts'
import { AgentId, DispatchId, type SquadDispatchResult } from '../types.ts'
import { boundedHandoffChain } from './handoff-chain.ts'

/** Explicit lead-only continuation; this never creates a new goal or clears a message claim. */
export function createContinueSquadRunTool(service: AgentTeamService) {
  return defineTool({
    name: 'continue_squad_run',
    description: 'Continue a settled failed/partial squad run after reviewing its failure diagnosis and existing progress. Same user goal, at most one continuation, shared Token budget. Revise every unfinished member assignment; independent successful work is reused. Do not use for cancelled runs, billing exhaustion, or a new goal.',
    parameters: {
      sourceRunId: { type: 'string', required: true, description: 'dispatchId of the settled source run belonging to this session and current user message.' },
      expectedRevision: { type: 'number', required: true, description: 'chain.revision returned with the source result; stale revisions are rejected.' },
      reason: { type: 'string', required: true, description: 'Failure evidence and why the revised work can meet the original goal.' },
      progressReview: { type: 'string', required: true, description: 'What is already done, what must be inspected, and how repeated side effects will be avoided. Do not claim unverified artifacts are complete.' },
      assignments: { type: 'array', required: true, description: 'Revised remaining tasks for every unfinished member. One task per existing member; break larger tasks into ordered steps without dropping requirements. Affected successful downstream tasks will rerun; independent successes cannot be restarted.', items: {
        type: 'object', additionalProperties: false, properties: {
          agentId: { type: 'string', required: true }, task: { type: 'string', required: true },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Optional revised dependencies on existing plan members. Omit to preserve dependencies.' },
        },
      } },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const result = value as unknown as SquadDispatchResult
        return [{ type: 'text', text: JSON.stringify({
          dispatchId: result.dispatchId, status: result.status, chain: result.chain, continuation: result.continuation, usage: result.usage,
          handoffs: JSON.parse(boundedHandoffChain(result.members)),
          diagnostics: result.members.filter(member => member.recovery !== undefined).map(member => ({
            agentId: member.agentId, state: member.recovery!.state, decision: member.recovery!.decision, error: member.recovery!.error,
          })),
          note: 'This is the same execution chain, not a new dispatch. Report unfinished work honestly; do not bypass the continuation limit or silently replace workers. Full history and prior artifacts are in Run Center.',
        }) }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('continue_squad_run requires the calling lead agent.')
      return await service.continueFromTool({
        sourceRunId: DispatchId(args.sourceRunId), expectedRevision: args.expectedRevision, reason: args.reason, progressReview: args.progressReview,
        assignments: args.assignments.map(node => ({ agentId: AgentId(node.agentId), task: node.task,
          ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn.map(AgentId) }),
        })),
      }, exec.agent, exec.signal) as unknown as JsonValue
    },
  })
}
