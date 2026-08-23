import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamRunCenter, TeamRunDock, type TeamRunCenterProps, type TeamRunDockProps } from '../src/client/RunCenter.tsx'
import { EMPTY_USAGE, type RunView, type TokenUsageView } from '../src/client/contracts.ts'
import { AgentTeamController } from '../src/client/controller.ts'
import { CLIENT_STYLES } from '../src/client/styles.ts'

const usage = (total: number): TokenUsageView => ({
  uncachedInputTokens: total,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: total,
  providerReported: true,
})

function run(status: RunView['status'] = 'interrupted'): RunView {
  return {
    id: 'run-1', sessionId: 'session-1', squadId: 'team-1', squadName: 'Delivery', projectKey: 'project-1',
    task: 'Build the release', status, startedAt: 1, ...(status === 'running' ? {} : { endedAt: 2 }),
    executionMode: 'serial', contextMode: 'fork', usage: usage(425),
    plan: {
      summary: 'Plan the release', planner: 'main-agent', memberOrder: ['agent-1'], usage: usage(100),
      assignments: [{ agentId: 'agent-1', task: 'Implement', dependsOn: [] }],
    },
    members: [{
      agentId: 'agent-1', agentName: 'Builder', provider: 'p', model: 'm',
      status: status === 'running' ? 'running' : 'interrupted', attempts: 1,
      output: [{ type: 'text', text: 'member output' }], usage: usage(200), usageSamples: { metered: 1, total: 2 },
    }],
    quality: {
      approved: false,
      rounds: [{
        round: 1, approved: false, feedback: 'Add the missing regression test.',
        reviewer: { agentId: 'reviewer', agentName: 'Reviewer', status: 'completed', attempts: 1, output: [{ text: 'review output' }], usage: usage(50) },
        repair: { agentId: 'repair', agentName: 'Repair', status: 'completed', attempts: 1, output: [{ text: 'repair output' }], usage: usage(75) },
      }],
    },
  }
}

function centerProps(controller: AgentTeamController): TeamRunCenterProps {
  return { controller, sessionId: 'session-1' } as unknown as TeamRunCenterProps
}

function dockProps(controller: AgentTeamController): TeamRunDockProps {
  return { controller, sessionId: 'session-1', input: { phase: 'plain' }, session: {} } as unknown as TeamRunDockProps
}

describe('Team Run Center', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('fetches detail only on expansion and renders DAG plus four disjoint usage buckets and quality rounds', async () => {
    const calls: Array<[string, unknown]> = []
    const detail = run()
    const { quality: _quality, ...summary } = detail
    const controller = new AgentTeamController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'run/list') return { runs: [summary] } as T
      if (endpoint === 'run/get') return { run: detail } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    expect(calls).toContainEqual(['run/list', { sessionId: 'session-1', limit: 50, detail: false }])
    expect(calls.some(([endpoint]) => endpoint === 'run/get')).toBe(false)

    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    await waitFor(() => { expect(calls).toContainEqual(['run/get', { id: 'run-1' }]) })
    expect(await screen.findByText('Add the missing regression test.')).toBeInTheDocument()
    expect(screen.getByText('审核: Reviewer')).toBeInTheDocument()
    expect(screen.getByText('修复: Repair')).toBeInTheDocument()
    const attribution = document.querySelector<HTMLElement>('.atg-usage-attribution')!
    expect(within(attribution).getByText('100')).toBeInTheDocument()
    expect(within(attribution).getByText('200')).toBeInTheDocument()
    expect(within(attribution).getByText('50')).toBeInTheDocument()
    expect(within(attribution).getByText('75')).toBeInTheDocument()
    expect(screen.getByText(/计量 1\/2/)).toBeInTheDocument()
    expect(screen.getByText('依赖阶段')).toBeInTheDocument()
  })

  it('surfaces a completed plain-text delivery whose child retained an error stop reason', async () => {
    const base = run('completed')
    const { quality: _quality, ...withoutQuality } = base
    const detail: RunView = {
      ...withoutQuality,
      members: base.members.map(member => ({
        ...member,
        status: 'completed' as const,
        stopReason: 'error',
        output: [{ type: 'text', text: 'Complete long-form delivery' }],
      })),
    }
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') return { runs: [detail] } as T
      if (endpoint === 'run/get') return { run: detail } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    expect(await screen.findByRole('status')).toHaveTextContent('本次按完成处理')
    expect(screen.getByText('Complete long-form delivery')).toBeInTheDocument()
  })

  it('keeps an expanded live detail fresh across summary polling', async () => {
    const full = run('running')
    const summary = { ...full, plan: undefined, quality: undefined, members: full.members.map(member => ({ ...member, output: [] })) }
    let detailReads = 0
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') return { runs: [summary] } as T
      if (endpoint === 'run/get') {
        detailReads += 1
        return { run: { ...full, members: full.members.map(member => ({ ...member, output: [{ text: `detail-v${detailReads}` }] })) } } as T
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    await user.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    expect(await screen.findByText('detail-v1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /刷新/ }))
    expect(await screen.findByText('detail-v2')).toBeInTheDocument()
    expect(screen.queryByText('detail-v1')).not.toBeInTheDocument()
    expect(screen.getByText('Add the missing regression test.')).toBeInTheDocument()
  })

  it('handles run/get null as an aged-out record and refreshes without crashing', async () => {
    let lists = 0
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') { lists += 1; return { runs: lists === 1 ? [run()] : [] } as T }
      if (endpoint === 'run/get') return { run: null } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('这条运行记录已被清理')
    await waitFor(() => { expect(screen.queryByText('Build the release')).not.toBeInTheDocument() })
    expect(screen.getByTestId('agent-team-run-center')).toBeInTheDocument()
  })

  it('wires active Stop to run/cancel', async () => {
    const calls: Array<[string, unknown]> = []
    const live = run('running')
    const controller = new AgentTeamController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'run/list') return { runs: [live] } as T
      if (endpoint === 'run/get') return { run: live } as T
      if (endpoint === 'run/cancel') return {} as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    await screen.findByRole('button', { name: '停止运行' })
    fireEvent.click(screen.getByRole('button', { name: '停止运行' }))
    await waitFor(() => { expect(calls).toContainEqual(['run/cancel', { id: 'run-1' }]) })
  })

  it('renders the synthesis status at an explicit readable size with a theme-safe label token', async () => {
    const detail = run()
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') return { runs: [detail] } as T
      if (endpoint === 'run/get') return { run: detail } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    const style = document.createElement('style')
    style.textContent = CLIENT_STYLES
    document.head.append(style)
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    const status = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('.atg-synthesis small')
      expect(value).not.toBeNull()
      return value!
    })
    expect(getComputedStyle(status).fontSize).toBe('12px')
    expect(CLIENT_STYLES).toContain('.atg-synthesis small{font-size:12px;color:var(--dsw-alias-label-secondary)}')
    style.remove()
  })

  it('keeps token attribution readable and makes the dependency scroller keyboard reachable', async () => {
    const detail = run()
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') return { runs: [detail] } as T
      if (endpoint === 'run/get') return { run: detail } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    const stageScroller = await screen.findByRole('region', { name: '可横向滚动的依赖阶段，共 1 个阶段' })
    expect(stageScroller).toHaveAttribute('tabindex', '0')
    expect(CLIENT_STYLES).toContain('.atg-usage-attribution small{color:var(--dsw-alias-label-secondary)}')
    expect(CLIENT_STYLES).toContain('.atg-stage-scroll:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)')
  })

  it('wires whole-run and member Retry to new-run RPCs', async () => {
    const calls: Array<[string, unknown]> = []
    const detail = run()
    const controller = new AgentTeamController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'run/list') return { runs: [detail] } as T
      if (endpoint === 'run/get') return { run: detail } as T
      if (endpoint === 'run/retry') return { id: 'retry', status: 'queued', retryOf: 'run-1' } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    await screen.findByRole('button', { name: '重试整次运行' })
    fireEvent.click(screen.getByRole('button', { name: '重试整次运行' }))
    await waitFor(() => { expect(calls).toContainEqual(['run/retry', { id: 'run-1' }]) })
    fireEvent.click(document.querySelector<HTMLElement>('.atg-run-member > summary')!)
    fireEvent.click(screen.getByRole('button', { name: '仅重试此成员' }))
    await waitFor(() => { expect(calls).toContainEqual(['run/retry', { id: 'run-1', agentId: 'agent-1' }]) })
  })

  it('filters, exports, and clears settled history through explicit actions', async () => {
    const calls: Array<[string, unknown]> = []
    const attention = run()
    const completed: RunView = {
      ...run('completed'), id: 'run-2', task: 'Completed task', status: 'completed',
      members: [{ ...run('completed').members[0]!, status: 'completed' }],
    }
    vi.stubGlobal('confirm', vi.fn(() => true))
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const controller = new AgentTeamController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'run/list') return { runs: [attention, completed] } as T
      if (endpoint === 'run/get') return { run: attention } as T
      if (endpoint === 'run/export') return { format: 'agent-team-gui/run', version: 1, run: attention } as T
      if (endpoint === 'run/clear') return { cleared: 2 } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Completed task')
    await user.click(screen.getByRole('button', { name: '需要关注' }))
    expect(screen.getByText('Build the release')).toBeInTheDocument()
    expect(screen.queryByText('Completed task')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '全部状态' }))
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-run-id="run-1"] .atg-run-summary')!)
    await user.click(await screen.findByRole('button', { name: '导出运行' }))
    await waitFor(() => { expect(calls).toContainEqual(['run/export', { id: 'run-1' }]) })
    expect(createUrl).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: '清理已结束历史' }))
    await waitFor(() => { expect(calls).toContainEqual(['run/clear', { sessionId: 'session-1', settledOnly: true }]) })
  })

  it('uses server-wide insights, range filters, project aggregation, and server statuses for completion rate', async () => {
    const calls: Array<[string, unknown]> = []
    const controller = new AgentTeamController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'insights/summary') return {
        runCount: 5,
        meteredRuns: 4,
        unmeteredRuns: 1,
        statuses: { completed: 2, failed: 1, skipped: 1, cancelled: 1 },
        usage: usage(1000), plannerUsage: usage(100), memberUsage: usage(700), qualityUsage: usage(200), reviewUsage: usage(120), repairUsage: usage(80),
        bySquad: [], byAgent: [], byModel: [], byProject: [{ key: 'project-1', label: 'Project One', runCount: 5, usage: usage(1000), meteredSamples: 4, unmeteredSamples: 1 }],
      } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamRunCenter {...centerProps(controller)} />)
    const runsTab = await screen.findByRole('tab', { name: '小队运行' })
    runsTab.focus()
    fireEvent.keyDown(runsTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '洞察' })).toHaveFocus()
    expect(await screen.findByText('67%')).toBeInTheDocument()
    expect(screen.getByText('Project One')).toBeInTheDocument()
    expect(screen.getByText(/Token 计量覆盖 4\/5 次运行/)).toBeInTheDocument()
    expect(screen.getByText(/计量 4\/5/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '最近 7 天' }))
    await waitFor(() => {
      const payloads = calls.filter(([endpoint]) => endpoint === 'insights/summary').map(([, payload]) => payload as { since?: number })
      expect(payloads.some(payload => typeof payload.since === 'number')).toBe(true)
    })
    expect(within(document.querySelector<HTMLElement>('.atg-usage-attribution')!).getByText('100')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('tab', { name: '洞察' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: '小队运行' })).toHaveFocus()
  })

  it('renders all-unmetered insights as unavailable instead of fabricated zero tokens', async () => {
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'insights/summary') return {
        runCount: 2, fullyMeteredRuns: 0, partiallyMeteredRuns: 0, meteredRuns: 0, unmeteredRuns: 2,
        statuses: { running: 2 }, usage: { ...EMPTY_USAGE }, plannerUsage: { ...EMPTY_USAGE }, memberUsage: { ...EMPTY_USAGE },
        qualityUsage: { ...EMPTY_USAGE }, reviewUsage: { ...EMPTY_USAGE }, repairUsage: { ...EMPTY_USAGE },
        bySquad: [], byAgent: [], byModel: [], byProject: [{ label: 'Unmetered project', runCount: 2, usage: { ...EMPTY_USAGE }, meteredSamples: 0, unmeteredSamples: 2 }],
      } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    fireEvent.click(await screen.findByRole('tab', { name: '洞察' }))
    expect(await screen.findByText('Unmetered project')).toBeInTheDocument()
    const usagePanel = document.querySelector<HTMLElement>('.atg-usage')!
    expect(within(usagePanel).getByText(/未上报用量/)).toBeInTheDocument()
    expect(within(usagePanel).queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByText('完成率').parentElement).toHaveTextContent('—')
    const row = screen.getByText('Unmetered project').parentElement!
    expect(row).toHaveTextContent('— · 计量 0/2')
    expect(screen.getByText(/完整 0 · 部分 0 · 未计量 2/)).toBeInTheDocument()
  })

  it('shows known totals and partial coverage for mixed official metering', async () => {
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'insights/summary') return {
        runCount: 2, fullyMeteredRuns: 0, partiallyMeteredRuns: 1, meteredRuns: 1, unmeteredRuns: 1,
        statuses: { completed: 2 }, usage: usage(100), plannerUsage: usage(20), memberUsage: usage(80),
        qualityUsage: { ...EMPTY_USAGE }, reviewUsage: { ...EMPTY_USAGE }, repairUsage: { ...EMPTY_USAGE },
        bySquad: [], byAgent: [], byModel: [], byProject: [{ label: 'Mixed project', runCount: 2, usage: usage(100), meteredSamples: 1, unmeteredSamples: 1 }],
      } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    fireEvent.click(await screen.findByRole('tab', { name: '洞察' }))
    expect(await screen.findByText('Mixed project')).toBeInTheDocument()
    expect(screen.getAllByText(/100/).length).toBeGreaterThan(0)
    expect(screen.getByText(/部分计量/)).toBeInTheDocument()
    expect(screen.getByText(/完整 0 · 部分 1 · 未计量 1/)).toBeInTheDocument()
    expect(screen.getByText(/Token 计量覆盖 1\/2 次运行/)).toBeInTheDocument()
  })

  it('shows live quality phase, bounded review progress, live usage, and never fabricates zero buckets', async () => {
    const base = run('running')
    const { quality: _quality, plan: originalPlan, ...withoutQuality } = base
    const { usage: _plannerUsage, ...plan } = originalPlan!
    const live: RunView = {
      ...withoutQuality,
      usage: { ...EMPTY_USAGE },
      plan,
      phase: 'quality-review',
      qualityProgress: { round: 2, maxRepairRounds: 2, totalReviews: 3, reviewerAgentId: 'agent-1', repairAgentId: 'repair', state: 'reviewing' },
      liveUsage: { review: usage(37) },
      members: [{ agentId: 'agent-1', agentName: 'Reviewer', provider: 'p', model: 'm', status: 'running', attempts: 1, output: [] }],
    }
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') return { runs: [live] } as T
      if (endpoint === 'run/get') return { run: live } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    expect(document.querySelector<HTMLElement>('.atg-run-summary')).toHaveTextContent('37')
    expect(document.querySelector<HTMLElement>('.atg-run-summary')).toHaveTextContent('部分计量')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    const progress = await waitFor(() => document.querySelector<HTMLElement>('.atg-quality-progress')!)
    expect(progress).toHaveTextContent('正在审核')
    expect(progress).toHaveTextContent('第 2/3 轮')
    expect(progress).toHaveTextContent('Reviewer')
    const attribution = document.querySelector<HTMLElement>('.atg-usage-attribution')!
    expect(within(attribution).getByText('37')).toBeInTheDocument()
    expect(within(attribution).getAllByText('统计中…').length).toBeGreaterThanOrEqual(2)
    expect(within(attribution).queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByText('等待小队完成后交接')).toBeInTheDocument()
  })

  it('unlocks Run Center and aborts a permanently pending retry', async () => {
    let retrySignal: AbortSignal | undefined
    const detail = run()
    const controller = new AgentTeamController(async <T,>(endpoint: string, _payload: unknown, signal?: AbortSignal) => {
      if (endpoint === 'run/list') return { runs: [detail] } as T
      if (endpoint === 'run/get') return { run: detail } as T
      if (endpoint === 'run/retry') { retrySignal = signal; return await new Promise<T>(() => undefined) }
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    await screen.findByText('Build the release')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.atg-run-summary')!)
    const retry = await screen.findByRole('button', { name: '重试整次运行' })
    vi.useFakeTimers()
    fireEvent.click(retry)
    expect(retry).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
    expect(retrySignal?.aborted).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent('请求超时')
    expect(screen.getByRole('button', { name: '重试整次运行' })).toBeEnabled()
  })

  it('contains a malformed run response inside the slot and can retry without unmounting Harness UI', async () => {
    let lists = 0
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'run/list') {
        lists += 1
        return (lists === 1 ? { runs: [{ id: 'broken' }] } : { runs: [] }) as T
      }
      if (endpoint === 'snapshot') return {
        apiVersion: 4, agents: [], squads: [], models: [], tools: [],
        capabilities: { smartActivation: true, dags: true, qualityGate: true, backgroundRuns: true, recipes: true, remoteRecipeFetch: false, insights: true, reproducibleVersions: true },
        defaults: { executionMode: 'serial', fixedOrderExecutionMode: 'serial', contextMode: 'fork', planningContext: 'full', plannerMaxTokens: 2_048 },
      } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunCenter {...centerProps(controller)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('前后端版本不一致')
    expect(screen.getByTestId('agent-team-run-center')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByText('这个对话还没有小队运行记录。')).toBeInTheDocument() })
  })

  it('provides a keyboard-native live dock with View run and Stop actions', async () => {
    const calls: Array<[string, unknown]> = []
    const base = run('running')
    const { quality: _quality, plan: originalPlan, ...rest } = base
    const { usage: _plannerUsage, ...plan } = originalPlan!
    const live: RunView = {
      ...rest, plan, phase: 'planning', meteringCoverage: 'partial', usage: { ...EMPTY_USAGE }, liveUsage: { planner: usage(44) },
      members: base.members.map(({ usage: _usage, ...member }) => ({ ...member, output: [] })),
    }
    const shellView = vi.fn()
    render(<button type="button" onClick={shellView}>小队运行</button>)
    const controller = new AgentTeamController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'run/list') return { runs: [live] } as T
      if (endpoint === 'run/cancel') return {} as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamRunDock {...dockProps(controller)} />)
    const dock = await screen.findByRole('button', { name: /Delivery/ })
    expect(dock).toHaveTextContent('44 Token')
    expect(dock).toHaveTextContent('部分计量')
    dock.focus(); fireEvent.keyDown(dock, { key: 'Enter' }); fireEvent.click(dock)
    expect(dock).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: '查看运行' }))
    expect(shellView).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '停止运行' }))
    await waitFor(() => { expect(calls).toContainEqual(['run/cancel', { id: 'run-1' }]) })
  })
})
