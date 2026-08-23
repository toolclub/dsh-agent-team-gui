import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamComposerControl, type TeamComposerControlProps } from '../src/client/ComposerControl.tsx'
import type { AgentTeamRpc, ModeResponse, TeamSnapshot } from '../src/client/contracts.ts'
import { AgentTeamController } from '../src/client/controller.ts'
import type { LocaleService } from '../src/client/i18n.ts'

const snapshot = (squads: TeamSnapshot['squads'] = [{
  id: 'team-1', name: 'Delivery', members: ['agent-1'], collabNote: '',
}]): TeamSnapshot => ({
  apiVersion: 4,
  agents: [{ id: 'agent-1', name: 'Builder', systemPrompt: 'Build', provider: 'p', model: 'm' }],
  squads,
  models: [{ provider: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }],
  tools: [],
  capabilities: { smartActivation: true, dags: true, qualityGate: true, backgroundRuns: true, recipes: true, remoteRecipeFetch: false, insights: true, reproducibleVersions: true },
  defaults: { executionMode: 'serial', fixedOrderExecutionMode: 'serial', contextMode: 'fork', planningContext: 'full', plannerMaxTokens: 2_048 },
})

function mode(overrides: Partial<ModeResponse> = {}): ModeResponse {
  return {
    mode: null,
    sessionOverride: 'inherit',
    sessionReady: true,
    projectKey: 'project-1',
    projectDefault: null,
    nextOverride: null,
    ...overrides,
  }
}

function composerProps(controller: AgentTeamController, sessionId = 'session-1'): TeamComposerControlProps {
  return { controller, sessionId, input: { phase: 'plain' } } as unknown as TeamComposerControlProps
}

async function readyController(rpc: AgentTeamRpc): Promise<AgentTeamController> {
  const controller = new AgentTeamController(rpc)
  await controller.load()
  return controller
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('TeamComposerControl', () => {
  it('switches inherit → Team → Solo and applies/clears one-shot choices', async () => {
    const calls: Array<[string, unknown]> = []
    let current = mode()
    const rpc: AgentTeamRpc = async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return snapshot() as T
      if (endpoint === 'mode/get') return current as T
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'mode/set') {
        const request = payload as { state: 'enabled' | 'disabled'; squadId?: string }
        current = request.state === 'enabled'
          ? mode({ sessionOverride: 'enabled', mode: { sessionId: 'session-1', squadId: request.squadId ?? 'team-1', squadName: 'Delivery' } })
          : mode({ sessionOverride: 'disabled' })
        return current as T
      }
      if (endpoint === 'mode/inherit') { current = mode(); return current as T }
      if (endpoint === 'mode/next-set') {
        const request = payload as { state: 'inherit' | 'solo' | 'team' }
        current = mode({ ...current, nextOverride: request.state === 'team' ? { squadId: 'team-1', squadName: 'Delivery' } : request.state === 'solo' ? 'solo' : null })
        return current as T
      }
      throw new Error(`unexpected ${endpoint}`)
    }
    const controller = await readyController(rpc)
    const user = userEvent.setup()
    render(<TeamComposerControl {...composerProps(controller)} />)

    await user.click(await screen.findByRole('button', { name: /小队模式设置/ }))
    const panel = screen.getByRole('dialog', { name: '小队模式设置' })
    await user.click(within(panel).getByRole('radio', { name: /始终使用小队/ }))
    await waitFor(() => { expect(screen.getByRole('button', { name: /小队模式设置: 小队/ })).toBeInTheDocument() })
    await user.click(within(panel).getByRole('radio', { name: /始终使用单人/ }))
    await waitFor(() => {
      const solo = screen.getByRole('button', { name: /小队模式设置: 单人/ })
      expect(solo).toBeInTheDocument()
      expect(solo).not.toHaveTextContent('Delivery')
    })
    await user.click(within(panel).getByRole('radio', { name: /继承项目默认/ }))
    await waitFor(() => { expect(screen.getByRole('button', { name: /小队模式设置: 继承/ })).toBeInTheDocument() })

    const next = within(panel).getByLabelText('仅下一条消息')
    await user.selectOptions(next, 'team')
    await waitFor(() => { expect(next).toHaveValue('team') })
    await user.selectOptions(next, 'solo')
    await waitFor(() => { expect(next).toHaveValue('solo') })
    await user.selectOptions(next, 'inherit')
    await waitFor(() => { expect(next).toHaveValue('inherit') })
    expect(calls.filter(([endpoint]) => endpoint === 'mode/next-set').map(([, value]) => (value as { state: string }).state)).toEqual(['team', 'solo', 'inherit'])
  })

  it('refreshes the effective inherited mode after setting the project default', async () => {
    let current = mode()
    const rpc: AgentTeamRpc = async <T,>(endpoint: string, payload: unknown) => {
      if (endpoint === 'snapshot') return snapshot() as T
      if (endpoint === 'mode/get') return current as T
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'project/default-set') {
        const squadId = (payload as { squadId: string }).squadId
        current = mode({
          mode: { sessionId: 'session-1', squadId, squadName: 'Delivery' },
          projectDefault: { projectKey: 'project-1', squadId, enabled: true },
        })
        return current as T
      }
      throw new Error(`unexpected ${endpoint}`)
    }
    const controller = await readyController(rpc)
    const user = userEvent.setup()
    render(<TeamComposerControl {...composerProps(controller)} />)
    await user.click(await screen.findByRole('button', { name: /小队模式设置/ }))
    await user.click(screen.getByRole('button', { name: '设为当前项目默认小队' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /小队模式设置: 继承, Delivery/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '取消当前项目默认小队' })).toBeInTheDocument()
    })
  })

  it('does not reinterpret a transient empty catalog as Solo', async () => {
    const persisted = mode({
      sessionOverride: 'enabled',
      mode: { sessionId: 'session-1', squadId: 'persisted', squadName: 'Persisted team' },
    })
    const controller = await readyController(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return snapshot([]) as T
      if (endpoint === 'mode/get') return persisted as T
      if (endpoint === 'run/list') return { runs: [] } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamComposerControl {...composerProps(controller)} />)
    expect(await screen.findByRole('button', { name: /小队模式设置: 小队, Persisted team/ })).toBeInTheDocument()
  })

  it('keeps the empty state actionable instead of disabling an unexplained control', async () => {
    const controller = await readyController(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return snapshot([]) as T
      if (endpoint === 'mode/get') return mode() as T
      if (endpoint === 'run/list') return { runs: [] } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamComposerControl {...composerProps(controller)} />)
    const trigger = await screen.findByRole('button', { name: /小队模式设置: 继承/ })
    expect(trigger).toBeEnabled()
    await user.click(trigger)
    expect(screen.getAllByText('还没有小队')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '创建第一个小队' })).toBeEnabled()
  })

  it('rejects an incomplete mutation response visibly instead of corrupting mode state', async () => {
    const controller = await readyController(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return snapshot() as T
      if (endpoint === 'mode/get') return mode() as T
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'mode/set') return { mode: null } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamComposerControl {...composerProps(controller)} />)
    await user.click(await screen.findByRole('button', { name: /小队模式设置/ }))
    await user.click(screen.getByRole('radio', { name: /始终使用小队/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('DeepSeek Harness')
    expect(screen.getByRole('radio', { name: /始终使用小队/ })).not.toBeDisabled()
  })

  it('unlocks after a permanently pending mode read and exposes Retry', async () => {
    vi.useFakeTimers()
    let modeSignal: AbortSignal | undefined
    const controller = await readyController(async <T,>(endpoint: string, _payload: unknown, signal?: AbortSignal) => {
      if (endpoint === 'snapshot') return snapshot() as T
      if (endpoint === 'mode/get') { modeSignal = signal; return await new Promise<T>(() => undefined) }
      if (endpoint === 'run/list') return { runs: [] } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamComposerControl {...composerProps(controller)} />)
    fireEvent.click(screen.getByRole('button', { name: /小队模式设置/ }))
    expect(screen.getByRole('radio', { name: /始终使用小队/ })).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(5_001); await Promise.resolve() })
    expect(modeSignal?.aborted).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent('请求超时')
    expect(screen.getByRole('radio', { name: /始终使用小队/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
  })

  it('explains a Manual effective team and offers an explicit one-shot team send', async () => {
    const squads = [{ id: 'team-1', name: 'Manual delivery', members: ['agent-1'], collabNote: '', activationMode: 'manual' as const }]
    let current = mode({ sessionOverride: 'enabled', mode: { sessionId: 'session-1', squadId: 'team-1', squadName: 'Manual delivery' } })
    const calls: Array<[string, unknown]> = []
    const controller = await readyController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return snapshot(squads) as T
      if (endpoint === 'mode/get') return current as T
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'mode/next-set') {
        current = mode({ ...current, nextOverride: { squadId: 'team-1', squadName: 'Manual delivery' } })
        return current as T
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamComposerControl {...composerProps(controller)} />)
    const trigger = await screen.findByRole('button', { name: /小队模式设置: 小队, Manual delivery/ })
    expect(trigger).toHaveTextContent('手动')
    await user.click(trigger)
    expect(screen.getByRole('note')).toHaveTextContent('普通发送不会启动成员')
    await user.click(screen.getByRole('button', { name: '下一条使用这个小队' }))
    await waitFor(() => { expect(calls).toContainEqual(['mode/next-set', { sessionId: 'session-1', state: 'team', squadId: 'team-1' }]) })
  })

  it('keeps trigger behavior tied to the effective team while another candidate is selected', async () => {
    const squads = [
      { id: 'team-a', name: 'Effective smart', members: ['agent-1'], collabNote: '', activationMode: 'smart' as const },
      { id: 'team-b', name: 'Candidate manual', members: ['agent-1'], collabNote: '', activationMode: 'manual' as const },
    ]
    const inherited = mode({ mode: { sessionId: 'session-1', squadId: 'team-a', squadName: 'Effective smart' } })
    const controller = await readyController(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return snapshot(squads) as T
      if (endpoint === 'mode/get') return inherited as T
      if (endpoint === 'run/list') return { runs: [] } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamComposerControl {...composerProps(controller)} />)
    const trigger = await screen.findByRole('button', { name: /小队模式设置: 继承, Effective smart/ })
    expect(trigger).toHaveTextContent('智能')
    await user.click(trigger)
    await user.selectOptions(screen.getByLabelText('选择小队'), 'team-b')
    expect(trigger).toHaveTextContent('Effective smart')
    expect(trigger).toHaveTextContent('智能')
    expect(trigger).not.toHaveTextContent('手动')
    expect(screen.getByRole('note')).toHaveTextContent('简单请求可能被有意跳过')
  })

  it('shows the actual queued one-shot team and explicitly requeues a newly selected candidate', async () => {
    const squads = [
      { id: 'team-a', name: 'Queued A', members: ['agent-1'], collabNote: '' },
      { id: 'team-b', name: 'Candidate B', members: ['agent-1'], collabNote: '' },
    ]
    let current = mode({ nextOverride: { squadId: 'team-a', squadName: 'Queued A' } })
    const calls: Array<[string, unknown]> = []
    const controller = await readyController(async <T,>(endpoint: string, payload: unknown) => {
      calls.push([endpoint, payload])
      if (endpoint === 'snapshot') return snapshot(squads) as T
      if (endpoint === 'mode/get') return current as T
      if (endpoint === 'run/list') return { runs: [] } as T
      if (endpoint === 'mode/next-set') {
        const squadId = (payload as { squadId: string }).squadId
        current = mode({ nextOverride: { squadId, squadName: squadId === 'team-b' ? 'Candidate B' : 'Queued A' } })
        return current as T
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const user = userEvent.setup()
    render(<TeamComposerControl {...composerProps(controller)} />)
    await user.click(await screen.findByRole('button', { name: /小队模式设置/ }))
    expect(screen.getByText('已排队：Queued A（team-a）')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('选择小队'), 'team-b')
    expect(screen.getByText('已排队：Queued A（team-a）')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '改为当前选中小队' }))
    await waitFor(() => { expect(screen.getByText('已排队：Candidate B（team-b）')).toBeInTheDocument() })
    expect(calls).toContainEqual(['mode/next-set', { sessionId: 'session-1', state: 'team', squadId: 'team-b' }])
    const radios = screen.getAllByRole('radio')
    expect(new Set(radios.map(input => input.getAttribute('name')))).toEqual(new Set(['agent-team-conversation-mode:session-1']))
  })

  it('isolates radio groups and dialog controls across concurrently mounted sessions', async () => {
    const controller = await readyController(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return snapshot() as T
      if (endpoint === 'mode/get') return mode() as T
      if (endpoint === 'run/list') return { runs: [] } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<>
      <section data-testid="composer-session-a"><TeamComposerControl {...composerProps(controller, 'session-a')} /></section>
      <section data-testid="composer-session-b"><TeamComposerControl {...composerProps(controller, 'session-b')} /></section>
    </>)
    const first = screen.getByTestId('composer-session-a')
    const second = screen.getByTestId('composer-session-b')
    const firstTrigger = await within(first).findByRole('button', { name: /小队模式设置/ })
    const secondTrigger = await within(second).findByRole('button', { name: /小队模式设置/ })
    fireEvent.click(firstTrigger)
    fireEvent.click(secondTrigger)
    const firstPanel = within(first).getByRole('dialog', { name: '小队模式设置' })
    const secondPanel = within(second).getByRole('dialog', { name: '小队模式设置' })
    expect(firstTrigger).toHaveAttribute('aria-controls', firstPanel.id)
    expect(secondTrigger).toHaveAttribute('aria-controls', secondPanel.id)
    expect(firstPanel.id).not.toBe(secondPanel.id)
    expect(new Set(within(firstPanel).getAllByRole('radio').map(input => input.getAttribute('name')))).toEqual(new Set(['agent-team-conversation-mode:session-a']))
    expect(new Set(within(secondPanel).getAllByRole('radio').map(input => input.getAttribute('name')))).toEqual(new Set(['agent-team-conversation-mode:session-b']))
  })

  it('places the mode panel within the available viewport and makes tall content scrollable', async () => {
    vi.stubGlobal('visualViewport', undefined)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
      const top = this.classList.contains('atg-composer-trigger') ? 500 : 0
      const height = this.classList.contains('atg-composer-trigger') ? 28 : 0
      return { x: 900, y: top, top, right: 1_000, bottom: top + height, left: 900, width: 100, height, toJSON: () => ({}) }
    })
    const controller = await readyController(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return snapshot() as T
      if (endpoint === 'mode/get') return mode() as T
      if (endpoint === 'run/list') return { runs: [] } as T
      throw new Error(`unexpected ${endpoint}`)
    })
    render(<TeamComposerControl {...composerProps(controller)} />)
    fireEvent.click(await screen.findByRole('button', { name: /小队模式设置/ }))
    const panel = screen.getByRole('dialog', { name: '小队模式设置' })
    await waitFor(() => {
      expect(panel).toHaveClass('placement-above')
      expect(panel).toHaveStyle({ maxHeight: '482px' })
    })
    expect(panel.scrollTop).toBe(0)
  })

  it('updates visible copy when the official locale service changes', async () => {
    let active = 'en'
    let localeSnapshot = { active, revision: 1 }
    let dictionaries: Record<string, Record<string, string>> = {}
    const listeners = new Set<() => void>()
    const locale: LocaleService = {
      getSnapshot: () => localeSnapshot,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      register: (_namespace, next) => { dictionaries = next; return () => undefined },
      bind: () => (key, params) => {
        const template = dictionaries[active]?.[key] ?? key
        return template.replace(/\{(\w+)\}/g, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
      },
    }
    const controller = new AgentTeamController(async <T,>(endpoint: string) => {
      if (endpoint === 'snapshot') return snapshot() as T
      if (endpoint === 'mode/get') return mode() as T
      throw new Error(`unexpected ${endpoint}`)
    }, locale)
    locale.register('agent-team-gui', (await import('../src/client/i18n.ts')).DICTIONARIES)
    await controller.load()
    render(<TeamComposerControl {...composerProps(controller)} />)
    expect(await screen.findByRole('button', { name: /Team mode settings: Inherited/ })).toBeInTheDocument()
    act(() => { active = 'zh'; localeSnapshot = { active, revision: 2 }; for (const listener of listeners) listener() })
    expect(screen.getByRole('button', { name: /小队模式设置: 继承/ })).toBeInTheDocument()
  })
})
