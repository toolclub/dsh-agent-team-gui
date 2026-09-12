import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { AgentTokenUsage } from '../../types.ts'

interface SessionProjectionService {
  snapshot(session: Agent['session']): { readonly values: Record<string, unknown> }
  onChanged?(listener: (
    session: Agent['session'],
    key: string,
    value: unknown,
    seq: number,
  ) => void): () => void
}

export interface TokenUsageProjection {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Narrow adapter over the official session `tokenUsage` projection. */
export class OfficialUsageMeter {
  constructor(private readonly ctx: Context) {}

  add(...samples: Array<AgentTokenUsage | undefined>): AgentTokenUsage {
    const present = samples.filter((sample): sample is AgentTokenUsage => sample !== undefined)
    const buckets = present.reduce((total, sample) => ({
      uncachedInputTokens: total.uncachedInputTokens + sample.uncachedInputTokens,
      outputTokens: total.outputTokens + sample.outputTokens,
      cacheReadTokens: total.cacheReadTokens + sample.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + sample.cacheWriteTokens,
    }), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    return {
      ...buckets,
      totalTokens: buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens,
      providerReported: present.some(sample => sample.providerReported),
    }
  }

  private projectionFor(run: SubagentRun): TokenUsageProjection | undefined {
    if (run.localAgent === undefined) return undefined
    try {
      const projections = this.ctx.get('sessionProjections') as SessionProjectionService | undefined
      if (projections === undefined) return undefined
      const value = projections.snapshot(run.localAgent.session).values['tokenUsage'] as Partial<TokenUsageProjection> | undefined
      if (value === undefined) return undefined
      const projection = {
        uncachedInputTokens: value.uncachedInputTokens ?? 0,
        outputTokens: value.outputTokens ?? 0,
        cacheReadTokens: value.cacheReadTokens ?? 0,
        cacheWriteTokens: value.cacheWriteTokens ?? 0,
      }
      return Object.values(projection).every(item => Number.isSafeInteger(item) && item >= 0) ? projection : undefined
    } catch (error: unknown) {
      this.ctx.logger.warn(`[agent-team-gui] official tokenUsage read failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  usageFor(run: SubagentRun, baseline?: TokenUsageProjection): AgentTokenUsage | undefined {
    const current = this.projectionFor(run)
    if (current === undefined) return undefined
    const buckets = {
      uncachedInputTokens: Math.max(0, current.uncachedInputTokens - (baseline?.uncachedInputTokens ?? 0)),
      outputTokens: Math.max(0, current.outputTokens - (baseline?.outputTokens ?? 0)),
      cacheReadTokens: Math.max(0, current.cacheReadTokens - (baseline?.cacheReadTokens ?? 0)),
      cacheWriteTokens: Math.max(0, current.cacheWriteTokens - (baseline?.cacheWriteTokens ?? 0)),
    }
    const totalTokens = buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
    // The projection initializes at zero before a provider reports; absence is
    // more honest than displaying an invented zero sample.
    return totalTokens === 0 ? undefined : { ...buckets, totalTokens, providerReported: true }
  }

  baselineFor(run: SubagentRun): TokenUsageProjection | undefined {
    if (run.localAgent === undefined) return undefined
    try {
      if (run.localAgent.session.firstLiveSeq === 0) return undefined
    } catch { return undefined }
    return this.projectionFor(run)
  }

  /** Subscribe one child and serialize durable publications without blocking projection callbacks. */
  track(
    run: SubagentRun,
    baseline: TokenUsageProjection | undefined,
    publishUsage: (usage: AgentTokenUsage) => Promise<void>,
    label: string,
  ): () => Promise<AgentTokenUsage | undefined> {
    if (run.localAgent === undefined) return async () => undefined
    let projections: SessionProjectionService
    try { projections = this.ctx.get('sessionProjections') as SessionProjectionService } catch { return async () => undefined }
    if (projections === undefined || projections.onChanged === undefined) return async () => this.usageFor(run, baseline)
    let lastSignature = ''
    let lastUsage: AgentTokenUsage | undefined
    let pending = Promise.resolve()
    const publish = (): void => {
      const usage = this.usageFor(run, baseline)
      if (usage === undefined) return
      lastUsage = usage
      const signature = `${usage.uncachedInputTokens}/${usage.outputTokens}/${usage.cacheReadTokens}/${usage.cacheWriteTokens}`
      if (signature === lastSignature) return
      lastSignature = signature
      pending = pending.then(() => publishUsage(usage)).catch((error: unknown) => {
        this.ctx.logger.warn(`[agent-team-gui] live ${label} token update failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const dispose = projections.onChanged((session, key) => {
      if (session === run.localAgent?.session && key === 'tokenUsage') publish()
    })
    publish()
    return async () => { dispose(); publish(); await pending; return lastUsage ?? this.usageFor(run, baseline) }
  }
}
