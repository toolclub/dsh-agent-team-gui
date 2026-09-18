import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-jobs'
import { agentTeamDomainSpec } from './spec.ts'
import { registerAgentTeamRpc } from './rpc.ts'
import { createDispatchToSquadTool } from './tools/dispatch-to-squad.ts'
import { teamChildToolGuard } from './tools/delegation-policy.ts'
import { ExecutionApplicationService } from './tools/application/execution-service.ts'
import type { AgentTeamConfig } from './tools/domain/host.ts'
import type { SquadDispatchResult } from './types.ts'

export * from './types.ts'
export { AgentTeamError } from './tools/domain/host.ts'
export type Config = AgentTeamConfig
export { agentExportItemSchema, agentRecordSchema, agentTeamDomainSpec, agentTeamExportSchema, agentTeamRecipeSchema, sessionNextSquadModeSchema, sessionSquadModeSchema, squadExportItemSchema, squadRecordSchema } from './spec.ts'
export { createDispatchToSquadTool } from './tools/dispatch-to-squad.ts'
export { AGENT_TEAM_RPC_CHANNEL, AGENT_TEAM_RPC_METHOD, createAgentTeamRpcHandler } from './rpc.ts'

interface SystemPromptService {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: { readonly agent?: Agent }) => string)
  }): () => void
}

/**
 * Cordis composition root and public facade. Definition/versioning and
 * execution use cases live in dedicated application services inherited here;
 * this class only wires official Harness seams and the conversation hook.
 */
export class AgentTeamService extends ExecutionApplicationService {
  static inject = ['storageDomain', 'tools', 'subagents', 'llm', 'agents', 'sessions', 'systemPrompt']

  static Config: z<AgentTeamConfig> = z.object({
    defaultProvider: z.string().default('spawn'),
    defaultExecutionMode: z.union(['serial', 'parallel'] as const).default('serial'),
    defaultContextMode: z.union(['spawn', 'fork', 'chain'] as const).default('spawn'),
    historyMaxRuns: z.number().min(0).max(5_000).step(1).default(0),
    historyMaxAgeDays: z.number().min(0).max(3_650).step(1).default(0),
    versionMaxPerSquad: z.number().min(0).max(1_000).step(1).default(0),
  })

  constructor(ctx: Context, config: AgentTeamConfig) {
    super(ctx, config)
    registerAgentTeamRpc(ctx, this)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'agent_team_gui.domainClose')
    this.attachTables({
      agents: domain.table('agents'),
      squads: domain.table('squads'),
      sessionModes: domain.table('session_modes'),
      nextModes: domain.table('next_modes'),
      messageClaims: domain.table('message_claims'),
      runs: domain.table('runs'),
      squadVersions: domain.table('squad_versions'),
      projectDefaults: domain.table('project_defaults'),
    })

    const { reconciled, pruned } = await this.recoverRunHistory()
    const prunedClaims = await this.pruneMessageClaims()
    if (reconciled > 0 || pruned > 0 || prunedClaims > 0) {
      this.ctx.logger.info(`[agent-team-gui] recovered ${reconciled} interrupted runs and pruned ${pruned} old runs/${prunedClaims} message receipts`)
    }

    this.ctx.tools.register(createDispatchToSquadTool(this))
    this.ctx.tools.guard(teamChildToolGuard(this.ctx.tools))
    const systemPrompt = this.ctx.get('systemPrompt') as SystemPromptService
    systemPrompt.section({
      name: 'agent-team:squad-mode',
      order: 118,
      text: context => this.squadModeGuidance(context.agent),
    })
    this.registerConversationOrchestration()
    this.ctx.logger.info('[agent-team-gui] v0.5 bounded DAG orchestration, durable runs, recipes and insights ready')
  }

  private registerConversationOrchestration(): void {
    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || this.isDelegatedAgent(agent)) return decision
      const submitted = [...decision.messages].reverse()
        .find((message): message is UserMessage => message.source.kind === 'user')
      if (submitted === undefined) return decision
      const task = this.messageText(submitted)
      if (task.trim() === '') return decision

      const nextMode = await this.claimNextSessionSquadMode(agent.id, submitted.id)
      if (nextMode?.state === 'solo') {
        const claimed = await this.claimGuaranteedMessage(agent, submitted.id, 'solo')
        await this.clearClaimedNextSessionSquadMode(agent.id, submitted.id)
        return claimed ? decision : decision
      }
      const mode = nextMode?.state === 'team' && nextMode.squadId !== undefined
        ? (() => {
            const selected = this.getSquad(nextMode.squadId!)
            return selected === undefined ? undefined : { sessionId: agent.id, squadId: nextMode.squadId!, squadName: selected.name }
          })()
        : this.getEffectiveSessionSquadMode(agent)
      if (mode === undefined) return decision
      const squad = this.getSquad(mode.squadId)
      const explicitOnce = nextMode?.state === 'team'
      if (squad === undefined
        || (!explicitOnce && (squad.triggerMode ?? 'guaranteed') !== 'guaranteed')
        || (!explicitOnce && (squad.activationMode ?? 'always') === 'manual')) return decision

      const claimed = await this.claimGuaranteedMessage(agent, submitted.id, 'team')
      if (explicitOnce) await this.clearClaimedNextSessionSquadMode(agent.id, submitted.id)
      if (!claimed) return decision
      if ((squad.responseMode ?? 'foreground') === 'background') {
        try {
          const run = await this.startBackgroundDispatch({ squadId: mode.squadId, task }, agent, {
            sessionId: agent.id,
            sourceMessageId: submitted.id,
          }, signal)
          return {
            kind: 'enter' as const,
            messages: [...decision.messages, createUserMessage({
              content: [{ type: 'text', text: `The selected squad started in the background as run ${run.id}. Do not imply that its unfinished output was incorporated. Answer only with a short acknowledgement and tell the user to follow progress in the Run Center.` }],
              source: { kind: 'plugin', plugin: 'dsh-agent-team-gui', form: 'notice', summary: `${squad.name}: background run started` },
            })],
          }
        } catch (error: unknown) {
          this.ctx.logger.warn(`[agent-team-gui] background dispatch failed to start: ${this.errorText(error)}`)
          return {
            kind: 'enter' as const,
            messages: [...decision.messages, createUserMessage({
              content: [{ type: 'text', text: `The selected squad could not start its background run: ${this.errorText(error)}. Do not silently run it in foreground. Tell the user the background start failed and that they can retry from the Run Center.` }],
              source: { kind: 'plugin', plugin: 'dsh-agent-team-gui', form: 'notice', summary: 'Background squad start failed' },
            })],
          }
        }
      }

      let result: SquadDispatchResult
      try {
        result = await this.dispatch({ squadId: mode.squadId, task }, agent, signal, {
          sessionId: agent.id,
          sourceMessageId: submitted.id,
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`[agent-team-gui] guaranteed dispatch failed; allowing lead model to continue: ${this.errorText(error)}`)
        return {
          kind: 'enter' as const,
          messages: [...decision.messages, createUserMessage({
            content: [{ type: 'text', text: `The selected squad could not run: ${this.errorText(error)}. Continue answering the user directly and disclose the team failure briefly.` }],
            source: { kind: 'plugin', plugin: 'dsh-agent-team-gui', form: 'notice', summary: 'Squad dispatch failed' },
          })],
        }
      }
      return {
        kind: 'enter' as const,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: this.renderSquadContext(result) }],
          source: {
            kind: 'plugin', plugin: 'dsh-agent-team-gui', form: 'notice',
            summary: `${result.squadName}: ${result.status}, ${result.usage.totalTokens} tokens`,
          },
        })],
      }
    })
  }
}

export default AgentTeamService

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeamGui: AgentTeamService
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'agent-team': 'agent-team'
  }
}
