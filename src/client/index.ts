/** agent_team_gui 浏览器入口：Settings 小队页 + 输入区小队模式。 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  AgentTeamController,
  CLIENT_STYLES,
  refreshAgentTeamsOnReconnect,
  TeamComposerControl,
  TeamRunCenter,
  TeamRunDock,
  TeamSettingsPage,
} from './AgentTeamDashboard.tsx'
import { AGENT_TEAM_LOCALE_NS, DICTIONARIES, type LocaleService } from './i18n.ts'

/** 浏览器侧依赖；模块加载器会在这些服务就绪后调用 apply。 */
export const inject = ['slots', 'connection', 'locale']

/** agent_team_gui 使用的认证 Connection RPC channel。 */
export const RPC_CHANNEL = '/api'
const RPC_METHOD = 'agentTeamGui'

/** 将管理页和会话模式控件贡献到 dsh 的既有 additive slots。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const locale = ctx.get('locale') as LocaleService
  const call = async <T,>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> => {
    const result = await connection.rpc.call(RPC_CHANNEL, RPC_METHOD, { endpoint, payload }, signal)
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
    return result.value as T
  }
  ctx.effect(
    () => locale.register(AGENT_TEAM_LOCALE_NS, DICTIONARIES),
    'agent-team-gui: bilingual locale dictionary',
  )
  const controller = new AgentTeamController(call, locale)

  // A browser tab survives `dsh` restarts. Re-read the durable catalog when
  // a new Connection generation becomes ready; otherwise one early failed
  // snapshot remains cached until the user happens to save a team in Settings.
  ctx.effect(
    () => refreshAgentTeamsOnReconnect(controller, connection.generation),
    'agent-team-gui: refresh durable teams after reconnect',
  )

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.agentTeamGui = 'true'
    style.textContent = CLIENT_STYLES
    document.head.append(style)
    return () => { style.remove() }
  }, 'agent-team-gui: theme-token styles')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-teams',
    order: 25,
    label: () => controller.i18n.t('teams'),
    inject: () => ({ controller }),
  }, TeamSettingsPage))

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'agent-team-gui-mode',
    order: 80,
    inject: () => ({ controller }),
  }, TeamComposerControl))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'agent-team-run-dock',
    order: 15,
    inject: () => ({ controller }),
  }, TeamRunDock))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-team-runs',
    order: 20,
    label: () => controller.i18n.t('runs'),
    inject: () => ({ controller }),
  }, TeamRunCenter))
}
