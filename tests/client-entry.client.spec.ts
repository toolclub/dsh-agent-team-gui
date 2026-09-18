import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { EMPTY_DATA } from '../src/client/contracts.ts'
import type { LocaleService } from '../src/client/i18n.ts'

describe('DSH 0.1.5 browser entry', () => {
  it('loads through generation readiness and refreshes after reconnect without hostDescription', async () => {
    let generation: ConnectionGeneration | undefined
    let notify = (): void => {}
    const unsubscribe = vi.fn()
    const rpc = vi.fn(async () => ({ ok: true, value: { ...EMPTY_DATA, apiVersion: 6 } }))
    const connection = {
      generation: {
        getSnapshot: () => generation,
        subscribe: (listener: () => void) => { notify = listener; return unsubscribe },
      },
      rpc: { call: rpc },
    }
    const locale: LocaleService = {
      getSnapshot: () => ({ active: 'en', revision: 0 }),
      subscribe: () => () => {}, register: () => () => {}, bind: () => key => key,
    }
    const disposers: Array<() => void> = []
    const registrations: string[] = []
    const context = {
      get: (name: string) => name === 'connection' ? connection : locale,
      effect: (factory: () => () => void) => { disposers.push(factory()) },
      slots: {
        inject: (_name: string, factory: () => unknown) => factory(),
        register: (entry: { name: string }) => { registrations.push(entry.name); return () => {} },
      },
    } as unknown as Context
    try {
      expect(() => apply(context)).not.toThrow()
      expect(rpc).not.toHaveBeenCalled()
      generation = { id: 1, host: { home: '/fixture' } } as unknown as ConnectionGeneration
      notify()
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
      expect(rpc).toHaveBeenLastCalledWith('/api', 'agentTeamGui', { endpoint: 'snapshot', payload: {} }, expect.any(AbortSignal))
      generation = undefined
      notify()
      expect(rpc).toHaveBeenCalledTimes(1)
      generation = { id: 2, host: { home: '/fixture' } } as unknown as ConnectionGeneration
      notify()
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
      expect(registrations).toEqual(['settings.section', 'conversation.input.right', 'conversation.input.dock', 'conversation.view'])
    } finally {
      for (const dispose of disposers.reverse()) dispose()
    }
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
