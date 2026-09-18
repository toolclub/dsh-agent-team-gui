import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { AgentId } from '../types.ts'
import type { AgentTeamService } from '../index.ts'

/** Build the model-facing natural-language dispatch tool over the host service. */
export function createDispatchToSquadTool(service: AgentTeamService) {
  return defineTool({
    name: 'dispatch_to_squad',
    description: 'Dispatch a task to a configured agent squad. Use assignments when particular members should do different work.',
    parameters: {
      squadId: {
        type: 'string',
        required: true,
        description: 'Durable squad id or exact configured squad name (case-insensitive).',
      },
      task: {
        type: 'string',
        required: true,
        description: 'Shared task and desired final outcome.',
      },
      assignments: {
        type: 'array',
        description: 'Optional member-specific tasks. Every agentId must be a unique member of the squad.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agentId: { type: 'string', required: true },
            task: { type: 'string', required: true },
          },
        },
      },
      memberOrder: {
        type: 'array',
        description: 'Omit this field entirely when the squad has a fixed executionOrder. Otherwise, a complete unique permutation of every member id; controls serial start order and parallel result order.',
        items: { type: 'string' },
      },
      executionMode: {
        type: 'string',
        enum: ['serial', 'parallel'],
        description: 'Member execution order. Defaults to the plugin setting.',
      },
      contextMode: {
        type: 'string',
        enum: ['spawn', 'fork', 'chain'],
        description: 'spawn starts fresh children; fork seeds parent history; chain passes each prior member result to the next serial member.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dispatchId: { type: 'string', required: true },
          squadId: { type: 'string', required: true },
          squadName: { type: 'string', required: true },
          task: { type: 'string', required: true },
          executionMode: { type: 'string', required: true, enum: ['serial', 'parallel'] },
          contextMode: { type: 'string', required: true, enum: ['spawn', 'fork', 'chain'] },
          status: { type: 'string', required: true, enum: ['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'skipped'] },
          startedAt: { type: 'number', required: true },
          endedAt: { type: 'number', required: true },
          usage: { type: 'json', required: true },
          plan: { type: 'json' },
          quality: { type: 'json' },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                agentName: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['completed', 'failed', 'cancelled', 'timed-out'] },
                runId: { type: 'string' },
                childId: { type: 'string' },
                stopReason: { type: 'string' },
                output: { type: 'array', required: true, items: { type: 'json' } },
                error: { type: 'string' },
                attempts: { type: 'number', required: true },
                provider: { type: 'string' },
                model: { type: 'string' },
                startedAt: { type: 'number' },
                endedAt: { type: 'number' },
                usage: { type: 'json' },
                handoff: { type: 'json' },
              },
            },
          },
        },
      },
      // The canonical value remains lossless for durable run storage and UI
      // detail. The lead model receives only bounded handoffs so a large log
      // or artifact cannot be injected back into its context.
      render: (_args, value) => {
        const bounded = {
          dispatchId: value.dispatchId,
          squadId: value.squadId,
          squadName: value.squadName,
          status: value.status,
          task: value.task.slice(0, 1_000),
          executionMode: value.executionMode,
          contextMode: value.contextMode,
          startedAt: value.startedAt,
          endedAt: value.endedAt,
          usage: value.usage,
          plan: value.plan === undefined ? undefined : (() => {
            const plan = value.plan as Record<string, unknown>
            const assignments = Array.isArray(plan['assignments']) ? plan['assignments'] : []
            return {
              decision: plan['decision'],
              reason: typeof plan['reason'] === 'string' ? plan['reason'].slice(0, 2_000) : plan['reason'],
              summary: typeof plan['summary'] === 'string' ? plan['summary'].slice(0, 2_000) : plan['summary'],
              memberOrder: plan['memberOrder'],
              assignments: assignments.slice(0, 32).map((item) => {
                const row = item as Record<string, unknown>
                return { ...row, task: typeof row['task'] === 'string' ? row['task'].slice(0, 1_000) : row['task'] }
              }),
            }
          })(),
          members: value.members.map(member => ({
            agentId: member.agentId,
            agentName: member.agentName,
            status: member.status,
            runId: member.runId,
            childId: member.childId,
            stopReason: member.stopReason,
            attempts: member.attempts,
            usage: member.usage,
            error: member.error?.slice(0, 2_000),
            handoff: member.handoff === undefined ? { summary: 'Full output is available in Run Center.' } : (() => {
              const handoff = member.handoff as Record<string, unknown>
              const strings = (input: unknown, count: number, width: number) => Array.isArray(input)
                ? input.filter((item): item is string => typeof item === 'string').slice(0, count).map(item => item.slice(0, width))
                : []
              return {
                summary: typeof handoff['summary'] === 'string' ? handoff['summary'].slice(0, 2_000) : 'Full output is available in Run Center.',
                deliverables: strings(handoff['deliverables'], 8, 500),
                risks: strings(handoff['risks'], 8, 500),
                changedFiles: strings(handoff['changedFiles'], 20, 300),
              }
            })(),
          })),
          quality: value.quality === undefined ? undefined : (() => {
            const quality = value.quality as Record<string, unknown>
            const rounds = Array.isArray(quality['rounds']) ? quality['rounds'] : []
            const boundedAttempt = (input: unknown) => {
              if (input === null || typeof input !== 'object') return undefined
              const attempt = input as Record<string, unknown>
              const handoff = attempt['handoff'] as Record<string, unknown> | undefined
              return {
                agentId: attempt['agentId'], agentName: attempt['agentName'], status: attempt['status'],
                attempts: attempt['attempts'], usage: attempt['usage'],
                error: typeof attempt['error'] === 'string' ? attempt['error'].slice(0, 2_000) : attempt['error'],
                handoff: handoff === undefined ? undefined : {
                  summary: typeof handoff['summary'] === 'string' ? handoff['summary'].slice(0, 2_000) : undefined,
                },
              }
            }
            return {
              approved: quality['approved'],
              rounds: rounds.slice(0, 3).map((item) => {
                const round = item as Record<string, unknown>
                return {
                  round: round['round'], approved: round['approved'],
                  feedback: typeof round['feedback'] === 'string' ? round['feedback'].slice(0, 2_000) : round['feedback'],
                  reviewer: boundedAttempt(round['reviewer']), repair: boundedAttempt(round['repair']),
                }
              }),
            }
          })(),
          note: 'Full member outputs are persisted in Run Center and intentionally omitted here. After receiving this result, produce a structured retrospective: (1) what the squad accomplished, (2) what went well and what did not, (3) knowledge gap analysis — was missing context about the codebase or missing user-supplied domain knowledge the root cause of any underperformance, (4) concrete improvement suggestions for progressive disclosure or documentation, and (5) a final retrospective summary with a verdict on squad effectiveness.',
        }
        return [{ type: 'text', text: JSON.stringify(bounded, null, 2) }]
      },
    },
    // The official runtime treats false/absence as exclusive within a model
    // step, preventing accidental parallel fan-out from duplicate calls.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('dispatch_to_squad requires a calling agent (exec.agent was undefined)')
      }
      const result = await service.dispatchFromTool({
        squadId: service.resolveSquadId(args.squadId),
        task: args.task,
        ...args.assignments === undefined ? {} : {
          assignments: args.assignments.map(item => ({ agentId: AgentId(item.agentId), task: item.task })),
        },
        ...args.memberOrder === undefined ? {} : { memberOrder: args.memberOrder.map(AgentId) },
        ...args.executionMode === undefined ? {} : { executionMode: args.executionMode },
        ...args.contextMode === undefined ? {} : { contextMode: args.contextMode },
      }, exec.agent, exec.signal)
      const { usage, plan, quality, members, ...rest } = result
      return {
        ...rest,
        usage: usage as unknown as JsonValue,
        ...plan === undefined ? {} : { plan: plan as unknown as JsonValue },
        ...quality === undefined ? {} : { quality: quality as unknown as JsonValue },
        members: members.map(({ usage: memberUsage, handoff, output, ...member }) => ({
          ...member,
          output: output as unknown as JsonValue[],
          ...memberUsage === undefined ? {} : { usage: memberUsage as unknown as JsonValue },
          ...handoff === undefined ? {} : { handoff: handoff as unknown as JsonValue },
        })),
      }
    },
  })
}
