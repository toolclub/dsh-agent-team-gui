import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamSettingsPage, type TeamSettingsPageProps } from '../src/client/SettingsPage.tsx'
import type { AgentTeamRpc, SquadView, TeamSnapshot } from '../src/client/contracts.ts'
import { AgentTeamController } from '../src/client/controller.ts'
import { CLIENT_STYLES } from '../src/client/styles.ts'

const DEFINITION_REVISION = 17

function catalog(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    apiVersion: 4,
    agents: [
      { id: 'agent-1', name: 'Builder', systemPrompt: 'Build', provider: 'p', model: 'm' },
      { id: 'agent-2', name: 'Reviewer', systemPrompt: 'Review', provider: 'p', model: 'm' },
    ],
    squads: [{ id: 'team-1', name: 'Delivery', members: ['agent-1', 'agent-2'], collabNote: 'Ship safely' }],
    models: [{ provider: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }],
    tools: [{ name: 'read', description: 'Read files' }],
    capabilities: { smartActivation: true, dags: true, qualityGate: true, backgroundRuns: true, recipes: true, remoteRecipeFetch: false, insights: true, reproducibleVersions: true },
    defaults: { executionMode: 'serial', fixedOrderExecutionMode: 'serial', contextMode: 'fork', planningContext: 'full', plannerMaxTokens: 2_048 },
    ...overrides,
  }
}

function settingsProps(controller: AgentTeamController, close = vi.fn()): TeamSettingsPageProps {
  return {
    controller,
    close,
    useSessions: (select: (state: { current: string }) => unknown) => select({ current: 'session-1' }),
  } as unknown as TeamSettingsPageProps
}

async function setup(rpc: AgentTeamRpc): Promise<{ controller: AgentTeamController; user: ReturnType<typeof userEvent.setup> }> {
  const controller = new AgentTeamController(rpc)
  await controller.load()
  return { controller, user: userEvent.setup() }
}

beforeEach(() => { vi.stubGlobal('confirm', vi.fn(() => true)) })
afterEach(() => { vi.useRealTimers() })

describe('TeamSettingsPage', () => {
  it('renders team and member actions last in the keyboard-scrollable form flow', async () => {
    const { controller, user } = await setup(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)

    const assertLayout = (editorName: string): { editor: HTMLElement; actions: HTMLElement } => {
      const editor = screen.getByRole('main', { name: editorName })
      const scrollBody = within(editor).getByRole('region', { name: editorName })
      const actions = within(editor).getByRole('group', { name: '编辑操作' })
      expect(scrollBody).toHaveAttribute('tabindex', '0')
      expect(editor.firstElementChild).toBe(scrollBody)
      expect(editor.lastElementChild).toBe(scrollBody)
      expect(scrollBody.lastElementChild).toBe(actions)
      expect(scrollBody).toContainElement(actions)
      expect(actions).toHaveClass('atg-editor-actions')
      expect(actions).not.toHaveClass('atg-sticky-actions')
      return { editor, actions }
    }

    const team = assertLayout('小队编辑器')
    expect(screen.getByLabelText('成员交接摘要上限（字符）')).toHaveValue('')
    expect(screen.getByText(/留空使用默认 16,000/)).toBeInTheDocument()
    expect(within(team.actions).getByRole('button', { name: '保存' })).toBeDisabled()
    expect(within(team.actions).getByRole('button', { name: '放弃修改' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('小队名称'), { target: { value: 'Unsaved delivery' } })
    expect(within(team.actions).getByText('有未保存修改')).toBeInTheDocument()
    expect(within(team.actions).getByRole('button', { name: '保存' })).toBeEnabled()
    await user.click(within(team.actions).getByRole('button', { name: '放弃修改' }))
    expect(screen.getByLabelText('小队名称')).toHaveValue('Delivery')

    await user.click(screen.getByRole('tab', { name: /成员库/ }))
    const member = assertLayout('成员编辑器')
    fireEvent.change(screen.getByLabelText('成员名称'), { target: { value: 'Unsaved builder' } })
    expect(within(member.actions).getByRole('button', { name: '保存' })).toBeEnabled()
    await user.click(within(member.actions).getByRole('button', { name: '放弃修改' }))
    expect(screen.getByLabelText('成员名称')).toHaveValue('Builder')
    expect(within(member.actions).getByRole('button', { name: '保存' })).toBeDisabled()

    expect(CLIENT_STYLES).not.toContain('.atg-sticky-actions')
    expect(CLIENT_STYLES).toContain('.atg-editor{display:flex;min-height:0;overflow:hidden}')
    expect(CLIENT_STYLES.match(/\.atg-editor-actions\{([^}]*)\}/)?.[1]).not.toMatch(/position:(?:absolute|fixed|sticky)/)
    expect(CLIENT_STYLES.match(/\.atg-editor\{([^}]*)\}/)?.[1]).not.toContain('grid-template-rows')
    expect(CLIENT_STYLES).toContain('@media(max-width:430px){.atg-editor-actions>span:not(:empty)')
  })

  it('selects the first persisted team, keeps it selected after save, and guards dirty navigation', async () => {
    let data = catalog()
    const rpc: AgentTeamRpc = async <T,>(endpoint: string, payload: unknown) => {
      if (endpoint === 'snapshot') return data as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'squad/update') {
        const request = payload as { id: string; record: Omit<SquadView, 'id'> }
        data = { ...data, squads: data.squads.map(item => item.id === request.id ? { id: request.id, ...request.record } : item) }
        return {} as T
      }
      throw new Error(`unexpected ${endpoint}`)
    }
    const { controller, user } = await setup(rpc)
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    const name = await screen.findByLabelText('小队名称')
    expect(name).toHaveValue('Delivery')

    await user.clear(name); await user.type(name, 'Delivery v2')
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await user.click(screen.getByRole('tab', { name: /成员库/ }))
    expect(screen.getByRole('tab', { name: /小队/ })).toHaveAttribute('aria-selected', 'true')
    expect(name).toHaveValue('Delivery v2')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByLabelText('小队名称')).toHaveValue('Delivery v2') })
    const master = screen.getAllByRole('button', { name: /Delivery v2/ }).find(button => button.classList.contains('atg-master-main'))
    expect(master?.closest('article')).toHaveClass('is-active')
  })

  it('really discards the current draft before switching settings tabs', async () => {
    const { controller, user } = await setup(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    fireEvent.change(await screen.findByLabelText('小队名称'), { target: { value: 'Unsaved team name' } })
    await user.click(screen.getByRole('tab', { name: /成员库/ }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('尚未保存'))
    await user.click(screen.getByRole('tab', { name: /小队/ }))
    expect(screen.getByLabelText('小队名称')).toHaveValue('Delivery')
    expect(screen.queryByText('未保存')).not.toBeInTheDocument()
  })

  it('shows unknown preset-scoped tools as a warning while still blocking real policy conflicts', async () => {
    const calls: string[] = []
    const { controller, user } = await setup(async <T,>(endpoint: string) => {
      calls.push(endpoint)
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /成员库/ }))
    await user.click(screen.getByText('工具权限').closest('summary')!)
    fireEvent.change(screen.getByLabelText('允许工具'), { target: { value: 'shell' } })
    expect(screen.getByRole('status')).toHaveTextContent('可能来自对话 preset')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('允许工具'), { target: { value: 'read' } })
    fireEvent.change(screen.getByLabelText('禁止工具'), { target: { value: 'read' } })
    expect(screen.getByRole('alert')).toHaveTextContent('同时允许和禁止')
    expect(calls).not.toContain('agent/update')
  })

  it('previews and restores the exact selected historical version', async () => {
    const calls: Array<[string, unknown]> = []
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [
        { version: 3, createdAt: 3, memberSnapshots: [] },
        { version: 2, createdAt: 2, memberSnapshots: [{ id: 'agent-1', name: 'Old Builder', systemPrompt: 'Old', provider: 'p', model: 'm' }] },
      ] as T
      if (endpoint === 'squad/restore-preview') return {
        definitionRevision: DEFINITION_REVISION, squadId: 'team-1', version: 2, record: { name: 'Delivery v2' },
        memberSnapshots: [{ id: 'agent-1', name: 'Old Builder' }], conflicts: [],
        affectedSquads: [{ squadId: 'shared-team', squadName: 'Shared review', agentIds: ['agent-1'] }],
      } as T
      if (endpoint === 'squad/restore') return {} as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    const versionsSummary = await screen.findByText('版本历史')
    await user.click(versionsSummary.closest('summary')!)
    const versionTwo = screen.getByText(/v2 ·/).parentElement!
    await user.click(within(versionTwo).getByRole('button', { name: '预览恢复' }))
    const preview = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('.atg-restore-preview')
      expect(value).not.toBeNull()
      return value!
    })
    expect(preview).toHaveTextContent('v2')
    expect(preview).toHaveTextContent('Old Builder')
    expect(preview).toHaveTextContent('Shared review')
    await user.click(within(preview).getByRole('button', { name: '确认恢复此版本' }))
    await waitFor(() => {
      expect(calls).toContainEqual(['squad/restore', { id: 'team-1', version: 2, expectedRevision: DEFINITION_REVISION }])
    })
  })

  it('clears a stale restore preview and requires the version to be previewed again', async () => {
    const calls: Array<[string, unknown]> = []
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [{ version: 2, createdAt: 2, memberSnapshots: [] }] as T
      if (endpoint === 'squad/restore-preview') return {
        definitionRevision: 29, squadId: 'team-1', version: 2, record: { name: 'Delivery v2', members: ['agent-1'] },
        memberSnapshots: [], conflicts: [], affectedSquads: [],
      } as T
      if (endpoint === 'squad/restore') throw new Error('bad-request: INVALID_IMPORT: stale restore preview: definitions changed')
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click((await screen.findByText('版本历史')).closest('summary')!)
    await user.click(screen.getByRole('button', { name: '预览恢复' }))
    const preview = await waitFor(() => document.querySelector<HTMLElement>('.atg-restore-preview')!)
    await user.click(within(preview).getByRole('button', { name: '确认恢复此版本' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('恢复预览已经失效')
    expect(document.querySelector('.atg-restore-preview')).toBeNull()
    expect(calls).toContainEqual(['squad/restore', { id: 'team-1', version: 2, expectedRevision: 29 }])
    expect(screen.getByRole('button', { name: '预览恢复' })).toBeEnabled()
  })

  it('renders failed diagnostics as an error instead of a green success notice', async () => {
    const { controller, user } = await setup(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'squad/diagnose') return { ok: false, checks: [{ name: 'model route', ok: false, message: 'model unavailable' }] } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    const versions = (await screen.findByText('版本历史')).closest('summary')!
    await user.click(versions)
    await user.click(screen.getByRole('button', { name: '检查配置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('小队检查未通过')
    expect(screen.getByRole('alert')).toHaveTextContent('✕ model route: model unavailable')
    expect(document.querySelector('.atg-success')).toBeNull()
  })

  it('does not preview a stale stored team while its draft is dirty', async () => {
    const calls: string[] = []
    const { controller, user } = await setup(async <T,>(endpoint: string) => {
      calls.push(endpoint)
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    const name = await screen.findByLabelText('小队名称')
    await user.type(name, ' changed')
    const previewSummary = screen.getAllByText('试运行计划').find(element => element.closest('summary') !== null)!.closest('summary')!
    await user.click(previewSummary)
    await user.type(screen.getByLabelText('输入一个示例任务'), 'Build a feature')
    const previewButton = within(previewSummary.closest('details')!).getByRole('button', { name: '试运行计划' })
    expect(previewButton).toBeDisabled()
    expect(screen.getByText(/请先保存当前小队/)).toBeInTheDocument()
    expect(calls).not.toContain('plan/preview')
  })

  it('reconciles clean drafts after external changes and preserves dirty drafts with a warning', async () => {
    let data = catalog()
    const calls: Array<[string, unknown]> = []
    const rpc: AgentTeamRpc = async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return data as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'squad/update') {
        const request = payload as { id: string; record: Omit<SquadView, 'id'> }
        data = { ...data, squads: data.squads.map(item => item.id === request.id ? { id: request.id, ...request.record } : item) }
        return {} as T
      }
      throw new Error(`unexpected ${endpoint}`)
    }
    const { controller, user } = await setup(rpc)
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    expect(await screen.findByLabelText('小队名称')).toHaveValue('Delivery')

    data = { ...data, squads: [{ ...data.squads[0]!, name: 'Remote rename' }] }
    await act(async () => { await controller.load(true) })
    await waitFor(() => { expect(screen.getByLabelText('小队名称')).toHaveValue('Remote rename') })

    fireEvent.change(screen.getByLabelText('小队名称'), { target: { value: 'Local draft' } })
    data = { ...data, squads: [{ ...data.squads[0]!, name: 'Other window rename' }] }
    await act(async () => { await controller.load(true) })
    await waitFor(() => {
      expect(screen.getByLabelText('小队名称')).toHaveValue('Local draft')
      expect(screen.getByRole('status')).toHaveTextContent('检测到来自其他窗口')
    })
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(calls.some(([endpoint]) => endpoint === 'squad/update')).toBe(false)
    vi.mocked(window.confirm).mockReturnValueOnce(true)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(calls.some(([endpoint]) => endpoint === 'squad/update')).toBe(true) })
  })

  it('implements roving ARIA tabs with Arrow, End, and Home keys', async () => {
    const { controller } = await setup(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    const teams = await screen.findByRole('tab', { name: /小队/ })
    teams.focus()
    fireEvent.keyDown(teams, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: /成员库/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /成员库/ })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: /成员库/ }), { key: 'End' })
    expect(screen.getByRole('tab', { name: /配方与数据/ })).toHaveFocus()
    expect(screen.getByTestId('agent-team-recipes')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('tab', { name: /配方与数据/ }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: /小队/ })).toHaveFocus()
  })

  it('shows planner route and provider-reported token buckets in a non-executing plan preview', async () => {
    const calls: Array<[string, unknown]> = []
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'plan/preview') return { plan: {
        decision: 'run', summary: 'Previewed plan', planner: 'main-agent', plannerProvider: 'p', plannerModel: 'm',
        memberOrder: ['agent-1'], assignments: [{ agentId: 'agent-1', task: 'Build', dependsOn: [] }],
        usage: { uncachedInputTokens: 80, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: 115, providerReported: true },
      } } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    const summary = (await screen.findAllByText('试运行计划')).find(item => item.closest('summary') !== null)!.closest('summary')!
    await user.click(summary)
    await user.type(screen.getByLabelText('输入一个示例任务'), 'Build feature')
    await user.click(within(summary.closest('details')!).getByRole('button', { name: '试运行计划' }))
    expect(await screen.findByText('Previewed plan')).toBeInTheDocument()
    expect(screen.getByText(/规划模型: p \/ m/)).toBeInTheDocument()
    expect(screen.getByText(/规划器: 115 Token/)).toBeInTheDocument()
    expect(calls).toContainEqual(['plan/preview', { sessionId: 'session-1', squadId: 'team-1', task: 'Build feature' }])
    expect(screen.getByText('会调用规划模型并计入 Token，但不会启动任何成员。')).toBeInTheDocument()
  })

  it('blocks deletion of a shared quality owner and names all teams affected by a safe delete', async () => {
    const data = catalog({
      agents: [
        ...catalog().agents,
        { id: 'agent-3', name: 'Writer', systemPrompt: 'Write', provider: 'p', model: 'm' },
      ],
      squads: [
        { id: 'team-1', name: 'Delivery', members: ['agent-1', 'agent-2', 'agent-3'], collabNote: '', qualityGate: { reviewerAgentId: 'agent-1', repairAgentId: 'agent-2', maxRounds: 1 } },
        { id: 'team-2', name: 'Shared', members: ['agent-1', 'agent-2', 'agent-3'], collabNote: '' },
      ],
    })
    const calls: Array<[string, unknown]> = []
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return data as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /成员库/ }))
    await user.click(screen.getByRole('button', { name: '删除: Builder' }))
    expect(screen.getByRole('alert')).toHaveTextContent('质量门负责人')
    expect(calls.some(([endpoint]) => endpoint === 'agent/delete')).toBe(false)

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await user.click(screen.getByRole('button', { name: '删除: Writer' }))
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('Delivery, Shared'))
    expect(calls.some(([endpoint]) => endpoint === 'agent/delete')).toBe(false)
  })

  it('explains linked state before deleting a team and cancel performs no write', async () => {
    const calls: Array<[string, unknown]> = []
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(await screen.findByRole('button', { name: '删除: Delivery' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/版本历史.*会话选择.*项目默认/))
    expect(calls.some(([endpoint]) => endpoint === 'squad/delete')).toBe(false)
  })

  it('creates quick templates with one atomic recipe import and no orphan-producing writes', async () => {
    const calls: Array<[string, unknown]> = []
    const empty = catalog({ squads: [], agents: [] })
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return empty as T
      if (endpoint === 'recipe/preview') {
        const doc = (payload as { doc: { squad: unknown; agents: unknown[] } }).doc
        return { valid: true, definitionRevision: DEFINITION_REVISION, conflicts: [], missingRoutes: [], affectedSquads: [], squad: doc.squad, agents: doc.agents } as T
      }
      if (endpoint === 'recipe/import') return { squadId: 'created-team', agents: 3, createdAgents: 3, updatedAgents: 0 } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(await screen.findByRole('button', { name: /全栈开发/ }))
    await waitFor(() => { expect(calls.some(([endpoint]) => endpoint === 'recipe/import')).toBe(true) })
    expect(calls.some(([endpoint]) => endpoint === 'agent/create' || endpoint === 'squad/create')).toBe(false)
    const importPayload = calls.find(([endpoint]) => endpoint === 'recipe/import')?.[1] as { policy: string; expectedRevision: number; doc: { agents: unknown[]; squad: { members: string[] } } }
    expect(importPayload.policy).toBe('copy')
    expect(importPayload.expectedRevision).toBe(DEFINITION_REVISION)
    expect(importPayload.doc.agents).toHaveLength(3)
    expect(importPayload.doc.squad.members).toHaveLength(3)
  })

  it('previews, remaps, revalidates, and imports a recipe while hiding unsupported URL fetch', async () => {
    const calls: Array<[string, unknown]> = []
    const recipeDoc = { format: 'agent-team-gui/recipe', version: 1, exportedAt: 1, squad: { id: 'r', name: 'Recipe', members: ['a'], collabNote: '' }, agents: [{ id: 'a', name: 'A', systemPrompt: 'A', provider: 'old', model: 'old' }] }
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'recipe/preview') {
        const routes = (payload as { routeRemap: Record<string, unknown> }).routeRemap
        return (Object.keys(routes).length === 0
          ? { valid: false, definitionRevision: DEFINITION_REVISION, conflicts: [], missingRoutes: [{ agentId: 'a', kind: 'primary', provider: 'old', model: 'old', message: 'missing' }], squad: recipeDoc.squad, agents: recipeDoc.agents }
          : { valid: true, definitionRevision: DEFINITION_REVISION, conflicts: [], missingRoutes: [], squad: recipeDoc.squad, agents: recipeDoc.agents }) as T
      }
      if (endpoint === 'recipe/import') return { squadId: 'copy' } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    expect(screen.queryByLabelText('HTTPS 配方地址')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: JSON.stringify(recipeDoc) } })
    await user.click(screen.getByRole('button', { name: '预览' }))
    const remap = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('.atg-route-remap')
      expect(value).not.toBeNull()
      return value!
    })
    await user.selectOptions(within(remap).getByLabelText('提供方'), 'p')
    await waitFor(() => { expect(screen.getByText('配方校验通过')).toBeInTheDocument() })
    await user.click(screen.getByRole('button', { name: '确认导入配方' }))
    await waitFor(() => { expect(calls.some(([endpoint]) => endpoint === 'recipe/import')).toBe(true) })
    expect(calls.find(([endpoint]) => endpoint === 'recipe/import')?.[1]).toMatchObject({ expectedRevision: DEFINITION_REVISION })
    expect(calls.some(([endpoint]) => endpoint === 'recipe/fetch-preview')).toBe(false)
  })

  it('renders recipe conflicts and missing routes as scannable records instead of raw JSON', async () => {
    const recipeDoc = { format: 'agent-team-gui/recipe', version: 1, squad: { id: 'r', name: 'Incoming Delivery', members: ['a'], collabNote: '' }, agents: [{ id: 'a', name: 'Incoming Builder', systemPrompt: 'Build', provider: 'portable', model: 'missing' }] }
    const { controller, user } = await setup(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'recipe/preview') return {
        valid: false,
        definitionRevision: DEFINITION_REVISION,
        conflicts: [
          { kind: 'agent', id: 'a', existingName: 'Existing Builder', incomingName: 'Incoming Builder' },
          { kind: 'squad', id: 'r', existingName: 'Existing Delivery', incomingName: 'Incoming Delivery' },
        ],
        missingRoutes: [{ agentId: 'a', kind: 'primary', provider: 'portable', model: 'missing', message: 'Route is unavailable' }],
        squad: recipeDoc.squad,
        agents: recipeDoc.agents,
        affectedSquads: [],
      } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: JSON.stringify(recipeDoc) } })
    await user.click(screen.getByRole('button', { name: '预览' }))

    const conflicts = await screen.findByRole('region', { name: '冲突' })
    expect(conflicts).toHaveTextContent('成员冲突')
    expect(conflicts).toHaveTextContent('现有：Existing Builder → 导入：Incoming Builder')
    expect(conflicts).toHaveTextContent('小队冲突')
    const routes = screen.getByRole('region', { name: '缺少模型路由' })
    expect(routes).toHaveTextContent('Incoming Builder')
    expect(routes).toHaveTextContent('主模型')
    expect(routes).toHaveTextContent('portable / missing')
    expect(routes).toHaveTextContent('原因：Route is unavailable')
    expect(routes).not.toHaveTextContent('"agentId"')
    expect(conflicts).not.toHaveTextContent('"existingName"')
  })

  it('warns about shared-team effects only for recipe merge, never copy', async () => {
    const recipeDoc = { format: 'agent-team-gui/recipe', version: 1, squad: { id: 'r', name: 'Recipe', members: ['agent-1'], collabNote: '' }, agents: [{ id: 'agent-1', name: 'Builder', systemPrompt: 'Build', provider: 'p', model: 'm' }] }
    const { controller, user } = await setup(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'recipe/preview') return {
        valid: true, definitionRevision: DEFINITION_REVISION, conflicts: [], missingRoutes: [], squad: recipeDoc.squad, agents: recipeDoc.agents,
        affectedSquads: [{ squadId: 'team-1', squadName: 'Delivery', agentIds: ['agent-1'] }],
      } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: JSON.stringify(recipeDoc) } })
    await user.click(screen.getByRole('button', { name: '预览' }))
    const recipePreview = await waitFor(() => document.querySelector<HTMLElement>('.atg-recipe-preview')!)
    expect(within(recipePreview).queryByText(/Delivery/)).not.toBeInTheDocument()
    await user.selectOptions(within(recipePreview).getByLabelText('导入策略'), 'merge')
    expect(await within(recipePreview).findByRole('alert')).toHaveTextContent('影响这些现有小队：Delivery')
    await user.selectOptions(within(recipePreview).getByLabelText('导入策略'), 'copy')
    await waitFor(() => { expect(within(recipePreview).queryByRole('alert')).not.toBeInTheDocument() })
  })

  it('remaps an unavailable fallback without overwriting the primary route', async () => {
    const calls: Array<[string, unknown]> = []
    const recipeDoc = {
      format: 'agent-team-gui/recipe', version: 1,
      squad: { id: 'r', name: 'Recipe', members: ['a'], collabNote: '' },
      agents: [{ id: 'a', name: 'A', systemPrompt: 'A', provider: 'p', model: 'm', fallbackProvider: 'old', fallbackModel: 'old' }],
    }
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'recipe/preview') {
        const routes = (payload as { routeRemap: Record<string, { fallbackProvider?: string }> }).routeRemap
        return {
          valid: routes.a?.fallbackProvider === 'p', definitionRevision: DEFINITION_REVISION, conflicts: [],
          missingRoutes: routes.a?.fallbackProvider === 'p' ? [] : [{ agentId: 'a', kind: 'fallback', provider: 'old', model: 'old', message: 'missing fallback' }],
          squad: recipeDoc.squad, agents: recipeDoc.agents, affectedSquads: [],
        } as T
      }
      if (endpoint === 'recipe/import') return { squadId: 'copy' } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: JSON.stringify(recipeDoc) } })
    await user.click(screen.getByRole('button', { name: '预览' }))
    const remap = await waitFor(() => document.querySelector<HTMLElement>('.atg-route-remap')!)
    expect(remap).toHaveTextContent('回退模型')
    await user.selectOptions(within(remap).getByLabelText('提供方'), 'p')
    await waitFor(() => { expect(screen.getByText('配方校验通过')).toBeInTheDocument() })
    await user.click(screen.getByRole('button', { name: '确认导入配方' }))
    const imported = calls.find(([endpoint]) => endpoint === 'recipe/import')?.[1] as { routeRemap: Record<string, unknown> }
    expect(imported.routeRemap.a).toEqual({ provider: 'p', model: 'm', fallbackProvider: 'p', fallbackModel: 'm' })
  })

  it('binds recipe apply to the newest remap preview when responses arrive out of order', async () => {
    const calls: Array<[string, unknown]> = []
    const recipeDoc = { format: 'agent-team-gui/recipe', version: 1, exportedAt: 1, squad: { id: 'r', name: 'Recipe', members: ['a'], collabNote: '' }, agents: [{ id: 'a', name: 'A', systemPrompt: 'A', provider: 'old', model: 'old' }] }
    const data = catalog({ models: [
      { provider: 'p1', name: 'Provider 1', models: [{ id: 'm1', name: 'Model 1' }] },
      { provider: 'p2', name: 'Provider 2', models: [{ id: 'm2', name: 'Model 2' }] },
    ] })
    let previewCall = 0
    let resolveOld: ((value: unknown) => void) | undefined
    let resolveNew: ((value: unknown) => void) | undefined
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return data as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'recipe/preview') {
        previewCall += 1
        if (previewCall === 1) return { valid: false, definitionRevision: DEFINITION_REVISION, conflicts: [], missingRoutes: [{ agentId: 'a', kind: 'primary', provider: 'old', model: 'old', message: 'missing' }], squad: recipeDoc.squad, agents: recipeDoc.agents } as T
        return await new Promise<T>(resolve => {
          if (previewCall === 2) resolveOld = resolve as (value: unknown) => void
          else resolveNew = resolve as (value: unknown) => void
        })
      }
      if (endpoint === 'recipe/import') return { squadId: 'copy' } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: JSON.stringify(recipeDoc) } })
    await user.click(screen.getByRole('button', { name: '预览' }))
    const remap = await waitFor(() => document.querySelector<HTMLElement>('.atg-route-remap')!)
    const provider = within(remap).getByLabelText('提供方')
    await user.selectOptions(provider, 'p1')
    await user.selectOptions(provider, 'p2')
    await waitFor(() => { expect(previewCall).toBe(3) })
    await act(async () => { resolveNew?.({ valid: true, definitionRevision: DEFINITION_REVISION, conflicts: [], missingRoutes: [], squad: recipeDoc.squad, agents: recipeDoc.agents }); await Promise.resolve() })
    expect(await screen.findByText('配方校验通过')).toBeInTheDocument()
    await act(async () => { resolveOld?.({ valid: false, definitionRevision: DEFINITION_REVISION - 1, conflicts: ['stale'], missingRoutes: [{ agentId: 'a' }] }); await Promise.resolve() })
    expect(screen.getByText('配方校验通过')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认导入配方' }))
    const imported = calls.find(([endpoint]) => endpoint === 'recipe/import')?.[1] as { routeRemap: Record<string, { provider: string; model: string }> }
    expect(imported.routeRemap.a).toEqual({ provider: 'p2', model: 'm2' })
  })

  it('previews a definition backup without writes, supports cancel, and applies only after confirmation', async () => {
    const calls: Array<[string, unknown]> = []
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'import/preview') return {
        valid: true, definitionRevision: DEFINITION_REVISION, mode: (payload as { mode: string }).mode, incoming: { agents: 2, squads: 1 },
        conflicts: { agentIds: ['agent-1'], squadIds: [] },
        deletions: { agents: 0, squads: 0, sessionModes: 0, nextModes: 0, projectDefaults: 0, squadVersions: 0 },
        affectedSquads: [{ squadId: 'team-2', squadName: 'Shared team', agentIds: ['agent-1'] }],
      } as T
      if (endpoint === 'import') return {} as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    expect(screen.getByText(/不包含运行历史、会话选择、项目默认或版本历史/)).toBeInTheDocument()
    const backupInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]!
    const file = new File([JSON.stringify({ agents: [], squads: [] })], 'definitions.json', { type: 'application/json' })
    await user.upload(backupInput, file)
    expect(await screen.findByText('将导入 2 名成员、1 个小队')).toBeInTheDocument()
    expect(screen.getByText(/共享成员定义变化会影响这些现有小队：Shared team/)).toBeInTheDocument()
    expect(calls.some(([endpoint]) => endpoint === 'import')).toBe(false)
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(calls.some(([endpoint]) => endpoint === 'import')).toBe(false)
    const backupPolicy = screen.getAllByLabelText('导入策略').find(select => select.querySelector('option[value="replace"]') !== null)!
    await user.selectOptions(backupPolicy, 'replace')
    await user.upload(backupInput, file)
    await screen.findByText('将导入 2 名成员、1 个小队')
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await user.click(screen.getByRole('button', { name: '确认导入定义' }))
    expect(calls.some(([endpoint]) => endpoint === 'import')).toBe(false)
    vi.mocked(window.confirm).mockReturnValueOnce(true)
    await user.click(screen.getByRole('button', { name: '确认导入定义' }))
    await waitFor(() => { expect(calls.filter(([endpoint]) => endpoint === 'import')).toHaveLength(1) })
    expect(calls.find(([endpoint]) => endpoint === 'import')?.[1]).toMatchObject({ expectedRevision: DEFINITION_REVISION })
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('替换会删除'))
  })

  it('invalidates recipe and definition previews when their optimistic revision becomes stale', async () => {
    const calls: Array<[string, unknown]> = []
    const recipeDoc = {
      format: 'agent-team-gui/recipe', version: 1,
      squad: { id: 'r', name: 'Recipe', members: ['agent-1'], collabNote: '' },
      agents: [{ id: 'agent-1', name: 'Builder', systemPrompt: 'Build', provider: 'p', model: 'm' }],
    }
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'recipe/preview') return {
        valid: true, definitionRevision: 31, conflicts: [], missingRoutes: [], affectedSquads: [],
        squad: recipeDoc.squad, agents: recipeDoc.agents,
      } as T
      if (endpoint === 'recipe/import') throw new Error('bad-request: INVALID_IMPORT: stale recipe preview: definitions changed')
      if (endpoint === 'import/preview') return {
        valid: true, definitionRevision: 44, mode: 'merge', incoming: { agents: 1, squads: 1 },
        conflicts: { agentIds: [], squadIds: [] }, affectedSquads: [],
        deletions: { agents: 0, squads: 0, sessionModes: 0, nextModes: 0, projectDefaults: 0, squadVersions: 0 },
      } as T
      if (endpoint === 'import') throw new Error('bad-request: INVALID_IMPORT: stale import preview: definitions changed')
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: JSON.stringify(recipeDoc) } })
    await user.click(screen.getByRole('button', { name: '预览' }))
    await user.click(await screen.findByRole('button', { name: '确认导入配方' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('配方预览已经失效')
    expect(document.querySelector('.atg-recipe-preview')).toBeNull()
    expect(calls.find(([endpoint]) => endpoint === 'recipe/import')?.[1]).toMatchObject({ expectedRevision: 31 })

    const backupInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]!
    await user.upload(backupInput, new File([JSON.stringify({ agents: [], squads: [] })], 'definitions.json', { type: 'application/json' }))
    await user.click(await screen.findByRole('button', { name: '确认导入定义' }))
    expect(await screen.findByText(/备份预览已经失效/)).toHaveAttribute('role', 'alert')
    expect(document.querySelector('.atg-backup-preview')).toBeNull()
    expect(calls.find(([endpoint]) => endpoint === 'import')?.[1]).toMatchObject({ expectedRevision: 44 })
  })

  it('rejects oversized, malformed, and unreadable portable input before any preview RPC', async () => {
    const calls: Array<[string, unknown]> = []
    const { controller, user } = await setup(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await user.click(screen.getByRole('tab', { name: /配方与数据/ }))
    const [recipeInput, backupInput] = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')]

    const recipeText = '界'.repeat(Math.floor((4 * 1_024 * 1_024) / 3) + 1)
    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: recipeText } })
    await user.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByText(/不能超过 4 MiB/)).toHaveAttribute('role', 'alert')

    fireEvent.change(screen.getByLabelText('配方 JSON'), { target: { value: '{bad json' } })
    await user.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByText('JSON 格式无效。')).toHaveAttribute('role', 'alert')

    const unreadable = { size: 1, text: vi.fn().mockRejectedValue(new Error('disk failed')) } as unknown as File
    fireEvent.change(recipeInput!, { target: { files: [unreadable] } })
    expect(await screen.findByText(/无法读取文件：disk failed/)).toHaveAttribute('role', 'alert')

    const oversizedRecipe = { size: 4 * 1_024 * 1_024 + 1, text: vi.fn() } as unknown as File
    fireEvent.change(recipeInput!, { target: { files: [oversizedRecipe] } })
    expect(await screen.findByText(/不能超过 4 MiB/)).toHaveAttribute('role', 'alert')
    expect(oversizedRecipe.text).not.toHaveBeenCalled()

    const oversizedBackup = { size: 16 * 1_024 * 1_024 + 1, text: vi.fn() } as unknown as File
    fireEvent.change(backupInput!, { target: { files: [oversizedBackup] } })
    expect(await screen.findByText(/不能超过 16 MiB/)).toHaveAttribute('role', 'alert')
    expect(oversizedBackup.text).not.toHaveBeenCalled()
    expect(calls.some(([endpoint]) => endpoint === 'recipe/preview' || endpoint === 'recipe/import' || endpoint === 'import/preview' || endpoint === 'import')).toBe(false)
  })

  it('unlocks Settings and aborts a permanently pending save', async () => {
    let saveSignal: AbortSignal | undefined
    const controller = new AgentTeamController(async <T,>(endpoint: string, _payload: unknown, signal?: AbortSignal) => {
      if (endpoint === 'snapshot') return catalog() as T
      if (endpoint === 'squad/versions') return [] as T
      if (endpoint === 'squad/update') { saveSignal = signal; return await new Promise<T>(() => undefined) }
      throw new Error(`unexpected ${endpoint}`)
    })
    await controller.load()
    render(<TeamSettingsPage {...settingsProps(controller)} />)
    await screen.findByLabelText('小队名称')
    vi.useFakeTimers()
    fireEvent.change(screen.getByLabelText('小队名称'), { target: { value: 'Pending save' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
    expect(saveSignal?.aborted).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent('请求超时')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })
})
